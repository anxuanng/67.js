import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';
import { worldBounds } from './probe-trace.js';

// Water reflection: a large, flat, smooth surface (a lake, a river, a polished floor) shows the scene around it. The scene is
// drawn a second time from the camera's mirror image into a target at reduced size, and the surface samples that picture.
// This module is optional. A scene without such a surface never loads it, and the renderer's only links to it are the material
// field `waterReflection`, which batches parts by it, and `frame.reflectionTarget`, which sends one draw into the target.

/** A surface this smooth is a sharp mirror for the scene (sharper than the 0.075 floor the shader gives every material). */
export const WATER_MAXIMUM_ROUGHNESS = 0.1;
/** Above `WATER_MAXIMUM_ROUGHNESS` the mirror picture blurs with roughness, up to this one. A surface rougher than this is not water and gets no mirror. */
export const WATER_BLUR_LIMIT_ROUGHNESS = 0.5;
/** The mirror picture is sampled this many mip levels down at `WATER_BLUR_LIMIT_ROUGHNESS` (each level halves the picture, so the blur spans about 2^5 target pixels). */
export const WATER_MAXIMUM_BLUR_LEVEL = 5;
/** From this roughness the mirror picture fades out to the environment's own reflection, reaching nothing at `WATER_BLUR_LIMIT_ROUGHNESS`. */
export const WATER_FADE_START_ROUGHNESS = 0.35;

/** The mip level the mirror picture is sampled at for a roughness: 0 up to 0.1, rising linearly to `WATER_MAXIMUM_BLUR_LEVEL` at 0.5. */
export function waterMirrorLevel(roughness) {
  const share = (roughness - WATER_MAXIMUM_ROUGHNESS) / (WATER_BLUR_LIMIT_ROUGHNESS - WATER_MAXIMUM_ROUGHNESS);
  return WATER_MAXIMUM_BLUR_LEVEL * Math.min(Math.max(share, 0), 1);
}

/** How much of the mirror picture shows: 1 up to 0.35, falling linearly to 0 at 0.5 where only the environment is left. */
export function waterMirrorWeight(roughness) {
  const share = (roughness - WATER_FADE_START_ROUGHNESS) / (WATER_BLUR_LIMIT_ROUGHNESS - WATER_FADE_START_ROUGHNESS);
  return 1 - Math.min(Math.max(share, 0), 1);
}
/** The surface is flat when its bounds are at most this tall compared with their wider side. */
export const WATER_MAXIMUM_THICKNESS_RATIO = 0.02;
/** The surface is large when its footprint covers at least this share of the scene's footprint. */
export const WATER_MINIMUM_SCENE_SHARE = 0.002;
/** The reflection target is this share of the canvas in each direction. */
export const WATER_REFLECTION_SCALE = 0.75;
// The mirror draw is blurred and rippled, so it can use coarser levels and drop parts that cover almost nothing.
/** The mirror draw accepts this many times the level error that the lit frame accepts (`lodPixelError`). */
export const WATER_MIRROR_LOD_SCALE = 3;
/** The mirror draw skips a part whose bounding sphere covers a smaller radius than this on screen, in pixels. */
export const WATER_MIRROR_MINIMUM_PIXEL_RADIUS = 1.5;
// How the picture is treated before it reaches the surface (see afterEmission). Fresnel starts at the reflectance of water.
const FRESNEL_BASE = '0.02';
const REFLECTION_GAIN = '1.0';
const RIPPLE_SLOPE = '0.012';
const RIPPLE_REACH = '0.004';
const BLUR_TAPS = 8;
const BLUR_ACROSS = '0.0015';
const BLUR_DOWN = '0.0045';
// Geometry below this height above the water plane is left out of the reflection, so the lake bed never covers the sky.
const CLIP_MARGIN = 0.05;
const WATER_BATCH_FLAG = 'waterReflection';
const REFLECTION_TEXTURE_UNIT = 7;
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke', 'floor']);

function footprintOf({ minimum, maximum }) {
  return (maximum[0] - minimum[0]) * (maximum[2] - minimum[2]);
}

function isSmoothSurface(material) {
  return !EXCLUDED_TAGS.has(material.tag) && !(material.transmission > 0) && (material.roughness ?? 1) < WATER_BLUR_LIMIT_ROUGHNESS;
}

function isFlatSurface({ minimum, maximum }) {
  const wider = Math.max(maximum[0] - minimum[0], maximum[2] - minimum[2]);
  return wider > 0 && maximum[1] - minimum[1] <= wider * WATER_MAXIMUM_THICKNESS_RATIO;
}

