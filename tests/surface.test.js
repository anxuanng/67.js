import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Euler, Matrix4, Triangle, Vector3 } from 'three';
import { mat4 } from 'gl-matrix';
import { sphere } from '../src/geometry.js';
import { createSurfacePatch } from '../src/surface.js';

test('a very narrow angle includes a perfectly aligned face', () => {
  const target = {
    geometry: {
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
  };
  const patch = createSurfacePatch(target, { size: [3, 3, 1], clearance: 0, maxAngle: 1e-8 });
  assert.equal(patch.indices.length, 6);
});

const PROJECTOR = { position: [0, 0, 1], size: [0.8, 0.5, 0.4] };

function target(geometry = sphere(32, 20)) {
  return { name: 'curved target', geometry, matrix: mat4.create(), material: { tag: 'standard', color: [0.3, 0.4, 0.5], metallic: 0, roughness: 0.7 } };
}

function planeGeometry() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function closestSurfaceDistance(point, geometry) {
  const triangle = new Triangle();
  const nearest = new Vector3();
  let minimum = Infinity;
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    triangle.a.fromArray(geometry.positions, geometry.indices[offset] * 3);
    triangle.b.fromArray(geometry.positions, geometry.indices[offset + 1] * 3);
    triangle.c.fromArray(geometry.positions, geometry.indices[offset + 2] * 3);
    triangle.closestPointToPoint(point, nearest);
    minimum = Math.min(minimum, point.distanceTo(nearest));
  }
  return minimum;
}

test('surface patch conforms to actual curved triangles, projects bounded UVs and adds local normal clearance', () => {
  const part = target();
  const flush = createSurfacePatch(part, { ...PROJECTOR, clearance: 0 });
  const raised = createSurfacePatch(part, { ...PROJECTOR, clearance: 0.002 });
  assert.ok(flush.indices.length > 6);
  assert.deepEqual(flush.indices, raised.indices);
  assert.deepEqual(flush.uvs, raised.uvs);
  let minimumDepth = Infinity;
  let maximumDepth = -Infinity;
  for (let vertex = 0; vertex < flush.positions.length / 3; vertex++) {
    const offset = vertex * 3;
    const point = new Vector3().fromArray(flush.positions, offset);
    assert.ok(closestSurfaceDistance(point, part.geometry) < 8e-8, 'point must lie on an authored triangle, not an analytic sphere');
    assert.ok(Math.abs(point.x) <= 0.4000001);
    assert.ok(Math.abs(point.y) <= 0.2500001);
    assert.ok(point.z >= 0.8 - 1e-7 && point.z <= 1.2 + 1e-7);
    minimumDepth = Math.min(minimumDepth, point.z);
    maximumDepth = Math.max(maximumDepth, point.z);
    const normal = new Vector3().fromArray(raised.normals, offset);
    assert.ok(Math.abs(normal.length() - 1) < 1e-6);
    const difference = new Vector3().fromArray(raised.positions, offset).sub(point);
    assert.ok(Math.abs(difference.length() - 0.002) < 1e-7);
    assert.ok(difference.dot(normal) > 0.0019999);
    for (let axis = 0; axis < 2; axis++) assert.ok(flush.uvs[vertex * 2 + axis] >= -1e-6 && flush.uvs[vertex * 2 + axis] <= 1 + 1e-6);
  }
  assert.ok(maximumDepth - minimumDepth > 0.04, 'patch must curve with the target');
});

test('projector rotation maps plane coordinates to UVs and filters reversed target faces', () => {
  const part = target(planeGeometry());
  const options = { position: [0, 0, 0], rotation: [0, 0, 0.7], size: [0.8, 0.5, 0.2], clearance: 0 };
  const patch = createSurfacePatch(part, options);
  const inverse = new Matrix4().makeRotationFromEuler(new Euler(...options.rotation)).invert();
  for (let vertex = 0; vertex < patch.positions.length / 3; vertex++) {
    const projected = new Vector3().fromArray(patch.positions, vertex * 3).applyMatrix4(inverse);
    assert.ok(Math.abs(patch.uvs[vertex * 2] - (0.5 + projected.x / 0.8)) < 1e-6);
    assert.ok(Math.abs(patch.uvs[vertex * 2 + 1] - (0.5 + projected.y / 0.5)) < 1e-6);
  }
  const reversed = planeGeometry();
  reversed.indices.set([0, 2, 1, 0, 3, 2]);
  reversed.normals.fill(0);
  for (let offset = 2; offset < reversed.normals.length; offset += 3) reversed.normals[offset] = -1;
  assert.throws(() => createSurfacePatch(target(reversed), { position: [0, 0, 0] }), /misses/);
  const flippedProjector = createSurfacePatch(target(reversed), { position: [0, 0, 0], rotation: [0, Math.PI, 0] });
  assert.ok(flippedProjector.normals[2] < 0);
});

