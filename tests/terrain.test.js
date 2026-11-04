import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrain, heightmapFromImageData } from '../src/terrain.js';

const SMALL = { size: 128, chunks: 4, resolution: 16, levels: 3, height: { amplitude: 10, mountainAmplitude: 30, featureSize: 60 }, seed: 5 };

function vertexList(geometry) {
  const vertices = [];
  for (let index = 0; index < geometry.positions.length; index += 3) vertices.push(geometry.positions.slice(index, index + 3));
  return vertices;
}

function edgeHeights(geometry, axis, value) {
  const otherAxis = axis === 0 ? 2 : 0;
  const edge = new Map();
  for (const vertex of vertexList(geometry)) {
    if (Math.abs(vertex[axis] - value) < 1e-4) edge.set(vertex[otherAxis].toFixed(3), vertex[1]);
  }
  return edge;
}

function heightOnEdge(geometry, axis, value, other) {
  const edge = [...edgeHeights(geometry, axis, value).entries()].map(([position, height]) => [Number(position), height]).sort((first, second) => first[0] - second[0]);
  for (let index = 0; index < edge.length - 1; index++) {
    const [lowerPosition, lowerHeight] = edge[index];
    const [upperPosition, upperHeight] = edge[index + 1];
    if (other >= lowerPosition - 1e-3 && other <= upperPosition + 1e-3) {
      return lowerHeight + (upperHeight - lowerHeight) * (other - lowerPosition) / (upperPosition - lowerPosition);
    }
  }
  throw new Error('Position is not on the edge.');
}

test('the same seed gives the same terrain and another seed differs', () => {
  const first = createTerrain(SMALL);
  const second = createTerrain(SMALL);
  const other = createTerrain({ ...SMALL, seed: 6 });
  let differs = false;
  for (const [x, z] of [[0, 0], [13.7, -22.1], [-40, 31], [60, 60]]) {
    assert.equal(first.heightAt(x, z), second.heightAt(x, z));
    if (first.heightAt(x, z) !== other.heightAt(x, z)) differs = true;
  }
  assert.ok(differs);
  assert.deepEqual(first.parts[3].geometry.positions, second.parts[3].geometry.positions);
});

test('mirrorLevels gives every chunk coarser mirrorOnly meshes with growing errors, and none without the option', () => {
  const plain = createTerrain(SMALL);
  assert.ok(plain.parts.every(part => part.lods === undefined));
  const terrain = createTerrain({ ...SMALL, levels: 1, resolution: 64, mirrorLevels: 3 });
  for (const part of terrain.parts) {
    assert.equal(part.lods.length, 4);
    assert.equal(part.lods[0].geometry, part.geometry);
    assert.equal(part.lods[0].mirrorOnly, undefined);
    assert.ok(part.lods.slice(1).every(level => level.mirrorOnly === true && level.geometry.mirrorOnly === true));
    for (let index = 1; index < part.lods.length; index++) {
      assert.ok(part.lods[index].error >= part.lods[index - 1].error);
    }
    assert.ok(part.lods[3].geometry.indices.length < part.lods[0].geometry.indices.length / 2);
  }
});

test('a mirror mesh keeps every finest-grid vertex on the chunk edge, so it meets its neighbours without a crack', () => {
  const terrain = createTerrain({ ...SMALL, levels: 1, resolution: 64, mirrorLevels: 3 });
  const part = terrain.parts[5];
  const finest = vertexList(part.geometry);
  const lowestZ = Math.min(...finest.map(vertex => vertex[2]));
  const edgeAt = vertices => new Set(vertices.filter(vertex => Math.abs(vertex[2] - lowestZ) < 1e-4).map(vertex => vertex[0].toFixed(3)));
  const finestEdge = edgeAt(finest);
  assert.equal(finestEdge.size, 65);
  for (const level of part.lods.slice(1)) {
    const mirrorEdge = edgeAt(vertexList(level.geometry));
    assert.deepEqual([...mirrorEdge].sort(), [...finestEdge].sort());
  }
  assert.throws(() => createTerrain({ ...SMALL, levels: 3, mirrorLevels: 3 }), RangeError);
});

test('heightAt returns the vertex height at mesh vertices of the finest level', () => {
  const terrain = createTerrain(SMALL);
  terrain.update([0, 1, 0]);
  const chunk = terrain.parts.find(part => part.name === 'Terrain chunk 2,2');
  for (const [x, y, z] of vertexList(chunk.geometry)) assert.ok(Math.abs(terrain.heightAt(x, z) - y) < 1e-3, `${x},${z}`);
});

