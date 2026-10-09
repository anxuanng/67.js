import { createAgentScene } from '../src/agent-scene.js';
import { Renderer67 } from '../src/renderer.js';
import { applyProjection } from '../src/camera.js';
import { mat4 } from 'gl-matrix';
import { resolveAgentShadow } from '../src/agent-look.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';

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
  const camera = record.scene.camera;
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

function draw(record, time = 0) {
  if (!record.renderer) throw new Error('The scene renderer is leased to a render job.');
  if (record.renderer.context.isContextLost()) {
    throw new Error('The render context was lost. Export the recipe and dispose this session.');
  }
  // Shrink the existing target first so a smaller look can recover a staging-budget failure.
  record.renderer.resize();
  if (record.rendererTopology !== record.scene.topologyRevision) {
    record.renderer.replaceParts(record.scene.parts);
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
  record.renderer.render({ ...record.scene.camera, environment, effects, exposure: effects.exposure, time });
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
      checkpoints: new Map(), rendererTopology: scene.topologyRevision };
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

window.__agentPreview = {
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
  frame({ sessionId, animation, rendererTime = 0 }) {
    const record = requireSession(sessionId);
    if (!Number.isFinite(rendererTime) || rendererTime < 0 || rendererTime > 3600) throw new RangeError('Invalid render time.');
    if (animation) {
      record.scene.apply([{ type: 'set-animation', clip: animation.clip, time: animation.time }], { expectedRevision: record.scene.revision });
    }
    draw(record, rendererTime);
    return renderInfo(record.renderer);
  },
  create(input) {
    if (active) throw new Error('Dispose the current scene before creating another.');
    return createPreview(createAgentScene(input.recipe), input);
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
  apply({ sessionId, operations, expectedRevision }) {
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
  look({ sessionId }) {
    const record = requireSession(sessionId);
    draw(record);
    const render = renderInfo(record.renderer);
    record.lastRender = render;
    return {
      data: canvas.toDataURL('image/png').split(',')[1],
      mimeType: 'image/png',
      metadata: { sessionId, revision: record.scene.revision, topologyRevision: record.scene.topologyRevision, ...render },
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
