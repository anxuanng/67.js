import { buildWithKernels, kernelWorkersAvailable, kernelStats, resetKernelStats } from '../src/kernel-offload.js';
import { createAgentScene, loadAllAgentSceneModules, allAgentSceneModulesLoaded, needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader, needsPhysics, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader } from '../src/agent-scene.js';
import { Renderer67 } from '../src/renderer.js';
import { skyOpenness } from '../src/closed-room.js';
import { fogSkyVisibility } from '../src/fog-sky-visibility.js';
import { installCameraEffects } from '../src/camera-effects.js';
import { installRenderPasses } from '../src/render-passes.js';
import { installCoplanarDiagnostics } from '../src/coplanar-overlap.js';
import { applyProjection } from '../src/camera.js';
import { mat4 } from 'gl-matrix';
import { resolveAgentShadow, agentEnvironmentMap } from '../src/agent-look.js';
import { agentSceneModule } from '../src/agent-scene-modules.js';
import { agentGroundPlacement, createAgentGround, placeAgentGround, FLOOR_COLOR } from '../src/agent-ground.js';
import { groundBounceEnvironment } from '../src/ground-bounce.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';
import { exportGlb } from '../src/export.js';
import { weightTracksFromGltfAnimation } from '../src/export-skeleton.js';
import { clipFromGltfAnimation } from '../src/skeleton-pose.js';
import { sessionProblem } from '../src/agent-errors.js';
import { BRANCH_LIMITS, createBranchStore, printableLabel } from '../src/agent-branches.js';

let active = null;
let canvas = document.querySelector('canvas');

function requireSession(sessionId) {
  if (!active || active.sessionId !== sessionId) {
    throw new Error(sessionProblem(sessionId, active?.sessionId));
  }
  return active;
}

function validatePreviewCamera(camera) {
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  for (const aspect of [1 / 16, 16]) {
    const projection = applyProjection(mat4.create(), camera, aspect);
    const viewProjection = mat4.multiply(mat4.create(), projection, view);
    if (![projection, viewProjection].every(matrix => matrix.every(Number.isFinite))) {
      throw new RangeError('Camera matrices must remain finite for all supported preview aspect ratios.');
    }
  }
}

function candidateCamera(record, operations) {
  const camera = record.scene.exportRecipe().camera;
  for (const operation of operations) {
    if (operation.type === 'set-camera') {
      for (const field of ['eye', 'target', 'up', 'fov', 'near', 'far']) {
        if (Object.hasOwn(operation, field)) {
          camera[field] = operation[field];
        }
      }
    }
  }
  return createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], camera }).camera;
}

function renderInfo(renderer) {
  const context = renderer.context;
  const debug = context.getExtension('WEBGL_debug_renderer_info');
  return {
    graphics: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
    estimatedBytes: renderer.memoryPlan.estimatedBytes,
    width: canvas.width,
    height: canvas.height,
    samples: renderer.capabilities.samples,
    hdr: renderer.capabilities.hdr,
    depth: renderer.depth,
    geometryBuffers: renderer.geometryBuffers?.size ?? 0,
    materialTextures: renderer.textures ? [...renderer.textures.keys()].filter(Boolean).length : 0,
    skinTextures: renderer.skinTextures?.size ?? 0,
    morphTextures: renderer.morphTextures?.size ?? 0,
    gpuBuffers: renderer.buffers?.length ?? 0,
    drawBatches: renderer.batches?.length ?? 0,
    ...(renderer.diagnostics?.length ? { diagnostics: renderer.diagnostics } : {}),
  };
}

function hasPatternTextures(parts) {
  return parts.some(part => part.material.boxMapScale || part.material.emissiveMap);
}

// replaceParts streams only untextured parts, so a topology change around pattern textures takes a new renderer.
function rebuildRenderer(record) {
  record.renderer.dispose();
  record.renderer = null;
  resetCanvas();
  record.renderer = initializeRenderer(record.scene, record.options);
  record.shadowKey = null;
}

// The automatic floor (src/agent-ground.js) follows the scene's lowest geometry. A renderer gains or loses it only
// through a new renderer, so a floor that appears or disappears (a part now forms one, or environment.ground changed) rebuilds.
function syncAutomaticGround(record) {
  const placement = agentGroundPlacement(record.scene.parts, record.scene.environment);
  if (Boolean(placement) !== Boolean(record.renderer.groundPart)) {
    rebuildRenderer(record);
    record.renderer.resize();
    return;
  }
  if (placement) {
    placeAgentGround(record.renderer.groundPart, placement);
    record.renderer.updateParts([...record.scene.parts, record.renderer.groundPart]);
  }
}

// The scene's environment lit by the sky map, with the light its floor bounces (src/ground-bounce.js): a floor part of the
// recipe gives its own colour, and the automatic floor gives its own.
function litEnvironment(parts, environment, hasAutomaticGround) {
  return groundBounceEnvironment(parts, { ...environment, map: agentEnvironmentMap(environment) }, { automaticAlbedo: hasAutomaticGround ? FLOOR_COLOR : null });
}

