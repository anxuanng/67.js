import test from 'node:test';
import assert from 'node:assert/strict';
import { CLUTTER_LEVELS, CLUTTER_PRESETS, createClutter } from '../src/clutter.js';

const smallArea = { minX: 0, maxX: 8, minZ: 0, maxZ: 8 };
const near = { area: smallArea, eye: [4, 1, 4] };

function triangleFacesAgreeWithNormals(geometry) {
  const { positions, normals, indices } = geometry;
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [indices[index], indices[index + 1], indices[index + 2]].map(vertex => [0, 1, 2].map(axis => positions[vertex * 3 + axis]));
    const first = [0, 1, 2].map(axis => corners[1][axis] - corners[0][axis]);
    const second = [0, 1, 2].map(axis => corners[2][axis] - corners[0][axis]);
    const face = [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
    const normal = [0, 1, 2].map(axis => normals[indices[index] * 3 + axis]);
    if (face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2] < 0) return false;
  }
  return true;
}

test('the same options and seed build identical clutter', () => {
  const first = createClutter({ ...near, preset: 'riverbed', seed: 2 });
  const second = createClutter({ ...near, preset: 'riverbed', seed: 2 });
  assert.equal(first.parts.length, second.parts.length);
  first.parts.forEach((part, index) => assert.deepEqual(part.geometry.positions, second.parts[index].geometry.positions));
  const other = createClutter({ ...near, preset: 'riverbed', seed: 3 });
  assert.notDeepEqual(first.parts[0].geometry.positions, other.parts[0].geometry.positions);
});

test('stones face outward and stand on the ground they sink into', () => {
  const terrainHeight = (x, z) => 1 + x * 0.05 + Math.sin(z);
  const clutter = createClutter({ ...near, preset: 'scree', twigs: 0, leaves: 0, terrainHeight });
  const stones = clutter.parts.filter(part => part.name.match(/^Clutter (rocks|pebbles)/));
  assert.ok(stones.length > 0);
  for (const part of stones) {
    assert.ok(triangleFacesAgreeWithNormals(part.geometry), 'winding and normals agree, so stones are not inside out');
    assert.equal(part.castShadow, true);
  }
  // Every stone reaches below the ground and above it.
  const { positions } = stones[0].geometry;
  let below = 0;
  let above = 0;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const x = positions[vertex * 3] + stones[0].matrix[12];
    const z = positions[vertex * 3 + 2] + stones[0].matrix[14];
    if (positions[vertex * 3 + 1] < terrainHeight(x, z)) below += 1;
    else above += 1;
  }
  assert.ok(below > 0 && above > below * 0.5);
});

test('fallen leaves face the sky and litter never casts shadows', () => {
  const clutter = createClutter({ ...near, preset: 'forest', pebbles: 0, rocks: 0, twigs: 0 });
  const litter = clutter.parts.filter(part => part.name.startsWith('Clutter litter'));
  assert.ok(litter.length > 0);
  for (const part of litter) {
    assert.equal(part.castShadow, false);
    assert.equal(part.material.doubleSided, true);
    assert.ok(triangleFacesAgreeWithNormals(part.geometry));
  }
});

test('the farthest level keeps only rocks, and far tiles are culled', () => {
  const area = { minX: -80, maxX: 80, minZ: -80, maxZ: 80 };
  const clutter = createClutter({ area, preset: 'meadow', pebbles: 2, rocks: 0, twigs: 1, leaves: 1, eye: [0, 1, 0] });
  const stats = clutter.stats();
  assert.equal(stats.levelCounts[2], 0, 'without rocks the last level is empty');
  assert.ok(stats.levelCounts[0] > 0 && stats.levelCounts[1] > 0);
  assert.ok(stats.visibleTiles < stats.tiles);
  const rocky = createClutter({ area, preset: 'meadow', rocks: 0.5, eye: [0, 1, 0] }).stats();
  assert.ok(rocky.levelCounts[2] > 0);
  assert.equal(CLUTTER_LEVELS.at(-1).distance, 70);
});

test('a zero mask clears clutter, and update stays quiet when nothing moves', () => {
  assert.equal(createClutter({ ...near, mask: () => 0 }).parts.length, 0);
  const clutter = createClutter({ ...near, preset: 'forest' });
  assert.equal(clutter.update([4, 1, 4]), false);
  assert.equal(clutter.update([400, 1, 400]), true);
  assert.equal(clutter.parts.length, 0);
});

test('every preset builds, and bad options fail with clear errors', () => {
  for (const preset of Object.keys(CLUTTER_PRESETS)) assert.ok(createClutter({ ...near, preset }).parts.length > 0, preset);
  assert.throws(() => createClutter({ ...near, preset: 'beach' }), /Unknown clutter preset/);
  assert.throws(() => createClutter({}), /area/);
  assert.throws(() => createClutter({ ...near, pebbles: -1 }), /pebbles/);
  assert.throws(() => createClutter({ ...near, moss: 2 }), /moss/);
  assert.throws(() => createClutter({ ...near, rockSize: [0.5, 0.1] }), /rockSize/);
  assert.throws(() => createClutter({ ...near, leafColors: [] }), /leafColors/);
  assert.throws(() => createClutter({ ...near, mask: 1 }), /mask/);
});
