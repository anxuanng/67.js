import assert from 'node:assert/strict';
import test from 'node:test';
import { lathe, extrude, tube } from '../src/modeling.js';
import { torus } from '../src/geometry.js';

function validate(mesh) {
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.normals instanceof Float32Array);
  assert.ok(mesh.uvs instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.equal(mesh.uvs.length, mesh.positions.length / 3 * 2);
  for (const values of [mesh.positions, mesh.normals, mesh.uvs]) assert.ok(values.every(Number.isFinite));
  for (let index = 0; index < mesh.normals.length; index += 3) assert.ok(Math.abs(Math.hypot(...mesh.normals.subarray(index, index + 3)) - 1) < 1e-6);
  for (const index of mesh.indices) assert.ok(index < mesh.positions.length / 3);
}

function signedVolume(mesh) {
  let volume = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = mesh.indices[index] * 3;
    const b = mesh.indices[index + 1] * 3;
    const c = mesh.indices[index + 2] * 3;
    const p = mesh.positions;
    volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
      p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return volume;
}

test('lathe produces shared indexed geometry with normalized normals and UV seam', () => {
  const mesh = lathe([[0, 0], [1, 0], [1, 2], [0, 2]], { segments: 128 });
  validate(mesh);
  assert.equal(mesh.positions.length / 3, 129 * 4);
  assert.ok(Math.abs(signedVolume(mesh) - Math.PI * 2) < 0.004);
  assert.equal(mesh.uvs[0], 0);
  assert.equal(mesh.uvs.at(-2), 1);
  const partial = lathe([[1, 0], [1, 2]], { segments: 8, sweep: Math.PI });
  assert.equal(partial.positions.length / 3, 18);
  validate(partial);
});

test('concave extrusion and holes retain literal area, depth and outward winding', () => {
  const contour = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  const concave = extrude(contour, { depth: 2 });
  validate(concave);
  assert.ok(Math.abs(signedVolume(concave) - 10) < 1e-6);
  const outer = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
  const hole = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
  const hollow = extrude(outer, { holes: [hole], depth: 0.5 });
  validate(hollow);
  assert.ok(Math.abs(signedVolume(hollow) - 6) < 1e-6);
  const reversed = extrude([...outer].reverse(), { holes: [[...hole].reverse()], depth: 0.5 });
  assert.ok(Math.abs(signedVolume(reversed) - 6) < 1e-6);
  assert.deepEqual(contour, [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]);
});

test('beveled extrusion has finite geometry and extends its end caps by the requested thickness', () => {
  const mesh = extrude([[-1, -1], [1, -1], [1, 1], [-1, 1]], { depth: 0.5, bevel: 0.1, bevelSegments: 6 });
  validate(mesh);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = 2; index < mesh.positions.length; index += 3) {
    minimum = Math.min(minimum, mesh.positions[index]);
    maximum = Math.max(maximum, mesh.positions[index]);
  }
  assert.ok(Math.abs(minimum + 0.1) < 1e-6);
  assert.ok(Math.abs(maximum - 0.6) < 1e-6);
  assert.ok(signedVolume(mesh) > 2);
});

test('tube follows straight and closed paths with retained topology and finite seam data', () => {
  const straight = tube([[0, 0, 0], [0, 2, 0]], { radius: 0.2, segments: 16, radialSegments: 24 });
  validate(straight);
  for (let index = 0; index < straight.positions.length; index += 3) {
    assert.ok(Math.abs(Math.hypot(straight.positions[index], straight.positions[index + 2]) - 0.2) < 1e-6);
  }
  const closed = tube([[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]], { closed: true, segments: 48 });
  validate(closed);
  const first = closed.positions.subarray(0, 39);
  const last = closed.positions.subarray(closed.positions.length - 39);
  for (let index = 0; index < first.length; index++) assert.ok(Math.abs(first[index] - last[index]) < 1e-6);
});