test('thick projector on a closed mesh only emits the outward-facing side and maxAngle narrows the patch', () => {
  const part = target();
  const broad = createSurfacePatch(part, { position: [0, 0, 0], size: [3, 3, 3], clearance: 0 });
  const narrow = createSurfacePatch(part, { position: [0, 0, 0], size: [3, 3, 3], clearance: 0, maxAngle: 0.3 });
  assert.ok(narrow.indices.length < broad.indices.length);
  for (let offset = 2; offset < broad.positions.length; offset += 3) assert.ok(broad.positions[offset] >= -1e-7);
  assert.throws(() => createSurfacePatch(part, { position: [0, 0, 10], size: [1, 1, 1] }), /misses/);
});

test('local patch shares affine target transforms across arbitrary backward and forward animation seeks', () => {
  const part = target();
  const patch = createSurfacePatch(part, PROJECTOR);
  const patchPart = { geometry: patch, matrix: part.matrix };
  const saved = new Float32Array(patch.positions);
  const sample = time => {
    mat4.identity(part.matrix);
    mat4.translate(part.matrix, part.matrix, [time, -2, 0.5]);
    mat4.rotateY(part.matrix, part.matrix, time * 0.7);
    mat4.scale(part.matrix, part.matrix, [-2, 3, 0.5]);
    part.matrix[4] += 0.25;
    return new Vector3().fromArray(patch.positions).applyMatrix4(new Matrix4().fromArray(patchPart.matrix)).toArray();
  };
  const expected = sample(2);
  sample(7);
  sample(-1);
  assert.deepEqual(sample(2), expected);
  assert.equal(patchPart.matrix, part.matrix);
  assert.deepEqual(patch.positions, saved);
  assert.deepEqual(createSurfacePatch(part, PROJECTOR), patch, 'creation depends only on target-local geometry');
});

test('surface creation leaves offset source arrays and projector inputs untouched, including the sphere seam', () => {
  const part = target();
  const original = new Float32Array(part.geometry.positions);
  const storage = new Float32Array(original.length + 6).fill(99);
  storage.set(original, 3);
  part.geometry.positions = storage.subarray(3, original.length + 3);
  const options = { position: [1, 0, 0], rotation: [0, Math.PI / 2, 0], size: [0.7, 0.5, 0.4], clearance: 0.001 };
  const savedOptions = structuredClone(options);
  const savedNormals = new Float32Array(part.geometry.normals);
  const savedIndices = new Uint32Array(part.geometry.indices);
  const patch = createSurfacePatch(part, options);
  assert.deepEqual(part.geometry.positions, original);
  assert.deepEqual(part.geometry.normals, savedNormals);
  assert.deepEqual(part.geometry.indices, savedIndices);
  assert.deepEqual(options, savedOptions);
  assert.equal(storage[0], 99);
  const points = new Map();
  let seamMatches = 0;
  for (let offset = 0; offset < patch.positions.length; offset += 3) {
    const key = Array.from(patch.positions.slice(offset, offset + 3), value => Math.round(value * 1e6)).join(',');
    const attributes = [...patch.normals.slice(offset, offset + 3), ...patch.uvs.slice(offset / 3 * 2, offset / 3 * 2 + 2)];
    if (points.has(key)) {
      const previous = points.get(key);
      for (let component = 0; component < attributes.length; component++) assert.ok(Math.abs(attributes[component] - previous[component]) < 2e-6);
      seamMatches++;
    }
    points.set(key, attributes);
  }
  assert.ok(seamMatches > 0, 'shared clipped vertices retain matching seam positions');
  assert.equal(patch.colors, undefined);
});

