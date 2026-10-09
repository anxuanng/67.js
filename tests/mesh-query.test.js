import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Matrix4 } from 'three';
import { createMeshQueryIndex, createMeshPairQuery } from '../src/mesh-query.js';
import { sphere, torus, cylinder, box as beveledBox } from '../src/geometry.js';

const identity = new Matrix4().toArray();
const translated = (x, y = 0, z = 0) => new Matrix4().makeTranslation(x, y, z).toArray();

function box(size = 1) {
  const source = new BoxGeometry(size, size, size);
  const geometry = { positions: new Float32Array(source.attributes.position.array), indices: new Uint32Array(source.index.array), uvs: new Float32Array(source.attributes.uv.array) };
  source.dispose();
  return geometry;
}

function solid(size = 1) {
  return createMeshQueryIndex(box(size), { solid: true });
}

function joined(first, second, shift) {
  const positions = new Float32Array(first.positions.length + second.positions.length);
  positions.set(first.positions);
  positions.set(second.positions, first.positions.length);
  for (let offset = first.positions.length; offset < positions.length; offset += 3) positions[offset] += shift;
  const indices = new Uint32Array(first.indices.length + second.indices.length);
  indices.set(first.indices);
  indices.set(Array.from(second.indices, index => index + first.positions.length / 3), first.indices.length);
  return { positions, indices };
}

test('closed boxes distinguish containment in both directions, crossings, contact, and separation', () => {
  const outer = solid(4);
  const inner = solid();
  const query = createMeshPairQuery(outer, inner, { mode: 'closed-solids' });
  const contained = query.evaluate(identity, identity);
  assert.equal(contained.kind, 'contained');
  assert.equal(contained.solidRelation, 'b-in-a');
  assert.ok(contained.rayAttempts > 2, 'axis ray grazes a box diagonal and is retried');
  assert.equal(createMeshPairQuery(inner, outer, { mode: 'closed-solids' }).evaluate(identity, identity).solidRelation, 'a-in-b');
  for (const offset of [2, 2.5]) {
    const contact = query.evaluate(identity, translated(offset));
    assert.equal(contact.kind, 'surface-intersection');
    assert.equal(contact.solidRelation, 'boundaries-intersect');
    assert.equal(contact.triangles.length, 2);
  }
  assert.deepEqual(query.evaluate(identity, translated(10)), { kind: 'separate', solidRelation: 'outside', triangles: null, triangleTests: 0, rayAttempts: 0 });
  const repeated = query.evaluate(identity, identity);
  assert.deepEqual(repeated, contained);
  assert.notEqual(repeated, contained);
  outer.dispose();
  inner.dispose();
});

test('surface mode supports open triangles, including coplanar contact, without a containment claim', () => {
  const triangle = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const first = createMeshQueryIndex(triangle);
  const second = createMeshQueryIndex(triangle);
  const query = createMeshPairQuery(first, second);
  assert.equal(query.evaluate(identity, translated(0.2, 0.2)).kind, 'surface-intersection');
  assert.equal(query.evaluate(identity, translated(0, 0, 1)).kind, 'surface-disjoint');
  assert.equal(query.evaluate(identity, identity).solidRelation, 'not-tested');
  assert.throws(() => createMeshPairQuery(first, second, { mode: 'closed-solids' }), /validated solid/);
  first.dispose();
  second.dispose();
});

test('ray hits retain original triangle IDs and barycentric coordinates across affine transforms', () => {
  const geometry = box();
  const index = createMeshQueryIndex(geometry, { solid: true });
  const hit = index.raycast(identity, { origin: [0.1, 0.2, 2], direction: [0, 0, -3] });
  assert.ok(Math.abs(hit.distance - 1.5) < 1e-8);
  assert.ok(Math.abs(hit.point[2] - 0.5) < 1e-8);
  assert.ok(Math.abs(hit.barycentric.reduce((sum, value) => sum + value, 0) - 1) < 1e-8);
  for (let axis = 0; axis < 3; axis++) {
    const coordinate = hit.barycentric.reduce((sum, weight, corner) => sum + weight * geometry.positions[geometry.indices[hit.triangle * 3 + corner] * 3 + axis], 0);
    assert.ok(Math.abs(coordinate - hit.point[axis]) < 1e-8);
  }
  assert.equal(index.raycast(identity, { origin: [0, 0, 2], direction: [0, 0, -1], maxDistance: 1 }), null);
  const affine = new Matrix4().makeScale(-2, 3, 0.5);
  affine.elements[4] = 0.4;
  affine.setPosition(2, -1, 4);
  const transformed = index.raycast(affine.toArray(), { origin: [2, -1, 6], direction: [0, 0, -1] });
  assert.deepEqual(transformed.point, [2, -1, 4.25]);
  assert.equal(transformed.distance, 1.75);
  assert.equal(index.info.vertexCount, 24);
  assert.equal(index.info.triangleCount, 12);
  assert.ok(Object.isFrozen(index.info));
  index.dispose();
});

