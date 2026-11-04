import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MeshoptEncoder } from 'meshoptimizer';
import { createAccessorReader } from '../src/gltf-accessors.js';
import { parseGltf } from '../src/gltf.js';

const MESHOPT = 'EXT_meshopt_compression';
const FLOAT = 5126;
const BYTE = 5120;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;

await MeshoptEncoder.ready;

function padToFour(length) {
  return Math.ceil(length / 4) * 4;
}

function bytesOf(typedArray) {
  return new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

function buildGlb(document, binary) {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = padToFour(json.length);
  const binaryLength = padToFour(binary.length);
  const glb = new Uint8Array(28 + jsonLength + binaryLength);
  const header = new DataView(glb.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, glb.length, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  glb.fill(32, 20, 20 + jsonLength);
  glb.set(json, 20);
  header.setUint32(20 + jsonLength, binaryLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  glb.set(binary, 28 + jsonLength);
  return glb.buffer;
}

function joinChunks(chunks) {
  const offsets = [];
  let length = 0;
  for (const chunk of chunks) {
    offsets.push(length);
    length += padToFour(chunk.length);
  }
  const binary = new Uint8Array(length);
  chunks.forEach((chunk, index) => binary.set(chunk, offsets[index]));
  return { binary, offsets };
}

/** A latitude and longitude sphere with unit normals. */
function sphere(rings = 12, segments = 16) {
  const positions = [];
  const normals = [];
  for (let ring = 0; ring <= rings; ring++) {
    const polar = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = (segment / segments) * Math.PI * 2;
      const normal = [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      normals.push(...normal);
      positions.push(...normal.map(value => value * 1.5));
    }
  }
  const indices = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const first = ring * (segments + 1) + segment;
      const second = first + segments + 1;
      indices.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}

/** Octahedral-encodes unit normals into four signed bytes each, through the encoder's filter. */
function octahedralNormals(normals) {
  const count = normals.length / 3;
  const withWidth = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) withWidth.set(normals.subarray(index * 3, index * 3 + 3), index * 4);
  return MeshoptEncoder.encodeFilterOct(withWidth, count, 4, 8);
}

function compressedView({ buffer = 1, data, count, byteStride, mode, filter, target }) {
  const encoded = MeshoptEncoder.encodeGltfBuffer(data, count, byteStride, mode);
  return { encoded, view: (offset) => ({ buffer, byteLength: count * byteStride, byteStride: mode === 'ATTRIBUTES' ? byteStride : undefined, target, extensions: { [MESHOPT]: { buffer: 0, byteOffset: offset, byteLength: encoded.length, byteStride, mode, count, ...(filter ? { filter } : {}) } } }) };
}

/** The same sphere, either as plain buffer views or as one meshopt-compressed GLB (positions, octahedral normals, triangle indices). */
function sphereGlb({ compressed, fallback = 'zero' }) {
  const mesh = sphere();
  const vertexCount = mesh.positions.length / 3;
  const normalBytes = compressed ? octahedralNormals(mesh.normals) : bytesOf(mesh.normals);
  const base = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }] };
  const normalAccessor = compressed
    ? { bufferView: 1, componentType: BYTE, normalized: true, count: vertexCount, type: 'VEC3' }
    : { bufferView: 1, componentType: FLOAT, count: vertexCount, type: 'VEC3' };
  const accessors = [
    { bufferView: 0, componentType: FLOAT, count: vertexCount, type: 'VEC3', min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] },
    normalAccessor,
    { bufferView: 2, componentType: UNSIGNED_SHORT, count: mesh.indices.length, type: 'SCALAR' },
  ];
  if (!compressed) {
    const { binary, offsets } = joinChunks([bytesOf(mesh.positions), normalBytes, bytesOf(mesh.indices)]);
    const bufferViews = [
      { buffer: 0, byteOffset: offsets[0], byteLength: mesh.positions.byteLength, byteStride: 12 },
      { buffer: 0, byteOffset: offsets[1], byteLength: normalBytes.length, byteStride: 12 },
      { buffer: 0, byteOffset: offsets[2], byteLength: mesh.indices.byteLength },
    ];
    return buildGlb({ ...base, accessors, bufferViews, buffers: [{ byteLength: binary.length }] }, binary);
  }
  const position = compressedView({ data: bytesOf(mesh.positions), count: vertexCount, byteStride: 12, mode: 'ATTRIBUTES' });
  const normal = compressedView({ data: normalBytes, count: vertexCount, byteStride: 4, mode: 'ATTRIBUTES', filter: 'OCTAHEDRAL' });
  const index = compressedView({ data: bytesOf(mesh.indices), count: mesh.indices.length, byteStride: 2, mode: 'TRIANGLES' });
  const { binary, offsets } = joinChunks([position.encoded, normal.encoded, index.encoded]);
  const fallbackBuffer = { byteLength: 1 << 20, extensions: { [MESHOPT]: { fallback: true } } };
  if (fallback === 'unreachable') fallbackBuffer.uri = 'fallback.bin';
  const document = {
    ...base,
    accessors,
    bufferViews: [position.view(offsets[0]), normal.view(offsets[1]), index.view(offsets[2])],
    buffers: [{ byteLength: binary.length }, fallbackBuffer],
    extensionsUsed: [MESHOPT, 'KHR_mesh_quantization'],
    extensionsRequired: [MESHOPT, 'KHR_mesh_quantization'],
  };
  return buildGlb(document, binary);
}

