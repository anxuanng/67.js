import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';

test('runtime reports real scene capabilities without launching a browser and closes idempotently', async () => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64 });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.phase, 'idle');
  assert.equal(capabilities.scene.schemaVersion, 1);
  assert.equal(capabilities.preview.maximumActiveScenes, 1);
  assert.equal(capabilities.preview.memoryBudgetMiB, 64);
  assert.equal(capabilities.preview.backend, 'cpu');
  assert.equal(capabilities.sceneLimits.maxGeometryBytes, 32 * 1024 * 1024);
  await runtime.close();
  await runtime.close();
  assert.equal((await runtime.capabilities()).phase, 'closed');
  await assert.rejects(runtime.create({ recipe: {} }), /closed/);
});

test('invalid preview configuration rejects before any browser or renderer allocation', () => {
  assert.throws(() => createAgentRuntime({ backend: 'fake' }), /backend/);
  for (const memory of [0, 31, 257, 64.5, NaN]) {
    assert.throws(() => createAgentRuntime({ memory }), /memory/);
  }
  assert.throws(() => createAgentRuntime({ browser: 'does-not-exist-browser.exe' }), /browser/);
});

test('requests cannot address an absent session or enter a closing runtime', async () => {
  const runtime = createAgentRuntime();
  await assert.rejects(runtime.inspect({ sessionId: 'missing' }), /Unknown/);
  await assert.rejects(runtime.look({ sessionId: 'missing' }), /Unknown/);
  const closing = runtime.close();
  await assert.rejects(runtime.checkpoint({ sessionId: 'missing' }), /closing|closed/);
  await closing;
});