// A renderer takes its cascades at construction, so a change of the count (or of the extent that picks it) rebuilds.
function syncShadowCascades(record) {
  const count = cascadeCountFor(record.scene);
  if (count !== (record.renderer.shadowCascades?.count ?? 0)) {
    rebuildRenderer(record);
    record.renderer.resize();
  }
}

function draw(record, time = 0, camera = record.scene.camera, frameOptions = {}) {
  if (!record.renderer) throw new Error('The scene renderer is leased to a render job.');
  if (record.renderer.context.isContextLost()) {
    throw new Error('The render context was lost. Export the recipe and dispose this session.');
  }
  // Shrink the existing target first so a smaller look can recover a staging-budget failure.
  record.renderer.resize();
  if (record.rendererTopology !== record.scene.topologyRevision) {
    const textured = hasPatternTextures(record.scene.parts);
    // replaceParts refuses skinned and morphed parts, so an edited imported part takes a new renderer as well.
    if (textured || record.rendererTextured || record.asset) {
      rebuildRenderer(record);
    } else {
      record.renderer.replaceParts(record.scene.parts);
    }
    record.rendererTextured = textured;
    record.rendererTopology = record.scene.topologyRevision;
    record.renderer.resize();
  } else {
    record.renderer.updateParts(record.scene.parts);
  }
  syncAutomaticGround(record);
  syncShadowCascades(record);
  const environment = record.scene.environment;
  const effects = record.scene.effects;
  const shadow = record.scene.shadow;
  const shadowKey = JSON.stringify([environment.lightDirection, shadow]);
  if (record.shadowKey !== shadowKey) {
    record.renderer.shadowBounds = resolveAgentShadow(shadow, environment.lightDirection);
    record.renderer.shadowsDirty = true;
    record.shadowKey = shadowKey;
  }
  record.renderer.world = environment.world;
  record.renderer.render({ ...camera, environment: litEnvironment(record.scene.parts, environment, Boolean(record.renderer.groundPart)), effects, exposure: effects.exposure, time, lines: environment.lines, ...frameOptions });
  const error = record.renderer.context.getError();
  if (error !== 0) {
    throw new Error(`WebGL render failed with error ${error}.`);
  }
}

function status(record) {
  const render = renderInfo(record.renderer);
  record.lastRender = render;
  return {
    sessionId: record.sessionId,
    revision: record.scene.revision,
    topologyRevision: record.scene.topologyRevision,
    inspection: record.scene.inspect(),
    render,
  };
}

function mutationStatus(record) {
  try {
    draw(record);
    return { ...status(record), committed: true, renderSucceeded: true };
  } catch (error) {
    return {
      sessionId: record.sessionId,
      revision: record.scene.revision,
      inspection: record.scene.inspect(),
      render: record.lastRender ?? null,
      committed: true,
      renderSucceeded: false,
      renderError: error.message,
    };
  }
}

// Draw the part labels onto a copy of the frame, so the preview canvas itself stays unmarked.
function labeledPng(labels) {
  if (!labels) return canvas.toDataURL('image/png').split(',')[1];
  const composed = document.createElement('canvas');
  composed.width = canvas.width;
  composed.height = canvas.height;
  const context = composed.getContext('2d');
  context.drawImage(canvas, 0, 0);
  paintLabels(context, labels, 0, 0);
  return composed.toDataURL('image/png').split(',')[1];
}

function resetCanvas() {
  canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  const replacement = document.createElement('canvas');
  canvas.replaceWith(replacement);
  canvas = replacement;
}

// The cascade code is a loaded module, so a scene with one shadow map never runs it.
function cascadeCountFor(scene) {
  return agentSceneModule('cascades').effectiveShadowCascades(scene.environment, scene.shadow);
}

function cascadesFor(scene) {
  const count = cascadeCountFor(scene);
  return count > 0 ? agentSceneModule('cascades').createCascadedShadows({ count }) : null;
}

function initializeRenderer(scene, { memoryBudgetMiB, backend }) {
  const placement = agentGroundPlacement(scene.parts, scene.environment);
  const renderer = installCoplanarDiagnostics(installRenderPasses(installCameraEffects(new Renderer67(canvas, scene.parts, {
    ground: placement ? createAgentGround(placement) : false,
    hdr: true,
    depth: true,
    world: scene.environment.world,
    environment: litEnvironment(scene.parts, scene.environment, Boolean(placement)),
    shadowBounds: resolveAgentShadow(scene.shadow, scene.environment.lightDirection),
    shadowCascades: cascadesFor(scene),
    skyOpenness,
    fogSkyVisibility,
    pixelRatio: 1,
    samples: backend === 'cpu' ? 1 : 4,
    memoryBudgetMiB,
  }))));
  // Outlines, toon light and polylines draw only for a frame that carries environment.lines.
  return agentSceneModule('lineArt').installLineArt(renderer);
}

