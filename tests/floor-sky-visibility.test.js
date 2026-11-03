import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFloorSkyVisibility, findFloorParts } from '../src/floor-sky-visibility.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A flat square of side `size` at height `height`, facing up (or down), with UVs.
function square(name, size, height, { facing = 1, material = { color: [0.5, 0.5, 0.5] } } = {}) {
  const half = size / 2;
  const geometry = {
    positions: new Float32Array([-half, height, -half, half, height, -half, half, height, half, -half, height, half]),
    normals: new Float32Array([0, facing, 0, 0, facing, 0, 0, facing, 0, 0, facing, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array(facing > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]),
  };
  return { name, geometry, matrix: IDENTITY, material };
}

function skyVisibilityAt(result, floorIndex, x, z) {
  const { positions } = result.parts[floorIndex].geometry;
  const { skyVisibility } = result.parts[floorIndex].geometry;
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const distance = Math.hypot(positions[vertex * 3] - x, positions[vertex * 3 + 2] - z);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = vertex;
    }
  }
  return skyVisibility[nearest];
}

test('an open floor stays at full sky visibility', () => {
  const floor = square('floor', 20, 0);
  const result = applyFloorSkyVisibility([floor, square('far-away-roof', 2, 50, { facing: -1 })], { maximumTexels: 400 });
  assert.equal(result.report.reason, null);
  const values = result.parts[0].geometry.skyVisibility;
  assert.ok(values.length > 4, 'the floor is cut into texels');
  assert.ok(Math.min(...values) > 0.95, `the lowest value is ${Math.min(...values)}`);
});

test('a roof hides the sky under it and leaves the open side alone', () => {
  const floor = square('floor', 20, 0);
  const roof = square('roof', 6, 2, { facing: -1 });
  const result = applyFloorSkyVisibility([floor, roof], { maximumTexels: 1600 });
  const under = skyVisibilityAt(result, 0, 0, 0);
  const outside = skyVisibilityAt(result, 0, 9, 9);
  assert.ok(under < 0.5, `under the roof ${under}`);
  assert.ok(outside > 0.95, `outside ${outside}`);
});

test('strength 0.5 keeps half of what the roof hides', () => {
  const parts = [square('floor', 20, 0), square('roof', 6, 2, { facing: -1 })];
  const full = skyVisibilityAt(applyFloorSkyVisibility(parts, { maximumTexels: 1600 }), 0, 0, 0);
  const half = skyVisibilityAt(applyFloorSkyVisibility(parts, { maximumTexels: 1600, strength: 0.5 }), 0, 0, 0);
  assert.ok(Math.abs(half - (1 - (1 - full) / 2)) < 1e-6);
});

test('the cut floor keeps its UVs, normals and a shape that covers the same area', () => {
  const result = applyFloorSkyVisibility([square('floor', 10, 0), square('roof', 2, 3, { facing: -1 })], { maximumTexels: 200 });
  const { positions, uvs, normals, indices } = result.parts[0].geometry;
  assert.equal(uvs.length / 2, positions.length / 3);
  assert.equal(normals.length, positions.length);
  let area = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(slot => indices[corner + slot]);
    const edgeOne = [positions[second * 3] - positions[first * 3], positions[second * 3 + 2] - positions[first * 3 + 2]];
    const edgeTwo = [positions[third * 3] - positions[first * 3], positions[third * 3 + 2] - positions[first * 3 + 2]];
    area += Math.abs(edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]) / 2;
  }
  assert.ok(Math.abs(area - 100) < 1e-3, `area ${area}`);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    assert.ok(Math.abs(uvs[vertex * 2] - (positions[vertex * 3] / 10 + 0.5)) < 1e-5);
  }
});

test('the same parts give the same bytes', () => {
  const parts = [square('floor', 10, 0), square('roof', 4, 2, { facing: -1 })];
  const first = applyFloorSkyVisibility(parts, { maximumTexels: 300 }).parts[0].geometry.skyVisibility;
  const second = applyFloorSkyVisibility(parts, { maximumTexels: 300 }).parts[0].geometry.skyVisibility;
  assert.deepEqual(Array.from(first), Array.from(second));
});

test('parts that carry their own light, a cut-out or a tag are not floors', () => {
  const baked = square('baked', 10, 0, { material: { color: [1, 1, 1], lightMap: {} } });
  const leaves = square('leaves', 10, 0, { material: { color: [1, 1, 1], alphaMode: 'mask' } });
  const water = square('water', 10, 0, { material: { color: [1, 1, 1], tag: 'water' } });
  const own = square('own', 10, 0);
  own.geometry.skyVisibility = new Float32Array(4).fill(1);
  const roof = square('roof', 4, 2, { facing: -1 });
  assert.deepEqual(findFloorParts([baked, leaves, water, own, roof]), []);
});

test('a scene with no floor or nothing above it comes back unchanged', () => {
  const lone = [square('floor', 10, 0)];
  assert.equal(applyFloorSkyVisibility(lone).parts, lone);
  assert.equal(applyFloorSkyVisibility(lone).report.reason, 'nothing above the floor');
  const roofOnly = [square('roof', 4, 2, { facing: -1 }), square('roof-two', 4, 3, { facing: -1 })];
  assert.equal(applyFloorSkyVisibility(roofOnly).report.reason, 'no floor');
});

test('a trace that passes its time limit returns the parts as they were', () => {
  const parts = [square('floor', 10, 0), square('roof', 4, 2, { facing: -1 })];
  const result = applyFloorSkyVisibility(parts, { maxSeconds: 0 });
  assert.equal(result.parts, parts);
  assert.equal(result.report.reason, 'passed maxSeconds');
});