/** The triangle codec may rotate the corners of a triangle, so triangles compare by their corners starting from the lowest index. */
function triangleKeys(indices) {
  const keys = [];
  for (let start = 0; start < indices.length; start += 3) {
    const corners = [indices[start], indices[start + 1], indices[start + 2]];
    const lowest = corners.indexOf(Math.min(...corners));
    keys.push([0, 1, 2].map(offset => corners[(lowest + offset) % 3]).join(','));
  }
  return keys.sort();
}

test('a meshopt-compressed GLB decodes without any decoder option and matches the uncompressed geometry', async () => {
  const plain = await parseGltf(sphereGlb({ compressed: false }));
  const compressed = await parseGltf(sphereGlb({ compressed: true }));
  const expected = plain.parts[0].geometry;
  const actual = compressed.parts[0].geometry;
  assert.deepEqual(Array.from(actual.positions), Array.from(expected.positions));
  assert.deepEqual(triangleKeys(actual.indices), triangleKeys(expected.indices));
  assert.equal(actual.normals.length, expected.normals.length);
  for (let index = 0; index < expected.normals.length; index += 3) {
    const alignment = actual.normals[index] * expected.normals[index] + actual.normals[index + 1] * expected.normals[index + 1] + actual.normals[index + 2] * expected.normals[index + 2];
    assert.ok(alignment > 0.995, `normal ${index / 3} is within about 5 degrees of the source`);
  }
});

test('a fallback buffer that is absent, zero-filled in the file or an unreachable uri is never read', async () => {
  for (const fallback of ['zero', 'unreachable']) {
    const asset = await parseGltf(sphereGlb({ compressed: true, fallback }));
    assert.ok(asset.parts[0].geometry.positions.length > 0, fallback);
  }
});

test('a compressed buffer view that cannot be decoded names the extension', async () => {
  const glb = new Uint8Array(sphereGlb({ compressed: true }));
  const binaryStart = 28 + new DataView(glb.buffer).getUint32(12, true);
  glb.fill(0xff, binaryStart, binaryStart + 64);
  await assert.rejects(parseGltf(glb.buffer), /EXT_meshopt_compression could not decode a buffer view/);
});

test('a caller supplied decoder still takes the place of the built-in one', async () => {
  let calls = 0;
  const supplied = {
    ready: Promise.resolve(),
    decodeGltfBuffer() {
      calls++;
      throw new Error('stand-in');
    },
  };
  await assert.rejects(parseGltf(sphereGlb({ compressed: true }), { decoders: { meshopt: supplied } }), /stand-in/);
  assert.equal(calls, 1);
});

