// Sky visibility inside a tree crown: how much of the sky a leaf card sees through the other leaves around it.
// Leaf vertices are binned into a coarse grid, and each vertex looks up through the grid along a few directions; the
// more leaf it passes, the less sky it keeps. The result is stored once, when the tree is built, as one value per vertex.

const GRID_CELLS_ALONG_LONGEST_SIDE = 14;
// Leaf vertices per cell that cut the sky to 1/e over one cell of path. Fitted once against Cycles on the `foliage` scene.
const OPACITY_PER_VERTEX = 0.3;
const MINIMUM_VISIBILITY = 0.04;
const STEPS_PER_CELL = 2;
const UP_DIRECTIONS = buildUpDirections();

// One zenith ray and two rings of four rays, 40 and 65 degrees from the zenith.
function buildUpDirections() {
  const directions = [[0, 1, 0]];
  for (const [zenithAngle, phase] of [[40, 0], [65, 45]]) {
    const sine = Math.sin(zenithAngle * Math.PI / 180);
    const cosine = Math.cos(zenithAngle * Math.PI / 180);
    for (let ray = 0; ray < 4; ray++) {
      const azimuth = (phase + ray * 90) * Math.PI / 180;
      directions.push([sine * Math.cos(azimuth), cosine, sine * Math.sin(azimuth)]);
    }
  }
  return directions;
}

function boundsOfPositions(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
    }
  }
  return { minimum, maximum };
}

/**
 * Measures the leaf density of one foliage geometry and returns `{ visibilityOf(positions) }`, which gives one sky visibility
 * in 0 to 1 for every vertex of any geometry of the same crown. A thinner level of detail asks the field of the fullest
 * level, so every level reads the same value at the same place: working it out again from the few vertices of a thin level
 * put them in cells that looked solid and left the far crown near black.
 */
export function createCrownSkyField(positions) {
  const { minimum, maximum } = boundsOfPositions(positions);
  const longest = Math.max(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2], 1e-6);
  const cell = longest / GRID_CELLS_ALONG_LONGEST_SIDE;
  const size = [0, 1, 2].map(axis => Math.floor((maximum[axis] - minimum[axis]) / cell) + 1);
  const density = new Float32Array(size[0] * size[1] * size[2]);
  const cellOf = (value, axis) => Math.floor((value - minimum[axis]) / cell);
  const clampedCellOf = (value, axis) => Math.min(size[axis] - 1, Math.max(0, cellOf(value, axis)));
  for (let offset = 0; offset < positions.length; offset += 3) {
    const index = (cellOf(positions[offset + 2], 2) * size[1] + cellOf(positions[offset + 1], 1)) * size[0] + cellOf(positions[offset], 0);
    density[index] += OPACITY_PER_VERTEX;
  }
  const step = cell / STEPS_PER_CELL;
  // Visibility is worked out once for each occupied cell, from its centre, and shared by the vertices inside it.
  const cellVisibility = new Float32Array(density.length).fill(Number.NaN);

  function visibilityOfCell(column, row, layer) {
    const centre = [minimum[0] + (column + 0.5) * cell, minimum[1] + (row + 0.5) * cell, minimum[2] + (layer + 0.5) * cell];
    let open = 0;
    for (const direction of UP_DIRECTIONS) {
      let opticalDepth = 0;
      for (let travelled = 0; ; travelled += step) {
        const probeColumn = cellOf(centre[0] + direction[0] * travelled, 0);
        const probeRow = cellOf(centre[1] + direction[1] * travelled, 1);
        const probeLayer = cellOf(centre[2] + direction[2] * travelled, 2);
        if (probeColumn < 0 || probeLayer < 0 || probeColumn >= size[0] || probeRow >= size[1] || probeLayer >= size[2]) break;
        opticalDepth += density[(probeLayer * size[1] + probeRow) * size[0] + probeColumn] / STEPS_PER_CELL;
      }
      open += Math.exp(-opticalDepth);
    }
    return Math.max(MINIMUM_VISIBILITY, open / UP_DIRECTIONS.length);
  }

  function visibilityOf(targetPositions) {
    const vertexCount = targetPositions.length / 3;
    const visibility = new Float32Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const column = clampedCellOf(targetPositions[vertex * 3], 0);
      const row = clampedCellOf(targetPositions[vertex * 3 + 1], 1);
      const layer = clampedCellOf(targetPositions[vertex * 3 + 2], 2);
      const index = (layer * size[1] + row) * size[0] + column;
      if (Number.isNaN(cellVisibility[index])) cellVisibility[index] = visibilityOfCell(column, row, layer);
      visibility[vertex] = cellVisibility[index];
    }
    return visibility;
  }

  return { visibilityOf };
}

function meanOf(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Scales `visibility` so its mean is `targetMean`, keeping the floor and 1 as the limits. The larger leaves of a thinner level
 * sit further out in the crown than the leaves of level 0, so a field lookup alone leaves them seeing more sky on average.
 */
export function matchMeanVisibility(visibility, targetMean) {
  const scale = targetMean / meanOf(visibility);
  return visibility.map(value => Math.min(1, Math.max(MINIMUM_VISIBILITY, value * scale)));
}
