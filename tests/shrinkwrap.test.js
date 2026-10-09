import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { sphere, box } from '../src/geometry.js';
import { createMeshQueryIndex } from '../src/mesh-query.js';
import { shrinkwrapGeometry } from '../src/shrinkwrap.js';
import { sculptGeometry } from '../src/sculpt.js';

test('projected queries keep inside-bound hits and prune distant stacked surfaces', () => {
  const positions = [];
  const indices = [];
  for (let layer = 1; layer <= 32; layer++) {
    const offset = positions.length / 3;
    positions.push(-1, -1, layer, 1, -1, layer, 1, 1, layer, -1, 1, layer);
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
  const index = createMeshQueryIndex({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
  const inside = index.project({ origin: [0.1, 0.2, 1.5], direction: [0, 0, 1], maxDistance: 0.5 });
  assert.equal(inside.hit.distance, 0.5);
  assert.equal(inside.hit.point[2], 2);
  const outside = index.project({ origin: [0.1, 0.2, 0], direction: [0, 0, 1] });
  assert.equal(outside.hit.distance, 1);
  assert.ok(outside.triangleTests < indices.length / 3);
  const miss = index.project({ origin: [0.1, 0.2, 33], direction: [0, 0, 1] });
  assert.equal(miss.hit, null);
  assert.equal(miss.triangleTests, 0);
  index.dispose();
});

function plane(z = 0, extent = 1) {
  return {
    positions: new Float32Array([-extent, -extent, z, extent, -extent, z, extent, extent, z, -extent, extent, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]),
  };
}

function unitNormals(geometry) {
  for (let offset = 0; offset < geometry.normals.length; offset += 3) assert.ok(Math.abs(Math.hypot(...geometry.normals.subarray(offset, offset + 3)) - 1) < 1e-6);
}

test('nearest and directional projection wrap to a literal plane with physical clearance', () => {
  for (const mode of ['nearest', 'project']) {
    const source = plane(1, 0.3);
    const target = plane(0, 2);
    const snapshot = structuredClone(source);
    const targetSnapshot = structuredClone(target);
    const options = { mode, clearance: 0.125, maxDistance: 1 };
    if (mode === 'project') options.direction = [0, 0, -1];
    const { geometry, stats } = shrinkwrapGeometry(source, target, options);
    assert.deepEqual(stats.queriedVertices, 4);
    assert.equal(stats.matchedVertices, 4);
    assert.equal(stats.missedVertices, 0);
    assert.ok(stats.triangleTests > 0);
    for (let offset = 0; offset < source.positions.length; offset += 3) {
      assert.equal(geometry.positions[offset], source.positions[offset]);
      assert.equal(geometry.positions[offset + 1], source.positions[offset + 1]);
      assert.equal(geometry.positions[offset + 2], 0.125);
    }
    assert.deepEqual(geometry.indices, source.indices);
    assert.deepEqual(geometry.colors, source.colors);
    assert.deepEqual(geometry.uvs, source.uvs);
    assert.notEqual(geometry.indices, source.indices);
    assert.deepEqual(source, snapshot);
    assert.deepEqual(target, targetSnapshot);
    unitNormals(geometry);
  }
});

test('target-local nearest and project queries return original triangle coordinates and count misses', () => {
  const index = createMeshQueryIndex(plane());
  const nearest = index.nearest([0.2, 0.1, 1]);
  assert.equal(nearest.hit.distance, 1);
  assert.ok(Math.abs(nearest.hit.point[2]) < 1e-12);
  assert.ok(nearest.hit.normal[0] === 0 && nearest.hit.normal[1] === 0 && nearest.hit.normal[2] === 1);
  assert.ok(nearest.hit.barycentric.every(value => value >= 0));
  assert.equal(index.nearest([0, 0, 0], { maxDistance: 0 }).hit.distance, 0);
  const miss = index.project({ origin: [0, 0, 1], direction: [0, 0, 1] });
  assert.equal(miss.hit, null);
  assert.ok(miss.triangleTests > 0, 'ray reaches the leaf but misses its triangles');
  const far = index.nearest([0, 0, 1], { maxDistance: 0.5 });
  assert.equal(far.hit, null);
  assert.ok(far.triangleTests > 0);
  assert.throws(() => index.nearest([0, 0, 1], { unknown: true }), /Unsupported/);
  assert.throws(() => index.project({ origin: [0, 0, 1], direction: [0, 0, 0] }), /nonzero/);
  assert.throws(() => index.project({ origin: [0, 0, 1] }), /direction/);
  assert.throws(() => index.nearest([0, 0, 1], { maxTriangleTests: 1 }), /exhausted/);
  assert.ok(index.nearest([0, 0, 1]).hit);
  index.dispose();
});

test('sphere projection follows actual triangle planes rather than an analytic sphere', () => {
  const target = sphere(16, 12);
  const source = plane(1.3, 0.25);
  const index = createMeshQueryIndex(target);
  for (const mode of ['nearest', 'project']) {
    const options = { mode, clearance: 0, maxDistance: 2 };
    if (mode === 'project') options.direction = [0, 0, -1];
    const output = shrinkwrapGeometry(source, target, options);
    for (let vertex = 0; vertex < 4; vertex++) {
      const origin = source.positions.subarray(vertex * 3, vertex * 3 + 3);
      const query = mode === 'project' ? index.project({ origin, direction: [0, 0, -1] }) : index.nearest(origin);
      const triangle = query.hit.triangle;
      const first = new Vector3().fromArray(target.positions, target.indices[triangle * 3] * 3);
      const point = new Vector3().fromArray(output.geometry.positions, vertex * 3);
      assert.ok(Math.abs(point.sub(first).dot(new Vector3(...query.hit.normal))) < 1e-7);
    }
    unitNormals(output.geometry);
  }
  const raised = shrinkwrapGeometry(source, target, { mode: 'project', direction: [0, 0, -1], clearance: 0.01 });
  for (let vertex = 0; vertex < 4; vertex++) {
    const query = index.project({ origin: source.positions.subarray(vertex * 3, vertex * 3 + 3), direction: [0, 0, -1] });
    const actual = new Vector3().fromArray(raised.geometry.positions, vertex * 3).sub(new Vector3(...query.hit.point)).dot(new Vector3(...query.hit.normal));
    assert.ok(Math.abs(actual - 0.01) < 1e-7);
  }
  index.dispose();
});

test('misses throw atomically by default and keep only the transformed source when requested', () => {
  const source = plane(1, 0.3);
  const snapshot = structuredClone(source);
  assert.throws(() => shrinkwrapGeometry(source, plane(0, 2), { maxDistance: 0.25 }), /missed source/);
  const kept = shrinkwrapGeometry(source, plane(0, 2), { maxDistance: 0.25, onMiss: 'keep' });
  assert.deepEqual(kept.geometry.positions, source.positions);
  assert.equal(kept.stats.missedVertices, 4);
  assert.equal(kept.stats.matchedVertices, 0);
  assert.ok(kept.stats.triangleTests > 0);
  assert.throws(() => shrinkwrapGeometry(source, plane(0, 2), { maxDistance: 0.25, onMiss: 'keep', maxTriangleTests: kept.stats.triangleTests - 1 }), /exhausted/);
  assert.throws(() => shrinkwrapGeometry(source, plane(), { mode: 'project', direction: [0, 0, 1] }), /missed source/);
  assert.deepEqual(source, snapshot);
});

test('partial keep misses preserve transformed vertices and rebuild normals for the resulting slope', () => {
  const source = plane(1, 0.3);
  source.positions[2] = 0.2;
  source.positions[11] = 0.2;
  const output = shrinkwrapGeometry(source, plane(0, 2), { maxDistance: 0.5, onMiss: 'keep' });
  assert.equal(output.stats.matchedVertices, 2);
  assert.equal(output.stats.missedVertices, 2);
  assert.equal(output.geometry.positions[2], 0);
  assert.equal(output.geometry.positions[5], 1);
  unitNormals(output.geometry);
});

test('total callback and unique-position budgets fail without poisoning subsequent operations', () => {
  const source = plane(1, 0.3);
  const target = plane(0, 2);
  const baseline = shrinkwrapGeometry(source, target);
  assert.equal(baseline.stats.triangleTests, 8);
  assert.throws(() => shrinkwrapGeometry(source, target, { maxTriangleTests: 7 }), /exhausted/);
  assert.throws(() => shrinkwrapGeometry(source, target, { maxQueries: 3 }), /maxQueries/);
  assert.deepEqual(shrinkwrapGeometry(source, target), baseline);
});

test('source affine transforms use target-local coordinates and retain UVs and color byte offsets', () => {
  const source = plane(1, 0.3);
  const matrix = new Matrix4().makeScale(2, 0.5, 3).setPosition(0.2, 0.1, 0);
  const storage = new Float32Array(source.colors.length + 4);
  storage.set(source.colors, 2);
  source.colors = storage.subarray(2, -2);
  const output = shrinkwrapGeometry(source, plane(0, 2), { sourceToTarget: matrix.toArray(), mode: 'project', direction: [0, 0, -1], maxDistance: 3 });
  for (let offset = 0; offset < source.positions.length; offset += 3) {
    assert.ok(Math.abs(output.geometry.positions[offset] - (source.positions[offset] * 2 + Math.fround(0.2))) < 1e-7);
    assert.ok(Math.abs(output.geometry.positions[offset + 1] - (source.positions[offset + 1] * 0.5 + Math.fround(0.1))) < 1e-7);
    assert.equal(output.geometry.positions[offset + 2], 0);
  }
  assert.deepEqual(output.geometry.colors, source.colors);
  unitNormals(output.geometry);
});

test('coincident position seams move together while authored hard-normal groups remain separate', () => {
  const source = box(0, 1);
  for (let offset = 0; offset < source.positions.length; offset++) source.positions[offset] *= 2;
  const target = box(0, 1);
  const output = shrinkwrapGeometry(source, target);
  assert.equal(output.stats.queriedVertices, 8);
  assert.ok(source.positions.length / 3 > 8);
  const seen = new Map();
  const normals = new Map();
  for (let offset = 0; offset < source.positions.length; offset += 3) {
    const key = source.positions.subarray(offset, offset + 3).join(',');
    const point = output.geometry.positions.subarray(offset, offset + 3).join(',');
    if (seen.has(key)) assert.equal(point, seen.get(key));
    seen.set(key, point);
    if (!normals.has(key)) normals.set(key, new Set());
    normals.get(key).add(output.geometry.normals.subarray(offset, offset + 3).join(','));
  }
  assert.ok(Array.from(normals.values()).some(group => group.size === 3));
  unitNormals(output.geometry);
});

test('invalid geometry, options, precision collapse, backfaces and clearance failure reject', () => {
  const source = plane(1, 0.3);
  const target = plane(0, 2);
  for (const options of [{ unknown: 1 }, { clearance: -1 }, { maxDistance: -1 }, { mode: 'wrong' }, { onMiss: 'wrong' }, { direction: [0, 0, -1] }, { mode: 'project' }, { maxVertices: 3 }, { memoryBudgetMiB: 0.000001 }, { sourceToTarget: new Matrix4().makeScale(0, 1, 1).toArray() }]) assert.throws(() => shrinkwrapGeometry(source, target, options));
  const malformed = structuredClone(source);
  malformed.normals[0] = 10;
  assert.throws(() => shrinkwrapGeometry(malformed, target), /unit vectors/);
  for (const field of ['morphTargets', 'skinIndices', 'skinWeights']) assert.throws(() => shrinkwrapGeometry({ ...source, [field]: [] }, target), /static geometry/);
  const reversed = structuredClone(source);
  reversed.indices.reverse();
  assert.throws(() => shrinkwrapGeometry(reversed, target), /faces away/);
  assert.throws(() => shrinkwrapGeometry(source, target, { clearance: 1e-50 }), /Clearance collapses/);
  const huge = plane(1e20, 1e15);
  assert.throws(() => shrinkwrapGeometry(huge, huge, { clearance: 1 }), /Clearance collapses/);
  const collapsed = plane(0, 0.3);
  collapsed.positions[0] = collapsed.positions[3];
  collapsed.positions[1] = collapsed.positions[4];
  assert.throws(() => shrinkwrapGeometry(collapsed, target), /degenerate/);
  assert.throws(() => shrinkwrapGeometry(source, target, { sourceToTarget: new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 1).toArray(), mode: 'project', direction: [0, 0, -1] }), /collapses/);
});

test('normalized queries and Double normal sums support small and large finite local meshes', () => {
  for (const scale of [1e-30, 1e30]) {
    const source = plane(scale, 0.3 * scale);
    const output = shrinkwrapGeometry(source, plane(0, 2 * scale), { clearance: 0.01 * scale });
    assert.ok(Math.abs(output.geometry.positions[2] / scale - 0.01) < 1e-8);
    unitNormals(output.geometry);
  }
});

test('shared normal extraction preserves sculpt literal falloff and no-op behavior', () => {
  const source = plane();
  assert.deepEqual(sculptGeometry(source, []), source);
  const sculpted = sculptGeometry(source, [{ type: 'displace', center: [0, 0, 0], radius: 2, strength: 0.5, direction: [0, 0, 1] }]);
  assert.ok(sculpted.positions[2] > 0);
  assert.deepEqual(sculpted.uvs, source.uvs);
  unitNormals(sculpted);
});
