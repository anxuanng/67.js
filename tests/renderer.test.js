import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { Renderer67, groupParts, textureDescriptorInfo } from '../src/renderer.js';

function part(name, geometry = {}, map) {
  return { name, geometry, matrix: mat4.create(), material: { color: [0.1, 0.2, 0.3], metallic: 0.5, roughness: 0.3, emission: 0, map } };
}

function retainedRenderer(parts) {
  const writes = [];
  const renderer = Object.create(Renderer67.prototype);
  const batch = { instanceBuffer: {}, instanceData: new Float32Array(parts.length * 41).fill(7) };
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData(target, offset, data) { writes.push({ target, offset, data: Array.from(data) }); } };
  renderer.partLocations = new Map(parts.map((item, index) => [item, { batch, index, geometry: item.geometry, map: item.material.map ?? null }]));
  renderer.shadowsDirty = false;
  return { renderer, batch, writes };
}

test('sample reporting uses the negotiated allocation count and cannot diverge through assignment', () => {
  const renderer = Object.create(Renderer67.prototype);
  renderer.multisampleSamples = 4;
  assert.equal(renderer.samples, 4);
  assert.throws(() => { renderer.samples = 1; }, TypeError);
  assert.equal(renderer.samples, 4);
  renderer.multisampleSamples = 0;
  assert.equal(renderer.samples, 1);
});

test('batching shares geometry only when texture descriptor identities also match', () => {
  const geometry = {};
  const map = {};
  const parts = [part('first', geometry, map), part('second', geometry, map), part('other texture', geometry, {}), part('no texture', geometry)];
  const groups = groupParts(parts);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].length, 2);
  assert.equal(groupParts(parts, false).length, 4);
});

test('instance animation reuses retained buffers, updates inverse-transpose normals and RGB emission', () => {
  const parts = [part('moving'), part('static')];
  const { renderer, batch, writes } = retainedRenderer(parts);
  const data = batch.instanceData;
  const buffer = batch.instanceBuffer;
  mat4.fromScaling(parts[0].matrix, [2, 3, 4]);
  parts[0].matrix[12] = 2.5;
  parts[0].material.emissiveColor = [3, 0.5, 0.1];
  assert.equal(renderer.updateParts([parts[0]], { shadows: false }), 1);
  assert.equal(batch.instanceData, data);
  assert.equal(batch.instanceBuffer, buffer);
  assert.equal(writes.length, 1);
  assert.equal(data[12], 2.5);
  assert.equal(data[16], 0.5);
  assert.ok(Math.abs(data[20] - 1 / 3) < 1e-6);
  assert.equal(data[24], 0.25);
  assert.equal(data[38], 3);
  assert.equal(renderer.shadowsDirty, false);
  renderer.updateParts(parts);
  assert.equal(writes.length, 2, 'one upload for a changed batch');
  assert.equal(renderer.shadowsDirty, true);
});

test('mixed invalid updates fail atomically before CPU or GPU instance data changes', () => {
  const parts = [part('valid'), part('invalid')];
  const { renderer, batch, writes } = retainedRenderer(parts);
  const original = Array.from(batch.instanceData);
  parts[0].matrix[12] = 9;
  parts[1].matrix[0] = 0;
  assert.throws(() => renderer.updateParts(parts), /Singular/);
  assert.deepEqual(Array.from(batch.instanceData), original);
  assert.equal(writes.length, 0);
  mat4.identity(parts[1].matrix);
  parts[1].geometry = {};
  assert.throws(() => renderer.updateParts(parts), /Geometry changes/);
  assert.equal(writes.length, 0);
  assert.throws(() => renderer.updateParts([part('not uploaded')]), /Unknown part/);
  parts[0].material.emissiveColor = [1e200, 0, 0];
  assert.throws(() => renderer.updateParts([parts[0]]), /Invalid instance vector/);
  assert.equal(writes.length, 0);
});

test('texture descriptor preflight validates dimensions, channel, samplers and mipmap bytes', () => {
  const info = textureDescriptorInfo({ image: { width: 4, height: 4 }, colorSpace: 'srgb', uvChannel: 0 }, 16);
  assert.equal(info.bytes, 84);
  assert.equal(info.mipmaps, true);
  assert.equal(textureDescriptorInfo({ image: { width: 4, height: 4 }, minFilter: 9729 }, 16).bytes, 64);
  assert.throws(() => textureDescriptorInfo({ image: { width: 32, height: 32 } }, 16), /MAX_TEXTURE_SIZE/);
  assert.throws(() => textureDescriptorInfo({ image: { width: 4, height: 4 }, uvChannel: 1 }), /channel 0/);
  assert.throws(() => textureDescriptorInfo({ image: { width: 4, height: 4 }, minFilter: 4 }), /filtering/);
});
