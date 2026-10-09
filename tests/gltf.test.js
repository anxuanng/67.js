import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { GLTF_CAPABILITIES, loadGltf, parseGltf } from '../src/gltf.js';

function triangleAsset(edit = () => {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const times = new Float32Array([0, 2]);
  const translations = new Float32Array([1, 2, 3, 5, 2, 3]);
  const alternate = new Float32Array([1, 2, 3, 1, 6, 3]);
  const chunks = [positions, uvs, times, translations, alternate];
  let offset = 0;
  const bufferViews = chunks.map(chunk => {
    const view = { buffer: 0, byteOffset: offset, byteLength: chunk.byteLength };
    offset += chunk.byteLength;
    return view;
  });
  const document = {
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Parent', translation: [10, 0, 0], children: [1, 2] }, { name: 'First', mesh: 0, translation: [1, 2, 3] }, { name: 'Second', mesh: 0, translation: [0, 4, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1], metallicFactor: 0.35, roughnessFactor: 0.7 }, emissiveFactor: [0.1, 0.2, 0.3] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 3, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    bufferViews, buffers: [{ byteLength: offset }],
  };
  function appendAccessor(data, type, normalized = false) {
    chunks.push(data);
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    offset += Math.ceil(data.byteLength / 4) * 4;
    document.buffers[0].byteLength = offset;
    const accessor = document.accessors.length;
    document.accessors.push({ bufferView, componentType: data instanceof Uint8Array ? 5121 : 5126, count: data.length / (type === 'VEC4' ? 4 : 3), type, normalized });
    return accessor;
  }
  edit(document, appendAccessor);
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + offset);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, offset, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  for (let index = 0; index < chunks.length; index++) {
    bytes.set(new Uint8Array(chunks[index].buffer, chunks[index].byteOffset, chunks[index].byteLength), 28 + jsonLength + bufferViews[index].byteOffset);
  }
  return result;
}

