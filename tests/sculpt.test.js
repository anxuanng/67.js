import assert from 'node:assert/strict';
import test from 'node:test';
import { sphere, box } from '../src/geometry.js';
import { sculptGeometry } from '../src/sculpt.js';

function plane() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, 0, 0, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 3, 1, 2, 3, 2, 0, 3]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1, 0.5, 0.5]),
  };
}

test('directional sculpt uses literal quintic falloff and preserves independent channels', () => {
  const source = plane();
  const snapshot = structuredClone(source);
  const stroke = { type: 'displace', center: [0, 0, 0], radius: 2, strength: 0.5, direction: [0, 0, 20] };
  const output = sculptGeometry(source, [stroke]);
  assert.equal(output.positions[11], 0.5);
  assert.equal(output.positions[8], 0.25);
  assert.deepEqual(source, snapshot);
  assert.deepEqual(output.uvs, source.uvs);
  assert.notEqual(output.indices, source.indices);
  assert.notEqual(output.uvs, source.uvs);
  assert.deepEqual(output, sculptGeometry(source, [stroke]));
  for (let offset = 0; offset < output.normals.length; offset += 3) {
    assert.ok(Math.abs(Math.hypot(...output.normals.subarray(offset, offset + 3)) - 1) < 1e-6);
  }
});

test('inflate and deflate use original normals and leave vertices outside brush unchanged', () => {
  const source = sphere(16, 12);
  for (const strength of [-0.15, 0.15]) {
    const output = sculptGeometry(source, [{ type: 'inflate', center: [0, 1, 0], radius: 0.6, strength }]);
    assert.ok(Math.abs(output.positions[1] - (1 + strength)) < 1e-6);
    assert.equal(output.positions.at(-2), source.positions.at(-2));
  }
});

test('exact coincident position seams move together while authored normal splits stay separate', () => {
  const source = box();
  const result = sculptGeometry(source, [{ type: 'inflate', center: [0, 0, 0], radius: 10, strength: 0.1 }]);
  const seen = new Map();
  for (let offset = 0; offset < source.positions.length; offset += 3) {
    const key = source.positions.subarray(offset, offset + 3).join(',');
    const output = result.positions.subarray(offset, offset + 3);
    if (seen.has(key)) assert.deepEqual(output, seen.get(key));
    seen.set(key, output);
  }
  assert.ok(result.normals.some((value, offset) => offset % 3 === 2 && value > 0.99));
  assert.ok(result.normals.some((value, offset) => offset % 3 === 0 && value > 0.99));
});

test('Laplacian smoothing uses one immutable neighborhood snapshot for each stroke', () => {
  const source = plane();
  source.positions[11] = 1;
  const output = sculptGeometry(source, [{ type: 'smooth', center: [0, 0, 1], radius: 0.5, strength: 0.5 }]);
  assert.equal(output.positions[11], 0.5);
  assert.ok(Math.abs(output.positions[10] + 1 / 6) < 1e-7);
  assert.deepEqual(output.positions.subarray(0, 9), source.positions.subarray(0, 9));
});

test('invalid sculpt data, unsupported deformation and work budgets fail without source mutation', () => {
  const source = plane();
  const snapshot = structuredClone(source);
  const stroke = { type: 'inflate', center: [0, 0, 0], radius: 1, strength: 0.1 };
  assert.throws(() => sculptGeometry(source, [stroke], { maxVertices: 3 }), /maxVertices/);
  assert.throws(() => sculptGeometry(source, [stroke], { maxVertexVisits: 3 }), /maxVertexVisits/);
  assert.throws(() => sculptGeometry(source, [stroke], { maxTriangles: 2 }), /maxTriangles/);
  assert.throws(() => sculptGeometry(source, [stroke, stroke], { maxStrokes: 1 }), /maxStrokes/);
  assert.throws(() => sculptGeometry(source, [{ ...stroke, radius: 1e-50 }]), /radius/);
  assert.throws(() => sculptGeometry(source, [{ ...stroke, type: 'smooth', strength: 1.1 }]), /strength/);
  assert.throws(() => sculptGeometry(source, [{ ...stroke, type: 'displace', direction: [0, 0, 0] }]), /direction/);
  assert.throws(() => sculptGeometry(source, [{ ...stroke, center: [Infinity, 0, 0] }]), /Float32/);
  assert.throws(() => sculptGeometry({ ...source, morphTargets: [] }, [stroke]), /static/);
  assert.throws(() => sculptGeometry({ ...source, skinIndices: new Uint16Array(16) }, [stroke]), /static/);
  assert.deepEqual(source, snapshot);
});

test('sculpt rejects collapsed output triangles and retains source when the operation fails', () => {
  const source = plane();
  const snapshot = structuredClone(source);
  assert.throws(() => sculptGeometry(source, [{ type: 'displace', center: [0, 0, 0], radius: 1, strength: 1, direction: [0, -1, 0] }]), /collapsed/);
  assert.deepEqual(source, snapshot);
});

test('normal reconstruction remains accurate for very small and large finite meshes', () => {
  for (const size of [1, 1e20, 1e-24]) {
    const source = {
      positions: new Float32Array([0, 0, 0, size, 0, 0, 0, size, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const output = sculptGeometry(source, [{ type: 'displace', center: [0, 0, 0], radius: size / 10, strength: size, direction: [0, 0, 1] }]);
    for (const component of output.normals) assert.ok(Math.abs(component - 1 / Math.sqrt(3)) < 1e-6);
  }
});

test('UV seam duplication does not change area-weighted sculpt normals', () => {
  const source = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 1, 0, 3]),
  };
  const split = {
    positions: new Float32Array([...source.positions, 0, 0, 0, 1, 0, 0]),
    normals: new Float32Array([...source.normals, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 5, 4, 3]),
  };
  const strokes = [{ type: 'displace', center: [0, 1, 0], radius: 0.1, strength: 1, direction: [0, 0, 1] }];
  const ordinary = sculptGeometry(source, strokes);
  const seamed = sculptGeometry(split, strokes);
  assert.deepEqual(ordinary.normals.subarray(0, 3), seamed.normals.subarray(0, 3));
  assert.deepEqual(ordinary.normals.subarray(0, 3), seamed.normals.subarray(12, 15));
});
