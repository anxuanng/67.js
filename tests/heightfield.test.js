import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHeightfieldGeometry, sampleRasterGrid } from '../src/heightfield.js';

// The per-vertex code the AIS port film used before: a closure call per sample, a cell mean of 4 by 4 bilinear
// samples, an index array grown with push. The new path must give the same mesh from it.
function referenceBilinear(raster, east, north) {
  const { box } = raster;
  const column = ((east - box.x_min) / (box.x_max - box.x_min)) * raster.width - 0.5;
  const row = ((box.y_max - north) / (box.y_max - box.y_min)) * raster.height - 0.5;
  const left = Math.min(raster.width - 2, Math.max(0, Math.floor(column)));
  const top = Math.min(raster.height - 2, Math.max(0, Math.floor(row)));
  const across = Math.min(1, Math.max(0, column - left));
  const down = Math.min(1, Math.max(0, row - top));
  const at = (x, y) => raster.values[y * raster.width + x];
  const upper = at(left, top) * (1 - across) + at(left + 1, top) * across;
  const lower = at(left, top + 1) * (1 - across) + at(left + 1, top + 1) * across;
  return upper * (1 - down) + lower * down;
}

function referenceCellAverage(raster, east, north, cellSize, samplesPerSide) {
  let total = 0;
  for (let across = 0; across < samplesPerSide; across += 1) {
    for (let down = 0; down < samplesPerSide; down += 1) {
      const offsetEast = ((across + 0.5) / samplesPerSide - 0.5) * cellSize;
      const offsetNorth = ((down + 0.5) / samplesPerSide - 0.5) * cellSize;
      total += referenceBilinear(raster, east + offsetEast, north + offsetNorth);
    }
  }
  return total / (samplesPerSide * samplesPerSide);
}

function referenceGeometry({ columns, rows, eastAt, northAt, heightAt, uvBox, keepCell }) {
  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  for (let row = 0; row < rows; row += 1) {
    const north = northAt(row);
    for (let column = 0; column < columns; column += 1) {
      const east = eastAt(column);
      const vertex = row * columns + column;
      positions[vertex * 3] = east;
      positions[vertex * 3 + 1] = heightAt(east, north);
      positions[vertex * 3 + 2] = -north;
      uvs[vertex * 2] = (east - uvBox.x_min) / (uvBox.x_max - uvBox.x_min);
      uvs[vertex * 2 + 1] = (uvBox.y_max - north) / (uvBox.y_max - uvBox.y_min);
    }
  }
  const normals = new Float32Array(positions.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = row * columns + Math.max(0, column - 1);
      const right = row * columns + Math.min(columns - 1, column + 1);
      const up = Math.max(0, row - 1) * columns + column;
      const down = Math.min(rows - 1, row + 1) * columns + column;
      const normalX = -(positions[right * 3 + 1] - positions[left * 3 + 1]) / (positions[right * 3] - positions[left * 3]);
      const normalZ = -(positions[down * 3 + 1] - positions[up * 3 + 1]) / (positions[down * 3 + 2] - positions[up * 3 + 2]);
      const length = Math.hypot(normalX, 1, normalZ);
      const vertex = row * columns + column;
      normals[vertex * 3] = normalX / length;
      normals[vertex * 3 + 1] = 1 / length;
      normals[vertex * 3 + 2] = normalZ / length;
    }
  }
  const indices = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      if (keepCell && !keepCell(column, row)) continue;
      const a = row * columns + column;
      indices.push(a, a + columns, a + 1, a + 1, a + columns, a + columns + 1);
    }
  }
  return { positions, normals, uvs, indices: Uint32Array.from(indices) };
}

function seededRaster(width, height, box, seed) {
  const values = new Uint8Array(width * height);
  let state = seed;
  for (let index = 0; index < values.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    values[index] = state >>> 24;
  }
  return { values, width, height, box };
}

function checksum(array) {
  return createHash('sha256').update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex').slice(0, 16);
}

const mapBox = { x_min: 100, x_max: 740, y_min: -200, y_max: 440 };
const mask = seededRaster(53, 47, mapBox, 7);
const grid = { columns: 41, rows: 37, eastAt: (column) => 90 + column * 17, northAt: (row) => 450 - row * 18.5 };

test('sampleRasterGrid equals the cell mean of bilinear samples taken vertex by vertex', () => {
  for (const [cellSize, samplesPerSide] of [[17, 4], [0, 1], [40, 3]]) {
    const fast = sampleRasterGrid(mask, { ...grid, cellSize, samplesPerSide, scale: 1 / 255 });
    let largestDifference = 0;
    for (let row = 0; row < grid.rows; row += 1) {
      for (let column = 0; column < grid.columns; column += 1) {
        const expected = referenceCellAverage(mask, grid.eastAt(column), grid.northAt(row), cellSize, samplesPerSide) / 255;
        largestDifference = Math.max(largestDifference, Math.abs(fast[row * grid.columns + column] - expected));
      }
    }
    assert.ok(largestDifference < 1e-12, `cell ${cellSize}, ${samplesPerSide} samples: largest difference ${largestDifference}`);
  }
});

test('createHeightfieldGeometry matches the old per-vertex build, with dropped cells', () => {
  const heightOf = (east, north) => referenceCellAverage(mask, east, north, 17, 4) / 255 * 30 + Math.sin(east / 60) * 5 - north * 0.01;
  const keepCell = (column, row) => !(column > 10 && column < 25 && row > 8 && row < 20);
  const uvBox = mapBox;
  const expected = referenceGeometry({ ...grid, heightAt: heightOf, uvBox, keepCell });
  const heights = new Float32Array(grid.columns * grid.rows);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) heights[row * grid.columns + column] = heightOf(grid.eastAt(column), grid.northAt(row));
  }
  const actual = createHeightfieldGeometry({ ...grid, heights, uvBox, keepCell });
  assert.deepEqual(actual.indices, expected.indices);
  assert.deepEqual(actual.uvs, expected.uvs);
  assert.deepEqual(actual.positions, expected.positions);
  assert.deepEqual(actual.normals, expected.normals);
  assert.equal(checksum(actual.positions), '4e667c0630cadd69');
  assert.equal(checksum(actual.normals), 'a0164146e3b24eb8');
  assert.equal(checksum(actual.indices), 'cad638e3a2ef4d96');
});

test('createHeightfieldGeometry rejects a height array of the wrong length', () => {
  assert.throws(() => createHeightfieldGeometry({ ...grid, heights: new Float32Array(3), uvBox: mapBox }), RangeError);
});