test('GLB bridge preserves hierarchy, shared geometry, missing normals, UVs and linear PBR factors', async () => {
  const asset = await parseGltf(triangleAsset());
  assert.equal(asset.parts.length, 2);
  const [first, second] = asset.parts;
  assert.equal(first.geometry, second.geometry);
  assert.deepEqual(Array.from(first.matrix.subarray(12, 15)), [11, 2, 3]);
  assert.deepEqual(Array.from(second.matrix.subarray(12, 15)), [10, 4, 0]);
  assert.deepEqual(Array.from(first.geometry.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(first.geometry.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(first.geometry.uvs), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(first.material.color, [0.2, 0.4, 0.6]);
  assert.deepEqual(first.material.emissiveColor, [0.1, 0.2, 0.3]);
  assert.equal(first.material.metallic, 0.35);
  assert.equal(first.material.roughness, 0.7);
  assert.equal(asset.capabilities, GLTF_CAPABILITIES);
  asset.dispose();
  asset.dispose();
});

test('67.js exported GLB roundtrip preserves transforms and repeated primitive identity', async () => {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const material = { color: [0.2, 0.4, 0.6], metallic: 0.25, roughness: 0.6, emission: 0 };
  const matrix = mat4.fromTranslation(mat4.create(), [4, 5, 6]);
  const input = [{ name: 'Roundtrip', geometry, matrix, material }, { name: 'Instance', geometry, matrix: mat4.create(), material }];
  const asset = await parseGltf(exportGlb(input));
  assert.deepEqual(Array.from(asset.parts[0].matrix), Array.from(matrix));
  assert.deepEqual(Array.from(asset.parts[0].geometry.positions), Array.from(geometry.positions));
  assert.equal(asset.parts[0].geometry, asset.parts[1].geometry);
  assert.equal(asset.parts[0].material, asset.parts[1].material);
  asset.dispose();
});

test('rigid animation seeks are absolute, order independent, clip selectable and clamped', async () => {
  const asset = await parseGltf(triangleAsset(document => {
    document.animations = [3, 4].map((output, index) => ({
      name: `Clip ${index}`,
      samplers: [{ input: 2, output, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
    }));
  }));
  assert.equal(asset.animations.length, 2);
  assert.equal(asset.applyAnimation(1), asset.parts);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [13, 2, 3]);
  const middle = Array.from(asset.parts[0].matrix);
  asset.applyAnimation(2);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [15, 2, 3]);
  asset.applyAnimation(0.1);
  asset.applyAnimation(1);
  assert.deepEqual(Array.from(asset.parts[0].matrix), middle);
  asset.applyAnimation(1, 1);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [11, 4, 3]);
  asset.applyAnimation(-1);
  assert.deepEqual(Array.from(asset.parts[0].matrix.subarray(12, 15)), [11, 2, 3]);
  assert.throws(() => asset.applyAnimation(Infinity), /finite/);
  assert.throws(() => asset.applyAnimation(1, 8), /clip index/);
  asset.dispose();
  assert.throws(() => asset.applyAnimation(1), /disposed/);
});

test('mirrored static transforms reverse triangle winding without altering world matrices', async () => {
  const asset = await parseGltf(triangleAsset(document => { document.nodes[2].scale = [-1, 1, 1]; }));
  assert.deepEqual(Array.from(asset.parts[0].geometry.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(asset.parts[1].geometry.indices), [0, 2, 1]);
  assert.equal(asset.parts[1].matrix[0], -1);
  asset.dispose();
});

test('unsupported features fail explicitly before loading resources', async () => {
  const cases = [
    [document => { document.nodes[1].skin = 0; }, /Skinned/],
    [document => { document.meshes[0].primitives[0].targets = [{ POSITION: 0 }]; }, /Morph/],
    [document => { document.meshes[0].primitives[0].attributes.COLOR_0 = 1; }, /COLOR_0/],
    [document => { document.meshes[0].primitives[0].mode = 1; }, /TRIANGLES/],
    [document => { document.materials[0].alphaMode = 'BLEND'; }, /alpha mode/],
    [document => { document.materials[0].doubleSided = true; }, /Double-sided/],
    [document => { document.materials[0].normalTexture = { index: 0 }; }, /texture channels/],
    [document => { document.extensionsRequired = ['KHR_draco_mesh_compression']; }, /KHR_draco/],
    [document => { document.materials[0].extensions = { KHR_materials_clearcoat: {} }; }, /KHR_materials_clearcoat/],
    [document => { document.buffers[0].uri = 'external.bin'; }, /baseUrl/],
    [document => { document.nodes[2].children = [0]; }, /Cyclic/],
    [document => { document.materials[0].pbrMetallicRoughness.metallicFactor = 2; }, /metallic/],
    [document => { document.accessors[1].count = 4; }, /TEXCOORD_0/],
  ];
  for (const [edit, expected] of cases) await assert.rejects(parseGltf(triangleAsset(edit)), expected);
});

test('byte, vertex, part and input guards reject oversized or malformed assets', async () => {
  const data = triangleAsset();
  await assert.rejects(parseGltf(data, { maxBytes: 32 }), /maxBytes/);
  await assert.rejects(parseGltf(data, { maxVertices: 2 }), /maxVertices/);
  await assert.rejects(parseGltf(data, { maxParts: 1 }), /maxParts/);
  await assert.rejects(parseGltf(data, { maxVertices: NaN }), /positive safe integer/);
  await assert.rejects(parseGltf(new ArrayBuffer(2)), /truncated/);
  const malformed = data.slice(0);
  new DataView(malformed).setUint32(8, data.byteLength + 10, true);
  await assert.rejects(parseGltf(malformed), /declared length/);
  const oversizedAccessor = triangleAsset(document => { document.accessors.push({ componentType: 5126, count: 10_000_000, type: 'MAT4' }); });
  await assert.rejects(parseGltf(oversizedAccessor), /Decoded glTF accessors/);
  await assert.rejects(loadGltf(new Blob([data]), { maxBytes: 10 }), /maxBytes/);
  await assert.rejects(loadGltf({ arrayBuffer: () => Promise.resolve(data) }), /File\/Blob/);
  const asset = await loadGltf(new Blob([data]));
  assert.equal(asset.parts.length, 2);
  asset.dispose();
});

test('texture pixel budgets reject compressed images before browser decoding', async () => {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 100000);
  view.setUint32(20, 100000);
  const oversized = triangleAsset(document => {
    document.images = [{ uri: `data:image/png;base64,${Buffer.from(header).toString('base64')}` }];
  });
  await assert.rejects(parseGltf(oversized), /maxTexturePixels before decoding/);
});

test('hierarchy depth guards reject long chains regardless of node ordering', async () => {
  for (const reverse of [false, true]) {
    const asset = triangleAsset(document => {
      document.nodes = Array.from({ length: 300 }, (_, index) => {
        const child = reverse ? index - 1 : index + 1;
        return child >= 0 && child < 300 ? { children: [child] } : { mesh: 0 };
      });
      document.scenes = [{ nodes: [reverse ? 299 : 0] }];
    });
    await assert.rejects(parseGltf(asset), /256 levels/);
  }
});

test('relative external buffer paths normalize both fetch and decoder lookups', async context => {
  const previousProgressEvent = globalThis.ProgressEvent;
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, details) { this.type = type; Object.assign(this, details); }
  };
  context.after(() => {
    if (previousProgressEvent) globalThis.ProgressEvent = previousProgressEvent;
    else delete globalThis.ProgressEvent;
  });
  const source = triangleAsset();
  const header = new DataView(source);
  const jsonLength = header.getUint32(12, true);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(source, 20, jsonLength)));
  document.buffers[0].uri = '../mesh.bin';
  const binary = new Uint8Array(source, 28 + jsonLength);
  const fetched = [];
  context.mock.method(globalThis, 'fetch', async url => {
    fetched.push(String(url));
    return new Response(binary);
  });
  const asset = await parseGltf(JSON.stringify(document), { baseUrl: 'https://example.test/models/' });
  assert.equal(asset.parts.length, 2);
  assert.equal(fetched[0], 'https://example.test/mesh.bin');
  asset.dispose();
});

