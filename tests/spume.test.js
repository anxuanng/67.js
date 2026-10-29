import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSprayGeometry, createSpumePlayer, decodeSpumeFrame, float16ToFloat32, frameFileName, loadSpumeCache } from '../src/spume.js';

// Mirrors spume/export.py encode_mesh_frame: int16 positions over the frame bounds, int8 normals.
function encodeSpumeFrame(vertices, normals, indices) {
  const minimum = [0, 1, 2].map(axis => Math.min(...vertices.filter((_, index) => index % 3 === axis)));
  const maximum = [0, 1, 2].map(axis => Math.max(...vertices.filter((_, index) => index % 3 === axis)));
  const span = maximum.map((value, axis) => Math.max(value - minimum[axis], 1e-6));
  const quantised = Int16Array.from(vertices, (value, index) => Math.round((value - minimum[index % 3]) / span[index % 3] * 65535 - 32768));
  const packedNormals = Int8Array.from(normals, value => Math.round(Math.max(-1, Math.min(1, value)) * 127));
  const padded = (bytes) => {
    const result = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    result.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return result;
  };
  const indexBytes = padded(Uint16Array.from(indices));
  const positionBytes = padded(quantised);
  const normalBytes = padded(packedNormals);
  const description = {
    asset: { version: '2.0', generator: 'spume' },
    buffers: [{ byteLength: indexBytes.length + positionBytes.length + normalBytes.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: indexBytes.length },
      { buffer: 0, byteOffset: indexBytes.length, byteLength: positionBytes.length },
      { buffer: 0, byteOffset: indexBytes.length + positionBytes.length, byteLength: normalBytes.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5123, count: indices.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5122, count: vertices.length / 3, type: 'VEC3', min: minimum, max: maximum },
      { bufferView: 2, componentType: 5120, normalized: true, count: vertices.length / 3, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  let json = new TextEncoder().encode(JSON.stringify(description));
  json = padded(Uint8Array.from([...json, ...new Array((4 - json.length % 4) % 4).fill(32)]));
  const binary = new Uint8Array([...indexBytes, ...positionBytes, ...normalBytes]);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  view.setUint32(20 + json.length, binary.length, true);
  view.setUint32(24 + json.length, 0x004e4942, true);
  glb.set(binary, 28 + json.length);
  return glb.buffer;
}

function float16Bits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const bits = view.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const fraction = (bits >>> 13) & 0x3ff;
  if (value === 0) return sign;
  return sign | (exponent << 10) | fraction;
}

function syntheticCache() {
  const triangle = [0, 0, 0, 2, 0, 0, 0, 3, -1];
  const frames = [
    encodeSpumeFrame(triangle, [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]),
    encodeSpumeFrame(triangle.map(value => value * 2), [0, 1, 0, 0, 1, 0, 0, 1, 0], [0, 2, 1]),
  ];
  const points = [[1, 2, 3, 0, 1, 0], [-1, 0.5, 0.25, 0, 0, 0], [0, 4, 0, 0, 0, 0]];
  const spray = Uint16Array.from(points.flat(), float16Bits);
  const files = {
    'meta.json': new TextEncoder().encode(JSON.stringify({
      name: 'jet', fps: 30, frameCount: 2, frameFile: 'frame_%04d.glb',
      spray: { file: 'spray.bin', floatsPerPoint: 6, dtype: 'float16', ids: 'spray_ids.bin', kinds: 'spray_kinds.bin', index: [[0, 0], [0, 3]] },
    })).buffer,
    'frame_0000.glb': frames[0],
    'frame_0001.glb': frames[1],
    'spray.bin': spray.buffer,
    'spray_ids.bin': Uint32Array.from([7, 8, 9]).buffer,
    'spray_kinds.bin': Uint8Array.from([0, 1, 2]).buffer,
  };
  return async (name) => files[name] ?? null;
}

test('decodes Spume frames back to metres within one int16 step', () => {
  const vertices = [-0.4, 0.019, 1.5, 3.25, 7.75, -2.5, 0.125, 2, 0];
  const geometry = decodeSpumeFrame(encodeSpumeFrame(vertices, [1, 0, 0, 0, -1, 0, 0.6, 0.8, 0], [0, 1, 2]));
  const step = 10.5 / 65535;
  geometry.positions.forEach((value, index) => assert.ok(Math.abs(value - vertices[index]) <= step, `position ${index}`));
  assert.ok(geometry.positions instanceof Float32Array && geometry.normals instanceof Float32Array && geometry.indices instanceof Uint32Array);
  assert.deepEqual(Array.from(geometry.indices), [0, 1, 2]);
  for (let vertex = 0; vertex < 9; vertex += 3) {
    assert.ok(Math.abs(Math.hypot(geometry.normals[vertex], geometry.normals[vertex + 1], geometry.normals[vertex + 2]) - 1) < 1e-6);
  }
  assert.ok(Math.abs(geometry.normals[6] - 0.6) < 0.01 && Math.abs(geometry.normals[7] - 0.8) < 0.01);
});

test('rejects frames that are not Spume binary glTF', () => {
  assert.throws(() => decodeSpumeFrame(new ArrayBuffer(40)), /binary glTF/);
});

test('float16 decoding covers normal, subnormal and signed values', () => {
  assert.equal(float16ToFloat32(0x3c00), 1);
  assert.equal(float16ToFloat32(0xc000), -2);
  assert.equal(float16ToFloat32(0x0001), 2 ** -24);
  assert.equal(float16ToFloat32(0x7c00), Infinity);
});

test('loads a cache through a read function and plays frames by time', async () => {
  const cache = await loadSpumeCache(syntheticCache());
  assert.equal(cache.frames.length, 2);
  assert.equal(cache.duration, 2 / 30);
  assert.equal(frameFileName(cache.meta, 1), 'frame_0001.glb');
  const player = createSpumePlayer(cache, { cachedFrames: 1 });
  assert.equal(player.frameIndexAt(-1), 0);
  assert.equal(player.frameIndexAt(1 / 30), 1);
  assert.equal(player.frameIndexAt(10), 1);
  const first = player.partsAt(0);
  assert.equal(first.length, 1, 'frame 0 has no whitewater, so only the liquid part is returned');
  assert.equal(first[0].material.tag, 'liquid');
  const second = player.partsAt(0.04);
  assert.equal(second.length, 2);
  assert.equal(second[1].castShadow, false);
  assert.equal(player.partsAt(0.05), second, 'the most recent frame is reused without decoding again');
  assert.ok(Math.abs(second[0].geometry.positions[7] - 6) < 1e-3);
  const looping = createSpumePlayer(cache, { loop: true });
  assert.equal(looping.frameIndexAt(2 / 30), 0);
});

test('whitewater becomes octahedra filtered by kind and capped evenly', async () => {
  const cache = await loadSpumeCache(syntheticCache());
  assert.equal(buildSprayGeometry(cache, 0), null);
  const defaults = buildSprayGeometry(cache, 1);
  assert.equal(defaults.positions.length / 18, 2, 'bubbles are hidden by default');
  assert.equal(defaults.indices.length, 2 * 24);
  const all = buildSprayGeometry(cache, 1, { kinds: ['spray', 'foam', 'bubble'], radius: 0.1 });
  assert.equal(all.positions.length / 18, 3);
  const center = [0, 1, 2].map(axis => (all.positions[axis] + all.positions[3 + axis]) / 2);
  center.forEach((value, axis) => assert.ok(Math.abs(value - [1, 2, 3][axis]) < 1e-6));
  const capped = buildSprayGeometry(cache, 1, { kinds: ['spray', 'foam', 'bubble'], maxPoints: 1 });
  assert.equal(capped.positions.length / 18, 1);
  assert.throws(() => buildSprayGeometry(cache, 1, { kinds: ['mist'] }), /Unknown spray kind/);
});
