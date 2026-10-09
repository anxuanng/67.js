import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { box, cylinder, sphere, torus } from '../src/geometry.js';

test('closed primitives have exact Float32 seams and oppositely oriented paired edges', () => {
  for (const [name, mesh] of [
    ['sphere', sphere(16, 12)], ['torus', torus(0.08, 16, 8)],
    ['cylinder', cylinder(16, 0.025, 3)], ['box', box()],
  ]) {
    const vertices = new Map();
    const welded = [];
    for (let offset = 0; offset < mesh.positions.length; offset += 3) {
      const key = mesh.positions.subarray(offset, offset + 3).join(',');
      if (!vertices.has(key)) vertices.set(key, vertices.size);
      welded.push(vertices.get(key));
    }
    const edges = new Map();
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = Array.from(mesh.indices.subarray(offset, offset + 3), index => welded[index]);
      assert.equal(new Set(triangle).size, 3, name);
      for (let corner = 0; corner < 3; corner++) {
        const first = triangle[corner];
        const second = triangle[(corner + 1) % 3];
        const key = `${Math.min(first, second)}:${Math.max(first, second)}`;
        const edge = edges.get(key) ?? { count: 0, direction: 0 };
        edge.count++;
        edge.direction += first < second ? 1 : -1;
        edges.set(key, edge);
      }
    }
    assert.ok([...edges.values()].every(edge => edge.count === 2 && edge.direction === 0), `${name} has exact closed, oriented edges.`);
  }
});

test('primitive validation rejects unsafe allocations and invalid shapes before sampling', () => {
  assert.throws(() => sphere(2048, 2048), /million vertices/);
  assert.throws(() => sphere(Infinity, 40), /segments/);
  assert.throws(() => sphere(64, 0), /rings/);
  assert.throws(() => torus(1e-50), /positive/);
  assert.throws(() => torus(0.1, 16, 8, 0), /arc/);
  assert.throws(() => torus(0.1, 16, 8, 1e-50), /arc/);
  assert.throws(() => torus(0.1, 16, 8, Math.PI * 3), /arc/);
  assert.throws(() => torus(0.1, 16, 8, Math.PI, NaN), /Float32/);
  assert.throws(() => cylinder(16, 0.6), /bevel/);
  assert.throws(() => cylinder(16, 0.025, 0), /bevelSegments/);
  assert.throws(() => box(-0.1), /bevel/);
  assert.throws(() => box(1e-50), /underflow/);
  assert.throws(() => box(0.08, 1000000), /subdivisions/);
});
import { createModel } from '../src/model.js';

test('sphere UVs preserve separate seam coordinates and cover every vertex', () => {
  const segments = 12;
  const rings = 8;
  const mesh = sphere(segments, rings);
  assert.equal(mesh.uvs.length, mesh.positions.length / 3 * 2);
  for (const value of mesh.uvs) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  for (let row = 0; row <= rings; row++) {
    const first = row * (segments + 1);
    const last = first + segments;
    assert.equal(mesh.uvs[first * 2], 0);
    assert.equal(mesh.uvs[last * 2], 1);
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(mesh.positions[first * 3 + axis] - mesh.positions[last * 3 + axis]) < 1e-6);
  }
});

function validateGeometry(mesh) {
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.normals instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.equal(mesh.indices.length % 3, 0);
  for (let offset = 0; offset < mesh.normals.length; offset += 3) {
    const normal = mesh.normals.slice(offset, offset + 3);
    assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-5, 'unit vertex normal');
  }
  let signedVolume = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const vertices = Array.from(mesh.indices.slice(offset, offset + 3), index => {
      assert.ok(index < mesh.positions.length / 3, 'index is in range');
      return Array.from(mesh.positions.slice(index * 3, index * 3 + 3));
    });
    const [first, second, third] = vertices;
    const edgeA = second.map((value, axis) => value - first[axis]);
    const edgeB = third.map((value, axis) => value - first[axis]);
    const cross = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
    assert.ok(Math.hypot(...cross) > 1e-10, 'nondegenerate triangle');
    const normalSum = [0, 1, 2].map(axis => Array.from(mesh.indices.slice(offset, offset + 3)).reduce((sum, index) => sum + mesh.normals[index * 3 + axis], 0));
    assert.ok(cross.reduce((sum, value, axis) => sum + value * normalSum[axis], 0) > 0, 'outward counterclockwise winding');
    signedVolume += first[0] * (second[1] * third[2] - second[2] * third[1]) + first[1] * (second[2] * third[0] - second[0] * third[2]) + first[2] * (second[0] * third[1] - second[1] * third[0]);
  }
  return signedVolume / 6;
}

