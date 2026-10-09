import { createAgentScene } from '../src/agent-scene.js';
import { Renderer67 } from '../src/renderer.js';
import { applyProjection } from '../src/camera.js';
import { mat4 } from 'gl-matrix';

let active = null;
let canvas = document.querySelector('canvas');
const effects = { bloom: { strength: 0.12, threshold: 1, radius: 1 }, grain: 0, vignette: 0 };

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
    geometryBuffers: renderer.geometryBuffers?.size ?? 0,
    gpuBuffers: renderer.buffers?.length ?? 0,
    drawBatches: renderer.batches?.length ?? 0,
  };
}

function draw(record) {
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
  record.renderer.render({ ...record.scene.camera, effects });
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

window.__agentPreview = {
  create({ recipe, sessionId, memoryBudgetMiB, backend }) {
    if (active) {
      throw new Error('Dispose the current scene before creating another.');
    }
    const scene = createAgentScene(recipe);
    validatePreviewCamera(scene.camera);
    let renderer;
    try {
      renderer = new Renderer67(canvas, scene.parts, {
        ground: false,
        hdr: true,
        pixelRatio: 1,
        samples: backend === 'cpu' ? 1 : 4,
        memoryBudgetMiB,
      });
      const record = { scene, renderer, sessionId, checkpoints: new Map(), rendererTopology: scene.topologyRevision };
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
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      const replacement = document.createElement('canvas');
      canvas.replaceWith(replacement);
      canvas = replacement;
      throw error;
    }
  },
  inspect({ sessionId, ...options }) {
    return { sessionId, ...requireSession(sessionId).scene.inspect(options) };
  },
  apply({ sessionId, operations, expectedRevision }) {
    const record = requireSession(sessionId);
    validatePreviewCamera(candidateCamera(record, operations));
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
    record.checkpoints.set(checkpointId, handle);
    return { sessionId, checkpointId, revision: record.scene.revision };
  },
  restore({ sessionId, checkpointId, expectedRevision }) {
    const record = requireSession(sessionId);
    if (!record.checkpoints.has(checkpointId)) {
      throw new Error('Unknown or released checkpoint.');
    }
    record.scene.restore(record.checkpoints.get(checkpointId), { expectedRevision });
    return mutationStatus(record);
  },
  releaseCheckpoint({ sessionId, checkpointId }) {
    const record = requireSession(sessionId);
    if (!record.checkpoints.has(checkpointId)) {
      throw new Error('Unknown or released checkpoint.');
    }
    record.scene.releaseCheckpoint(record.checkpoints.get(checkpointId));
    record.checkpoints.delete(checkpointId);
    return { sessionId, checkpointId, released: true };
  },
  exportRecipe({ sessionId }) {
    const record = requireSession(sessionId);
    return { sessionId, revision: record.scene.revision, recipe: record.scene.exportRecipe() };
  },
  dispose({ sessionId }) {
    const record = requireSession(sessionId);
    record.renderer.dispose();
    record.checkpoints.clear();
    active = null;
    return { sessionId, disposed: true };
  },
};
