// A mesh grid over georeferenced rasters (heights, a mask, a photo) without a closure call per sample. Rasters are
// { values, width, height, box: { x_min, x_max, y_min, y_max } } with pixel centres on the box and row 0 at the north edge.
// World axes: x east, y up, z = -north.

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// For one axis, the raster pixels each grid index reads and their weights. The mean of bilinear samples is a
// weighted sum of pixels, and a bilinear sample is separable across the axes, so the east weights and the north
// weights can be built apart and applied in two passes.
function axisTaps({ count, coordinateAt, boxLow, boxHigh, pixels, reversed, cellSize, samplesPerSide }) {
  const firstPixel = new Int32Array(count);
  const tapCount = new Int32Array(count);
  const tapOffset = new Int32Array(count);
  const lowPixels = new Int32Array(samplesPerSide);
  const fractions = new Float64Array(samplesPerSide);
  const share = 1 / samplesPerSide;
  let weights = new Float64Array(count * (samplesPerSide + 1));
  let used = 0;
  for (let index = 0; index < count; index += 1) {
    const centre = coordinateAt(index);
    let lowest = pixels;
    let highest = 0;
    for (let sample = 0; sample < samplesPerSide; sample += 1) {
      const world = centre + ((sample + 0.5) / samplesPerSide - 0.5) * cellSize;
      const unit = reversed ? (boxHigh - world) / (boxHigh - boxLow) : (world - boxLow) / (boxHigh - boxLow);
      const position = unit * pixels - 0.5;
      const low = clamp(Math.floor(position), 0, pixels - 2);
      lowPixels[sample] = low;
      fractions[sample] = clamp(position - low, 0, 1);
      lowest = Math.min(lowest, low);
      highest = Math.max(highest, low + 1);
    }
    const taps = highest - lowest + 1;
    if (used + taps > weights.length) {
      const grown = new Float64Array(Math.max(weights.length * 2, used + taps));
      grown.set(weights);
      weights = grown;
    }
    firstPixel[index] = lowest;
    tapCount[index] = taps;
    tapOffset[index] = used;
    for (let sample = 0; sample < samplesPerSide; sample += 1) {
      const slot = used + lowPixels[sample] - lowest;
      weights[slot] += (1 - fractions[sample]) * share;
      weights[slot + 1] += fractions[sample] * share;
    }
    used += taps;
  }
  return { firstPixel, tapCount, tapOffset, weights };
}

/**
 * The mean of a raster over a square cell centred on every vertex of a regular grid, from a samplesPerSide by
 * samplesPerSide pattern of bilinear samples; `cellSize` 0 with one sample reads the raster at the vertex.
 * Returns a Float64Array of columns * rows values (row-major), each multiplied by `scale`. The same values as
 * averaging bilinear samples vertex by vertex, in a pass over the pixels per axis and no allocation per vertex.
 */
export function sampleRasterGrid(raster, { columns, rows, eastAt, northAt, cellSize = 0, samplesPerSide = 1, scale = 1 }) {
  const { values, width, height, box } = raster;
  if (width < 2 || height < 2) throw new RangeError('A raster needs at least 2 by 2 pixels.');
  const east = axisTaps({ count: columns, coordinateAt: eastAt, boxLow: box.x_min, boxHigh: box.x_max, pixels: width, reversed: false, cellSize, samplesPerSide });
  const north = axisTaps({ count: rows, coordinateAt: northAt, boxLow: box.y_min, boxHigh: box.y_max, pixels: height, reversed: true, cellSize, samplesPerSide });
  let firstRow = height;
  let lastRow = 0;
  for (let row = 0; row < rows; row += 1) {
    firstRow = Math.min(firstRow, north.firstPixel[row]);
    lastRow = Math.max(lastRow, north.firstPixel[row] + north.tapCount[row] - 1);
  }
  const across = new Float64Array((lastRow - firstRow + 1) * columns);
  for (let pixelRow = firstRow; pixelRow <= lastRow; pixelRow += 1) {
    const rowStart = pixelRow * width;
    const outputStart = (pixelRow - firstRow) * columns;
    for (let column = 0; column < columns; column += 1) {
      const offset = east.tapOffset[column];
      const start = rowStart + east.firstPixel[column];
      let total = 0;
      for (let tap = 0, taps = east.tapCount[column]; tap < taps; tap += 1) total += east.weights[offset + tap] * values[start + tap];
      across[outputStart + column] = total;
    }
  }
  const output = new Float64Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const offset = north.tapOffset[row];
    const outputStart = row * columns;
    for (let tap = 0, taps = north.tapCount[row]; tap < taps; tap += 1) {
      const weight = north.weights[offset + tap] * scale;
      const sourceStart = (north.firstPixel[row] + tap - firstRow) * columns;
      for (let column = 0; column < columns; column += 1) output[outputStart + column] += weight * across[sourceStart + column];
    }
  }
  return output;
}