/**
 * The reflecting surface of a scene, or null. A part qualifies when its material is smooth (roughness below 0.5, blurred above 0.1, and not
 * liquid, foam, unlit, fire, smoke or floor), its bounds are flat, and its footprint is at least 0.2% of the scene's. The largest
 * qualifying part sets the plane (its top); parts within a few centimetres of that height join it.
 * Returns `{ height, partIndices, footprint, sceneShare }`.
 */
export function findWaterSurface(parts) {
  const bounds = parts.map(part => worldBounds(part));
  const sceneMinimum = [Infinity, Infinity, Infinity];
  const sceneMaximum = [-Infinity, -Infinity, -Infinity];
  for (const { minimum, maximum } of bounds) {
    for (let axis = 0; axis < 3; axis++) {
      sceneMinimum[axis] = Math.min(sceneMinimum[axis], minimum[axis]);
      sceneMaximum[axis] = Math.max(sceneMaximum[axis], maximum[axis]);
    }
  }
  const sceneFootprint = footprintOf({ minimum: sceneMinimum, maximum: sceneMaximum });
  const candidates = [];
  parts.forEach((part, index) => {
    const share = sceneFootprint > 0 ? footprintOf(bounds[index]) / sceneFootprint : 0;
    if (isSmoothSurface(part.material) && isFlatSurface(bounds[index]) && share >= WATER_MINIMUM_SCENE_SHARE) {
      candidates.push({ index, share, height: bounds[index].maximum[1], footprint: footprintOf(bounds[index]) });
    }
  });
  if (candidates.length === 0) {
    return null;
  }
  const largest = candidates.reduce((best, candidate) => (candidate.footprint > best.footprint ? candidate : best));
  const sameLevel = candidates.filter(candidate => Math.abs(candidate.height - largest.height) <= CLIP_MARGIN);
  return { height: largest.height, partIndices: sameLevel.map(candidate => candidate.index), footprint: largest.footprint, sceneShare: largest.share };
}

// A part keeps reading every other field from the live material, so motion on colour still works.
function withWaterReflectionFlag(liveMaterial) {
  const wrapper = {};
  for (const field of Object.keys(liveMaterial)) {
    Object.defineProperty(wrapper, field, { enumerable: true, get: () => liveMaterial[field] });
  }
  Object.defineProperty(wrapper, WATER_BATCH_FLAG, { enumerable: true, value: true });
  return Object.freeze(wrapper);
}

/**
 * Marks the qualifying parts of a scene for the reflection. Returns `{ parts, surface, report }`; `surface` is null (and the
 * parts are returned as they came) when nothing qualifies. Call `attachWaterReflection(renderer, surface)` after the renderer
 * is built from `parts`.
 */
export function applyWaterReflection(parts) {
  const surface = findWaterSurface(parts);
  if (!surface) {
    return { parts, surface: null, report: { placed: false, reason: 'no large flat smooth surface' } };
  }
  const flagged = new Set(surface.partIndices);
  const marked = parts.map((part, index) => (flagged.has(index) ? Object.freeze({ ...part, material: withWaterReflectionFlag(part.material) }) : part));
  const report = { placed: true, height: surface.height, parts: surface.partIndices.length, footprint: surface.footprint, sceneShare: surface.sceneShare };
  return { parts: Object.freeze(marked), surface, report };
}

