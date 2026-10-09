import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { applyProjection } from '../src/camera.js';

const source = (await readFile(new URL('../scripts/agent-preview-browser.js', import.meta.url), 'utf8')).replace(/^import .+;\r?$/gm, '');

function previewHarness() {
  let renderError = 0;
  let lost = false;
  const canvas = { width: 768, height: 512 };
  class FaultInjectedRenderer {
    memoryPlan = { estimatedBytes: 1024 };
    capabilities = { hdr: true, samples: 4 };
    context = {
      isContextLost: () => lost,
      getError: () => renderError,
      getExtension: () => null,
      getParameter: () => 'Test renderer',
    };
    resize() {}
    updateParts() {}
    render() {}
    dispose() {}
  }
  const context = createContext({
    window: {},
    document: { querySelector: () => canvas },
    // The real browser bundles these functions in one realm. Bridge only the VM realm here.
    createAgentScene: input => createAgentScene(JSON.parse(JSON.stringify(input))),
    applyProjection, mat4,
    Renderer67: FaultInjectedRenderer,
  });
  // Evaluate only trusted repository adapter code; inject the driver boundary for failure cases.
  new Script(source).runInContext(context);
  return {
    preview: context.window.__agentPreview,
    injectError: value => { renderError = value; },
    loseContext: () => { lost = true; },
  };
}

function recipe() {
  return { format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.4, 0.5, 0.6] }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }] };
}

test('preview rejects a camera that overflows at a permitted aspect before committing edits', () => {
  const { preview } = previewHarness();
  const input = recipe();
  input.camera = { fov: 1e-36 };
  assert.throws(() => preview.create({ recipe: input, sessionId: 'scene', backend: 'gpu', memoryBudgetMiB: 192 }), /aspect ratios/);
  preview.create({ recipe: recipe(), sessionId: 'scene', backend: 'gpu', memoryBudgetMiB: 192 });
  assert.throws(() => preview.apply({ sessionId: 'scene', expectedRevision: 0, operations: [
    { type: 'set-node', id: 'cube', translation: [1, 2, 3] },
    { type: 'set-camera', fov: 1e-36 },
  ] }), /aspect ratios/);
  assert.equal(preview.exportRecipe({ sessionId: 'scene' }).revision, 0);
  assert.deepEqual(preview.exportRecipe({ sessionId: 'scene' }).recipe.nodes[0].translation, [0, 0, 0]);
});

test('driver errors disclose committed revision and context loss preserves recipe recovery', () => {
  const harness = previewHarness();
  const { preview } = harness;
  preview.create({ recipe: recipe(), sessionId: 'scene', backend: 'gpu', memoryBudgetMiB: 192 });
  preview.checkpoint({ sessionId: 'scene', checkpointId: 'checkpoint' });
  harness.injectError(1285);
  const result = preview.apply({ sessionId: 'scene', expectedRevision: 0, operations: [
    { type: 'set-node', id: 'cube', translation: [1, 2, 3] },
  ] });
  assert.equal(result.committed, true);
  assert.equal(result.renderSucceeded, false);
  assert.equal(result.revision, 1);
  assert.match(result.renderError, /1285/);
  assert.deepEqual(preview.exportRecipe({ sessionId: 'scene' }).recipe.nodes[0].translation, [1, 2, 3]);
  const restored = preview.restore({ sessionId: 'scene', checkpointId: 'checkpoint', expectedRevision: 1 });
  assert.equal(restored.committed, true);
  assert.equal(restored.renderSucceeded, false);
  assert.equal(restored.revision, 2);
  harness.loseContext();
  assert.equal(preview.exportRecipe({ sessionId: 'scene' }).revision, 2);
  assert.equal(preview.inspect({ sessionId: 'scene' }).revision, 2);
  assert.equal(preview.dispose({ sessionId: 'scene' }).disposed, true);
});
