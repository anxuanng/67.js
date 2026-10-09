import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, mat3 } from 'gl-matrix';
import { Renderer67, groupParts, textureDescriptorInfo } from '../src/renderer.js';

function part(name, geometry = {}, map) {
  return { name, geometry, matrix: mat4.create(), material: { color: [0.1, 0.2, 0.3], metallic: 0.5, roughness: 0.3, emission: 0, map } };
}

function retainedRenderer(parts) {
  const writes = [];
  const renderer = Object.create(Renderer67.prototype);
  const batch = { instanceBuffer: {}, instanceData: new Float32Array(parts.length * 41).fill(7) };
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData(target, offset, data) { writes.push({ target, offset, data: Array.from(data) }); } };
  renderer.partLocations = new Map(parts.map((item, index) => [item, {
    batch, index, geometry: item.geometry, map: item.material.map ?? null, normalMatrix: mat3.create(),
    mapState: ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'].map(field => item.material[field] ?? null).concat(item.material.normalScale ?? [1, 1], item.material.occlusionStrength ?? 1),
  }]));
  renderer.updateBatches = new Set();
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

test('repeated instance updates retain normal buffers without allocating matrices per frame', () => {
  const parts = [part('first'), part('second')];
  const { renderer, batch } = retainedRenderer(parts);
  const normals = parts.map(item => renderer.partLocations.get(item).normalMatrix);
  const dirtyBatches = renderer.updateBatches;
  const originalCreate = mat3.create;
  mat3.create = () => { throw new Error('Unexpected per-frame matrix allocation'); };
  try {
    for (let frame = 0; frame < 20; frame++) {
      parts[0].matrix[12] = frame;
      renderer.updateParts(parts);
    }
  } finally {
    mat3.create = originalCreate;
  }
  assert.equal(batch.instanceData[12], 19);
  assert.equal(renderer.updateBatches, dirtyBatches);
  parts.forEach((item, index) => assert.equal(renderer.partLocations.get(item).normalMatrix, normals[index]));
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

test('all material map identities and fixed scale values partition instance batches', () => {
  for (const field of ['normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    const geometry = {};
    const first = part('first', geometry);
    first.material[field] = {};
    const second = part('second', geometry);
    second.material[field] = first.material[field];
    assert.equal(groupParts([first, second]).length, 1);
    second.material[field] = {};
    assert.equal(groupParts([first, second]).length, 2);
    second.material[field] = first.material[field];
    second.material.normalScale = [0.5, -1];
    assert.equal(groupParts([first, second]).length, 2);
    second.material.normalScale = [1, 1];
    second.material.occlusionStrength = 0.3;
    assert.equal(groupParts([first, second]).length, 2);
  }
});

test('map and scale changes reject atomically before retained data uploads', () => {
  for (const field of ['normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'normalScale', 'occlusionStrength']) {
    const parts = [part('moving'), part('changed')];
    const { renderer, batch, writes } = retainedRenderer(parts);
    parts[0].matrix[12] = 4;
    parts[1].material[field] = field === 'normalScale' ? [0.5, 1] : field === 'occlusionStrength' ? 0.2 : {};
    assert.throws(() => renderer.updateParts(parts), /map or scale changes/);
    assert.ok(batch.instanceData.every(value => value === 7));
    assert.equal(writes.length, 0);
  }
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, normalScale: [Infinity, 1] } }]), /normalScale/);
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, occlusionStrength: 2 } }]), /occlusionStrength/);
  const procedural = part('procedural');
  procedural.material.tag = 'water';
  procedural.material.metallicRoughnessMap = {};
  assert.throws(() => groupParts([procedural]), /Procedural tags/);
  procedural.material.tag = 'unlit';
  assert.throws(() => groupParts([procedural]), /Unlit materials/);
});

function preflightCanvas() {
  const context = {
    MAX_TEXTURE_SIZE: 3379, MAX_SAMPLES: 36183,
    getInternalformatParameter() { return []; },
    getParameter(parameter) { return parameter === this.MAX_TEXTURE_SIZE ? 8192 : 4; },
    createProgram() { throw new Error('Reached GPU allocation'); },
  };
  return { clientWidth: 64, clientHeight: 64, getContext() { return context; } };
}

