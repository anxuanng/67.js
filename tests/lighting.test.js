import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightingState, updateLightingState } from '../src/lighting.js';

test('lighting preserves legacy key defaults and independently controls direct fill and ambient light', () => {
  const state = createLightingState();
  updateLightingState(state, {});
  assert.deepEqual(Array.from(state.keyColor), [5.2, 4.7, 4.1].map(Math.fround));
  updateLightingState(state, { daylight: 0.5 }, { world: true });
  assert.deepEqual(Array.from(state.keyColor), [1.85, 1.7, 1.45].map(Math.fround));
  updateLightingState(state, { keyColor: [1, 0.5, 0.1], keyIntensity: 2, fillIntensity: 0, ambientIntensity: 0 });
  assert.deepEqual(Array.from(state.keyColor), [2, 1, 0.2].map(Math.fround));
  assert.equal(state.fillIntensity, 0);
  assert.equal(state.ambientIntensity, 0);
});

test('animated lights retain uniform buffers and removal clears stale lights without mutating source', () => {
  const state = createLightingState();
  const identities = [state.positions, state.colors, state.radii, state.keyColor];
  const light = { position: [1, 2, 3], color: [1, 0.5, 0], intensity: 12, range: 7, radius: 0.2 };
  const original = structuredClone(light);
  updateLightingState(state, { pointLights: [light] });
  assert.deepEqual(Array.from(state.positions.slice(0, 4)), [1, 2, 3, 7]);
  assert.deepEqual(Array.from(state.colors.slice(0, 4)), [1, 0.5, 0, 12]);
  assert.equal(state.pointCount, 1);
  for (let frame = 0; frame < 100; frame++) updateLightingState(state, { pointLights: [{ ...light, position: [frame, 2, 3] }] });
  updateLightingState(state, { pointLights: [] });
  assert.equal(state.pointCount, 0);
  assert.ok(state.positions.every(value => value === 0));
  assert.ok(state.colors.every(value => value === 0));
  assert.ok(state.radii.every(value => value === 0));
  assert.deepEqual([state.positions, state.colors, state.radii, state.keyColor], identities);
  assert.deepEqual(light, original);
});

test('malformed later lights reject atomically before replacing any retained lighting values', () => {
  const state = createLightingState();
  const light = { position: [0, 2, 1] };
  updateLightingState(state, { pointLights: [light], fillIntensity: 0.4 });
  const snapshot = structuredClone(state);
  for (const malformed of [
    null,
    { position: [0, 0] },
    { position: [Infinity, 0, 0] },
    { position: ['1', 0, 0] },
    { position: [0, 0, 0], color: [1, -1, 0] },
    { position: [0, 0, 0], intensity: NaN },
    { position: [0, 0, 0], radius: 1e-100 },
    { position: [0, 0, 0], range: 1e-100 },
  ]) {
    assert.throws(() => updateLightingState(state, { pointLights: [light, malformed], fillIntensity: 0 }));
    assert.deepEqual(state, snapshot);
  }
  assert.throws(() => updateLightingState(state, { pointLights: Array(9).fill(light) }), /at most/);
  assert.throws(() => updateLightingState(state, { keyIntensity: -1 }));
  assert.throws(() => updateLightingState(state, { ambientIntensity: Infinity }));
  assert.deepEqual(state, snapshot);
});
