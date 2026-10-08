import assert from 'node:assert/strict';
import test from 'node:test';
import { createNatureWorld } from '../src/nature.js';

const worlds = Object.fromEntries(['low', 'balanced', 'high'].map(detail => [detail, createNatureWorld({ detail })]));

function triangleCount(world) {
  return world.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
}

function validateGeometry(mesh) {
  assert.ok(mesh.positions instanceof Float32Array);
  assert.ok(mesh.normals instanceof Float32Array);
  assert.ok(mesh.indices instanceof Uint32Array);
  assert.equal(mesh.positions.length, mesh.normals.length);
  assert.equal(mesh.positions.length % 3, 0);
  assert.equal(mesh.indices.length % 3, 0);
  assert.ok(Array.from(mesh.positions).every(Number.isFinite));
  for (let offset = 0; offset < mesh.normals.length; offset += 3) {
    assert.ok(Math.abs(Math.hypot(...mesh.normals.subarray(offset, offset + 3)) - 1) < 1e-5, 'finite unit normals');
  }
  for (const index of mesh.indices) {
    assert.ok(index < mesh.positions.length / 3, 'index in vertex range');
  }
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const indices = Array.from(mesh.indices.subarray(offset, offset + 3));
    const vertices = indices.map(index => Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)));
    const [first, second, third] = vertices;
    const edgeA = second.map((value, axis) => value - first[axis]);
    const edgeB = third.map((value, axis) => value - first[axis]);
    const cross = [
      edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
      edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
      edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
    ];
    assert.ok(Math.hypot(...cross) > 1e-10, 'nondegenerate triangles');
    const averageNormal = [0, 1, 2].map(axis => indices.reduce((sum, index) => sum + mesh.normals[index * 3 + axis], 0));
    assert.ok(cross.reduce((sum, value, axis) => sum + value * averageNormal[axis], 0) > 0, 'winding matches normals');
  }
}

test('nature generation is repeatable and seeds change terrain and tree placement', () => {
  const repeated = createNatureWorld();
  assert.deepEqual(repeated, worlds.balanced);
  const alternative = createNatureWorld({ seed: 68 });
  assert.notDeepEqual(alternative.parts[0].geometry.positions, repeated.parts[0].geometry.positions);
  const treeIndex = repeated.parts.findIndex(part => part.name === 'Tree 0 trunk');
  const alternativeTree = alternative.parts.find(part => part.name === 'Tree 0 trunk');
  assert.notDeepEqual(repeated.parts[treeIndex].matrix, alternativeTree.matrix);
});

test('all detail presets produce finite geometry with consistent winding', () => {
  for (const world of Object.values(worlds)) {
    const meshes = new Set(world.parts.map(part => part.geometry));
    for (const mesh of meshes) validateGeometry(mesh);
  }
});

test('scene parts meet the renderer contract and stay within declared bounds', () => {
  const world = worlds.balanced;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const tags = new Set();
  for (const part of world.parts) {
    assert.ok(part.name.length > 0);
    assert.ok(part.matrix instanceof Float32Array);
    assert.equal(part.matrix.length, 16);
    assert.ok(Array.from(part.matrix).every(Number.isFinite));
    assert.equal(part.matrix[15], 1);
    assert.ok(part.material.color.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(part.material.metallic >= 0 && part.material.metallic <= 1);
    assert.ok(part.material.roughness > 0 && part.material.roughness <= 1);
    assert.ok(part.material.emission >= 0);
    tags.add(part.material.tag);
    const matrix = part.matrix;
    const positions = part.geometry.positions;
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const position = matrix[axis] * positions[offset] + matrix[axis + 4] * positions[offset + 1] + matrix[axis + 8] * positions[offset + 2] + matrix[axis + 12];
        minimum[axis] = Math.min(minimum[axis], position);
        maximum[axis] = Math.max(maximum[axis], position);
        assert.ok(position >= world.bounds.minimum[axis] - 1e-5 && position <= world.bounds.maximum[axis] + 1e-5);
      }
    }
  }
  assert.deepEqual(minimum, world.bounds.minimum);
  assert.deepEqual(maximum, world.bounds.maximum);
  for (const tag of ['terrain', 'foliage', 'grass', 'water', 'rock', 'wood']) assert.ok(tags.has(tag));
});

test('detail presets scale vegetation and real geometry inside the instancing budget', () => {
  assert.ok(worlds.low.parts.length < worlds.balanced.parts.length);
  assert.ok(worlds.balanced.parts.length < worlds.high.parts.length);
  assert.ok(triangleCount(worlds.low) < triangleCount(worlds.balanced));
  assert.ok(triangleCount(worlds.balanced) < triangleCount(worlds.high));
  assert.ok(worlds.low.parts[0].geometry.positions.length < worlds.balanced.parts[0].geometry.positions.length);
  assert.ok(worlds.balanced.parts[0].geometry.positions.length < worlds.high.parts[0].geometry.positions.length);
  for (const [detail, world] of Object.entries(worlds)) {
    const sharedMeshes = new Set(world.parts.map(part => part.geometry));
    assert.ok(world.parts.length < 4000, `${detail} part budget`);
    assert.ok(sharedMeshes.size < 100, `${detail} shared mesh budget`);
    assert.ok(triangleCount(world) < 1_000_000, `${detail} triangle budget`);
    console.log(JSON.stringify({ detail, parts: world.parts.length, sharedMeshes: sharedMeshes.size, triangles: triangleCount(world) }));
  }
});

test('water is a continuous horizontal surface and navigation has usable view directions', () => {
  const world = worlds.balanced;
  const water = world.parts.find(part => part.material.tag === 'water');
  assert.ok(water.geometry.indices.length > 300);
  for (let offset = 1; offset < water.geometry.positions.length; offset += 3) {
    assert.ok(Math.abs(water.geometry.positions[offset] - 0.22) < 1e-6);
  }
  assert.ok(world.points.length >= 3);
  assert.deepEqual(world.points[0].eye, world.camera.eye);
  for (const viewpoint of [world.camera, ...world.points]) {
    assert.ok(viewpoint.eye.every(Number.isFinite));
    assert.ok(viewpoint.target.every(Number.isFinite));
    assert.ok(Math.hypot(...viewpoint.eye.map((value, axis) => value - viewpoint.target[axis])) > 1);
  }
  assert.ok(world.environment.fogDensity > 0 && world.environment.fogDensity < 0.05);
  for (const key of ['fogColor', 'skyTop', 'skyBottom']) {
    assert.equal(world.environment[key].length, 3);
    assert.ok(world.environment[key].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }
  assert.ok(Math.hypot(...world.environment.lightDirection) > 0);
});

test('unsupported options fail with explicit errors', () => {
  assert.throws(() => createNatureWorld({ detail: 'ultra' }), RangeError);
  assert.throws(() => createNatureWorld({ detail: 'toString' }), RangeError);
  assert.throws(() => createNatureWorld({ seed: NaN }), TypeError);
  assert.throws(() => createNatureWorld({ seed: Infinity }), TypeError);
});