test('heightAt matches the interpolated triangles of the finest mesh', () => {
  const terrain = createTerrain({ ...SMALL, resolution: 8, levels: 1 });
  const { positions, indices } = terrain.parts[5].geometry;
  const weights = [[1 / 3, 1 / 3], [0.6, 0.15], [0.1, 0.7]];
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const corners = [0, 1, 2].map(offset => positions.subarray(indices[triangle + offset] * 3, indices[triangle + offset] * 3 + 3));
    const [weightFirst, weightSecond] = weights[triangle / 3 % 3];
    const weightThird = 1 - weightFirst - weightSecond;
    const x = corners[0][0] * weightFirst + corners[1][0] * weightSecond + corners[2][0] * weightThird;
    const z = corners[0][2] * weightFirst + corners[1][2] * weightSecond + corners[2][2] * weightThird;
    const expected = corners[0][1] * weightFirst + corners[1][1] * weightSecond + corners[2][1] * weightThird;
    assert.ok(Math.abs(terrain.heightAt(x, z) - expected) < 1e-3);
  }
});

test('triangles face up and normals are unit length and smooth', () => {
  const terrain = createTerrain(SMALL);
  const { positions, normals, indices } = terrain.parts[0].geometry;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const [a, b, c] = [0, 1, 2].map(offset => indices[triangle + offset] * 3);
    const edgeOne = [positions[b] - positions[a], positions[b + 2] - positions[a + 2]];
    const edgeTwo = [positions[c] - positions[a], positions[c + 2] - positions[a + 2]];
    assert.ok(edgeOne[1] * edgeTwo[0] - edgeOne[0] * edgeTwo[1] > 0);
  }
  for (let vertex = 0; vertex < normals.length; vertex += 3) {
    assert.ok(Math.abs(Math.hypot(normals[vertex], normals[vertex + 1], normals[vertex + 2]) - 1) < 1e-4);
    assert.ok(normals[vertex + 1] > 0);
  }
  assert.ok(Math.abs(Math.hypot(...terrain.normalAt(10, 10)) - 1) < 1e-6);
});

test('chunk edges stay watertight between different levels of detail', () => {
  const terrain = createTerrain({ ...SMALL, lodDistance: 20 });
  terrain.update([-60, 5, -60]);
  assert.ok(new Set(terrain.chunkLevels()).size > 1, 'the eye should produce several levels');
  const side = SMALL.chunks;
  let checked = 0;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side - 1; column++) {
      const west = terrain.parts[row * side + column].geometry;
      const east = terrain.parts[row * side + column + 1].geometry;
      const edgeX = -SMALL.size / 2 + (column + 1) * terrain.chunkSize;
      for (const [position, height] of edgeHeights(west, 0, edgeX)) {
        assert.ok(Math.abs(heightOnEdge(east, 0, edgeX, Number(position)) - height) < 1e-3);
        checked++;
      }
      for (const [position, height] of edgeHeights(east, 0, edgeX)) {
        assert.ok(Math.abs(heightOnEdge(west, 0, edgeX, Number(position)) - height) < 1e-3);
      }
    }
  }
  assert.ok(checked > 0);
});

test('update reports only chunks that changed and keeps triangle budgets per level', () => {
  const terrain = createTerrain({ ...SMALL, lodDistance: 20 });
  terrain.update([0, 1, 0]);
  assert.equal(terrain.update([0, 1, 0]).length, 0);
  const sum = terrain.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  assert.equal(sum, terrain.triangleCount);
  assert.ok(terrain.triangleCount < SMALL.chunks ** 2 * SMALL.resolution ** 2 * 2);
  assert.ok(terrain.update([0, 600, 0]).length > 0);
  assert.equal(terrain.triangleCount, SMALL.chunks ** 2 * (SMALL.resolution / 4) ** 2 * 2);
  for (const part of terrain.parts) assert.ok(part.geometry.indices.length / 3 <= 2 * SMALL.resolution ** 2);
});

test('heightmap arrays and functions drive the surface, and bad options throw', () => {
  const heights = new Float32Array(9).fill(2);
  heights[4] = 8;
  const terrain = createTerrain({ size: 64, chunks: 2, resolution: 8, levels: 1, height: heights });
  assert.ok(Math.abs(terrain.heightAt(0, 0) - 8) < 1e-4);
  assert.ok(Math.abs(terrain.heightAt(-32, -32) - 2) < 1e-4);
  const flat = createTerrain({ size: 64, chunks: 2, resolution: 8, levels: 1, height: () => 3 });
  assert.equal(flat.heightAt(5, 5), 3);
  assert.deepEqual(flat.bounds.min, [-32, 3, -32]);
  assert.throws(() => createTerrain({ resolution: 30, levels: 4 }), /divisible/);
  assert.throws(() => createTerrain({ height: new Float32Array(5) }), /square/);
  const image = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255]) };
  assert.deepEqual([...heightmapFromImageData(image, 10)], [10, 0, 0, 10]);
});
