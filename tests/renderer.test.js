import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, mat3 } from 'gl-matrix';
import { Renderer67, groupParts, resolveLiquidOptics, textureDescriptorInfo } from '../src/renderer.js';
import { createSkinPose } from '../src/skinning.js';
import { materialLayerState } from '../src/material-layers.js';

function part(name, geometry = {}, map) {
  return { name, geometry, matrix: mat4.create(), material: { color: [0.1, 0.2, 0.3], metallic: 0.5, roughness: 0.3, emission: 0, map } };
}

function retainedRenderer(parts) {
  const writes = [];
  const renderer = Object.create(Renderer67.prototype);
  const batch = { instanceBuffer: {}, instanceData: new Float32Array(parts.length * 41).fill(7), castShadow: true, alphaMode: 'opaque', alphaCutoff: 0, opacity: 1, doubleSided: false };
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData(target, offset, data) { writes.push({ target, offset, data: Array.from(data) }); } };
  renderer.partLocations = new Map(parts.map((item, index) => [item, {
    batch, index, geometry: item.geometry, map: item.material.map ?? null, normalMatrix: mat3.create(), layerState: materialLayerState(item.material), skin: item.skin ?? null,
    jointMatrices: item.skin?.jointMatrices, skinIndices: item.geometry.skinIndices, skinWeights: item.geometry.skinWeights,
    mapState: ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'].map(field => item.material[field] ?? null).concat(item.material.normalScale ?? [1, 1], item.material.occlusionStrength ?? 1, item.material.moss ?? 0, item.material.mossColor ?? [0.05, 0.085, 0.02]),
  }]));
  renderer.updateBatches = new Set();
  renderer.updateSkins = new Set();
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

test('liquid and foam parts form their own batches and validate their optics', () => {
  const geometry = {};
  const solid = part('solid', geometry);
  const liquid = { ...part('liquid', geometry), material: { ...part('liquid', geometry).material, tag: 'liquid' } };
  const foam = { ...part('foam', geometry), material: { ...part('foam', geometry).material, tag: 'foam' } };
  const groups = groupParts([solid, liquid, foam]);
  assert.equal(groups.length, 3, 'a shared geometry must not mix opaque and translucent instances');
  assert.deepEqual(resolveLiquidOptics(), { thickness: 0.5, ior: 1.33, refraction: 1, scattering: 1, foamOpacity: 0.55, foamSoftness: 1 });
  assert.equal(resolveLiquidOptics({ thickness: 2 }).thickness, 2);
  assert.throws(() => resolveLiquidOptics({ ior: 0.5 }), /liquid.ior/);
  assert.throws(() => resolveLiquidOptics({ foamOpacity: NaN }), /liquid.foamOpacity/);
  const { renderer, writes } = retainedRenderer([solid]);
  solid.material = { ...solid.material, tag: 'liquid' };
  assert.throws(() => renderer.updateParts([solid]), /liquid or foam pass/);
  assert.equal(writes.length, 0);
});

test('shadowless parts form separate render batches and cannot change casting after upload', () => {
  const geometry = {};
  const caster = part('caster', geometry);
  const window = { ...part('window', geometry), castShadow: false };
  const groups = groupParts([caster, window]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0][0], caster);
  assert.equal(groups[1][0], window);
  const { renderer, writes } = retainedRenderer([caster]);
  caster.castShadow = false;
  assert.throws(() => renderer.updateParts([caster]), /Shadow casting/);
  assert.equal(writes.length, 0);
  assert.throws(() => groupParts([{ ...window, castShadow: 0 }]), /boolean/);
});

function alphaPart(name, geometry, materialFields) {
  const base = part(name, geometry);
  return { ...base, material: { ...base.material, ...materialFields } };
}

