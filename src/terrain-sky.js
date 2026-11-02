// Sky visibility of a heightfield: the share of the cosine-weighted sky above a ground point that the terrain around
// it leaves open. A valley floor inside a ring of peaks sees only part of the sky; a plateau sees all of it.
// It is computed from the horizon in a few directions, lazily for each grid point the first time a mesh needs it.

const AZIMUTH_COUNT = 16;
const FIRST_STEP_CELLS = 2;
const STEP_GROWTH = 1.3;
const HALF_PI = Math.PI / 2;
// At most about 160 lattice nodes along a side, so the cost does not grow with the grid.
const NODES_PER_SIDE = 160;

// Integral of max(dot(normal, direction), 0) over elevation, up to `elevation`, for one azimuth. `up` is the normal's
// y component and `across` its horizontal component along that azimuth.
function irradianceUpTo(elevation, up, across) {
  return up * Math.sin(elevation) ** 2 / 2 + across * (elevation / 2 + Math.sin(2 * elevation) / 4);
}

/**
 * `heights` is a (gridCells + 1) squared row-major grid with `spacing` meters between points; `highest` is its maximum.
 * `normalAt(column, row, target)` writes the unit surface normal into target. Returns `(column, row) => visibility`
 * in 0 to 1, where a point whose whole sky is open reads 1.
 */
export function createSkyVisibilitySampler({ heights, gridCells, spacing, highest, normalAt }) {
  const gridSide = gridCells + 1;
  const cache = new Float32Array(gridSide * gridSide).fill(Number.NaN);
  const maximumDistance = gridCells * spacing;
  const nodeStride = Math.max(1, Math.round(gridCells / NODES_PER_SIDE));
  const normal = new Float32Array(3);
  const cosines = Array.from({ length: AZIMUTH_COUNT }, (_, index) => Math.cos(index / AZIMUTH_COUNT * 2 * Math.PI));
  const sines = Array.from({ length: AZIMUTH_COUNT }, (_, index) => Math.sin(index / AZIMUTH_COUNT * 2 * Math.PI));

  function heightAtGrid(gridX, gridZ) {
    const column = Math.min(Math.floor(gridX), gridCells - 1);
    const row = Math.min(Math.floor(gridZ), gridCells - 1);
    const fractionX = gridX - column;
    const fractionZ = gridZ - row;
    const index = row * gridSide + column;
    const lower = heights[index] * (1 - fractionX) + heights[index + 1] * fractionX;
    const upper = heights[index + gridSide] * (1 - fractionX) + heights[index + gridSide + 1] * fractionX;
    return lower * (1 - fractionZ) + upper * fractionZ;
  }

  function horizonTangent(column, row, base, cosine, sine) {
    let tangent = -Infinity;
    for (let distance = spacing * FIRST_STEP_CELLS; distance <= maximumDistance; distance *= STEP_GROWTH) {
      // Nothing further out can rise above the horizon found so far.
      if ((highest - base) / distance <= tangent) break;
      const gridX = column + cosine * distance / spacing;
      const gridZ = row + sine * distance / spacing;
      if (gridX < 0 || gridZ < 0 || gridX > gridCells || gridZ > gridCells) break;
      tangent = Math.max(tangent, (heightAtGrid(gridX, gridZ) - base) / distance);
    }
    return tangent;
  }

  function compute(column, row) {
    const base = heights[row * gridSide + column];
    if (highest - base <= 0) return 1;
    normalAt(column, row, normal);
    const up = Math.max(normal[1], 1e-6);
    let visible = 0;
    let total = 0;
    for (let azimuth = 0; azimuth < AZIMUTH_COUNT; azimuth++) {
      const across = normal[0] * cosines[azimuth] + normal[2] * sines[azimuth];
      const horizon = Math.atan(horizonTangent(column, row, base, cosines[azimuth], sines[azimuth]));
      const surfaceHorizon = Math.atan(-across / up);
      const open = irradianceUpTo(HALF_PI, up, across);
      total += open - irradianceUpTo(surfaceHorizon, up, across);
      visible += open - irradianceUpTo(Math.max(horizon, surfaceHorizon), up, across);
    }
    return total > 0 ? Math.min(1, Math.max(0, visible / total)) : 1;
  }

  // Sky visibility changes slowly, so it is computed on a lattice every `nodeStride` grid points and interpolated.
  function nodeValue(column, row) {
    const index = row * gridSide + column;
    if (Number.isNaN(cache[index])) cache[index] = compute(column, row);
    return cache[index];
  }

  return function skyVisibilityAt(column, row) {
    const lowColumn = Math.floor(column / nodeStride) * nodeStride;
    const lowRow = Math.floor(row / nodeStride) * nodeStride;
    const highColumn = Math.min(lowColumn + nodeStride, gridCells);
    const highRow = Math.min(lowRow + nodeStride, gridCells);
    const fractionColumn = highColumn === lowColumn ? 0 : (column - lowColumn) / (highColumn - lowColumn);
    const fractionRow = highRow === lowRow ? 0 : (row - lowRow) / (highRow - lowRow);
    const near = nodeValue(lowColumn, lowRow) * (1 - fractionColumn) + nodeValue(highColumn, lowRow) * fractionColumn;
    const far = nodeValue(lowColumn, highRow) * (1 - fractionColumn) + nodeValue(highColumn, highRow) * fractionColumn;
    return near * (1 - fractionRow) + far * fractionRow;
  };
}
