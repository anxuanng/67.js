import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerrain } from '../src/terrain.js';
import { createTree } from '../src/vegetation.js';

function lowestAndMeanOf(values) {
  let lowest = Infinity;
  let sum = 0;
  for (const value of values) {
    lowest = Math.min(lowest, value);
    sum += value;
  }
  return { lowest, mean: sum / values.length };
}

test('flat terrain sees the whole sky', () => {
  const terrain = createTerrain({ size: 256, resolution: 8, chunks: 4, height: () => 3 });
  for (const part of terrain.parts) {
    assert.equal(part.geometry.skyVisibility.length, part.geometry.positions.length / 3);
    for (const value of part.geometry.skyVisibility) assert.equal(value, 1);
  }
});

test('a bowl hides part of the sky on its floor and none on its rim', () => {
  const bowl = (x, z) => 300 * Math.min(1, Math.hypot(x, z) / 400) ** 2;
  const terrain = createTerrain({ size: 1024, resolution: 16, chunks: 8, height: bowl, eye: [0, 100, 0] });
  const floorChunk = terrain.parts.find(part => part.name === 'Terrain chunk 4,4').geometry;
  const floor = lowestAndMeanOf(floorChunk.skyVisibility);
  assert.ok(floor.mean < 0.8, `bowl floor mean ${floor.mean}`);
  assert.ok(floor.lowest > 0, 'the floor still sees some sky');
  const summit = lowestAndMeanOf(terrain.parts.find(part => part.name === 'Terrain chunk 0,0').geometry.skyVisibility);
  assert.ok(summit.mean > floor.mean);
  for (const part of terrain.parts) {
    for (const value of part.geometry.skyVisibility) assert.ok(value >= 0 && value <= 1);
  }
});

test('terrain sky visibility is the same on every build', () => {
  const options = { size: 512, resolution: 8, chunks: 4, seed: 4, eye: [0, 80, 0] };
  const first = createTerrain(options).parts.map(part => [...part.geometry.skyVisibility]);
  const second = createTerrain(options).parts.map(part => [...part.geometry.skyVisibility]);
  assert.deepEqual(first, second);
});

test('crown vertices inside the leaves see less sky than the outermost ones, at every level', () => {
  const tree = createTree('broadleaf', 3);
  for (const level of tree.levels) {
    const foliage = level.parts.find(part => part.role === 'foliage').geometry;
    assert.equal(foliage.skyVisibility.length, foliage.positions.length / 3);
    let highestVertex = 0;
    for (let vertex = 1; vertex < foliage.skyVisibility.length; vertex++) {
      if (foliage.positions[vertex * 3 + 1] > foliage.positions[highestVertex * 3 + 1]) highestVertex = vertex;
    }
    const { lowest, mean } = lowestAndMeanOf(foliage.skyVisibility);
    assert.ok(lowest >= 0.04 - 1e-6 && lowest < mean, `level range ${lowest} to ${mean}`);
    assert.ok(foliage.skyVisibility[highestVertex] > mean, 'the top of the crown sees more sky than the average vertex');
  }
});

test('bark and other parts carry no sky visibility', () => {
  const tree = createTree('broadleaf', 3);
  assert.equal(tree.levels[0].parts.find(part => part.role === 'bark').geometry.skyVisibility, undefined);
});