function gridNormals(positions, columns, rows) {
  const normals = new Float32Array(positions.length);
  for (let row = 0; row < rows; row += 1) {
    const upRow = Math.max(0, row - 1) * columns;
    const downRow = Math.min(rows - 1, row + 1) * columns;
    for (let column = 0; column < columns; column += 1) {
      const vertex = row * columns + column;
      const left = row * columns + Math.max(0, column - 1);
      const right = row * columns + Math.min(columns - 1, column + 1);
      const up = upRow + column;
      const down = downRow + column;
      const normalX = -(positions[right * 3 + 1] - positions[left * 3 + 1]) / (positions[right * 3] - positions[left * 3]);
      const normalZ = -(positions[down * 3 + 1] - positions[up * 3 + 1]) / (positions[down * 3 + 2] - positions[up * 3 + 2]);
      const length = Math.hypot(normalX, 1, normalZ);
      normals[vertex * 3] = normalX / length;
      normals[vertex * 3 + 1] = 1 / length;
      normals[vertex * 3 + 2] = normalZ / length;
    }
  }
  return normals;
}

/**
 * Mesh geometry ({ positions, normals, uvs, indices }) for a regular grid of `heights` (columns * rows, row-major,
 * row 0 first). `eastAt(column)` and `northAt(row)` give the world position of each line; uvs span `uvBox`;
 * `keepCell(column, row)` drops the cells a finer tier covers.
 */
export function createHeightfieldGeometry({ columns, rows, eastAt, northAt, heights, uvBox, keepCell }) {
  if (heights.length !== columns * rows) throw new RangeError('heights must hold columns * rows values.');
  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  const uvWidth = uvBox.x_max - uvBox.x_min;
  const uvHeight = uvBox.y_max - uvBox.y_min;
  const eastLines = new Float64Array(columns);
  for (let column = 0; column < columns; column += 1) eastLines[column] = eastAt(column);
  for (let row = 0; row < rows; row += 1) {
    const north = northAt(row);
    const uvNorth = (uvBox.y_max - north) / uvHeight;
    for (let column = 0; column < columns; column += 1) {
      const east = eastLines[column];
      const vertex = row * columns + column;
      positions[vertex * 3] = east;
      positions[vertex * 3 + 1] = heights[vertex];
      positions[vertex * 3 + 2] = -north;
      uvs[vertex * 2] = (east - uvBox.x_min) / uvWidth;
      uvs[vertex * 2 + 1] = uvNorth;
    }
  }
  const kept = new Uint8Array((columns - 1) * (rows - 1));
  let keptCount = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      if (keepCell && !keepCell(column, row)) continue;
      kept[row * (columns - 1) + column] = 1;
      keptCount += 1;
    }
  }
  const indices = new Uint32Array(keptCount * 6);
  let cursor = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      if (!kept[row * (columns - 1) + column]) continue;
      const a = row * columns + column;
      const c = a + columns;
      indices[cursor] = a;
      indices[cursor + 1] = c;
      indices[cursor + 2] = a + 1;
      indices[cursor + 3] = a + 1;
      indices[cursor + 4] = c;
      indices[cursor + 5] = c + 1;
      cursor += 6;
    }
  }
  return { positions, normals: gridNormals(positions, columns, rows), uvs, indices };
}
