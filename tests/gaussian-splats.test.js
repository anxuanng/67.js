import assert from 'node:assert/strict';
import test from 'node:test';
import { createGaussianSplats, parseGaussianSplatPly } from '../src/gaussian-splats.js';
import { createSplatSorter } from '../src/gaussian-splat-sort.js';

const PROPERTIES = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

// splats: arrays of the 14 values in PROPERTIES order
function buildPly(splats, { properties = PROPERTIES, format = 'binary_little_endian', extraBytes = 0 } = {}) {
  const header = ['ply', `format ${format} 1.0`, `element vertex ${splats.length}`, ...properties.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const body = new Float32Array(splats.length * properties.length + extraBytes / 4);
  splats.forEach((values, index) => body.set(values, index * properties.length));
  const file = new Uint8Array(headerBytes.length + body.byteLength);
  file.set(headerBytes, 0);
  file.set(new Uint8Array(body.buffer), headerBytes.length);
  return file.buffer;
}

const IDENTITY_SPLAT = (x, y, z) => [x, y, z, 0, 0, 0, 0, Math.log(0.1), Math.log(0.2), Math.log(0.3), 1, 0, 0, 0];

test('parses positions, colour, opacity, scale and rotation of a synthetic PLY', () => {
  const data = parseGaussianSplatPly(buildPly([IDENTITY_SPLAT(1, 2, 3), [-1, 0, 4, 1, -1, 0, 3, 0, 0, 0, 2, 0, 0, 0]]));
  assert.equal(data.count, 2);
  assert.deepEqual(Array.from(data.positions), [1, 2, 3, -1, 0, 4]);
  assert.deepEqual(data.bounds, { minimum: [-1, 0, 3], maximum: [1, 2, 4] });
  assert.deepEqual(Array.from(data.colors.subarray(0, 4)), [128, 128, 128, 128]);
  const bright = 0.5 + 0.28209479177387814;
  assert.equal(data.colors[4], Math.round(bright * 255));
  assert.equal(data.colors[5], Math.round((0.5 - 0.28209479177387814) * 255));
  assert.equal(data.colors[7], Math.round(255 / (1 + Math.exp(-3))));
  assert.deepEqual(Array.from(data.scales.subarray(0, 3)).map(value => Number(value.toFixed(4))), [0.1, 0.2, 0.3]);
  assert.deepEqual(Array.from(data.rotations.subarray(4, 8)), [1, 0, 0, 0], 'a rotation of length 2 is normalised');
});

test('accepts properties in any order and extra properties such as normals and harmonics', () => {
  const properties = ['nx', 'f_rest_0', ...PROPERTIES.slice().reverse()];
  const values = [9, 9, ...IDENTITY_SPLAT(5, 6, 7).reverse()];
  const data = parseGaussianSplatPly(buildPly([values], { properties }));
  assert.deepEqual(Array.from(data.positions), [5, 6, 7]);
});

test('rejects files that are not 3DGS PLY with a clear message', () => {
  assert.throws(() => parseGaussianSplatPly(new TextEncoder().encode('hello').buffer), /Not a PLY file/);
  assert.throws(() => parseGaussianSplatPly(buildPly([IDENTITY_SPLAT(0, 0, 0)], { format: 'ascii' })), /binary_little_endian/);
  assert.throws(() => parseGaussianSplatPly(buildPly([IDENTITY_SPLAT(0, 0, 0).slice(0, 13)], { properties: PROPERTIES.slice(0, 13) })), /lacks the properties rot_3/);
  const truncated = buildPly([IDENTITY_SPLAT(0, 0, 0), IDENTITY_SPLAT(1, 1, 1)]).slice(0, -8);
  assert.throws(() => parseGaussianSplatPly(truncated), /truncated/);
  assert.throws(() => parseGaussianSplatPly(buildPly([IDENTITY_SPLAT(NaN, 0, 0)])), /non-finite position/);
});

test('enforces the byte and splat count limits before reading splats', () => {
  const file = buildPly([IDENTITY_SPLAT(0, 0, 0), IDENTITY_SPLAT(1, 0, 0), IDENTITY_SPLAT(2, 0, 0)]);
  assert.throws(() => parseGaussianSplatPly(file, { maximumCount: 2 }), /holds 3 splats, over the limit of 2/);
  assert.throws(() => parseGaussianSplatPly(file, { maximumBytes: 100 }), RangeError);
  assert.throws(() => parseGaussianSplatPly(file, { maximumBytes: 100 }), /over the limit of 100/);
  assert.equal(parseGaussianSplatPly(file, { maximumCount: 3 }).count, 3);
  assert.throws(() => parseGaussianSplatPly(file, { maximumCount: 0 }), /positive/);
});

test('the count limit applies to a header that claims more splats than the file holds', () => {
  const header = ['ply', 'format binary_little_endian 1.0', 'element vertex 99999999', ...PROPERTIES.map(name => `property float ${name}`), 'end_header', ''].join('\n');
  assert.throws(() => parseGaussianSplatPly(new TextEncoder().encode(header).buffer), /holds 99999999 splats/);
});

test('createGaussianSplats packs position, colour and covariance and limits the count', () => {
  const data = parseGaussianSplatPly(buildPly([IDENTITY_SPLAT(1, 2, 3)]));
  const splats = createGaussianSplats(data);
  const floats = new Float32Array(splats.packed.words.buffer);
  assert.deepEqual(Array.from(floats.subarray(0, 3)), [1, 2, 3]);
  const [xx, xy, xz, yy, yz, zz] = Array.from(floats.subarray(4, 10)).map(value => Number(value.toFixed(5)));
  assert.deepEqual([xx, xy, xz, yy, yz, zz], [0.01, 0, 0, 0.04, 0, 0.09]);
  assert.throws(() => createGaussianSplats(data, { maximumCount: 0 }), /over the limit/);
  assert.throws(() => createGaussianSplats(data, { matrix: [1, 2, 3] }), /16 finite/);
});

test('a rotated splat has a rotated covariance', () => {
  const quarterTurnAboutZ = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const splat = [0, 0, 0, 0, 0, 0, 0, Math.log(1), Math.log(2), Math.log(1), ...quarterTurnAboutZ];
  const floats = new Float32Array(createGaussianSplats(parseGaussianSplatPly(buildPly([splat]))).packed.words.buffer);
  const [xx, , , yy] = Array.from(floats.subarray(4, 8));
  assert.ok(Math.abs(xx - 4) < 1e-5 && Math.abs(yy - 1) < 1e-5, `the long axis turned from y to x, got xx ${xx} yy ${yy}`);
});

// A camera at the origin looking down -z: the model-view is the identity, and depth is the negative z.
const IDENTITY_VIEW = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

function sorterFor(points) {
  const positions = Float32Array.from(points.flat());
  const minimum = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])));
  const maximum = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])));
  return createSplatSorter(positions, points.length, { minimum, maximum });
}