test('URL loading streams within maxBytes and cancels oversized responses', async context => {
  const data = triangleAsset();
  const url = `data:model/gltf-binary;base64,${Buffer.from(data).toString('base64')}`;
  const asset = await loadGltf(url);
  assert.equal(asset.parts.length, 2);
  asset.dispose();
  let cancelled = false;
  context.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
      controller.enqueue(new Uint8Array(64));
    },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(loadGltf('https://example.invalid/asset.glb', { maxBytes: 80 }), /maxBytes/);
  assert.equal(cancelled, true);
});

test('linear RGB and normalized Uint8 vertex colors become shared Float32 RGB geometry', async () => {
  const inputs = [
    { colors: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]), type: 'VEC3', normalized: false },
    { colors: new Uint8Array([0, 128, 255, 255, 64, 0, 128, 255, 64]), type: 'VEC3', normalized: true },
    { colors: new Uint8Array([0, 128, 255, 255, 255, 64, 0, 255, 128, 255, 64, 255]), type: 'VEC4', normalized: true },
  ];
  for (const input of inputs) {
    const asset = await parseGltf(triangleAsset((document, append) => {
      document.meshes[0].primitives[0].attributes.COLOR_0 = append(input.colors, input.type, input.normalized);
    }));
    const colors = asset.parts[0].geometry.colors;
    assert.ok(colors instanceof Float32Array);
    assert.equal(colors.length, 9);
    assert.equal(asset.parts[0].geometry, asset.parts[1].geometry);
    for (let vertex = 0; vertex < 3; vertex++) {
      for (let component = 0; component < 3; component++) {
        const value = input.colors[vertex * (input.type === 'VEC4' ? 4 : 3) + component];
        const expected = input.normalized ? value / 255 : value;
        assert.ok(Math.abs(colors[vertex * 3 + component] - expected) < 1e-7);
      }
    }
    asset.dispose();
  }
});

test('vertex colors reject nonopaque alpha and invalid RGB factors explicitly', async () => {
  for (const [colors, type, expected] of [
    [new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 1]), 'VEC4', /Vertex alpha/],
    [new Float32Array([1, 0, 0, 0, -0.1, 0, 0, 0, 1]), 'VEC3', /COLOR_0 RGB/],
  ]) {
    await assert.rejects(parseGltf(triangleAsset((document, append) => {
      document.meshes[0].primitives[0].attributes.COLOR_0 = append(colors, type);
    })), expected);
  }
});