// Camera fields from a timeline shot on top of the sampled camera, checked with the scene's own camera rules.
function withCameraOverrides(camera, overrides) {
  const merged = createAgentScene({ format: '67js.scene', schemaVersion: 1,
    geometries: [], materials: [], nodes: [], camera: { ...camera, ...overrides } }).camera;
  validatePreviewCamera(merged);
  return merged;
}

// The camera at the start of the shutter interval, sampled from time so the same seek always gives the same blur.
function previousCameraFor(record, motionTime) {
  const shutter = record.scene.effects.motionBlur.shutter;
  if (shutter <= 0 || motionTime === undefined || record.asset) return undefined;
  record.scene.sampleMotion(Math.max(0, motionTime - shutter));
  const previousCamera = record.scene.camera;
  record.scene.sampleMotion(motionTime);
  return previousCamera;
}

function createPreview(scene, { sessionId, memoryBudgetMiB, backend }, asset) {
  if (active) {
    throw new Error('Dispose the current scene before creating another.');
  }
  validatePreviewCamera(scene.camera);
  let renderer;
  try {
    renderer = initializeRenderer(scene, { memoryBudgetMiB, backend });
    const record = { scene, renderer, asset, sessionId, options: { memoryBudgetMiB, backend },
      checkpoints: new Map(), branches: createBranchStore(), rendererTopology: scene.topologyRevision, rendererTextured: hasPatternTextures(scene.parts) };
    draw(record);
    const result = status(record);
    if (backend === 'gpu' && /swiftshader|llvmpipe|software/i.test(result.render.graphics)) {
      throw new Error('Hardware GPU rendering was requested, but the browser selected a software renderer.');
    }
    active = record;
    return result;
  } catch (error) {
    renderer?.dispose();
    // A throwing constructor may already own GPU objects without returning an instance.
    resetCanvas();
    throw error;
  }
}

// Manifold is an optional peer dependency; the runtime serves it from the host's node_modules on this origin.
setManifoldModuleLoader(() => import(/* @vite-ignore */ new URL('/vendor/manifold.js', location.href).href));
// Rapier is the same kind of optional peer: its WASM travels inside the module served from /vendor/rapier.js.
setPhysicsModuleLoader(() => import(/* @vite-ignore */ new URL('/vendor/rapier.js', location.href).href));

// The preview bundle is one file, so the on-demand scene modules load together on the first call and later calls stay
// synchronous. The boolean engine is WebAssembly and loads asynchronously, once, only for calls that need it.
function afterMeshBooleans(value, run) {
  if (!allAgentSceneModulesLoaded()) return loadAllAgentSceneModules().then(() => afterMeshBooleans(value, run));
  const loads = [];
  if (!meshBooleansLoaded() && needsMeshBooleans(value)) loads.push(loadMeshBooleans());
  if (!physicsEngineLoaded() && needsPhysics(value)) loads.push(loadPhysicsEngine());
  if (!loads.length) return run();
  return Promise.all(loads).then(run);
}

// Heavy kernels (light bake, cloth, uv_unwrap, pattern textures) compute on a worker while the page stays responsive;
// the scene is built from the same bytes as on one thread. Reading each part's maps here makes pattern bakes run in the
// same pass, so the renderer later finds them baked.
// Where the work ran, for scene_inspect: kernels served by the worker and run inline (with the reason for any
// fallback), the time of the last scene build, and the longest main-thread task the browser reported since then.
// Long tasks are those over 50 ms, so 0 means none that long.
const longTaskObserver = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ? new PerformanceObserver(() => {})
  : null;
longTaskObserver?.observe({ type: 'longtask' });
const buildReport = { buildMilliseconds: 0, longestBlockMilliseconds: 0, longestLongTaskMilliseconds: 0, longTasks: 0 };

// The long task API skips work run by a remote-debugging call, so a timer also measures how long the page stayed
// unresponsive: the longest delay of a 20 ms tick is the longest stretch the main thread was busy.
const HEARTBEAT_MILLISECONDS = 20;
let lastHeartbeat = performance.now();
setInterval(() => {
  const now = performance.now();
  buildReport.longestBlockMilliseconds = Math.max(buildReport.longestBlockMilliseconds, Math.round(now - lastHeartbeat - HEARTBEAT_MILLISECONDS));
  lastHeartbeat = now;
}, HEARTBEAT_MILLISECONDS);

function drainLongTasks() {
  for (const entry of longTaskObserver?.takeRecords() ?? []) {
    buildReport.longTasks++;
    buildReport.longestLongTaskMilliseconds = Math.max(buildReport.longestLongTaskMilliseconds, Math.round(entry.duration));
  }
}

