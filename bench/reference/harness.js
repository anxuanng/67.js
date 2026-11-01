// Runs in the page: draws one reference scene, and describes it as plain data for Blender.
import { Renderer67 } from '/src/renderer.js';
import { REFERENCE_SCENES, KHRONOS_SCENES, CLOTH_SCENES } from './scenes.js';
import { skinnedGeometry } from '/src/path-tracer-scene.js';
import { boxProjectedGeometry } from '/src/export-box-uv.js';
import '/src/material-layer-shaders.js';
import { createCascadedShadows } from '/src/cascaded-shadows.js';
import { applyLightLinks } from '/src/light-linking.js';

// ?set=khronos draws the Khronos sample assets (npm run reference -- --khronos) and ?set=cloth the cloth scenes
// (npm run reference -- --cloth) instead of the fixed scenes.
const SCENE_SETS = { khronos: KHRONOS_SCENES, cloth: CLOTH_SCENES };
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

function plainData(value) {
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, base64: encodeBytes(value) };
  if (value instanceof ImageData) return { width: value.width, height: value.height, data: plainData(value.data) };
  if (Array.isArray(value)) return value.map(plainData);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'function') result[key] = plainData(entry);
    }
    return result;
  }
  return value;
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
  const describedParts = scene.parts.map(part => {
    const geometry = part.skin ? skinnedGeometry(part) : boxProjectedFor(part, boxProjected);
    if (!geometries.has(geometry)) geometries.set(geometry, geometries.size);
    return { name: part.name, geometry: geometries.get(geometry), matrix: [...part.matrix], material: plainData(part.material) };
  });
  return {
    id, camera: scene.camera, environment, world: scene.blenderWorld, blenderCloth: scene.blenderCloth,
    parts: describedParts,
    geometries: [...geometries.keys()].map(({ positions, normals, uvs, colors, indices }) => plainData({ positions, normals, uvs, colors, indices })),
  };
}

// Blender always gets the original parts: the bake is 67js's approximation of what Cycles computes.
async function bakeScene(scene, bakeOptions) {
  const { bakeLightmaps } = await import('/src/light-bake.js');
  const { pointLights, keyColor, lightDirection } = scene.environment;
  const started = performance.now();
  const baked = bakeLightmaps(scene.parts, { pointLights, keyColor, lightDirection }, bakeOptions);
  return { parts: baked.parts, report: baked.report, seconds: (performance.now() - started) / 1000 };
}

// The 67js renderer for a scene: light linking from the lights' affects lists, and cascaded sun shadows when asked for.
function createSceneRenderer(parts, scene, cascades) {
  return new Renderer67(document.querySelector('canvas'), applyLightLinks(parts, scene.environment), {
    ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true,
    environment: scene.environment, shadowBounds: scene.shadow, shadowCascades: cascades ? createCascadedShadows({ count: cascades }) : null,
  });
}

// Probes are traced from the original parts and placed on whichever parts the scene draws (baked or not). An open scene has
// no automatic probe, so these name one by hand.
const PROBE_SPECIFICATIONS = { 'material-spheres': [{ position: [0, 1.6, 0] }], metal: [{ position: [0.2, 1, 0.9] }] };

async function probeScene(scene, id, drawnParts) {
  const { placeProbes, traceProbes } = await import('/src/reflection-probes.js');
  const { pointLights, keyColor, lightDirection, map } = scene.environment;
  const started = performance.now();
  const lighting = { pointLights, keyColor, lightDirection };
  const trace = traceProbes(scene.parts, lighting, PROBE_SPECIFICATIONS[id] ?? 'room', { environment: scene.environment, environmentMap: map, rotation: map.rotation });
  const placed = placeProbes(drawnParts, trace, { rotation: map.rotation });
  return { parts: placed.parts, report: placed.report, seconds: (performance.now() - started) / 1000 };
}

async function renderReferenceScene(id, { describe, ambientOcclusion = 0, ambientOcclusionRadius = 0.5, bake = null, cascades = 0, backgroundOnly = false, probes = false }) {
  const scene = await SCENES[id]();
  const baked = bake ? await bakeScene(scene, bake) : null;
  const probed = probes ? await probeScene(scene, id, baked ? baked.parts : scene.parts) : null;
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
async function measureReferenceFrameTime(id, { bake, probes = false, cascades = 0, orbit = false, warmupFrames = 20, measuredFrames = 200 }) {
  const scene = await REFERENCE_SCENES[id]();
  const baked = bake ? await bakeScene(scene, {}) : null;
  const probed = probes ? await probeScene(scene, id, baked ? baked.parts : scene.parts) : null;
  const renderer = createSceneRenderer(probed ? probed.parts : baked ? baked.parts : scene.parts, scene, cascades);
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
  return { baked: Boolean(bake), probes: Boolean(probes), frames: measuredFrames, meanMilliseconds: total / measuredFrames,
    medianMilliseconds: frameMilliseconds[Math.floor(measuredFrames / 2)], p95Milliseconds: frameMilliseconds[Math.floor(measuredFrames * 0.95)] };
}

window.measureReferenceFrameTime = measureReferenceFrameTime;

async function renderReferencePathTraced(id, options) {
  const scene = await REFERENCE_SCENES[id]();
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const result = await renderPathTracedImage({ parts: scene.parts, environment: scene.environment, camera: scene.camera }, options);
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  canvas.getContext('2d').putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  return { image: canvas.toDataURL('image/png').split(',')[1], report: result.report };
}

window.renderReferenceScene = renderReferenceScene;
window.renderReferencePathTraced = renderReferencePathTraced;
window.referenceSceneIds = Object.keys(SCENES);