test('closed primitive surfaces have finite unit normals and outward winding', () => {
  for (const mesh of [sphere(), cylinder(), cylinder(6), torus(), box()]) {
    assert.ok(validateGeometry(mesh) > 0, 'positive signed volume');
    assert.ok(Array.from(mesh.positions).every(Number.isFinite));
  }
});

test('partial armor arc keeps its winding', () => {
  const mesh = torus(0.12, 80, 24, Math.PI * 0.84, Math.PI * 0.08);
  assert.ok(validateGeometry(mesh) > 0);
  assertClosedJoins(mesh, false);
});

function assertClosedJoins(mesh, smoothNormals = true) {
  const vertexKeys = [];
  const normalsAtPosition = new Map();
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const key = Array.from(mesh.positions.slice(offset, offset + 3), value => Math.round(value * 100000)).join(',');
    vertexKeys.push(key);
    const normal = Array.from(mesh.normals.slice(offset, offset + 3));
    const previousNormal = normalsAtPosition.get(key);
    if (previousNormal && smoothNormals) {
      assert.ok(normal.every((value, axis) => Math.abs(value - previousNormal[axis]) < 1e-5), 'smooth normals match at patch joins');
    }
    normalsAtPosition.set(key, normal);
  }
  const edgeCounts = new Map();
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = Array.from(mesh.indices.slice(offset, offset + 3), index => vertexKeys[index]);
    assert.equal(new Set(triangle).size, 3, 'joins do not produce collapsed triangles');
    for (let edge = 0; edge < 3; edge++) {
      const edgeKey = [triangle[edge], triangle[(edge + 1) % 3]].sort().join('|');
      edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + 1);
    }
  }
  assert.ok(Array.from(edgeCounts.values()).every(count => count === 2), 'each welded edge has two adjacent triangles');
}

test('rounded box fillets are sampled locally with closed smooth patch joins', () => {
  for (const bevel of [0.015, 0.08, 0.18]) {
    const mesh = box(bevel, 6);
    validateGeometry(mesh);
    assertClosedJoins(mesh);
    assert.ok(Array.from(mesh.positions).every(value => Math.abs(value) <= 0.500001));
    const intermediateNormals = new Set(Array.from(mesh.normals).filter(value => value > 0.01 && value < 0.99).map(value => value.toFixed(3)));
    assert.ok(intermediateNormals.size > 15, 'fillets carry enough normal samples for continuous highlights');
  }
  validateGeometry(box(0));
});

test('cylinder rim fillets join flat caps and walls without gaps or normal discontinuities', () => {
  const mesh = cylinder();
  assertClosedJoins(mesh);
  assert.ok(Array.from(mesh.positions).every((value, index) => Math.abs(value) <= (index % 3 === 1 ? 0.500001 : 1.000001)));
  const rimNormals = Array.from(mesh.normals).filter((value, index) => index % 3 === 1 && value > 0.01 && value < 0.99);
  assert.ok(new Set(rimNormals.map(value => value.toFixed(3))).size >= 5);
});