function startBuildReport() {
  drainLongTasks();
  Object.assign(buildReport, { buildMilliseconds: 0, longestBlockMilliseconds: 0, longestLongTaskMilliseconds: 0, longTasks: 0 });
  lastHeartbeat = performance.now();
  resetKernelStats();
}

function finishBuildReport(startedAt) {
  buildReport.buildMilliseconds = Math.round(performance.now() - startedAt);
}

function kernelReport() {
  drainLongTasks();
  return { ...kernelStats(), ...buildReport };
}

// The runtime can switch workers off (createAgentRuntime kernelWorkers: false) to measure what they buy.
function useKernelWorkers() {
  return kernelWorkersAvailable() && globalThis.__67jsKernelWorkers !== 'off';
}

function buildSceneOffMainThread(recipe) {
  return buildWithKernels(() => {
    const scene = createAgentScene(recipe);
    for (const part of scene.parts) {
      void part.material.map;
    }
    return scene;
  });
}

function seekForExport(record, motionTime) {
  if (record.asset) record.scene.sampleFrame({ motionTime });
  else record.scene.sampleMotion(motionTime);
}

// The scene's parts already carry the current pose, including IK and node overrides, so skinned parts export it as is.
function posedExport(record) {
  const rig = record.scene.rigExport?.() ?? { nodes: [], clips: [] };
  return { parts: record.scene.parts.map(withoutRoundoffShear), options: rig.nodes.length ? rig : {} };
}

// Chains of bone transforms leave world matrices with Float32 roundoff that the exporter reads as shear. Real shear
// (dot products above the tolerance) still reaches the exporter and fails there.
const ROUNDOFF_SHEAR_LIMIT = 1e-3;

function withoutRoundoffShear(part) {
  if (part.skin) return part;
  const columns = [0, 4, 8].map(offset => {
    const column = [part.matrix[offset], part.matrix[offset + 1], part.matrix[offset + 2]];
    const length = Math.hypot(...column);
    return length === 0 ? column : column.map(value => value / length);
  });
  const dots = [[0, 1], [0, 2], [1, 2]].map(([first, second]) => Math.abs(columns[first].reduce((sum, value, axis) => sum + value * columns[second][axis], 0)));
  if (Math.max(...dots) > ROUNDOFF_SHEAR_LIMIT) return part;
  const scale = mat4.getScaling([0, 0, 0], part.matrix);
  const rotation = mat4.getRotation([0, 0, 0, 1], part.matrix);
  const translation = mat4.getTranslation([0, 0, 0], part.matrix);
  return { ...part, matrix: mat4.fromRotationTranslationScale(mat4.create(), rotation, translation, scale) };
}

// A source clip animates the source skeleton, so the scene must not carry a pose of its own that the clip would fight.
function clipExport(record, clipIndex) {
  const { asset, scene } = record;
  if (!asset) throw new Error('clip needs an imported asset scene. Recipe scenes export their current pose.');
  const animation = asset.animations[clipIndex];
  if (!animation) throw new RangeError(`clip ${clipIndex} does not exist. The asset has ${asset.animations.length} clips.`);
  const recipe = scene.exportRecipe();
  if (recipe.animation || recipe.nodeOverrides.length || recipe.motion) {
    throw new Error('Exporting a clip needs the unposed asset: remove animation, node overrides and motion first, or export without clip for the current pose.');
  }
  const sourceClip = clipFromGltfAnimation(animation);
  const name = String(animation.name || `clip ${clipIndex}`);
  const clip = { ...sourceClip, name, tracks: [...sourceClip.tracks, ...weightTracksFromGltfAnimation(animation)] };
  // Edited parts export their edited geometry on the source part's own matrix, skin and morph.
  const parts = asset.parts.map((part, index) => scene.parts[index].geometry === part.geometry ? part : { ...part, geometry: scene.parts[index].geometry });
  return { parts, options: { nodes: asset.nodes, clips: [clip] } };
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// The feature images of the last denoise "oidn" trace, kept until finishPathTrace draws it.
let tracedFeatures;

function encodeTracedPng(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// The review grid outlives the private scenes drawn into it, because each branch in a review is its own scene.
let reviewGrid;

function projectToScreen(matrix, point, width, height) {
  const [x, y, z] = point;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!(clipW > 0)) return null;
  const normalizedX = clipX / clipW;
  const normalizedY = clipY / clipW;
  if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) return null;
  return { x: Math.round((normalizedX * 0.5 + 0.5) * width), y: Math.round((1 - (normalizedY * 0.5 + 0.5)) * height) };
}

function meshProblemsByGeometry(scene, geometryIds) {
  const result = new Map();
  if (typeof scene.inspectMeshes !== 'function' || geometryIds.length === 0) return result;
  const { meshes } = scene.inspectMeshes({ geometries: geometryIds.slice(0, 16) });
  for (const mesh of meshes) {
    const faceTags = Array.isArray(mesh.tags) ? mesh.tags : Object.keys(mesh.tags ?? {});
    result.set(mesh.geometry, { problems: mesh.problems.map(problem => problem.kind), faceTags: faceTags.slice(0, 6) });
  }
  return result;
}

