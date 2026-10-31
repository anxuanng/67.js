import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeshData, applyMeshEdits, evaluateMeshStack, meshTags, facesWithTag, validateTopology, editMesh } from '../src/mesh.js';
import { decimateMesh } from '../src/mesh-decimate.js';
import { remeshMesh } from '../src/mesh-remesh.js';
import { generateMeshLods, generateGeometryLods, generateAssetLods } from '../src/mesh-lod.js';
import { surfaceDeviation, signedVolume } from '../src/mesh-surface-distance.js';
import { withFaceAttributes } from '../src/mesh-convert.js';
import { extractRender } from '../src/mesh-render.js';

function sphere(columns, rows, { open = false } = {}) {
  const positions = [0, 0, 1];
  for (let row = 1; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const polar = Math.PI * row / rows;
      const azimuth = 2 * Math.PI * column / columns;
      positions.push(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar));
    }
  }
  positions.push(0, 0, -1);
  const ring = (row, column) => 1 + (row - 1) * columns + (column % columns);
  const bottom = positions.length / 3 - 1;
  const faces = [];
  if (!open) for (let column = 0; column < columns; column++) faces.push([0, ring(1, column), ring(1, column + 1)]);
  for (let row = 1; row < rows - 1; row++) {
    for (let column = 0; column < columns; column++) faces.push([ring(row, column), ring(row + 1, column), ring(row + 1, column + 1), ring(row, column + 1)]);
  }
  for (let column = 0; column < columns; column++) faces.push([bottom, ring(rows - 1, column + 1), ring(rows - 1, column)]);
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => {
    faceOffsets[index + 1] = faceOffsets[index] + face.length;
  });
  return createMeshData({ positions: new Float32Array(positions), faceOffsets, cornerVertices: new Uint32Array(faces.flat()) });
}

function tagUpperHalf(mesh) {
  const data = new Uint8Array(mesh.faceCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    let height = 0;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) height += mesh.positions[mesh.cornerVertices[corner] * 3 + 2];
    data[face] = height > 0 ? 1 : 0;
  }
  return withFaceAttributes(mesh, { 'tag:top': { data, size: 1 } });
}

