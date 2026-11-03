// Runs in the page: draws one reference scene, and describes it as plain data for Blender.
import { Renderer67 } from '/src/renderer.js';
import { REFERENCE_SCENES, KHRONOS_SCENES, CLOTH_SCENES } from './scenes.js';
import { GRAND_SCENES } from './grand-scenes.js';
import { skinnedGeometry } from '/src/path-tracer-scene.js';
import { boxProjectedGeometry } from '/src/export-box-uv.js';
import '/src/material-layer-shaders.js';
import { skyOpenness } from '/src/closed-room.js';
import { fogSkyVisibility } from '/src/fog-sky-visibility.js';
import { createCascadedShadows } from '/src/cascaded-shadows.js';
import { applyLightLinks } from '/src/light-linking.js';
import { applyWaterReflection, attachWaterReflection } from '/src/water-reflection.js';
import { attachScreenSpaceWater } from './ssr-water.js';

// Water reflection is on the way a recipe gets it: found from the materials, no field. ?water=off draws the scenes without it, ?water=ssr with the screen-space reflection it was compared with.
const WATER_REFLECTION = { off: false, ssr: 'ssr' }[new URLSearchParams(location.search).get('water')] ?? 'planar';

// ?set=khronos draws the Khronos sample assets (npm run reference -- --khronos) and ?set=cloth the cloth scenes
// (npm run reference -- --cloth) instead of the fixed scenes.
const SCENE_SETS = { khronos: KHRONOS_SCENES, cloth: CLOTH_SCENES, grand: GRAND_SCENES };
const SCENES = SCENE_SETS[new URLSearchParams(location.search).get('set')] ?? REFERENCE_SCENES;

function encodeBytes(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  let text = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(text);
}

// With an image table, each ImageData is written once into the table and its place holds { imageId }, so a scene with
// thousands of parts that share a leaf texture does not repeat the pixels in every material.
function plainData(value, imageTable = null) {
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, base64: encodeBytes(value) };
  if (value instanceof ImageData) {
    if (!imageTable) return { width: value.width, height: value.height, data: plainData(value.data) };
    if (!imageTable.ids.has(value)) {
      imageTable.ids.set(value, imageTable.images.length);
      imageTable.images.push({ width: value.width, height: value.height, data: plainData(value.data) });
    }
    return { imageId: imageTable.ids.get(value) };
  }
  if (Array.isArray(value)) return value.map(entry => plainData(entry, imageTable));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'function') result[key] = plainData(entry, imageTable);
    }
    return result;
  }
  return value;
}

// Parts that look the same share one entry of the scene's material list.
function materialTable() {
  const imageTable = { ids: new Map(), images: [] };
  const entries = [];
  const indexByText = new Map();
  function indexOf(material) {
    const described = plainData(material, imageTable);
    const text = JSON.stringify(described);
    if (!indexByText.has(text)) {
      indexByText.set(text, entries.length);
      entries.push(described);
    }
    return indexByText.get(text);
  }
  return { indexOf, entries, images: imageTable.images };
}