/** Name, material tag, face tags and lint problems of the visible parts, with the pixel they project to. */
function collectLabels(record, camera, width, height) {
  const { scene } = record;
  // Mesh reports of an imported asset are keyed by part ID (mesh-0); a recipe's are keyed by geometry ID.
  const meshKeyOf = node => record.asset ? node.id : node.geometry;
  const nodes = scene.inspect({ includeBounds: true }).nodes.filter(node => node.bounds);
  // An imported asset's recipe has no materials list: its parts carry no tags.
  const materialTags = new Map((scene.exportRecipe().materials ?? []).map(material => [material.id, material.tag]));
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  const matrix = mat4.multiply(mat4.create(), applyProjection(mat4.create(), camera, width / height), view);
  const geometryIds = [...new Set(nodes.map(meshKeyOf))];
  const meshInfo = meshProblemsByGeometry(scene, geometryIds);
  const labels = [];
  for (const node of nodes) {
    const center = [0, 1, 2].map(axis => (node.bounds.min[axis] + node.bounds.max[axis]) / 2);
    const position = projectToScreen(matrix, center, width, height);
    if (!position || labels.length >= BRANCH_LIMITS.maximumLabels) continue;
    const mesh = meshInfo.get(meshKeyOf(node));
    labels.push({ id: node.id, name: printableLabel(node.label), tag: materialTags.get(node.material) ?? null,
      faceTags: mesh?.faceTags ?? [], problems: mesh?.problems ?? [], x: position.x, y: position.y });
  }
  return labels;
}

function paintLabels(context, labels, offsetX, offsetY) {
  context.font = '11px sans-serif';
  context.textBaseline = 'middle';
  for (const label of labels) {
    const text = [label.name, label.tag === 'surface' ? null : label.tag,...(label.problems.length ? [`! ${label.problems.join(',')}`] : [])].filter(Boolean).join(' ');
    const x = offsetX + label.x;
    const y = offsetY + label.y;
    context.fillStyle = label.problems.length ? '#ff8a65' : '#ffe082';
    context.fillRect(x - 2, y - 2, 4, 4);
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(16,20,22,0.85)';
    context.strokeText(text, x + 5, y);
    context.fillText(text, x + 5, y);
  }
}

