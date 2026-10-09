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
  let replacementError = false;
  let replacementCount = 0;
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
    replaceParts() {
      if (replacementError) throw new Error('Injected replacement allocation failure');
      replacementCount++;
    }
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
    rejectReplacement: value => { replacementError = value; },
    replacementCount: () => replacementCount,
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

test('topology driver failure discloses committed recipe and retries reconciliation with the current revision', () => {
  const harness = previewHarness();
  const sessionId = 'test-topology';
  harness.preview.create({ recipe: recipe(), sessionId, memoryBudgetMiB: 192, backend: 'cpu' });
  const checkpoint = harness.preview.checkpoint({ sessionId, checkpointId: 'initial' });
  harness.rejectReplacement(true);
  const added = harness.preview.apply({ sessionId, expectedRevision: 0, operations: [
    { type: 'add-node', node: { id: 'second', geometry: 'cube', material: 'paint', translation: [2, 0, 0] } },
  ] });
  assert.equal(added.committed, true);
  assert.equal(added.revision, 1);
  assert.equal(added.renderSucceeded, false);
  assert.match(added.renderError, /allocation failure/);
  assert.equal(harness.preview.inspect({ sessionId }).counts.parts, 2);
  assert.equal(harness.replacementCount(), 0);
  harness.rejectReplacement(false);
  const recovered = harness.preview.apply({ sessionId, expectedRevision: 1, operations: [
    { type: 'set-material', id: 'paint', color: [0.3, 0.6, 0.8] },
  ] });
  assert.equal(recovered.renderSucceeded, true);
  assert.equal(harness.replacementCount(), 1);
  const restored = harness.preview.restore({ sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 2 });
  assert.equal(restored.renderSucceeded, true);
  assert.equal(harness.preview.inspect({ sessionId }).counts.parts, 1);
  assert.equal(harness.replacementCount(), 2);
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