// A pattern material is box projected in the shader and has no UVs. Blender gets the same projection written as UVs,
// per part, because the projection depends on the part's scale.
function boxProjectedFor(part, cache) {
  const boxMapScale = part.material.boxMapScale;
  if (!(boxMapScale > 0) || part.geometry.uvs) return part.geometry;
  const { matrix } = part;
  const scale = [0, 1, 2].map(column => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
  const key = `${scale.join(',')}|${boxMapScale}|${part.material.boxMapAxis ?? 1}`;
  if (!cache.has(part.geometry)) cache.set(part.geometry, new Map());
  const byScale = cache.get(part.geometry);
  if (!byScale.has(key)) byScale.set(key, boxProjectedGeometry(part.geometry, scale, boxMapScale, part.material.boxMapAxis ?? 1));
  return byScale.get(key);
}

// Blender's glTF importer cannot reproduce this rig's pose (three.js and 67js agree on it), so Blender gets the
// skinned result as plain geometry. A score then measures shading, and not an importer's pose.
function describeScene(id, scene) {
  const { map: _map, ...environment } = scene.environment;
  // A sample asset reaches Blender as its own file, not as parts.
  if (scene.glb) return { id, camera: scene.camera, environment, world: scene.blenderWorld, glb: scene.glb, parts: [], geometries: [] };
  const geometries = new Map();
  const boxProjected = new Map();
  const materials = materialTable();
  const describedParts = scene.parts.map(part => {
    const geometry = part.skin ? skinnedGeometry(part) : boxProjectedFor(part, boxProjected);
    if (!geometries.has(geometry)) geometries.set(geometry, geometries.size);
    return { name: part.name, geometry: geometries.get(geometry), matrix: [...part.matrix], material: materials.indexOf(part.material) };
  });
  return {
    id, camera: scene.camera, environment, world: scene.blenderWorld, blenderCloth: scene.blenderCloth, brightRegion: scene.brightRegion,
    materials: materials.entries, images: materials.images,
    parts: describedParts,
    geometries: [...geometries.keys()].map(({ positions, normals, uvs, colors, indices }) => plainData({ positions, normals, uvs, colors, indices })),
  };
}

// Blender always gets the original parts: the bake is 67js's approximation of what Cycles computes.
async function bakeScene(scene, bakeOptions) {
  if (bakeOptions.preset) {
    return bakeScenePreset(scene, bakeOptions.preset);
  }
  const { bakeLightmaps } = await import('/src/light-bake.js');
  const { pointLights, keyColor, lightDirection } = scene.environment;
  const started = performance.now();
  // A scene as large as a hall can need its own texel density to stay under the bake's texel limit.
  const baked = bakeLightmaps(scene.parts, { pointLights, keyColor, lightDirection }, { ...scene.bakeOptions, ...bakeOptions });
  return { parts: baked.parts, report: baked.report, seconds: (performance.now() - started) / 1000 };
}

// The bake an agent gets from `bake: { preset }`: the same settings and budget fit as a recipe. Probes stay out of it and come
// from --probes, as in the other rows.
async function bakeScenePreset(scene, preset) {
  const { normalizeAgentBake, bakeAgentParts } = await import('/src/agent-bake.js');
  const settings = normalizeAgentBake({ preset, probes: false });
  const started = performance.now();
  let baked;
  try {
    baked = bakeAgentParts(scene.parts, new Map(scene.parts.map(part => [part.name, part.matrix])), scene.environment, settings);
  } catch (error) {
    // A recipe would get this error and no bake: the scene is drawn unbaked and the row says so.
    return { parts: scene.parts, report: { refused: error.message, texels: 0 }, seconds: 0 };
  }
  return { parts: baked.parts, report: baked.report, seconds: (performance.now() - started) / 1000 };
}

// The 67js renderer for a scene: light linking from the lights' affects lists, and cascaded sun shadows when asked for.
function createSceneRenderer(parts, scene, cascades, { water = WATER_REFLECTION } = {}) {
  const reflecting = water === 'planar' ? applyWaterReflection(parts) : { parts, surface: null };
  const renderer = new Renderer67(document.querySelector('canvas'), applyLightLinks(reflecting.parts, scene.environment), {
    ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true,
    environment: scene.environment, shadowBounds: scene.shadow, shadowCascades: cascades ? createCascadedShadows({ count: cascades }) : null, skyOpenness, fogSkyVisibility,
  });
  attachWaterReflection(renderer, reflecting.surface);
  if (water === 'ssr') {
    attachScreenSpaceWater(renderer, parts);
  }
  return renderer;
}

// Probes are traced from the original parts and placed on whichever parts the scene draws (baked or not). An open scene has
// no automatic probe, so these name one by hand.
const PROBE_SPECIFICATIONS = { 'material-spheres': [{ position: [0, 1.6, 0] }], metal: [{ position: [0.2, 1, 0.9] }] };

async function probeScene(scene, id, drawnParts, mode) {
  const { placeProbes, traceObjectProbes, traceProbes } = await import('/src/reflection-probes.js');
  const { pointLights, keyColor, lightDirection, map } = scene.environment;
  const started = performance.now();
  const lighting = { pointLights, keyColor, lightDirection };
  const options = { environment: scene.environment, environmentMap: map, rotation: map?.rotation ?? 0 };
  const trace = mode === 'objects' ? traceObjectProbes(scene.parts, lighting, options) : traceProbes(scene.parts, lighting, PROBE_SPECIFICATIONS[id] ?? 'room', options);
  const placed = placeProbes(drawnParts, trace, { rotation: map?.rotation ?? 0 });
  return { parts: placed.parts, report: placed.report, seconds: (performance.now() - started) / 1000 };
}

async function renderReferenceScene(id, { describe, ambientOcclusion = 0, ambientOcclusionRadius = 0.5, bake = null, cascades = 0, backgroundOnly = false, probes = false, ambient = null, fill = null }) {
  const scene = await SCENES[id]();
  // A measurement switch: 0 removes the world's light from every surface, to show how much of a picture comes from it.
  if (ambient !== null) scene.environment = { ...scene.environment, ambientIntensity: ambient };
  if (fill !== null) scene.environment = { ...scene.environment, fillIntensity: fill };
  const baked = bake ? await bakeScene(scene, bake) : null;
  const probed = probes ? await probeScene(scene, id, baked ? baked.parts : scene.parts, probes) : null;
  const canvas = document.querySelector('canvas');
  // backgroundOnly draws the sky alone, so a score can be limited to the pixels the asset covers.
  const renderer = createSceneRenderer(backgroundOnly ? [] : probed ? probed.parts : baked ? baked.parts : scene.parts, scene, cascades);
  renderer.resize();
  const frame = { ...scene.camera, environment: scene.environment, time: 0, exposure: 1, effects: { ambientOcclusion, ambientOcclusionRadius } };
  renderer.render(frame);
  renderer.render(frame);
  const debug = renderer.context.getExtension('WEBGL_debug_renderer_info');
  const result = {
    image: canvas.toDataURL('image/png').split(',')[1],
    glError: renderer.context.getError(),
    graphics: renderer.context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : renderer.context.RENDERER),
    description: describe ? describeScene(id, scene) : null,
    bake: baked ? { seconds: baked.seconds, report: baked.report } : null,
    probes: probed ? { seconds: probed.seconds, report: probed.report } : null,
  };
  renderer.dispose();
  return result;
}