test('model respects the renderer contract, instancing and authored bounds', () => {
  const parts = createModel();
  assert.ok(parts.length >= 252);
  const geometries = new Set(parts.map(part => part.geometry));
  assert.ok(geometries.size < 12, 'repeated details reuse geometry identities');
  for (const mesh of geometries) {
    validateGeometry(mesh);
  }
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const expandedMinimum = [Infinity, Infinity, Infinity];
  const expandedMaximum = [-Infinity, -Infinity, -Infinity];
  const sections = new Map();
  let triangleCount = 0;
  for (const part of parts) {
    assert.ok(part.name);
    assert.ok(part.matrix instanceof Float32Array);
    assert.equal(part.matrix.length, 16);
    assert.ok(Array.from(part.matrix).every(Number.isFinite));
    assert.equal(part.matrix[15], 1);
    assert.ok(part.material.color.every(value => value >= 0 && value <= 1));
    assert.ok(part.material.metallic >= 0 && part.material.metallic <= 1);
    assert.ok(part.material.roughness > 0 && part.material.roughness <= 1);
    assert.ok(part.material.emission >= 0);
    assert.ok(['exterior', 'interior'].includes(part.assembly.layer));
    assert.ok(part.assembly.section.length > 3);
    assert.equal(part.assembly.offset.length, 3);
    assert.ok(part.assembly.offset.every(Number.isFinite));
    if (part.assembly.layer === 'interior') {
      assert.ok(part.assembly.offset.every(value => Math.abs(value) <= 0.4));
    }
    const section = sections.get(part.assembly.section);
    if (section) {
      assert.equal(part.assembly.layer, section.layer);
      assert.deepEqual(part.assembly.offset, section.offset, 'components share their section translation before detail expansion');
    } else {
      sections.set(part.assembly.section, part.assembly);
    }
    triangleCount += part.geometry.indices.length / 3;
    const matrix = part.matrix;
    const positions = part.geometry.positions;
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const world = matrix[axis] * positions[offset] + matrix[axis + 4] * positions[offset + 1] + matrix[axis + 8] * positions[offset + 2] + matrix[axis + 12];
        minimum[axis] = Math.min(minimum[axis], world);
        maximum[axis] = Math.max(maximum[axis], world);
        expandedMinimum[axis] = Math.min(expandedMinimum[axis], world + part.assembly.offset[axis]);
        expandedMaximum[axis] = Math.max(expandedMaximum[axis], world + part.assembly.offset[axis]);
      }
    }
  }
  assert.ok(minimum[1] >= 0.045);
  assert.ok(maximum[1] <= 3);
  assert.ok(Math.max(Math.abs(minimum[0]), Math.abs(maximum[0])) <= 1.3);
  assert.ok(Math.max(Math.abs(minimum[2]), Math.abs(maximum[2])) <= 1);
  assert.ok(expandedMinimum[1] >= 0.045);
  assert.ok(expandedMaximum[1] <= 4.5);
  assert.ok(Math.max(Math.abs(expandedMinimum[0]), Math.abs(expandedMaximum[0])) <= 3.4);
  assert.ok(Math.max(Math.abs(expandedMinimum[2]), Math.abs(expandedMaximum[2])) <= 2.8);
  assert.ok(parts.filter(part => part.assembly.layer === 'interior').length > 100);
  assert.ok(parts.filter(part => part.assembly.layer === 'exterior').length > 100);
  assert.ok(sections.size >= 15);
  assert.ok(triangleCount < 1000000, 'assembled scene stays below one million triangles');
  const meshBytes = Array.from(geometries).reduce((sum, mesh) => sum + mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength, 0);
  assert.ok(meshBytes < 1500000, 'geometry remains suitable for a compact export');
  console.log(JSON.stringify({ parts: parts.length, geometries: geometries.size, triangleCount, meshBytes, sections: sections.size, bounds: { minimum, maximum }, expandedBounds: { minimum: expandedMinimum, maximum: expandedMaximum } }));
});

test('assembled WALL-E geometry and instance snapshot stays stable after exact seam closure', () => {
  const parts = createModel();
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(JSON.stringify({ name: part.name, matrix: Array.from(part.matrix), material: part.material }));
  }
  for (const mesh of new Set(parts.map(part => part.geometry))) {
    for (const field of [mesh.positions, mesh.normals, mesh.indices]) {
      hash.update(new Uint8Array(field.buffer, field.byteOffset, field.byteLength));
    }
  }
  assert.equal(parts.length, 574);
  assert.equal(hash.digest('hex'), 'e9479c0c3061a32645e5510346e964be9ac8505135c7342a83295f7373d894b0');
});