test('closed queries accept reflected, rotated, nonuniform, and sheared affine transforms', () => {
  const outer = solid(4);
  const inner = solid();
  const query = createMeshPairQuery(outer, inner, { mode: 'closed-solids' });
  const matrix = new Matrix4().makeRotationY(0.4).multiply(new Matrix4().makeScale(-2, 0.5, 1.4));
  matrix.elements[4] += 0.3;
  matrix.setPosition(3, -2, 1);
  assert.equal(query.evaluate(matrix.toArray(), matrix.toArray()).solidRelation, 'b-in-a');
  assert.equal(query.evaluate(identity, identity).solidRelation, 'b-in-a');
  outer.dispose();
  inner.dispose();
});

test('exact position welding handles UV seams and leaves source arrays untouched and uncoupled', () => {
  const geometry = box();
  const positionStorage = new Float32Array(geometry.positions.length + 6);
  positionStorage.set(geometry.positions, 3);
  const indexStorage = new Uint32Array(geometry.indices.length + 4);
  indexStorage.set(geometry.indices, 2);
  geometry.positions = positionStorage.subarray(3, -3);
  geometry.indices = indexStorage.subarray(2, -2);
  const positions = new Float32Array(geometry.positions);
  const indices = new Uint32Array(geometry.indices);
  const index = createMeshQueryIndex(geometry, { solid: true });
  assert.deepEqual(geometry.positions, positions);
  assert.deepEqual(geometry.indices, indices);
  geometry.positions.fill(100);
  geometry.indices.fill(0);
  assert.equal(index.raycast(identity, { origin: [0, 0, 2], direction: [0, 0, -1] }).point[2], 0.5);
  index.dispose();
  index.dispose();
  assert.throws(() => index.raycast(identity, { origin: [0, 0, 2], direction: [0, 0, -1] }), /disposed/);
  assert.throws(() => createMeshPairQuery(index, index), /disposed/);
});

test('solid preflight rejects open, unoriented, nonmanifold, disconnected and self-crossing boundaries', () => {
  const open = box();
  open.indices = open.indices.slice(3);
  assert.throws(() => createMeshQueryIndex(open, { solid: true }), /manifold edges/);
  const reversed = box();
  [reversed.indices[0], reversed.indices[1]] = [reversed.indices[1], reversed.indices[0]];
  assert.throws(() => createMeshQueryIndex(reversed, { solid: true }), /manifold edges/);
  const duplicate = box();
  duplicate.indices = new Uint32Array([...duplicate.indices, ...duplicate.indices.slice(0, 3)]);
  assert.throws(() => createMeshQueryIndex(duplicate, { solid: true }), /manifold edges/);
  assert.throws(() => createMeshQueryIndex(joined(box(), box(), 3), { solid: true }), /connected boundary/);
  const folded = box();
  for (let offset = 0; offset < folded.positions.length; offset += 3) {
    if (folded.positions[offset] === 0.5 && folded.positions[offset + 1] === 0.5 && folded.positions[offset + 2] === 0.5) folded.positions.set([-1, -1, -1], offset);
  }
  assert.throws(() => createMeshQueryIndex(folded, { solid: true }), /intersect|overlap/);
  const valid = solid();
  valid.dispose();
});

test('budget failures unwind BVH callbacks and leave subsequent queries usable', () => {
  assert.throws(() => createMeshQueryIndex(box(), { solid: true, maxValidationPairs: 1 }), /maxValidationPairs exhausted/);
  const outer = solid(4);
  const inner = solid();
  assert.throws(() => createMeshPairQuery(outer, inner, { mode: 'closed-solids', maxTriangleTests: 1 }).evaluate(identity, identity), /maxTriangleTests exhausted/);
  const surfaces = createMeshPairQuery(outer, inner).evaluate(identity, identity);
  assert.equal(surfaces.kind, 'surface-disjoint');
  assert.throws(() => createMeshPairQuery(outer, inner, { mode: 'closed-solids', maxTriangleTests: surfaces.triangleTests + 1 }).evaluate(identity, identity), /maxTriangleTests exhausted/);
  assert.equal(createMeshPairQuery(outer, inner, { mode: 'closed-solids' }).evaluate(identity, identity).kind, 'contained');
  outer.dispose();
  inner.dispose();
});