// Frame time of one scene with and without the light bake: a bake only adds an emissive map to each part, so this shows what it costs to draw.
async function measureReferenceFrameTime(id, { bake, probes = false, cascades = 0, orbit = false, water = WATER_REFLECTION, glowMipChain = true, warmupFrames = 20, measuredFrames = 200 }) {
  const scene = await SCENES[id]();
  const baked = bake ? await bakeScene(scene, {}) : null;
  const probed = probes ? await probeScene(scene, id, baked ? baked.parts : scene.parts, probes) : null;
  const renderer = createSceneRenderer(probed ? probed.parts : baked ? baked.parts : scene.parts, scene, cascades, { water });
  renderer.resize();
  const frame = { ...scene.camera, environment: scene.environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0, ambientOcclusionRadius: 0.5 } };
  // With orbit the camera moves a little every frame, so cascaded maps have to be redrawn each time, as in a camera move.
  const orbitedEye = index => [scene.camera.eye[0] + Math.sin(index * 0.05) * 0.5, scene.camera.eye[1], scene.camera.eye[2]];
  // finish() returns before a hardware GPU is done, so reading one pixel back is what waits for the frame.
  const pixel = new Uint8Array(4);
  const finishDrawing = () => renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  for (let index = 0; index < warmupFrames; index++) {
    renderer.render(orbit ? { ...frame, eye: orbitedEye(index) } : frame);
    finishDrawing();
  }
  // glowMipChain false stops the fog from rebuilding the frame's mip chain after warm-up. The mips stay as the last warm-up frame
  // left them, so sampling costs the same and the difference is the cost of generating them.
  if (!glowMipChain) {
    renderer.context.generateMipmap = () => {};
  }
  const frameMilliseconds = [];
  for (let index = 0; index < measuredFrames; index++) {
    const started = performance.now();
    renderer.render(orbit ? { ...frame, eye: orbitedEye(index) } : frame);
    finishDrawing();
    frameMilliseconds.push(performance.now() - started);
  }
  renderer.dispose();
  frameMilliseconds.sort((first, second) => first - second);
  const total = frameMilliseconds.reduce((sum, value) => sum + value, 0);
  return { baked: Boolean(bake), probes: Boolean(probes), water, glowMipChain, frames: measuredFrames, meanMilliseconds: total / measuredFrames,
    medianMilliseconds: frameMilliseconds[Math.floor(measuredFrames / 2)], p95Milliseconds: frameMilliseconds[Math.floor(measuredFrames * 0.95)] };
}

window.measureReferenceFrameTime = measureReferenceFrameTime;

async function renderReferencePathTraced(id, options) {
  const scene = await REFERENCE_SCENES[id]();
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const result = await renderPathTracedImage({ parts: applyLightLinks(scene.parts, scene.environment), environment: scene.environment, camera: scene.camera }, options);
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  canvas.getContext('2d').putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  return { image: canvas.toDataURL('image/png').split(',')[1], report: result.report };
}

window.renderReferenceScene = renderReferenceScene;
window.renderReferencePathTraced = renderReferencePathTraced;
window.referenceSceneIds = Object.keys(SCENES);