test('texture budgets count every channel and charge shared descriptors once before GPU allocation', () => {
  const geometry = { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), uvs: new Float32Array(6) };
  for (const field of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    const item = part('large map', geometry);
    item.material[field] = { image: { width: 4096, height: 4096 }, colorSpace: field === 'map' || field === 'emissiveMap' ? 'srgb' : 'linear' };
    assert.throws(() => new Renderer67(preflightCanvas(), [item], { ground: false, memoryBudgetMiB: 32 }), /Memory budget/);
  }
  const shared = { image: { width: 1024, height: 1024 }, colorSpace: 'linear' };
  const item = part('shared map', geometry);
  item.material.normalMap = shared;
  item.material.metallicRoughnessMap = shared;
  item.material.occlusionMap = shared;
  assert.throws(() => new Renderer67(preflightCanvas(), [item], { ground: false, memoryBudgetMiB: 24 }), /Reached GPU allocation/);
  item.material.occlusionMap = { ...shared };
  assert.throws(() => new Renderer67(preflightCanvas(), [item], { ground: false, memoryBudgetMiB: 24 }), /Memory budget/);
  item.material.normalMap = { ...shared, colorSpace: 'srgb' };
  assert.throws(() => new Renderer67(preflightCanvas(), [item], { ground: false }), /requires a linear/);
  assert.throws(() => textureDescriptorInfo({ ...shared, rotation: 1 }), /transforms/);
});

test('GPU uploads use descriptor color spaces, cache shared maps, and dispose every cached texture', () => {
  const renderer = Object.create(Renderer67.prototype);
  const uploaded = [];
  const deleted = [];
  renderer.textures = new Map();
  renderer.buffers = [];
  renderer.batches = [];
  renderer.partLocations = new Map();
  renderer.releaseFrameTargets = () => {};
  renderer.context = {
    RGBA8: 32856, SRGB8_ALPHA8: 35907, MAX_TEXTURE_SIZE: 3379,
    getParameter(parameter) { return parameter === this.MAX_TEXTURE_SIZE ? 8192 : 0; },
    createTexture() { return {}; }, bindTexture() {}, pixelStorei() {}, texParameteri() {}, generateMipmap() {},
    texImage2D(...arguments_) { uploaded.push(arguments_[2]); },
    deleteTexture(texture) { if (texture) deleted.push(texture); }, deleteFramebuffer() {}, deleteProgram() {},
  };
  const color = { image: { width: 4, height: 4 }, colorSpace: 'srgb' };
  const data = { ...color, colorSpace: 'linear' };
  const first = renderer.createTexture(color);
  const second = renderer.createTexture(data);
  assert.equal(renderer.createTexture(data), second);
  assert.deepEqual(uploaded, [35907, 32856]);
  renderer.dispose();
  assert.deepEqual(deleted, [first, second]);
  assert.equal(renderer.textures.size, 0);
});

test('draw batches bind all channels with their flags and scalar uniforms', () => {
  const renderer = Object.create(Renderer67.prototype);
  const bindings = [];
  const uniforms = [];
  renderer.uniforms = Object.fromEntries(['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'hasBaseMap', 'hasNormalMap', 'hasMetallicRoughnessMap', 'hasOcclusionMap', 'hasEmissiveMap', 'normalScale', 'occlusionStrength'].map(name => [name, name]));
  renderer.context = {
    TEXTURE0: 33984,
    activeTexture(unit) { bindings.push(unit); }, bindTexture() {}, bindVertexArray() {}, drawElementsInstanced() {},
    uniform1i(name, value) { uniforms.push([name, value]); },
    uniform1f(name, value) { uniforms.push([name, value]); },
    uniform2f(name, first, second) { uniforms.push([name, first, second]); },
  };
  renderer.drawBatch({ textures: [{}, {}, {}, {}, {}], mapState: [{}, {}, {}, null, {}, 0.5, -1, 0.4] }, true);
  assert.deepEqual(bindings, [33985, 33986, 33987, 33988, 33989]);
  assert.ok(uniforms.some(values => values[0] === 'hasOcclusionMap' && values[1] === 0));
  assert.ok(uniforms.some(values => values[0] === 'metallicRoughnessMap' && values[1] === 3));
  assert.ok(uniforms.some(values => values[0] === 'normalScale' && values[1] === 0.5 && values[2] === -1));
  assert.ok(uniforms.some(values => values[0] === 'occlusionStrength' && values[1] === 0.4));
});