registerShaderFeatureCode('waterReflection', Object.freeze({
  declarations: `uniform sampler2D waterReflection;
uniform mat4 waterReflectionMatrix;
uniform vec2 waterClip;
uniform float waterReflectionEnabled;
`,
  // While the mirror image is drawn, nothing under the water plane is part of it.
  mainSetup: '  if (waterClip.y > 0.5 && worldPosition.y < waterClip.x + ' + CLIP_MARGIN.toFixed(2) + ') discard;\n',
  // Above roughness 0.1 the picture is sampled from a coarser mip level (rougher water, blurrier reflection) and fades to the
  // environment's reflection between 0.35 and 0.5: `waterMirrorLevel` and `waterMirrorWeight` written in GLSL.
  // The picture holds the light as the frame leaves the shader: scaled by exposure, and encoded when the frame is not HDR.
  // Still water is not a mirror: small ripples shake the picture (more with distance), a few taps smear it (more up and down,
  // as ripples stretch a reflection), and Fresnel makes it strong at grazing angles and faint when looking down into the water.
  afterEmission: `  if (waterReflectionEnabled > 0.5) {
    float eyeDistance = length(worldPosition - eye);
    vec2 slope = vec2(sin(worldPosition.x * 0.31 + worldPosition.z * 0.17 + time * 0.4) + 0.6 * sin(worldPosition.x * 0.83 - worldPosition.z * 0.5 - time * 0.7),
      sin(worldPosition.z * 0.27 - worldPosition.x * 0.11 + time * 0.5) + 0.6 * sin(worldPosition.z * 0.91 + worldPosition.x * 0.43 - time * 0.6)) * ${RIPPLE_SLOPE};
    vec3 shaken = worldPosition + vec3(slope.x, 0.0, slope.y) * (1.0 + eyeDistance * ${RIPPLE_REACH});
    vec4 mirrorClip = waterReflectionMatrix * vec4(shaken, 1.0);
    vec2 mirrorCentre = mirrorClip.xy / mirrorClip.w * 0.5 + 0.5;
    float mirrorLevel = ${WATER_MAXIMUM_BLUR_LEVEL.toFixed(1)} * clamp((roughness - ${WATER_MAXIMUM_ROUGHNESS.toFixed(2)}) / ${(WATER_BLUR_LIMIT_ROUGHNESS - WATER_MAXIMUM_ROUGHNESS).toFixed(2)}, 0.0, 1.0);
    float mirrorWeight = 1.0 - clamp((roughness - ${WATER_FADE_START_ROUGHNESS.toFixed(2)}) / ${(WATER_BLUR_LIMIT_ROUGHNESS - WATER_FADE_START_ROUGHNESS).toFixed(2)}, 0.0, 1.0);
    vec3 mirrored = vec3(0.0);
    for (int tap = 0; tap < ${BLUR_TAPS}; tap++) {
      float angle = float(tap) * 2.39996;
      vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / ${BLUR_TAPS}.0);
      mirrored += textureLod(waterReflection, mirrorCentre + offset * vec2(${BLUR_ACROSS}, ${BLUR_DOWN}), mirrorLevel).rgb;
    }
    mirrored = (hdrEnabled > 0.5 ? mirrored / ${BLUR_TAPS}.0 : pow(mirrored / ${BLUR_TAPS}.0, vec3(2.2))) / max(exposure, 1e-4);
    float fresnelWeight = (${FRESNEL_BASE} + (1.0 - ${FRESNEL_BASE}) * pow(1.0 - max(viewDirection.y, 0.0), 5.0)) * mirrorWeight;
    vec3 skyLight = ENVIRONMENT_ENABLED ? environmentLighting(normal, specularNormal, baseReflectance, viewDirection, reflect(-viewDirection, specularNormal), vec3(0.0), metallic, roughness, occlusion, ambientIntensity, skyReflection) : vec3(0.0);
    radiance = ENVIRONMENT_ENABLED ? max(radiance - skyLight * mirrorWeight, vec3(0.0)) + mirrored * ${REFLECTION_GAIN} * fresnelWeight : mix(radiance, mirrored * ${REFLECTION_GAIN}, fresnelWeight);
  }
`,
}));

const rendererStates = new WeakMap();

function createReflectionTarget(renderer, width, height) {
  const context = renderer.context;
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, renderer.hdr ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA, renderer.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  const depth = context.createRenderbuffer();
  context.bindRenderbuffer(context.RENDERBUFFER, depth);
  context.renderbufferStorage(context.RENDERBUFFER, context.DEPTH_COMPONENT24, width, height);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depth);
  const complete = context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  return { framebuffer, texture, depth, width, height, complete };
}

function releaseReflectionTarget(renderer, target) {
  if (!target) {
    return;
  }
  const context = renderer.context;
  context.deleteFramebuffer(target.framebuffer);
  context.deleteTexture(target.texture);
  context.deleteRenderbuffer(target.depth);
}

// The camera as the water sees it: below the plane, looking at the mirrored target, with up turned over.
function mirroredFrame(frame, height, target) {
  const [eyeX, eyeY, eyeZ] = frame.eye;
  const [targetX, targetY, targetZ] = frame.target ?? [0, 1.2, 0];
  const [upX, upY, upZ] = frame.up ?? [0, 1, 0];
  return { ...frame, eye: [eyeX, 2 * height - eyeY, eyeZ], target: [targetX, 2 * height - targetY, targetZ], up: [upX, -upY, upZ], reflectionTarget: target };
}