test('sorts splats from the farthest to the nearest and drops those behind the camera', () => {
  const sorter = sorterFor([[0, 0, -2], [0, 0, -9], [0, 0, 3], [0, 0, -5], [1, 0, -0.5]]);
  const { order, visibleCount, changed } = sorter.sort(IDENTITY_VIEW);
  assert.equal(changed, true);
  assert.equal(visibleCount, 4);
  assert.deepEqual(Array.from(order.subarray(0, visibleCount)), [1, 3, 0, 4]);
});

test('sort orders by view depth, not by distance to the eye', () => {
  const sorter = sorterFor([[100, 0, -3], [0, 0, -4]]);
  assert.deepEqual(Array.from(sorter.sort(IDENTITY_VIEW).order.subarray(0, 2)), [1, 0]);
});

test('sort follows the camera: turning the view around reverses the order', () => {
  const sorter = sorterFor([[0, 0, -2], [0, 0, 2], [0, 0, -6], [0, 0, 6]]);
  assert.deepEqual(Array.from(sorter.sort(IDENTITY_VIEW).order.subarray(0, 2)), [2, 0]);
  const halfTurn = Float32Array.of(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1);
  const turned = sorter.sort(halfTurn);
  assert.equal(turned.changed, true);
  assert.deepEqual(Array.from(turned.order.subarray(0, turned.visibleCount)), [3, 1]);
});

test('sort reports no change for an unchanged view depth axis and keeps the order', () => {
  const sorter = sorterFor([[0, 0, -2], [0, 0, -6]]);
  sorter.sort(IDENTITY_VIEW);
  const sidestep = Float32Array.from(IDENTITY_VIEW);
  sidestep[12] = 5;
  const second = sorter.sort(sidestep);
  assert.equal(second.changed, false);
  assert.deepEqual(Array.from(second.order.subarray(0, 2)), [1, 0]);
});

test('sort handles splats at the same depth and a single splat', () => {
  const equal = sorterFor([[0, 0, -3], [1, 0, -3], [2, 0, -3]]).sort(IDENTITY_VIEW);
  assert.equal(equal.visibleCount, 3);
  assert.deepEqual(Array.from(equal.order.subarray(0, 3)).sort(), [0, 1, 2]);
  assert.equal(sorterFor([[0, 0, -3]]).sort(IDENTITY_VIEW).visibleCount, 1);
});

test('200,000 random splats sort back to front', () => {
  const count = 200_000;
  const positions = new Float32Array(count * 3);
  let seed = 12345;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let index = 0; index < count; index++) positions.set([next() * 20 - 10, next() * 20 - 10, -next() * 50], index * 3);
  const sorter = createSplatSorter(positions, count, { minimum: [-10, -10, -50], maximum: [10, 10, 0] });
  const { order, visibleCount } = sorter.sort(IDENTITY_VIEW);
  assert.equal(visibleCount, count);
  const stepSize = 50 / 65535;
  for (let index = 1; index < visibleCount; index++) {
    const previous = positions[order[index - 1] * 3 + 2];
    const current = positions[order[index] * 3 + 2];
    assert.ok(previous <= current + stepSize, `splat ${index} is farther than the one drawn before it`);
  }
});
