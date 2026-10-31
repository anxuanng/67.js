import { createAgentScene, loadAllAgentSceneModules, allAgentSceneModulesLoaded, needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader, needsPhysics, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader } from '../src/agent-scene.js';
import { Renderer67 } from '../src/renderer.js';
import { applyProjection } from '../src/camera.js';
import { mat4 } from 'gl-matrix';
import { resolveAgentShadow } from '../src/agent-look.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';
import { exportGlb } from '../src/export.js';
import { weightTracksFromGltfAnimation } from '../src/export-skeleton.js';
import { clipFromGltfAnimation } from '../src/skeleton-pose.js';

let active = null;
let canvas = document.querySelector('canvas');

function requireSession(sessionId) {
  if (!active || active.sessionId !== sessionId) {
    throw new Error('Unknown or disposed scene session.');
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
  };
}

function hasPatternTextures(parts) {
  return parts.some(part => part.material.boxMapScale);
}

// replaceParts streams only untextured parts, so a topology change around pattern textures takes a new renderer.
function rebuildRenderer(record) {
  record.renderer.dispose();
  record.renderer = null;
  resetCanvas();
  record.renderer = initializeRenderer(record.scene, record.options);
  record.shadowKey = null;
}

function draw(record, time = 0, camera = record.scene.camera) {
  if (!record.renderer) throw new Error('The scene renderer is leased to a render job.');
  if (record.renderer.context.isContextLost()) {
    throw new Error('The render context was lost. Export the recipe and dispose this session.');
  }
  // Shrink the existing target first so a smaller look can recover a staging-budget failure.
  record.renderer.resize();
  if (record.rendererTopology !== record.scene.topologyRevision) {
    const textured = hasPatternTextures(record.scene.parts);
    if (textured || record.rendererTextured) {
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
  record.renderer.render({ ...camera, environment, effects, exposure: effects.exposure, time });
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

function resetCanvas() {
  canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  const replacement = document.createElement('canvas');
  canvas.replaceWith(replacement);
  canvas = replacement;
}

function initializeRenderer(scene, { memoryBudgetMiB, backend }) {
  return new Renderer67(canvas, scene.parts, {
    ground: false,
    hdr: true,
    depth: true,
    world: scene.environment.world,
    environment: scene.environment,
    shadowBounds: resolveAgentShadow(scene.shadow, scene.environment.lightDirection),
    pixelRatio: 1,
    samples: backend === 'cpu' ? 1 : 4,
    memoryBudgetMiB,
  });
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
      checkpoints: new Map(), rendererTopology: scene.topologyRevision, rendererTextured: hasPatternTextures(scene.parts) };
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

function seekForExport(record, motionTime) {
  if (record.asset) record.scene.sampleFrame({ motionTime });
  else record.scene.sampleMotion(motionTime);
}

// The scene's parts already carry the current pose, including IK and node overrides, so skinned parts export it as is.
function posedExport(record) {
  return { parts: record.scene.parts.map(withoutRoundoffShear), options: {} };
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
  return { parts: [...asset.parts], options: { nodes: asset.nodes, clips: [clip] } };
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

window.__agentPreview = {
  reviewBegin({ sessionId, width, height }) {
    const record = requireSession(sessionId);
    record.reviewGrid = document.createElement('canvas');
    record.reviewGrid.width = width;
    record.reviewGrid.height = height;
    const context = record.reviewGrid.getContext('2d');
    context.fillStyle = '#202428';
    context.fillRect(0, 0, width, height);
    return { width, height };
  },
  reviewShot({ sessionId, shot, index, width, height, columns }) {
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
    const context = record.reviewGrid.getContext('2d');
    const x = index % columns * width;
    const y = Math.floor(index / columns) * (height + 24);
    context.drawImage(canvas, x, y + 24, width, height);
    context.fillStyle = '#e4e7e9';
    context.font = '12px sans-serif';
    context.textBaseline = 'middle';
    context.fillText(shot.label.replace(/[\r\n\t]/g, ' '), x + 8, y + 12, width - 16);
    return { label: shot.label, camera, animation: record.asset ? animation : null,
      motionTime: record.scene.motionTime ?? null, rendererTime: shot.rendererTime,
      requestedWidth: width, requestedHeight: height, ...render };
  },
  reviewResult({ sessionId }) {
    const record = requireSession(sessionId);
    return { data: record.reviewGrid.toDataURL('image/png').split(',')[1], mimeType: 'image/png' };
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
  frame({ sessionId, animation, motionTime, rendererTime = 0 }) {
    const record = requireSession(sessionId);
    if (!Number.isFinite(rendererTime) || rendererTime < 0 || rendererTime > 3600) throw new RangeError('Invalid render time.');
    if (record.asset && (animation !== undefined || motionTime !== undefined)) {
      record.scene.sampleFrame({ ...(animation === undefined ? {} : { animation }),
        ...(motionTime === undefined ? {} : { motionTime }) });
    } else if (motionTime !== undefined) {
      record.scene.sampleMotion(motionTime);
    }
    draw(record, rendererTime);
    return renderInfo(record.renderer);
  },
  create(input) {
    if (active) throw new Error('Dispose the current scene before creating another.');
    return afterMeshBooleans(input.recipe, () => createPreview(createAgentScene(input.recipe), input));
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
      asset = await parseGltf(bytes.buffer, { maxBytes: 16 * 1024 * 1024, maxVertices: 250000, maxParts: 4096, maxTexturePixels: 4194304, maxJoints: 1024 });
      return createPreview(createAgentAssetScene(asset, input.recipe), input, asset);
    } catch (error) {
      asset?.dispose();
      throw error;
    }
  },
  inspect({ sessionId, ...options }) {
    return { sessionId, ...requireSession(sessionId).scene.inspect(options) };
  },
  inspectMeshes({ sessionId, ...options }) {
    const scene = requireSession(sessionId).scene;
    if (typeof scene.inspectMeshes !== 'function') {
      throw new TypeError('mesh_inspect supports procedural recipe scenes. Imported asset scenes are not inspected as polygon meshes yet.');
    }
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
      throw new TypeError('mesh_edit supports procedural recipe scenes. Imported asset scenes have no editable mesh geometry yet.');
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
    if (typeof record.scene.inspectMeshes !== 'function') {
      throw new TypeError('mesh_stack supports procedural recipe scenes.');
    }
    const operation = { type: 'set-mesh-stack', geometry, ...(stack === undefined ? {} : { stack }), ...(apply === undefined ? {} : { apply }) };
    const status = this.applyLoaded({ sessionId, operations: [operation], expectedRevision });
    const [mesh] = record.scene.inspectMeshes({ geometries: [geometry] }).meshes;
    return { ...status, mesh };
  },
  look({ sessionId, motionTime }) {
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
    return {
      data: canvas.toDataURL('image/png').split(',')[1],
      mimeType: 'image/png',
      metadata: { sessionId, revision: record.scene.revision, topologyRevision: record.scene.topologyRevision,
        motionTime: record.scene.motionTime ?? null, ...render },
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
    active = null;
    return { sessionId, disposed: true };
  },
};
