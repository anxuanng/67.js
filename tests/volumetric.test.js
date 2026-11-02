import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVolumeFog } from '../src/volumetric.js';
import { Renderer67 } from '../src/renderer.js';

test('bounded volume controls default disabled and preserve ordinary input data', () => {
  assert.equal(resolveVolumeFog().density, 0);
  const input = { density: 0.05, minimum: [-4, 0, -4], maximum: [4, 5, 4], color: [0.8, 0.6, 0.3], steps: 24 };
  const snapshot = structuredClone(input);
  const resolved = resolveVolumeFog(input);
  assert.equal(resolved.density, 0.05);
  assert.equal(resolved.steps, 24);
  assert.deepEqual(input, snapshot);
});

test('volume preflight rejects malformed controls and Float32 collapsed bounds', () => {
  for (const input of [null, [], { density: -1 }, { density: Infinity }, { steps: 7 }, { steps: 12.5 }, { noiseScale: 0 }, { noiseAmount: 1.01 }, { anisotropy: 1 }, { minimum: [1e5, 0, 0], maximum: [1e5 + 1e-8, 1, 1] }, { color: [1, NaN, 1] }, { drift: [0, '1', 0] }, { shadowAmbient: -0.1 }, { shadowAmbient: 1.1 }]) {
    assert.throws(() => resolveVolumeFog(input));
  }
  assert.throws(() => new Renderer67({}, [], { hdr: true, environment: { volumeFog: { density: 0.1 } } }), /depth:true/);
  assert.throws(() => new Renderer67({}, [], { hdr: true, depth: true, transparent: true, environment: { volumeFog: { density: 0.1 } } }), /opaque/);
});

test('volume shadow ambient defaults to the closed room share and accepts the full range', () => {
  assert.equal(resolveVolumeFog({ density: 0.1 }).shadowAmbient, 0.15);
  assert.equal(resolveVolumeFog({ density: 0.1, shadowAmbient: 1 }).shadowAmbient, 1);
  assert.equal(resolveVolumeFog({ density: 0.1, shadowAmbient: 0 }).shadowAmbient, 0);
});