const SNAPSHOT_DEPTH = 4;

// A copy of the frame's values (arrays, typed arrays and plain objects are copied, anything else is kept by reference), so a later
// frame can be compared with what this one held even when the caller changes the same arrays in place.
function snapshotOf(value, depth = 0) {
  if (depth >= SNAPSHOT_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.slice();
  }
  if (Array.isArray(value)) {
    return value.map(item => snapshotOf(item, depth + 1));
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotOf(item, depth + 1)]));
  }
  return value;
}

function sameValue(first, second, depth = 0) {
  if (first === second) {
    return true;
  }
  if (depth >= SNAPSHOT_DEPTH || first === null || second === null || typeof first !== 'object' || typeof second !== 'object') {
    return false;
  }
  const firstKeys = Object.keys(first);
  if (Object.getPrototypeOf(first) !== Object.getPrototypeOf(second) || firstKeys.length !== Object.keys(second).length) {
    return false;
  }
  return firstKeys.every(key => sameValue(first[key], second[key], depth + 1));
}

/**
 * Whether the picture from the last mirror draw still serves this frame: the frame holds the same values as the one it was drawn for
 * and no part was updated since, or `updateEvery` asks for the last picture to stay for that many lit frames.
 */
export function canReuseMirrorImage(state, frame) {
  if (!state.ready || !state.drawnFrame) {
    return false;
  }
  if (state.partsRevision === state.drawnRevision && sameValue(state.drawnFrame, frame)) {
    return true;
  }
  return state.framesSinceDraw < state.updateEvery - 1;
}

function drawMirrorImage(renderer, state, frame, renderFrame) {
  const width = Math.max(1, Math.ceil(renderer.canvas.width * state.scale));
  const height = Math.max(1, Math.ceil(renderer.canvas.height * state.scale));
  if (!state.target || state.target.width !== width || state.target.height !== height) {
    releaseReflectionTarget(renderer, state.target);
    state.target = createReflectionTarget(renderer, width, height);
    state.ready = false;
  }
  const lookingDown = frame.eye[1] > state.height;
  if (!lookingDown || !state.target.complete) {
    state.ready = false;
    return;
  }
  if (canReuseMirrorImage(state, frame)) {
    state.framesSinceDraw++;
    return;
  }
  state.ready = false;
  // The last frame left the picture bound for sampling, and a target cannot be drawn into while it is bound.
  renderer.context.activeTexture(renderer.context.TEXTURE0 + REFLECTION_TEXTURE_UNIT);
  renderer.context.bindTexture(renderer.context.TEXTURE_2D, null);
  renderer.context.activeTexture(renderer.context.TEXTURE0);
  state.drawing = true;
  // Parts wholly under the plane are discarded by the shader anyway, so the renderer leaves them out of the draw.
  renderer.mirrorCulling = { belowHeight: state.height + CLIP_MARGIN, lodScale: WATER_MIRROR_LOD_SCALE, minimumPixelRadius: WATER_MIRROR_MINIMUM_PIXEL_RADIUS };
  try {
    renderFrame(mirroredFrame(frame, state.height, state.target));
  } finally {
    renderer.mirrorCulling = null;
    state.drawing = false;
  }
  // Rougher water samples the coarser levels, so they are built from the finished picture.
  renderer.context.bindTexture(renderer.context.TEXTURE_2D, state.target.texture);
  renderer.context.generateMipmap(renderer.context.TEXTURE_2D);
  state.matrix.set(renderer.viewProjection);
  state.drawnFrame = snapshotOf(frame);
  state.drawnRevision = state.partsRevision;
  state.framesSinceDraw = 0;
  state.ready = true;
}

function locationsOf(renderer, state) {
  if (state.program !== renderer.program) {
    const context = renderer.context;
    const locate = name => context.getUniformLocation(renderer.program, name);
    state.program = renderer.program;
    state.locations = { sampler: locate('waterReflection'), matrix: locate('waterReflectionMatrix'), clip: locate('waterClip'), enabled: locate('waterReflectionEnabled') };
  }
  return state.locations;
}