function openBoundaryVertices(mesh) {
  const counts = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const first = mesh.cornerVertices[corner];
      const second = mesh.cornerVertices[corner + 1 === end ? start : corner + 1];
      const key = first < second ? `${first},${second}` : `${second},${first}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const boundary = new Set();
  for (const [key, count] of counts) if (count === 1) key.split(',').forEach(vertex => boundary.add(Number(vertex)));
  return [...boundary].map(vertex => Array.from(mesh.positions.subarray(vertex * 3, vertex * 3 + 3)));
}

test('decimate reaches its ratio, keeps the surface close and the mesh valid', () => {
  const source = sphere(40, 24);
  const { mesh, triangles, reachedTarget } = decimateMesh(source, { ratio: 0.25 });
  assert.equal(reachedTarget, true);
  assert.ok(mesh.faceCount <= Math.ceil(triangles.before * 0.25));
  assert.equal(validateTopology(editMesh(mesh)).euler, 2);
  assert.ok(surfaceDeviation(mesh, source).hausdorff < 0.04);
  assert.ok(Math.abs(signedVolume(mesh) - signedVolume(source)) / signedVolume(source) < 0.03);
});

test('decimate keeps the open boundary where it was', () => {
  const source = sphere(40, 24, { open: true });
  const { mesh } = decimateMesh(source, { ratio: 0.2 });
  const rim = openBoundaryVertices(mesh);
  assert.ok(rim.length >= 3);
  const rimHeight = Math.cos(Math.PI / 24);
  const rimRadius = Math.sin(Math.PI / 24);
  for (const [x, y, z] of rim) {
    assert.ok(Math.abs(z - rimHeight) < 1e-4, 'the rim stays in its plane');
    assert.ok(Math.hypot(x, y) <= rimRadius + 1e-4 && Math.hypot(x, y) > rimRadius * 0.9, 'the rim stays on its circle');
  }
});

test('decimate keeps tags and the border between them', () => {
  const source = tagUpperHalf(sphere(40, 24));
  const { mesh } = decimateMesh(source, { ratio: 0.2 });
  assert.deepEqual(meshTags(mesh), ['top']);
  const top = facesWithTag(mesh, 'top');
  assert.ok(top.length > 0 && top.length < mesh.faceCount);
  for (const face of top) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      assert.ok(mesh.positions[mesh.cornerVertices[corner] * 3 + 2] > -0.2, 'the top tag stays in the upper part');
    }
  }
});

test('decimate rejects a bad ratio and stops at four triangles', () => {
  const source = sphere(8, 6);
  assert.throws(() => decimateMesh(source, { ratio: 0 }), /ratio/);
  assert.throws(() => decimateMesh(source, { ratio: 1.5 }), /ratio/);
  assert.ok(decimateMesh(source, { ratio: 0.001 }).mesh.faceCount >= 4);
});

test('decimate and remesh run as edits and as stack nodes with a budget', () => {
  const source = sphere(40, 24);
  const edited = applyMeshEdits(source, [{ op: 'decimate', ratio: 0.5 }]);
  assert.equal(edited.results[0].triangles.before, 40 * 22 * 2 + 40 * 2);
  const stacked = evaluateMeshStack(source, [{ op: 'remesh', resolution: 20 }]);
  assert.ok(stacked.mesh.faceCount > 100);
  assert.throws(() => applyMeshEdits(source, [{ op: 'decimate', ratio: 2 }]), /ratio/);
  assert.throws(() => applyMeshEdits(source, [{ op: 'remesh', voxelSize: 0.1, resolution: 20 }]), /exactly one/);
  assert.throws(() => applyMeshEdits(source, [{ op: 'remesh', resolution: 500 }]), /resolution/);
  assert.throws(() => applyMeshEdits(source, [{ op: 'remesh', voxelSize: 0.001 }]), /over the limits/);
});

test('remesh makes a closed quad surface with positive volume near the input', () => {
  const source = sphere(40, 24);
  const { mesh, voxelSize } = remeshMesh(source, { resolution: 32 });
  assert.equal(validateTopology(editMesh(mesh)).euler, 2);
  assert.equal(mesh.faceOffsets[1] - mesh.faceOffsets[0], 4);
  assert.ok(signedVolume(mesh) > 0);
  assert.ok(surfaceDeviation(mesh, source).hausdorff < voxelSize);
  assert.ok(Math.abs(signedVolume(mesh) - signedVolume(source)) / signedVolume(source) < 0.03);
});

test('remesh refuses an open surface and a mesh smaller than a voxel', () => {
  assert.throws(() => remeshMesh(sphere(16, 10, { open: true }), { resolution: 16 }), /closed/);
  assert.throws(() => remeshMesh(sphere(16, 10), { voxelSize: 100 }), /no surface|voxel/);
});

test('generated levels shrink, report a growing error and share the input as level 0', () => {
  const source = sphere(40, 24);
  const levels = generateMeshLods(source, { ratios: [0.5, 0.2] });
  assert.deepEqual(levels.map(level => level.level), [0, 1, 2]);
  assert.equal(levels[0].mesh, source);
  assert.ok(levels[1].triangles < levels[0].triangles && levels[2].triangles < levels[1].triangles);
  assert.ok(levels[1].error > 0 && levels[2].error >= levels[1].error);
  assert.throws(() => generateMeshLods(source, { ratios: [0.2, 0.5] }), /decreasing/);
});

test('geometry and asset levels return renderer geometry, and refuse skinned parts', () => {
  const geometry = extractRender(sphere(40, 24)).geometry;
  const levels = generateGeometryLods(geometry, { ratios: [0.25] });
  assert.equal(levels[0].geometry, geometry);
  assert.ok(levels[1].geometry.indices.length < geometry.indices.length);
  assert.ok(levels[1].geometry.normals.length === levels[1].geometry.positions.length);
  const asset = { parts: [{ name: 'ball', geometry }, { name: 'twin', geometry }] };
  const assetLevels = generateAssetLods(asset, { ratios: [0.25] });
  assert.equal(assetLevels.length, 2);
  assert.equal(assetLevels[1].asset.parts[0].geometry, assetLevels[1].asset.parts[1].geometry);
  assert.throws(() => generateAssetLods({ parts: [{ name: 'arm', geometry, skin: {} }] }), /skinned/);
});