test('invalid topology and allocation requests fail before generating a mesh', () => {
  assert.throws(() => lathe([[1, 0], [1, 1]], { segments: 2048, maxVertices: 100 }), /maxVertices/);
  assert.throws(() => lathe([[-1, 0], [1, 1]]), /radii/);
  assert.throws(() => lathe([[1, 0], [1, 0]]), /duplicate/);
  assert.throws(() => tube([[0, 0, 0], [1, 0, 0]], { radius: 0 }), /radius/);
  assert.throws(() => tube([[0, 0, 0], [1, 0, 0]], { closed: true }), /points/);
  assert.throws(() => extrude([[0, 0], [2, 2], [0, 2], [2, 0]]), /intersect/);
  assert.throws(() => extrude([[0, 0], [1, 0], [2, 0]]), /area/);
  const contour = [[0, 0], [4, 0], [4, 4], [0, 4]];
  assert.throws(() => extrude(contour, { holes: [[[3, 3], [5, 3], [5, 5], [3, 5]]] }), /inside/);
  const hole = [[1, 1], [2, 1], [2, 2], [1, 2]];
  assert.throws(() => extrude(contour, { holes: [hole, hole] }), /overlap/);
  assert.throws(() => extrude(contour, { steps: 256, maxVertices: 100 }), /maxVertices/);
  assert.throws(() => extrude([[0, 0], [Infinity, 0], [0, 1]]), /finite/);
});

test('Float32 collapse is rejected and large lathe angles retain drawable geometry', () => {
  assert.throws(() => tube([[1e10, 0, 1e10], [1e10, 2, 1e10]], { radius: 0.1, segments: 8, radialSegments: 8 }), /collapsed/);
  const largeAngle = lathe([[1, 0], [1, 2]], { startAngle: 1e20, segments: 8 });
  validate(largeAngle);
  const reference = lathe([[1, 0], [1, 2]], { startAngle: 1e20 % (Math.PI * 2), segments: 8 });
  assert.deepEqual(largeAngle.positions, reference.positions);
  assert.throws(() => extrude([[0, 0], [1, 0], [0, 1]], { depth: 1e-50 }), /positive/);
});

test('torus maps cover both surface seams and partial arc caps', () => {
  for (const arc of [Math.PI * 2, Math.PI]) {
    const mesh = torus(0.08, 16, 8, arc);
    validate(mesh);
    assert.equal(mesh.uvs[0], 0);
    assert.equal(mesh.uvs[16 * 2], 1);
    assert.ok(mesh.uvs.every(value => value >= 0 && value <= 1));
    if (arc === Math.PI) assert.deepEqual(Array.from(mesh.uvs.subarray(17 * 9 * 2, 17 * 9 * 2 + 2)), [0.5, 0.5]);
  }
});

test('extrude stays closed when hole edges line up with each other', () => {
  const rectangle = (minimumX, minimumY, maximumX, maximumY) => [[minimumX, minimumY], [maximumX, minimumY], [maximumX, maximumY], [minimumX, maximumY]];
  const contour = rectangle(-0.5, 0, 0.5, 1.2);
  const panes = [rectangle(-0.44, 0.06, -0.03, 0.57), rectangle(0.03, 0.06, 0.44, 0.57), rectangle(-0.44, 0.63, -0.03, 1.14), rectangle(0.03, 0.63, 0.44, 1.14)];
  for (const options of [{ depth: 0.08 }, { depth: 0.08, steps: 3 }, { depth: 0.08, bevel: 0.005, bevelSegments: 2 }]) {
    const geometry = extrude(contour, { holes: panes, ...options });
    const uses = new Map();
    const keyOf = vertex => Array.from(geometry.positions.subarray(vertex * 3, vertex * 3 + 3)).join(',');
    for (let offset = 0; offset < geometry.indices.length; offset += 3) {
      for (let side = 0; side < 3; side++) {
        const edge = [keyOf(geometry.indices[offset + side]), keyOf(geometry.indices[offset + (side + 1) % 3])].sort().join('|');
        uses.set(edge, (uses.get(edge) ?? 0) + 1);
      }
    }
    assert.deepEqual([...uses.values()].filter(count => count !== 2), [], JSON.stringify(options));
    assert.equal(geometry.positions.length / 3, geometry.normals.length / 3);
    assert.equal(geometry.positions.length / 3, geometry.uvs.length / 2);
  }
  const plain = extrude(contour, { holes: panes, depth: 0.08 });
  let volume = 0;
  for (let offset = 0; offset < plain.indices.length; offset += 3) {
    const [first, second, third] = [0, 1, 2].map(side => Array.from(plain.positions.subarray(plain.indices[offset + side] * 3, plain.indices[offset + side] * 3 + 3)));
    volume += (first[0] * (second[1] * third[2] - second[2] * third[1]) - first[1] * (second[0] * third[2] - second[2] * third[0]) + first[2] * (second[0] * third[1] - second[1] * third[0])) / 6;
  }
  assert.ok(Math.abs(volume - 0.029088) < 1e-5, `volume ${volume}`);
});