/** Reads one accessor through a compressed view of the given mode and filter. */
async function readThroughMeshopt({ data, count, byteStride, mode, filter, accessor }) {
  const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
  const { encoded, view } = compressedView({ data, count, byteStride, mode, filter });
  const document = { accessors: [{ bufferView: 0, count, ...accessor }], bufferViews: [view(0)], buffers: [{ byteLength: encoded.length }, { byteLength: count * byteStride }] };
  const reader = createAccessorReader(document, index => (index === 0 ? encoded : null), MeshoptDecoder);
  await reader.prepare();
  return reader.readAccessor(0).array;
}

test('the OCTAHEDRAL filter returns unit normals', async () => {
  const normals = sphere(6, 8).normals;
  const count = normals.length / 3;
  const decoded = await readThroughMeshopt({ data: octahedralNormals(normals), count, byteStride: 4, mode: 'ATTRIBUTES', filter: 'OCTAHEDRAL', accessor: { componentType: BYTE, normalized: true, type: 'VEC3' } });
  assert.equal(decoded.length, count * 3);
  for (let index = 0; index < count; index++) {
    const x = decoded[index * 3] / 127;
    const y = decoded[index * 3 + 1] / 127;
    const z = decoded[index * 3 + 2] / 127;
    const length = Math.hypot(x, y, z);
    const alignment = (x * normals[index * 3] + y * normals[index * 3 + 1] + z * normals[index * 3 + 2]) / length;
    assert.ok(alignment > 0.995, `normal ${index}`);
  }
});

test('the QUATERNION filter returns a rotation equal to the source', async () => {
  const half = Math.PI / 5;
  const source = new Float32Array([Math.sin(half) * 0.6, Math.sin(half) * 0.8, 0, Math.cos(half), 0, 0, 0, 1]);
  const filtered = MeshoptEncoder.encodeFilterQuat(source, 2, 8, 16);
  const decoded = await readThroughMeshopt({ data: filtered, count: 2, byteStride: 8, mode: 'ATTRIBUTES', filter: 'QUATERNION', accessor: { componentType: SHORT, normalized: true, type: 'VEC4' } });
  for (let element = 0; element < 2; element++) {
    let alignment = 0;
    for (let lane = 0; lane < 4; lane++) alignment += (decoded[element * 4 + lane] / 32767) * source[element * 4 + lane];
    assert.ok(Math.abs(alignment) > 0.9999, `quaternion ${element}`);
  }
});

test('the EXPONENTIAL filter returns floats close to the source', async () => {
  const source = new Float32Array([0.5, -12.25, 300.125, 1e-3, 7, -0.75]);
  const filtered = MeshoptEncoder.encodeFilterExp(source, 2, 12, 16);
  const decoded = await readThroughMeshopt({ data: filtered, count: 2, byteStride: 12, mode: 'ATTRIBUTES', filter: 'EXPONENTIAL', accessor: { componentType: FLOAT, type: 'VEC3' } });
  source.forEach((value, index) => assert.ok(Math.abs(decoded[index] - value) <= Math.abs(value) * 1e-3 + 1e-3, `value ${index}`));
});

test('the INDICES mode returns the same index sequence', async () => {
  const indices = Uint16Array.from({ length: 300 }, (_, index) => (index * 7) % 91);
  const decoded = await readThroughMeshopt({ data: bytesOf(indices), count: indices.length, byteStride: 2, mode: 'INDICES', accessor: { componentType: UNSIGNED_SHORT, type: 'SCALAR' } });
  assert.deepEqual(Array.from(decoded), Array.from(indices));
});

test('the public showcase and sample GLBs load without a decoder option', async () => {
  globalThis.createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });
  const bytes = await readFile(new URL('../public/wall-e.glb', import.meta.url));
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  assert.ok(asset.parts.length > 0);
});
