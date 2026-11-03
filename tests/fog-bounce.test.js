import test from 'node:test';
import assert from 'node:assert/strict';
import { fogBounceGrid } from '../src/fog-bounce.js';
import { skyGridSize } from '../src/closed-room.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// A square facing up at the given height.
function floorPart(name, height, material) {
  const corners = [-50, height, -50, 50, height, -50, 50, height, 50, -50, height, 50];
  return { name, geometry: { positions: new Float32Array(corners), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) }, matrix: identity, material };
}

function channelTotal(grid, channel) {
  let total = 0;
  for (let index = channel; index < grid.length; index += 3) {
    total += grid[index];
  }
  return total;
}

const minimum = [-4, 0.5, -4];
const maximum = [4, 2.5, 4];
const size = skyGridSize(minimum, maximum);

test('an emissive floor gives the fog above it light in its own colour, and a plain one gives none', () => {
  const glowing = fogBounceGrid([floorPart('floor', 0, { color: [1, 0.5, 0], emission: 2 })], size, minimum, maximum, {});
  const plain = fogBounceGrid([floorPart('floor', 0, { color: [1, 0.5, 0] })], size, minimum, maximum, {});
  assert.equal(glowing.length, size[0] * size[1] * size[2] * 3);
  assert.ok(channelTotal(glowing, 0) > 0);
  assert.ok(channelTotal(glowing, 1) > 0 && channelTotal(glowing, 1) < channelTotal(glowing, 0));
  assert.equal(channelTotal(glowing, 2), 0);
  assert.ok(plain.every(value => value === 0));
});

test('a point light on a plain floor lights the fog, and the same scene gives the same numbers', () => {
  const parts = [floorPart('floor', 0, { color: [0.5, 0.5, 0.5] })];
  const lighting = { pointLights: [{ position: [0, 1, 0], color: [1, 1, 1], intensity: 20 }] };
  const lit = fogBounceGrid(parts, size, minimum, maximum, lighting);
  assert.ok(lit.some(value => value > 0));
  assert.deepEqual(fogBounceGrid(parts, size, minimum, maximum, lighting), lit);
});

test('a part with an emissive map is not a source, and a part the bake cannot read leaves no grid', () => {
  const baked = fogBounceGrid([floorPart('floor', 0, { color: [1, 1, 1], emission: 5, emissiveColor: [1, 1, 1], emissiveMap: {} })], size, minimum, maximum, {});
  assert.ok(baked.every(value => value === 0));
  assert.equal(fogBounceGrid([floorPart('floor', 0, undefined)], size, minimum, maximum, {}), null);
});