function bindWater(renderer, mapState) {
  const state = rendererStates.get(renderer);
  if (!state || !renderer.shaderFeatures?.has('waterReflection')) {
    return;
  }
  const context = renderer.context;
  const locations = locationsOf(renderer, state);
  const sampled = Boolean(mapState[20]) && state.ready && !state.drawing;
  context.uniform2f(locations.clip, state.height, state.drawing ? 1 : 0);
  context.uniform1f(locations.enabled, sampled ? 1 : 0);
  if (sampled) {
    context.activeTexture(context.TEXTURE0 + REFLECTION_TEXTURE_UNIT);
    context.bindTexture(context.TEXTURE_2D, state.target.texture);
    context.uniform1i(locations.sampler, REFLECTION_TEXTURE_UNIT);
    context.uniformMatrix4fv(locations.matrix, false, state.matrix);
  }
}

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState) => {
  previousBind?.(renderer, mapState, layerState);
  bindWater(renderer, mapState);
};

/**
 * Draws the mirror image before each frame of a renderer built from the parts `applyWaterReflection` marked. Wraps
 * `renderer.render` and `renderer.dispose`; the returned function undoes both. Does nothing when `surface` is null.
 * `scale` is the target's size against the canvas in each direction (default 0.75). The picture is kept while the frame holds the same
 * values as the one it was drawn for and no part was updated (`renderer.updateParts`); `updateEvery: 2` also keeps it for one lit frame
 * after each draw (the reflection then trails the camera by a frame), which suits a film.
 */
/**
 * Hides the geometries flagged `mirrorOnly` (the coarse terrain meshes of `createTerrain({ mirrorLevels })`) from every draw but
 * the mirror: the batch keeps its true level errors in `mirrorErrors` and shows an infinite error for those levels, which no
 * frame or shadow selection can pass. Done once for each batch, also across attaching and detaching.
 */
const hiddenBatches = new WeakSet();
function hideMirrorOnlyLevels(batch) {
  if (hiddenBatches.has(batch)) {
    return;
  }
  hiddenBatches.add(batch);
  if (batch.levelGeometries?.some(geometry => geometry.mirrorOnly)) {
    batch.mirrorErrors = batch.levelErrors;
    batch.levelErrors = batch.levelErrors.map((error, level) => (batch.levelGeometries[level].mirrorOnly ? Infinity : error));
  }
}

export function attachWaterReflection(renderer, surface, { scale = WATER_REFLECTION_SCALE, updateEvery = 1 } = {}) {
  if (!surface) {
    return () => {};
  }
  const state = { height: surface.height, scale, updateEvery: Math.max(1, Math.floor(updateEvery)), partsRevision: 0, drawnRevision: -1, drawnFrame: null, framesSinceDraw: 0, target: null, ready: false, drawing: false, matrix: new Float32Array(16), program: null, locations: null };
  rendererStates.set(renderer, state);
  renderer.batches?.forEach(hideMirrorOnlyLevels);
  const render = renderer.render;
  const dispose = renderer.dispose;
  const updateParts = renderer.updateParts;
  const renderFrame = frame => render.call(renderer, frame);
  const selectBatchInstances = renderer.selectBatchInstances;
  // The mirror draw selects among all the levels of a batch; every other draw never sees the mirror-only ones.
  renderer.selectBatchInstances = batch => {
    hideMirrorOnlyLevels(batch);
    if (!state.drawing || !batch.mirrorErrors) {
      return selectBatchInstances.call(renderer, batch);
    }
    const hidden = batch.levelErrors;
    batch.levelErrors = batch.mirrorErrors;
    try {
      return selectBatchInstances.call(renderer, batch);
    } finally {
      batch.levelErrors = hidden;
    }
  };
  renderer.render = frame => {
    // The shadow passes of a lit frame run before its first draw, so every batch is checked first.
    renderer.batches?.forEach(hideMirrorOnlyLevels);
    // A render pass (albedo, depth, object ID...) never shows the reflection, so it skips the mirror draw.
    if (!frame.reflectionTarget && frame.pass === undefined) {
      drawMirrorImage(renderer, state, frame, renderFrame);
    }
    return render.call(renderer, frame);
  };
  if (updateParts) {
    renderer.updateParts = (...updateArguments) => {
      state.partsRevision++;
      return updateParts.apply(renderer, updateArguments);
    };
  }
  renderer.dispose = () => {
    releaseReflectionTarget(renderer, state.target);
    rendererStates.delete(renderer);
    return dispose.call(renderer);
  };
  return () => {
    renderer.render = render;
    renderer.selectBatchInstances = selectBatchInstances;
    renderer.dispose = dispose;
    if (updateParts) {
      renderer.updateParts = updateParts;
    }
    releaseReflectionTarget(renderer, state.target);
    rendererStates.delete(renderer);
  };
}