window.__agentPreview = {
  reviewBegin({ width, height }) {
    reviewGrid = document.createElement('canvas');
    reviewGrid.width = width;
    reviewGrid.height = height;
    const context = reviewGrid.getContext('2d');
    context.fillStyle = '#202428';
    context.fillRect(0, 0, width, height);
    return { width, height };
  },
  reviewShot({ sessionId, shot, index, width, height, columns, labels: withLabels = false }) {
    const record = requireSession(sessionId);
    const recipe = record.scene.exportRecipe();
    const animation = shot.animation ?? recipe.animation ?? null;
    if (record.asset) {
      record.scene.sampleFrame({ animation, motionTime: shot.motionTime });
    } else {
      if (shot.animation !== undefined) throw new RangeError('Imported animation requires an asset scene.');
      record.scene.sampleMotion(shot.motionTime);
    }
    const camera = createAgentScene({ format: '67js.scene', schemaVersion: 1,
      geometries: [], materials: [], nodes: [], camera: { ...record.scene.camera, ...shot.camera } }).camera;
    validatePreviewCamera(camera);
    draw(record, shot.rendererTime, camera);
    const render = renderInfo(record.renderer);
    if (render.width < 64 || render.height < 64) throw new Error('Render budget reduced review below its minimum output size.');
    const context = reviewGrid.getContext('2d');
    const x = index % columns * width;
    const y = Math.floor(index / columns) * (height + 24);
    context.drawImage(canvas, x, y + 24, width, height);
    context.fillStyle = '#e4e7e9';
    context.font = '12px sans-serif';
    context.textBaseline = 'middle';
    context.fillText(shot.label.replace(/[\r\n\t]/g, ' '), x + 8, y + 12, width - 16);
    const labels = withLabels ? collectLabels(record, camera, width, height) : undefined;
    if (labels) paintLabels(context, labels, x, y + 24);
    return { label: shot.label, camera, animation: record.asset ? animation : null,
      motionTime: record.scene.motionTime ?? null, rendererTime: shot.rendererTime,
      requestedWidth: width, requestedHeight: height, ...render, ...(labels ? { labels } : {}) };
  },
  reviewResult() {
    return { data: reviewGrid.toDataURL('image/png').split(',')[1], mimeType: 'image/png' };
  },
  snapshot({ sessionId, expectedRevision }) {
    const record = requireSession(sessionId);
    if (record.scene.revision !== expectedRevision) throw new Error('Stale revision for render snapshot.');
    return { sourceRevision: record.scene.revision, recipe: record.scene.exportRecipe(),
      clips: record.asset?.animations.map(clip => ({ duration: clip.duration })) ?? [] };
  },
  suspend({ sessionId }) {
    const record = requireSession(sessionId);
    if (!record.renderer) throw new Error('Scene renderer is already suspended.');
    record.renderer.dispose();
    record.renderer = null;
    resetCanvas();
    return { sessionId, revision: record.scene.revision, suspended: true };
  },
  resume({ sessionId }) {
    const record = requireSession(sessionId);
    if (record.renderer) throw new Error('Scene renderer is already active.');
    try {
      record.renderer = initializeRenderer(record.scene, record.options);
      record.rendererTopology = record.scene.topologyRevision;
      record.rendererTextured = hasPatternTextures(record.scene.parts);
      record.shadowKey = null;
      draw(record);
      return status(record);
    } catch (error) {
      record.renderer?.dispose();
      record.renderer = null;
      resetCanvas();
      throw error;
    }
  },
  // `pass` draws one render pass instead of the lit image. Object ID frames also list the part behind each ID.
  // `camera` overrides camera fields and `depthOfField` the blur and focus distance (a timeline shot); `brightness` scales exposure for a dip through black.
  frame({ sessionId, animation, motionTime, rendererTime = 0, pass, passDepthRange, camera: cameraOverrides, depthOfField: depthOfFieldOverrides, brightness = 1 }) {
    const record = requireSession(sessionId);
    if (!Number.isFinite(brightness) || brightness < 0 || brightness > 1) throw new RangeError('Invalid frame brightness.');
    if (!Number.isFinite(rendererTime) || rendererTime < 0 || rendererTime > 3600) throw new RangeError('Invalid render time.');
    if (record.asset && (animation !== undefined || motionTime !== undefined)) {
      record.scene.sampleFrame({ ...(animation === undefined ? {} : { animation }),
        ...(motionTime === undefined ? {} : { motionTime }) });
    } else if (motionTime !== undefined) {
      record.scene.sampleMotion(motionTime);
    }
    const shotCamera = cameraOverrides ? withCameraOverrides(record.scene.camera, cameraOverrides) : undefined;
    const sampledPreviousCamera = pass ? undefined : previousCameraFor(record, motionTime);
    const previousCamera = sampledPreviousCamera && cameraOverrides ? withCameraOverrides(sampledPreviousCamera, cameraOverrides) : sampledPreviousCamera;
    const exposure = record.scene.effects.exposure * brightness;
    const shotEffects = depthOfFieldOverrides
      ? { ...record.scene.effects, depthOfField: { ...record.scene.effects.depthOfField, ...depthOfFieldOverrides } }
      : undefined;
    draw(record, rendererTime, shotCamera, { pass, passDepthRange, previousCamera,
      ...(brightness === 1 ? {} : { exposure }), ...(shotEffects ? { effects: shotEffects } : {}) });
    const info = renderInfo(record.renderer);
    return pass === 'objectId' ? { ...info, objectNames: record.renderer.passSupport.objectNames() } : info;
  },
  // Offline path trace of the scene at one instant. The tracer loads here, on first use, and not with the preview.
  async pathTrace({ sessionId, animation, motionTime, options }) {
    const record = requireSession(sessionId);
    if (record.asset && (animation !== undefined || motionTime !== undefined)) {
      record.scene.sampleFrame({ ...(animation === undefined ? {} : { animation }),
        ...(motionTime === undefined ? {} : { motionTime }) });
    } else if (motionTime !== undefined) {
      record.scene.sampleMotion(motionTime);
    }
    const { renderPathTracedImage } = await import('../src/path-tracer.js');
    const environment = record.scene.environment;
    const result = await renderPathTracedImage({
      parts: record.scene.parts,
      environment: { ...environment, map: agentEnvironmentMap(environment) },
      camera: record.scene.camera,
    }, options);
    // An external denoiser (denoise "oidn") works on the traced features outside the page; finishPathTrace then draws its result.
    if (result.report.denoiser === 'oidn') {
      tracedFeatures = result.features;
      const features = {};
      for (const name of ['color', 'albedo', 'normal']) {
        const values = result.features[name];
        features[name] = bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      }
      return { features, report: result.report };
    }
    return { data: encodeTracedPng(result.rgba, result.width, result.height), report: result.report };
  },
  // The PNG of linear pixels (three floats each, base64) that a denoiser outside the page returned, or of the wavelet
  // filter over the kept features when none came back.
  async finishPathTrace({ width, height, linear }) {
    const { toneMapToRgba8 } = await import('../src/path-tracer.js');
    let pixels;
    if (linear) {
      const binary = atob(linear);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      pixels = new Float32Array(bytes.buffer);
    } else {
      const { denoiseRadiance } = await import('../src/path-tracer-denoise.js');
      pixels = denoiseRadiance({ width, height, ...tracedFeatures });
    }
    tracedFeatures = undefined;
    return { data: encodeTracedPng(toneMapToRgba8(pixels, width, height), width, height) };
  },
  create(input) {
    if (active) throw new Error('Dispose the current scene before creating another.');
    return afterMeshBooleans(input.recipe, () => {
      startBuildReport();
      const startedAt = performance.now();
      if (!useKernelWorkers()) {
        const scene = createAgentScene(input.recipe);
        finishBuildReport(startedAt);
        return createPreview(scene, input);
      }
      return buildSceneOffMainThread(input.recipe).then(scene => {
        finishBuildReport(startedAt);
        return createPreview(scene, input);
      });
    });
  },
  async createAsset(input) {
    if (active) throw new Error('Dispose the current scene before creating another.');
    let bytes;
    if (typeof Uint8Array.fromBase64 === 'function') {
      bytes = Uint8Array.fromBase64(input.data);
    } else {
      const binary = atob(input.data);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    }
    let asset;
    try {
      // Labels, mesh reports and motion read the on-demand modules on any asset, not only one with mesh edits.
      await loadAllAgentSceneModules();
      asset = await parseGltf(bytes.buffer, { maxBytes: 16 * 1024 * 1024, maxVertices: 250000, maxParts: 4096, maxTexturePixels: 4194304, maxJoints: 1024 });
      return createPreview(createAgentAssetScene(asset, input.recipe), input, asset);
    } catch (error) {
      asset?.dispose();
      throw error;
    }
  },
  inspect({ sessionId, ...options }) {
    return { sessionId, ...requireSession(sessionId).scene.inspect(options), kernels: kernelReport() };
  },
  inspectMeshes({ sessionId, ...options }) {
    const scene = requireSession(sessionId).scene;
    if (typeof scene.inspectMeshes !== 'function') {
      throw new TypeError('mesh_inspect needs a procedural recipe scene or an imported asset scene.');
    }
    if (!allAgentSceneModulesLoaded()) return loadAllAgentSceneModules().then(() => this.inspectMeshes({ sessionId, ...options }));
    return { sessionId, ...scene.inspectMeshes(options) };
  },
  apply(input) {
    return afterMeshBooleans(input.operations, () => this.applyLoaded(input));
  },
  applyLoaded({ sessionId, operations, expectedRevision }) {
    const record = requireSession(sessionId);
    validatePreviewCamera(candidateCamera(record, operations));
    let fogDensity = record.scene.environment.volumeFog.density;
    for (const operation of operations) {
      if (operation.type === 'set-environment' && Object.hasOwn(operation.environment?.volumeFog ?? {}, 'density')) {
        fogDensity = operation.environment.volumeFog.density;
      }
    }
    if (fogDensity > 0 && !record.renderer.capabilities.hdr) {
      throw new Error('Volumetric fog requires HDR support; this preview cannot enable it.');
    }
    record.scene.apply(operations, { expectedRevision });
    return mutationStatus(record);
  },
  editMesh({ sessionId, expectedRevision, geometry, edits, replace }) {
    const record = requireSession(sessionId);
    if (typeof record.scene.inspectMeshes !== 'function') {
      throw new TypeError('mesh_edit needs a procedural recipe scene or an imported asset scene.');
    }
    const operation = { type: 'edit-mesh', geometry, edits, ...(replace === undefined ? {} : { replace }) };
    return afterMeshBooleans(edits, () => {
      const status = this.applyLoaded({ sessionId, operations: [operation], expectedRevision });
      const [mesh] = record.scene.inspectMeshes({ geometries: [geometry] }).meshes;
      return { ...status, mesh };
    });
  },
  setMeshStack({ sessionId, expectedRevision, geometry, stack, apply }) {
    const record = requireSession(sessionId);
    if (typeof record.scene.inspectMeshes !== 'function' || record.asset) {
      throw new TypeError('mesh_stack supports procedural recipe scenes. Imported parts take mesh_edit with a mesh ID such as mesh-0.');
    }
    const operation = { type: 'set-mesh-stack', geometry, ...(stack === undefined ? {} : { stack }), ...(apply === undefined ? {} : { apply }) };
    const status = this.applyLoaded({ sessionId, operations: [operation], expectedRevision });
    const [mesh] = record.scene.inspectMeshes({ geometries: [geometry] }).meshes;
    return { ...status, mesh };
  },
  look({ sessionId, motionTime, labels: withLabels = false }) {
    const record = requireSession(sessionId);
    if (motionTime !== undefined) {
      if (typeof record.scene.sampleMotion !== 'function') {
        throw new RangeError('Procedural motion time is unavailable for imported assets.');
      }
      record.scene.sampleMotion(motionTime);
    }
    draw(record);
    const render = renderInfo(record.renderer);
    record.lastRender = render;
    const labels = withLabels ? collectLabels(record, record.scene.camera, canvas.width, canvas.height) : undefined;
    return {
      data: labeledPng(labels),
      mimeType: 'image/png',
      metadata: { sessionId, revision: record.scene.revision, topologyRevision: record.scene.topologyRevision,
        motionTime: record.scene.motionTime ?? null, ...render, ...(labels ? { labels } : {}) },
    };
  },
  checkpoint({ sessionId, checkpointId }) {
    const record = requireSession(sessionId);
    const handle = record.scene.checkpoint();
    record.checkpoints.set(checkpointId, { handle, fogDensity: record.scene.environment.volumeFog.density });
    return { sessionId, checkpointId, revision: record.scene.revision };
  },
  restore({ sessionId, checkpointId, expectedRevision }) {
    const record = requireSession(sessionId);
    if (!record.checkpoints.has(checkpointId)) {
      throw new Error('Unknown or released checkpoint.');
    }
    const checkpoint = record.checkpoints.get(checkpointId);
    if (checkpoint.fogDensity > 0 && !record.renderer.capabilities.hdr) {
      throw new Error('Volumetric fog requires HDR support; this preview cannot restore it.');
    }
    record.scene.restore(checkpoint.handle, { expectedRevision });
    return mutationStatus(record);
  },
  releaseCheckpoint({ sessionId, checkpointId }) {
    const record = requireSession(sessionId);
    if (!record.checkpoints.has(checkpointId)) {
      throw new Error('Unknown or released checkpoint.');
    }
    record.scene.releaseCheckpoint(record.checkpoints.get(checkpointId).handle);
    record.checkpoints.delete(checkpointId);
    return { sessionId, checkpointId, released: true };
  },
  /** Apply operations to a scratch copy and store the result as a branch. The source scene and its revision stay as they are. */
  branchApply({ sessionId, name, operations, expectedRevision }) {
    return afterMeshBooleans(operations, () => {
      const record = requireSession(sessionId);
      if (record.asset) throw new TypeError('Branches support procedural recipe scenes.');
      if (record.scene.revision !== expectedRevision) throw new Error('Stale revision for branch.');
      const baseRecipe = record.scene.exportRecipe();
      const scratch = createAgentScene(baseRecipe);
      validatePreviewCamera(candidateCamera(record, operations));
      scratch.apply(operations, { expectedRevision: scratch.revision });
      const { shared } = record.branches.fork(name, { recipe: scratch.exportRecipe(), baseRecipe, operations, baseRevision: expectedRevision });
      return { sessionId, branch: name, sourceRevision: record.scene.revision, shared,
        branches: record.branches.names(), snapshots: record.branches.snapshotCount() };
    });
  },
  branchRecipe({ sessionId, name }) {
    const record = requireSession(sessionId);
    const branch = record.branches.get(name);
    return { recipe: branch.recipe, stale: branch.baseKey !== JSON.stringify(record.scene.exportRecipe()) };
  },
  /** Keep one branch: replay its operations on the live scene (one revision), then drop every branch. */
  keepBranch({ sessionId, name, expectedRevision }) {
    const record = requireSession(sessionId);
    const branch = record.branches.get(name);
    if (branch.baseKey !== JSON.stringify(record.scene.exportRecipe())) {
      throw new Error(`The scene changed since branch ${name} was forked. Fork it again from the current revision.`);
    }
    const status = this.applyLoaded({ sessionId, operations: branch.operations, expectedRevision });
    record.branches.clear();
    return { ...status, kept: name };
  },
  exportRecipe({ sessionId }) {
    const record = requireSession(sessionId);
    return { sessionId, revision: record.scene.revision, recipe: record.scene.exportRecipe() };
  },
  exportGlb({ sessionId, clip, motionTime, maxTextureSize, maximumBytes }) {
    const record = requireSession(sessionId);
    if (motionTime !== undefined) seekForExport(record, motionTime);
    const { parts, options } = clip === undefined ? posedExport(record) : clipExport(record, clip);
    const binary = exportGlb(parts, { ...options, ...(maxTextureSize === undefined ? {} : { maxTextureSize }) });
    if (binary.byteLength > maximumBytes) {
      throw new RangeError(`The GLB is ${binary.byteLength} bytes, above the ${maximumBytes} byte limit. Lower maxTextureSize or simplify the scene.`);
    }
    return { sessionId, revision: record.scene.revision, bytes: binary.byteLength,
      parts: parts.length, clips: options.clips?.length ?? 0, data: bytesToBase64(new Uint8Array(binary)) };
  },
  dispose({ sessionId }) {
    const record = requireSession(sessionId);
    try {
      record.renderer?.dispose();
    } finally {
      record.asset?.dispose();
    }
    record.checkpoints.clear();
    record.branches.clear();
    active = null;
    return { sessionId, disposed: true };
  },
};