test('alpha mode, cutoff, opacity and double-sided state partition batches', () => {
  const geometry = {};
  const parts = [
    alphaPart('opaque', geometry, {}),
    alphaPart('leaf', geometry, { alphaMode: 'mask', doubleSided: true }),
    alphaPart('second leaf', geometry, { alphaMode: 'mask', doubleSided: true }),
    alphaPart('sharper leaf', geometry, { alphaMode: 'mask', alphaCutoff: 0.8, doubleSided: true }),
    alphaPart('one sided leaf', geometry, { alphaMode: 'mask' }),
    alphaPart('glass', geometry, { alphaMode: 'blend', opacity: 0.3 }),
    alphaPart('faint glass', geometry, { alphaMode: 'blend', opacity: 0.1 }),
    alphaPart('opaque with ignored opacity', geometry, { opacity: 0.2 }),
  ];
  const groups = groupParts(parts);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups[0].map(item => item.name), ['opaque', 'opaque with ignored opacity']);
  assert.deepEqual(groups[1].map(item => item.name), ['leaf', 'second leaf']);
});

test('alpha material fields are validated with clear errors', () => {
  const geometry = {};
  const invalid = [
    [{ alphaMode: 'cutout' }, /alphaMode/],
    [{ alphaMode: 'mask', alphaCutoff: 1.5 }, /alphaCutoff/],
    [{ alphaMode: 'blend', opacity: -0.1 }, /opacity/],
    [{ opacity: NaN }, /opacity/],
    [{ doubleSided: 1 }, /doubleSided/],
  ];
  for (const [fields, expected] of invalid) assert.throws(() => groupParts([alphaPart('bad', geometry, fields)]), expected);
});

test('blend batches skip shadows by default and alpha state cannot change after upload', () => {
  const geometry = {};
  const glass = alphaPart('glass', geometry, { alphaMode: 'blend', opacity: 0.5 });
  assert.equal(groupParts([glass, { ...glass, castShadow: true }]).length, 2);
  const { renderer, batch, writes } = retainedRenderer([glass]);
  batch.alphaMode = 'blend';
  batch.opacity = 0.5;
  batch.castShadow = false;
  renderer.updateParts([glass]);
  assert.equal(writes.length, 1);
  for (const change of [{ alphaMode: 'mask' }, { opacity: 0.6 }, { doubleSided: true }]) {
    glass.material = { ...glass.material, ...change };
    assert.throws(() => renderer.updateParts([glass]), /require a new renderer/);
    glass.material = alphaPart('glass', geometry, { alphaMode: 'blend', opacity: 0.5 }).material;
  }
  assert.equal(writes.length, 1);
});

test('blend instances upload back to front by distance to the eye', () => {
  const uploads = [];
  const renderer = Object.create(Renderer67.prototype);
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData(target, offset, data) { uploads.push(Array.from(data)); } };
  const instanceData = new Float32Array(3 * 41);
  [1, 9, 4].forEach((distance, index) => { instanceData[index * 41 + 14] = -distance; instanceData[index * 41] = index; });
  const batch = { instanceBuffer: {}, instanceData, instanceCount: 3 };
  renderer.uploadSortedInstances(batch, [0, 0, 0]);
  const order = [0, 1, 2].map(rank => uploads[0][rank * 41]);
  assert.deepEqual(order, [1, 2, 0]);
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
  assert.equal(textureDescriptorInfo({ image: { width: 4, height: 4 }, uvChannel: 1 }).bytes, 84);
  assert.throws(() => textureDescriptorInfo({ image: { width: 4, height: 4 }, uvChannel: 2 }), /channels 0 and 1/);
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
  for (const field of ['normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'normalScale', 'occlusionStrength', 'moss']) {
    const parts = [part('moving'), part('changed')];
    const { renderer, batch, writes } = retainedRenderer(parts);
    parts[0].matrix[12] = 4;
    const changedValues = { normalScale: [0.5, 1], occlusionStrength: 0.2, moss: 0.5 };
    parts[1].material[field] = changedValues[field] ?? {};
    assert.throws(() => renderer.updateParts(parts), /map or scale changes/);
    assert.ok(batch.instanceData.every(value => value === 7));
    assert.equal(writes.length, 0);
  }
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, normalScale: [Infinity, 1] } }]), /normalScale/);
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, occlusionStrength: 2 } }]), /occlusionStrength/);
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, moss: 1.5 } }]), /moss/);
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, moss: 0.5, mossColor: [1, 1] } }]), /mossColor/);
  assert.throws(() => groupParts([{ ...part('invalid'), material: { ...part('invalid').material, tag: 'water', moss: 0.5 } }]), /Moss needs a standard/);
  const mossy = part('mossy');
  mossy.material.moss = 0.6;
  assert.equal(groupParts([part('bare'), mossy]).length, 2, 'moss splits batches');
  const procedural = part('procedural');
  procedural.material.tag = 'water';
  procedural.material.metallicRoughnessMap = {};
  assert.throws(() => groupParts([procedural]), /Procedural tags/);
  procedural.material.tag = 'unlit';
  assert.throws(() => groupParts([procedural]), /Unlit materials/);
});