test('surface geometry and options reject malformed data, unsupported deformation and unsafe clearance', () => {
  for (const options of [null, { unknown: 1 }, { size: [0, 1, 1] }, { size: [1e-50, 1, 1] }, { size: [1, 1] },
    { position: [Infinity, 0, 0] }, { rotation: [0, NaN, 0] }, { clearance: -1 }, { clearance: 1e40 },
    { clearance: 1e-50 }, { maxAngle: 0 }, { maxAngle: Math.PI }, { maxVertices: 2 }, { maxTriangles: 0 }]) {
    assert.throws(() => createSurfacePatch(target(), options));
  }
  for (const field of ['skin', 'morph', 'assembly']) assert.throws(() => createSurfacePatch({ ...target(), [field]: {} }, PROJECTOR), /cannot follow/);
  for (const tag of ['water', 'grass', 'foliage', 'terrain', 'floor', 'fire', 'smoke', 'armor']) {
    assert.throws(() => createSurfacePatch({ ...target(), material: { tag } }, PROJECTOR), /standard material/);
  }
  for (const [field, values] of [['positions', new Float64Array(12)], ['normals', new Float32Array(12)],
    ['indices', new Uint16Array([0, 1, 2])], ['indices', new Uint32Array([0, 1, 99])]]) {
    const geometry = planeGeometry();
    geometry[field] = values;
    assert.throws(() => createSurfacePatch(target(geometry)));
  }
  for (const field of ['positions', 'normals']) {
    const geometry = planeGeometry();
    geometry[field][0] = NaN;
    assert.throws(() => createSurfacePatch(target(geometry)), /finite/);
  }
  const collapsed = planeGeometry();
  collapsed.positions.fill(0);
  assert.throws(() => createSurfacePatch(target(collapsed)), /no drawable/);
  assert.throws(() => createSurfacePatch(target(), { ...PROJECTOR, clearance: 1e-12 }), /collapses/);
});

test('surface reservations reject before clipping while bounded local projection accepts a full detailed sphere', () => {
  const part = target(sphere());
  assert.throws(() => createSurfacePatch(part, { ...PROJECTOR, maxTriangles: 100 }), /maxTriangles/);
  assert.throws(() => createSurfacePatch(part, { ...PROJECTOR, maxVertices: 3 }), /reservation/);
  const patch = createSurfacePatch(part, { ...PROJECTOR, maxVertices: 4000 });
  assert.ok(patch.positions.length / 3 < 4000);
  const flush = createSurfacePatch(target(planeGeometry()), { size: [3, 3, 1], clearance: 0, maxVertices: 6 });
  assert.equal(flush.positions.length / 3, 6);
});

test('surface budget and invalid-input failures precede source and DecalGeometry buffer construction', () => {
  const part = target();
  const original = BufferGeometry.prototype.setAttribute;
  let attributeCalls = 0;
  BufferGeometry.prototype.setAttribute = function (...argumentsList) {
    attributeCalls++;
    return original.apply(this, argumentsList);
  };
  try {
    assert.throws(() => createSurfacePatch(part, { ...PROJECTOR, maxVertices: 3 }), /reservation/);
    assert.throws(() => createSurfacePatch(part, { ...PROJECTOR, maxTriangles: 1 }), /maxTriangles/);
    assert.throws(() => createSurfacePatch(part, { ...PROJECTOR, size: [1, 0, 1] }), /positive/);
    assert.equal(attributeCalls, 0);
  } finally {
    BufferGeometry.prototype.setAttribute = original;
  }
});

test('clearance rejects smooth-normal movement that rounds entirely tangent to a high-coordinate face', () => {
  const geometry = planeGeometry();
  const height = Math.fround(1e20);
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    geometry.positions[offset + 2] = height;
    geometry.normals.set([Math.sqrt(0.75), 0, 0.5], offset);
  }
  const options = { position: [0, 0, height], size: [3, 3, 1] };
  const flush = createSurfacePatch(target(geometry), { ...options, clearance: 0 });
  assert.equal(flush.indices.length, 6);
  assert.throws(() => createSurfacePatch(target(geometry), { ...options, clearance: 0.001 }), /triangle-plane gap/);
});

test('large smooth-normal clearance cannot publish a reversed or collapsed patch triangle', () => {
  const geometry = planeGeometry();
  geometry.indices = new Uint32Array([0, 1, 2]);
  const normals = [[0.9, 0, Math.sqrt(0.19)], [-0.9, 0, Math.sqrt(0.19)], [-0.9, 0, Math.sqrt(0.19)], [0, 0, 1]];
  geometry.normals.set(normals.flat());
  assert.throws(() => createSurfacePatch(target(geometry), { size: [3, 3, 1], clearance: 2 }), /reverses a triangle/);
});