test('closed built-in curved primitives retain seams and distinguish the torus hole from its solid interior', () => {
  for (const geometry of [sphere(12, 8), torus(0.2, 12, 8), cylinder(12, 0.025, 2), beveledBox(0.08, 2)]) {
    const index = createMeshQueryIndex(geometry, { solid: true });
    assert.ok(index.memoryPlan.validationPairs > 0);
    index.dispose();
  }
  const ring = createMeshQueryIndex(torus(0.2, 12, 8), { solid: true });
  const small = createMeshQueryIndex(sphere(12, 8), { solid: true });
  const query = createMeshPairQuery(ring, small, { mode: 'closed-solids' });
  const inHole = new Matrix4().makeScale(0.05, 0.05, 0.05);
  assert.equal(query.evaluate(identity, inHole.toArray()).kind, 'separate');
  const inTube = inHole.clone().setPosition(1, 0, 0);
  assert.equal(query.evaluate(identity, inTube.toArray()).solidRelation, 'b-in-a');
  ring.dispose();
  small.dispose();
});

test('closed topology rejects a pinched vertex even when all welded edges remain manifold', () => {
  const geometry = torus(0.2, 12, 8);
  const first = geometry.positions.slice(0, 3);
  const opposite = geometry.positions.slice(6 * 3, 6 * 3 + 3);
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    if (geometry.positions[offset] === opposite[0] && geometry.positions[offset + 1] === opposite[1] && geometry.positions[offset + 2] === opposite[2]) geometry.positions.set(first, offset);
  }
  assert.throws(() => createMeshQueryIndex(geometry, { solid: true }), /vertex link/);
});

test('input and allocation limits reject before building, including malformed deformation and triangles', () => {
  for (const options of [{ maxTriangles: 1 }, { maxVertices: 2 }, { memoryBudgetMiB: 0.0001 }, { maxValidationPairs: 0 }, { solid: 1 }, { unknown: 1 }]) assert.throws(() => createMeshQueryIndex(box(), options));
  for (const field of ['skinIndices', 'skinWeights', 'morphTargets']) assert.throws(() => createMeshQueryIndex({ ...box(), [field]: [] }), /static geometry/);
  assert.throws(() => createMeshQueryIndex({ ...box(), indices: new Uint16Array([0, 1, 2]) }), /Uint32/);
  const invalid = box();
  invalid.positions[0] = Infinity;
  assert.throws(() => createMeshQueryIndex(invalid), /finite/);
  const outOfRange = box();
  outOfRange.indices[0] = 1000;
  assert.throws(() => createMeshQueryIndex(outOfRange), /vertex count/);
  const degenerate = box();
  degenerate.indices[0] = degenerate.indices[1];
  assert.throws(() => createMeshQueryIndex(degenerate), /degenerate/);
  assert.throws(() => createMeshPairQuery({}, {}), /createMeshQueryIndex/);
});

test('numeric domains normalize tiny and huge meshes but reject singular, overflow and collapsed poses', () => {
  for (const size of [1e-30, 1e30]) {
    const outer = solid(size * 4);
    const inner = solid(size);
    assert.equal(createMeshPairQuery(outer, inner, { mode: 'closed-solids' }).evaluate(identity, identity).kind, 'contained');
    outer.dispose();
    inner.dispose();
  }
  const index = solid();
  const query = createMeshPairQuery(index, index);
  for (const matrix of [new Matrix4().makeScale(0, 1, 1), new Matrix4().makeScale(1e-50, 1, 1), new Matrix4().makeTranslation(1e20, 0, 0), new Matrix4().makeScale(3e38, 3e38, 3e38)]) assert.throws(() => query.evaluate(identity, matrix.toArray()), /singular|collapse|precision|Float32/);
  const perspective = identity.slice();
  perspective[3] = 1;
  assert.throws(() => query.evaluate(identity, perspective), /affine/);
  const nonfinite = identity.slice();
  nonfinite[0] = NaN;
  assert.throws(() => query.evaluate(nonfinite, identity), /finite Float32/);
  assert.throws(() => index.raycast(identity, { origin: [0, 0, 2], direction: [0, 0, 0] }), /nonzero/);
  assert.throws(() => index.raycast(identity, { origin: [0, 0, 1e8], direction: [0, 0, -1] }), /precision domain/);
  index.dispose();
});