function preflightCanvas({ vertexUnits = 2, combinedUnits = 8, maximumSize = 8192 } = {}) {
  const context = {
    MAX_TEXTURE_SIZE: 3379, MAX_SAMPLES: 36183,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 35660, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
    getInternalformatParameter() { return []; },
    getParameter(parameter) {
      if (parameter === this.MAX_TEXTURE_SIZE) return maximumSize;
      if (parameter === this.MAX_VERTEX_TEXTURE_IMAGE_UNITS) return vertexUnits;
      if (parameter === this.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return combinedUnits;
      return 4;
    },
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
  renderer.uniforms = Object.fromEntries(['materialDielectric', 'materialCoat', 'materialSheen', 'baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'hasBaseMap', 'hasNormalMap', 'hasMetallicRoughnessMap', 'hasOcclusionMap', 'hasEmissiveMap', 'normalScale', 'occlusionStrength', 'materialMoss'].map(name => [name, name]));
  renderer.context = {
    TEXTURE0: 33984,
    activeTexture(unit) { bindings.push(unit); }, bindTexture() {}, bindVertexArray() {}, drawElementsInstanced() {},
    uniform1i(name, value) { uniforms.push([name, value]); },
    uniform1f(name, value) { uniforms.push([name, value]); },
    uniform2f(name, first, second) { uniforms.push([name, first, second]); },
    uniform3f(name, ...values) { uniforms.push([name, ...values]); },
    uniform4f(name, ...values) { uniforms.push([name, ...values]); },
  };
  const layerState = materialLayerState({ clearcoat: 0.7, clearcoatRoughness: 0.2, sheenColor: [0.1, 0.2, 0.3], sheenRoughness: 0.4 });
  renderer.drawBatch({ textures: [{}, {}, {}, {}, {}], layerState, mapState: [{}, {}, {}, null, {}, 0.5, -1, 0.4, 0.6, 0.1, 0.2, 0.05] }, true);
  assert.deepEqual(bindings, [33985, 33986, 33987, 33988, 33989]);
  assert.ok(uniforms.some(values => values[0] === 'hasOcclusionMap' && values[1] === 0));
  assert.ok(uniforms.some(values => values[0] === 'metallicRoughnessMap' && values[1] === 3));
  assert.ok(uniforms.some(values => values[0] === 'normalScale' && values[1] === 0.5 && values[2] === -1));
  assert.ok(uniforms.some(values => values[0] === 'occlusionStrength' && values[1] === 0.4));
  assert.ok(uniforms.some(values => values[0] === 'materialMoss' && values[1] === 0.6 && values[4] === 0.05));
  assert.ok(uniforms.some(values => values[0] === 'materialCoat' && values[1] === 0.7 && values[2] === 0.2));
  assert.ok(uniforms.some(values => values[0] === 'materialSheen' && values[1] === 0.1 && values[4] === 0.4));
  assert.ok(uniforms.some(values => values[0] === 'materialDielectric' && Math.abs(values[1] - 0.04) < 1e-9));
});

function skinGeometry(vertexCount = 3) {
  const geometry = {
    positions: new Float32Array(vertexCount * 3), normals: new Float32Array(vertexCount * 3),
    indices: new Uint32Array([0, 1, 2]), skinIndices: new Uint16Array(vertexCount * 4), skinWeights: new Float32Array(vertexCount * 4),
  };
  for (let vertex = 0; vertex < vertexCount; vertex++) geometry.skinWeights[vertex * 4] = 1;
  return geometry;
}

test('pose identity partitions batches while shared poses retain instancing and all material maps', () => {
  const geometry = skinGeometry();
  const pose = createSkinPose(2);
  const first = part('first pose', geometry);
  const second = part('shared pose', geometry);
  first.skin = pose;
  second.skin = pose;
  first.material.normalMap = second.material.normalMap = {};
  assert.equal(groupParts([first, second]).length, 1);
  second.skin = createSkinPose(2);
  assert.equal(groupParts([first, second]).length, 2);
  second.skin = pose;
  second.material.emissiveMap = {};
  assert.equal(groupParts([first, second]).length, 2);
});

test('GPU skin preflight checks capabilities, texture capacity and retained texture budgets', () => {
  const item = part('skin', skinGeometry());
  item.skin = createSkinPose(2);
  assert.throws(() => new Renderer67(preflightCanvas({ vertexUnits: 1 }), [item], { ground: false }), /vertex texture units/);
  assert.throws(() => new Renderer67(preflightCanvas({ combinedUnits: 7 }), [item], { ground: false }), /combined texture units/);
  item.skin = createSkinPose(17);
  assert.throws(() => new Renderer67(preflightCanvas({ maximumSize: 8 }), [item], { ground: false }), /MAX_TEXTURE_SIZE/);
  item.geometry = skinGeometry(1000);
  item.skin = createSkinPose(2);
  assert.throws(() => new Renderer67(preflightCanvas(), [item], { ground: false, memoryBudgetMiB: 16.16 }), /Memory budget/);
  const rigid = part('rigid', { positions: item.geometry.positions, normals: item.geometry.normals, indices: item.geometry.indices });
  assert.throws(() => new Renderer67(preflightCanvas(), [rigid], { ground: false, memoryBudgetMiB: 16.16 }), /Reached GPU allocation/);
});

test('skin updates retain palette upload data, deduplicate shared poses and reject mixed invalid updates atomically', () => {
  const geometry = skinGeometry();
  const pose = createSkinPose(2);
  const first = part('first', geometry);
  const second = part('second', geometry);
  first.skin = second.skin = pose;
  const { renderer, batch, writes } = retainedRenderer([first, second]);
  const record = { pose, texture: {}, width: 4, height: 2, data: new Float32Array(pose.jointMatrices) };
  batch.skinTexture = record;
  const uploads = [];
  renderer.context.bindTexture = () => {};
  renderer.context.texSubImage2D = (...arguments_) => uploads.push(arguments_);
  pose.jointMatrices[12] = 2;
  second.matrix[0] = 0;
  assert.throws(() => renderer.updateParts([first, second]), /Singular/);
  assert.ok(batch.instanceData.every(value => value === 7));
  assert.equal(record.data[12], 0);
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
  second.matrix[0] = 1;
  const data = record.data;
  renderer.updateParts([first, second]);
  assert.equal(record.data, data);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][8], data);
  assert.equal(data[12], 2);
  assert.equal(writes.length, 1);
  pose.jointMatrices[0] = 0;
  assert.throws(() => renderer.updateParts([first]), /singular/);
  assert.equal(uploads.length, 1);
  pose.jointMatrices[0] = 1;
  first.skin = createSkinPose(2);
  assert.throws(() => renderer.updateParts([first]), /Skin identity/);
  assert.equal(uploads.length, 1);
});

test('skin palette and influence textures cache by pose and geometry identity and dispose fully', () => {
  const renderer = Object.create(Renderer67.prototype);
  const allocations = [];
  const deleted = [];
  renderer.context = {
    getParameter() { return 8192; }, createTexture() { return {}; }, bindTexture() {}, texParameteri() {},
    texImage2D(...arguments_) { allocations.push(arguments_); }, deleteTexture(texture) { if (texture) deleted.push(texture); },
    deleteFramebuffer() {}, deleteProgram() {},
  };
  renderer.skinTextures = new Map();
  renderer.influenceTextures = new Map();
  const pose = createSkinPose(2);
  const geometry = skinGeometry();
  const palette = renderer.createSkinTexture(renderer.skinTextures, pose, pose.jointMatrices, 4);
  const influences = renderer.createSkinTexture(renderer.influenceTextures, geometry, null, 2);
  assert.equal(renderer.createSkinTexture(renderer.skinTextures, pose, pose.jointMatrices, 4), palette);
  assert.equal(renderer.createSkinTexture(renderer.influenceTextures, geometry, null, 2), influences);
  assert.equal(allocations.length, 2);
  renderer.releaseFrameTargets = () => {};
  renderer.batches = [];
  renderer.buffers = [];
  renderer.textures = new Map();
  renderer.partLocations = new Map();
  renderer.dispose();
  assert.deepEqual(deleted, [palette.texture, influences.texture]);
  assert.equal(renderer.skinTextures.size, 0);
  assert.equal(renderer.influenceTextures.size, 0);
});

test('a shared palette validates consumers outside the submitted update list before any upload', () => {
  const pose = createSkinPose(2);
  const first = part('single joint', skinGeometry());
  const second = part('blended joints', skinGeometry());
  for (let vertex = 0; vertex < 3; vertex++) {
    second.geometry.skinIndices[vertex * 4 + 1] = 1;
    second.geometry.skinWeights[vertex * 4] = 0.5;
    second.geometry.skinWeights[vertex * 4 + 1] = 0.5;
  }
  first.skin = second.skin = pose;
  const { renderer, batch, writes } = retainedRenderer([first, second]);
  batch.skinTexture = { pose, texture: {}, data: new Float32Array(pose.jointMatrices) };
  const uploads = [];
  renderer.context.bindTexture = () => {};
  renderer.context.texSubImage2D = () => uploads.push(true);
  renderer.updateParts([first, second]);
  writes.length = 0;
  uploads.length = 0;
  const before = new Float32Array(batch.instanceData);
  pose.jointMatrices[16] = -1;
  pose.jointMatrices[21] = -1;
  assert.throws(() => renderer.updateParts([first]), /singular/);
  assert.deepEqual(batch.instanceData, before);
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
});

test('color, benchmark and shadow passes bind the same skin textures and disable skinning for rigid batches', () => {
  const renderer = Object.create(Renderer67.prototype);
  renderer.hasSkins = true;
  renderer.benchmark = true;
  renderer.uniforms = { skinEnabled: 'color enabled', skinInfluences: 'color influences', jointPalette: 'color palette' };
  renderer.depthSkinUniforms = { skinEnabled: 'shadow enabled', skinInfluences: 'shadow influences', jointPalette: 'shadow palette' };
  const uniforms = [];
  const bindings = [];
  renderer.context = {
    TEXTURE0: 33984, activeTexture(unit) { bindings.push(unit); }, bindTexture() {}, bindVertexArray() {}, drawElementsInstanced() {},
    uniform1f(name, value) { uniforms.push([name, value]); }, uniform1i(name, value) { uniforms.push([name, value]); },
  };
  const batch = { skin: {}, skinTexture: { texture: {} }, influenceTexture: { texture: {} } };
  renderer.drawBatch(batch, true);
  renderer.drawBatch(batch);
  renderer.drawBatch({});
  assert.deepEqual(bindings, [33990, 33991, 33990, 33991]);
  assert.ok(uniforms.some(([name, value]) => name === 'color enabled' && value === 1));
  assert.ok(uniforms.some(([name, value]) => name === 'shadow enabled' && value === 1));
  assert.deepEqual(uniforms.at(-1), ['shadow enabled', 0]);
});
