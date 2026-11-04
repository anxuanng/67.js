// Chunked heightfield terrain with distance-based level of detail and exact height queries.
// The finest grid is sampled once. Every mesh vertex reads that grid, and heightAt() interpolates it over the same
// triangles as the finest mesh, so vegetation and vehicles sit on the rendered surface.

import './world-material-shader.js';
import { createSkyVisibilitySampler } from './terrain-sky.js';

const DEFAULT_NOISE = Object.freeze({
  amplitude: 14,
  mountainAmplitude: 46,
  featureSize: 160,
  octaves: 6,
  gain: 0.5,
  lacunarity: 2,
  warp: 36,
  warpFeatureSize: 90,
  baseHeight: 0,
});
const OCTAVE_ROTATION = Object.freeze({ cosine: 0.8, sine: 0.6 });
const DEFAULT_MATERIAL = Object.freeze({ color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0 });

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(low, high, value) {
  const fraction = clamp((value - low) / (high - low), 0, 1);
  return fraction * fraction * (3 - 2 * fraction);
}

function hashLattice(cellX, cellZ, seed) {
  let hash = Math.imul(cellX, 374761393) ^ Math.imul(cellZ, 668265263) ^ Math.imul(seed | 0, 1597334677);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

/** Value noise in [-1, 1] with its analytic gradient, written into `output` as [value, dx, dz]. */
function sampleNoise(pointX, pointZ, seed, output) {
  const cellX = Math.floor(pointX);
  const cellZ = Math.floor(pointZ);
  const fractionX = pointX - cellX;
  const fractionZ = pointZ - cellZ;
  const blendX = fractionX * fractionX * fractionX * (fractionX * (fractionX * 6 - 15) + 10);
  const blendZ = fractionZ * fractionZ * fractionZ * (fractionZ * (fractionZ * 6 - 15) + 10);
  const slopeX = 30 * fractionX * fractionX * (fractionX - 1) * (fractionX - 1);
  const slopeZ = 30 * fractionZ * fractionZ * (fractionZ - 1) * (fractionZ - 1);
  const lowerLeft = hashLattice(cellX, cellZ, seed);
  const lowerRight = hashLattice(cellX + 1, cellZ, seed);
  const upperLeft = hashLattice(cellX, cellZ + 1, seed);
  const upperRight = hashLattice(cellX + 1, cellZ + 1, seed);
  const crossTerm = lowerLeft - lowerRight - upperLeft + upperRight;
  const value = lowerLeft + (lowerRight - lowerLeft) * blendX + (upperLeft - lowerLeft) * blendZ + crossTerm * blendX * blendZ;
  output[0] = value * 2 - 1;
  output[1] = 2 * slopeX * ((lowerRight - lowerLeft) + crossTerm * blendZ);
  output[2] = 2 * slopeZ * ((upperLeft - lowerLeft) + crossTerm * blendX);
}

// Slopes damp the finer octaves, which leaves smooth flanks and rough crests like eroded ground.
function erosionNoise(worldX, worldZ, noise, seed, scratch) {
  let pointX = worldX / noise.featureSize;
  let pointZ = worldZ / noise.featureSize;
  let sum = 0;
  let amplitude = 1;
  let amplitudeTotal = 0;
  let gradientX = 0;
  let gradientZ = 0;
  for (let octave = 0; octave < noise.octaves; octave++) {
    sampleNoise(pointX, pointZ, seed + octave * 17, scratch);
    gradientX += scratch[1];
    gradientZ += scratch[2];
    sum += amplitude * scratch[0] / (1 + gradientX * gradientX + gradientZ * gradientZ);
    amplitudeTotal += amplitude;
    amplitude *= noise.gain;
    const rotatedX = (OCTAVE_ROTATION.cosine * pointX - OCTAVE_ROTATION.sine * pointZ) * noise.lacunarity;
    pointZ = (OCTAVE_ROTATION.sine * pointX + OCTAVE_ROTATION.cosine * pointZ) * noise.lacunarity;
    pointX = rotatedX;
  }
  return sum / amplitudeTotal;
}

// Each ridge only feeds the next octave where it is strong, which carves sharp valleys between peaks.
function ridgedNoise(worldX, worldZ, noise, seed, scratch) {
  let pointX = worldX / noise.featureSize;
  let pointZ = worldZ / noise.featureSize;
  let sum = 0;
  let amplitude = 1;
  let amplitudeTotal = 0;
  let weight = 1;
  for (let octave = 0; octave < noise.octaves; octave++) {
    sampleNoise(pointX, pointZ, seed + 101 + octave * 13, scratch);
    const ridge = (1 - Math.abs(scratch[0])) ** 2 * weight;
    weight = clamp(ridge * 2, 0, 1);
    sum += ridge * amplitude;
    amplitudeTotal += amplitude;
    amplitude *= noise.gain;
    const rotatedX = (OCTAVE_ROTATION.cosine * pointX - OCTAVE_ROTATION.sine * pointZ) * noise.lacunarity;
    pointZ = (OCTAVE_ROTATION.sine * pointX + OCTAVE_ROTATION.cosine * pointZ) * noise.lacunarity;
    pointX = rotatedX;
  }
  return sum / amplitudeTotal;
}

/** Height function (x, z) -> metres from noise options: domain warped hills blended into ridged mountains. */
export function createNoiseHeight(options = {}, seed = 1) {
  const noise = { ...DEFAULT_NOISE, ...options };
  const scratch = new Float64Array(3);
  const warpScratch = new Float64Array(3);
  const maskNoise = { ...noise, featureSize: noise.featureSize * 2.6, octaves: 2 };
  const mountainMask = options.mountainMask ?? ((worldX, worldZ) => smoothstep(0.05, 0.4, erosionNoise(worldX, worldZ, maskNoise, seed + 7, scratch)));
  return (worldX, worldZ) => {
    sampleNoise(worldX / noise.warpFeatureSize, worldZ / noise.warpFeatureSize, seed + 31, warpScratch);
    const warpedX = worldX + warpScratch[0] * noise.warp;
    const warpedZ = worldZ + warpScratch[0] * noise.warp * 0.7 + warpScratch[1] * noise.warp * 0.2;
    const hills = erosionNoise(warpedX, warpedZ, noise, seed, scratch) * noise.amplitude;
    const mask = mountainMask(worldX, worldZ);
    if (mask <= 0) return noise.baseHeight + hills;
    const mountains = ridgedNoise(warpedX, warpedZ, { ...noise, featureSize: noise.featureSize * 1.3 }, seed, scratch) * noise.mountainAmplitude;
    return noise.baseHeight + hills * (1 - mask) + (hills * 0.4 + mountains) * mask;
  };
}

/** Converts the red channel of an ImageData-like object to a square height array in metres. */
export function heightmapFromImageData(imageData, amplitude = 1) {
  if (imageData.width !== imageData.height) throw new RangeError('Heightmap images must be square.');
  const heights = new Float32Array(imageData.width * imageData.height);
  for (let index = 0; index < heights.length; index++) heights[index] = imageData.data[index * 4] / 255 * amplitude;
  return heights;
}

function heightFromArray(heights, size) {
  const side = Math.round(Math.sqrt(heights.length));
  if (side * side !== heights.length || side < 2) throw new RangeError('A height array must be square with at least 2 by 2 samples.');
  return (worldX, worldZ) => {
    const gridX = clamp((worldX / size + 0.5) * (side - 1), 0, side - 1);
    const gridZ = clamp((worldZ / size + 0.5) * (side - 1), 0, side - 1);
    const cellX = Math.min(Math.floor(gridX), side - 2);
    const cellZ = Math.min(Math.floor(gridZ), side - 2);
    const fractionX = gridX - cellX;
    const fractionZ = gridZ - cellZ;
    const lower = heights[cellZ * side + cellX] * (1 - fractionX) + heights[cellZ * side + cellX + 1] * fractionX;
    const upper = heights[(cellZ + 1) * side + cellX] * (1 - fractionX) + heights[(cellZ + 1) * side + cellX + 1] * fractionX;
    return lower * (1 - fractionZ) + upper * fractionZ;
  };
}

function resolveHeightFunction(height, size, seed) {
  if (typeof height === 'function') return height;
  if (height instanceof Float32Array) return heightFromArray(height, size);
  return createNoiseHeight(height ?? {}, seed);
}

function validateOptions({ size, resolution, chunks, levels, mirrorLevels }) {
  if (!(size > 0) || !Number.isFinite(size)) throw new RangeError('size must be a positive number of metres.');
  if (!Number.isInteger(chunks) || chunks < 1) throw new RangeError('chunks must be a positive integer.');
  if (!Number.isInteger(levels) || levels < 1) throw new RangeError('levels must be a positive integer.');
  if (!Number.isInteger(resolution) || resolution < 1 || resolution % (2 ** (levels - 1)) !== 0) {
    throw new RangeError(`resolution must be a positive integer divisible by 2^(levels - 1) = ${2 ** (levels - 1)}.`);
  }
  if (!Number.isInteger(mirrorLevels) || mirrorLevels < 0 || resolution % (2 ** (levels - 1 + mirrorLevels)) !== 0) {
    throw new RangeError('mirrorLevels must be a whole number of extra halvings that the resolution divides by (2^(levels - 1 + mirrorLevels)).');
  }
}

const SIDES = Object.freeze(['west', 'east', 'north', 'south']);
const MAXIMUM_HOLES = 64;

/** Checks the hole list ({ center: [x, z], radius } circles) and returns a copy, or null when there are none. */
export function normalizeTerrainHoles(holes) {
  if (holes === undefined) return null;
  if (!Array.isArray(holes) || holes.length > MAXIMUM_HOLES) throw new RangeError(`holes must be a list of at most ${MAXIMUM_HOLES} circles.`);
  if (holes.length === 0) return null;
  return holes.map(hole => {
    const center = hole?.center;
    const validCenter = Array.isArray(center) && center.length === 2 && center.every(Number.isFinite);
    if (!validCenter || !(hole.radius > 0) || !Number.isFinite(hole.radius)) {
      throw new RangeError('Each hole needs center [x, z] in metres and a positive radius.');
    }
    return { center: [center[0], center[1]], radius: hole.radius };
  });
}

function pointInsideHoles(holes, pointX, pointZ) {
  for (const hole of holes) {
    if (Math.hypot(pointX - hole.center[0], pointZ - hole.center[1]) < hole.radius) return true;
  }
  return false;
}

/**
 * Returns { parts, heightAt, normalAt, isHole, bounds, update, triangleCount }.
 * `holes` ([{ center: [x, z], radius }]) cuts round openings through the ground; isHole(x, z) tells whether a point is in one.
 * Ground spans x and z from -size / 2 to size / 2. Call update(eye) each frame (or when the camera moves) and, when it
 * returns a non-empty list, pass the scene parts to renderer.replaceParts.
 */
export function createTerrain({ size = 512, resolution = 32, chunks = 8, levels = 4, height, seed = 1, material = DEFAULT_MATERIAL, lodDistance, eye, holes, mirrorLevels = 0 } = {}) {
  validateOptions({ size, resolution, chunks, levels, mirrorLevels });
  const holeCircles = normalizeTerrainHoles(holes);
  const isHole = (worldX, worldZ) => holeCircles !== null && pointInsideHoles(holeCircles, worldX, worldZ);
  const heightFunction = resolveHeightFunction(height, size, seed);
  const chunkSize = size / chunks;
  const gridCells = chunks * resolution;
  const gridSide = gridCells + 1;
  const spacing = size / gridCells;
  const origin = -size / 2;
  const heights = new Float32Array(gridSide * gridSide);
  let lowest = Infinity;
  let highest = -Infinity;
  for (let row = 0; row < gridSide; row++) {
    for (let column = 0; column < gridSide; column++) {
      const value = heightFunction(origin + column * spacing, origin + row * spacing);
      if (!Number.isFinite(value)) throw new RangeError('Height function returned a non-finite value.');
      heights[row * gridSide + column] = value;
      lowest = Math.min(lowest, heights[row * gridSide + column]);
      highest = Math.max(highest, heights[row * gridSide + column]);
    }
  }
  const bounds = { min: [origin, lowest, origin], max: [-origin, highest, -origin] };
  const nearDistance = lodDistance ?? chunkSize * 1.6;

  const gridHeight = (column, row) => heights[clamp(row, 0, gridCells) * gridSide + clamp(column, 0, gridCells)];

  function gridNormal(column, row, step, target, offset) {
    const slopeX = (gridHeight(column + step, row) - gridHeight(column - step, row)) / (2 * step * spacing);
    const slopeZ = (gridHeight(column, row + step) - gridHeight(column, row - step)) / (2 * step * spacing);
    const inverseLength = 1 / Math.hypot(slopeX, 1, slopeZ);
    target[offset] = -slopeX * inverseLength;
    target[offset + 1] = inverseLength;
    target[offset + 2] = -slopeZ * inverseLength;
  }

  const skyVisibilityAt = createSkyVisibilitySampler({ heights, gridCells, spacing, highest, normalAt: (column, row, target) => gridNormal(column, row, 1, target, 0) });

  function locate(worldX, worldZ) {
    const gridX = clamp((worldX - origin) / spacing, 0, gridCells);
    const gridZ = clamp((worldZ - origin) / spacing, 0, gridCells);
    const column = Math.min(Math.floor(gridX), gridCells - 1);
    const row = Math.min(Math.floor(gridZ), gridCells - 1);
    return { column, row, fractionX: gridX - column, fractionZ: gridZ - row };
  }

  // The finest mesh splits every cell along the (0,0)-(1,1) diagonal; heightAt walks the same triangles.
  function heightAt(worldX, worldZ) {
    const { column, row, fractionX, fractionZ } = locate(worldX, worldZ);
    const corner00 = gridHeight(column, row);
    const corner10 = gridHeight(column + 1, row);
    const corner01 = gridHeight(column, row + 1);
    const corner11 = gridHeight(column + 1, row + 1);
    if (fractionX >= fractionZ) return corner00 + fractionX * (corner10 - corner00) + fractionZ * (corner11 - corner10);
    return corner00 + fractionX * (corner11 - corner01) + fractionZ * (corner01 - corner00);
  }

  function normalAt(worldX, worldZ) {
    const { column, row, fractionX, fractionZ } = locate(worldX, worldZ);
    const corners = new Float32Array(12);
    gridNormal(column, row, 1, corners, 0);
    gridNormal(column + 1, row, 1, corners, 3);
    gridNormal(column, row + 1, 1, corners, 6);
    gridNormal(column + 1, row + 1, 1, corners, 9);
    const normal = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const lower = corners[axis] * (1 - fractionX) + corners[3 + axis] * fractionX;
      const upper = corners[6 + axis] * (1 - fractionX) + corners[9 + axis] * fractionX;
      normal[axis] = lower * (1 - fractionZ) + upper * fractionZ;
    }
    const length = Math.hypot(...normal);
    return normal.map(component => component / length);
  }

  /** Mesh of one chunk. An edge shared with a coarser neighbour is snapped to that neighbour's edge, so no crack opens. */
  function buildChunkGeometry(chunkColumn, chunkRow, level, edgeLevels) {
    const step = 2 ** level;
    const cells = resolution / step;
    const side = cells + 1;
    const positions = new Float32Array(side * side * 3);
    const normals = new Float32Array(side * side * 3);
    const uvs = new Float32Array(side * side * 2);
    const skyVisibility = new Float32Array(side * side);
    const firstColumn = chunkColumn * resolution;
    const firstRow = chunkRow * resolution;
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        const vertex = row * side + column;
        const gridColumn = firstColumn + column * step;
        const gridRow = firstRow + row * step;
        const worldX = origin + gridColumn * spacing;
        const worldZ = origin + gridRow * spacing;
        positions.set([worldX, snappedHeight(column, row, side, step, gridColumn, gridRow, edgeLevels, level), worldZ], vertex * 3);
        gridNormal(gridColumn, gridRow, step, normals, vertex * 3);
        uvs.set([worldX, worldZ], vertex * 2);
        skyVisibility[vertex] = skyVisibilityAt(clamp(gridColumn, 0, gridCells), clamp(gridRow, 0, gridCells));
      }
    }
    const indices = new Uint32Array(cells * cells * 6);
    let cursor = 0;
    for (let row = 0; row < cells; row++) {
      for (let column = 0; column < cells; column++) {
        // A cell whose centre lies inside a hole is left out, so a coarser level cuts a coarser hole.
        const cellCenterX = origin + (firstColumn + (column + 0.5) * step) * spacing;
        const cellCenterZ = origin + (firstRow + (row + 0.5) * step) * spacing;
        if (isHole(cellCenterX, cellCenterZ)) continue;
        const corner00 = row * side + column;
        const corner10 = corner00 + 1;
        const corner01 = corner00 + side;
        const corner11 = corner01 + 1;
        indices.set([corner00, corner11, corner10, corner00, corner01, corner11], cursor);
        cursor += 6;
      }
    }
    return { positions, normals, uvs, skyVisibility, indices: cursor === indices.length ? indices : indices.slice(0, cursor) };
  }

  function snappedHeight(column, row, side, step, gridColumn, gridRow, edgeLevels, level) {
    const last = side - 1;
    const alongX = row === 0 ? 'north' : row === last ? 'south' : null;
    const alongZ = column === 0 ? 'west' : column === last ? 'east' : null;
    if (alongX && column % (2 ** (edgeLevels[alongX] - level)) !== 0) {
      return interpolateEdge(column, 2 ** (edgeLevels[alongX] - level), (index) => gridHeight(gridColumn + (index - column) * step, gridRow));
    }
    if (alongZ && row % (2 ** (edgeLevels[alongZ] - level)) !== 0) {
      return interpolateEdge(row, 2 ** (edgeLevels[alongZ] - level), (index) => gridHeight(gridColumn, gridRow + (index - row) * step));
    }
    return gridHeight(gridColumn, gridRow);
  }

  function interpolateEdge(index, coarseStep, heightAtIndex) {
    const lowerIndex = Math.floor(index / coarseStep) * coarseStep;
    const fraction = (index - lowerIndex) / coarseStep;
    return heightAtIndex(lowerIndex) * (1 - fraction) + heightAtIndex(lowerIndex + coarseStep) * fraction;
  }

  const chunkStates = [];
  const parts = [];
  for (let chunkRow = 0; chunkRow < chunks; chunkRow++) {
    for (let chunkColumn = 0; chunkColumn < chunks; chunkColumn++) {
      const state = { chunkColumn, chunkRow, level: -1, edgeLevels: null, centerX: origin + (chunkColumn + 0.5) * chunkSize, centerZ: origin + (chunkRow + 0.5) * chunkSize };
      state.part = { name: `Terrain chunk ${chunkColumn},${chunkRow}`, geometry: null, matrix: identityMatrix(), material };
      chunkStates.push(state);
      parts.push(state.part);
    }
  }

  const chunkAt = (column, row) => (column < 0 || row < 0 || column >= chunks || row >= chunks ? null : chunkStates[row * chunks + column]);

  function levelFor(state, eyePosition) {
    const groundHeight = heightAt(clamp(eyePosition[0], origin, -origin), clamp(eyePosition[2], origin, -origin));
    const distance = Math.hypot(eyePosition[0] - state.centerX, eyePosition[1] - groundHeight, eyePosition[2] - state.centerZ) - chunkSize * 0.5;
    if (distance <= nearDistance) return 0;
    return Math.min(levels - 1, Math.floor(Math.log2(distance / nearDistance)) + 1);
  }

  // How far a coarser mesh can sit from the finest one on this chunk: the largest second difference of the heights at that step.
  function coarseError(state, level) {
    const step = 2 ** level;
    let largest = 0;
    for (let row = 0; row <= resolution; row += step) {
      for (let column = 0; column <= resolution; column += step) {
        const gridColumn = state.chunkColumn * resolution + column;
        const gridRow = state.chunkRow * resolution + row;
        const middle = gridHeight(gridColumn, gridRow);
        largest = Math.max(largest, Math.abs(gridHeight(gridColumn - step, gridRow) + gridHeight(gridColumn + step, gridRow) - 2 * middle) / 2, Math.abs(gridHeight(gridColumn, gridRow - step) + gridHeight(gridColumn, gridRow + step) - 2 * middle) / 2);
      }
    }
    return largest;
  }

  // Coarser meshes for the water mirror only (the renderer never picks them for the main camera): each has its own edges, so a
  // seam can open between two chunks that the mirror draws at different levels, which the blurred reflection hides.
  function buildMirrorLods(state) {
    const lods = [{ geometry: state.part.geometry, error: 0 }];
    for (let extra = 1; extra <= mirrorLevels; extra++) {
      const level = state.targetLevel + extra;
      const edgeLevels = { west: level, east: level, north: level, south: level };
      lods.push({ geometry: buildChunkGeometry(state.chunkColumn, state.chunkRow, level, edgeLevels), error: Math.max(lods[extra - 1].error, coarseError(state, level)), mirrorOnly: true });
    }
    return lods;
  }

  let triangleTotal = 0;
  function update(eyePosition) {
    if (!Array.isArray(eyePosition) && !(eyePosition instanceof Float32Array)) throw new TypeError('update needs an eye position [x, y, z].');
    for (const state of chunkStates) state.targetLevel = levelFor(state, eyePosition);
    const changed = [];
    for (const state of chunkStates) {
      const neighbours = [chunkAt(state.chunkColumn - 1, state.chunkRow), chunkAt(state.chunkColumn + 1, state.chunkRow), chunkAt(state.chunkColumn, state.chunkRow - 1), chunkAt(state.chunkColumn, state.chunkRow + 1)];
      const edgeLevels = Object.fromEntries(SIDES.map((side, index) => [side, Math.max(state.targetLevel, neighbours[index]?.targetLevel ?? state.targetLevel)]));
      const unchanged = state.level === state.targetLevel && SIDES.every(side => state.edgeLevels?.[side] === edgeLevels[side]);
      if (unchanged) continue;
      if (state.part.geometry) triangleTotal -= state.part.geometry.indices.length / 3;
      state.part.geometry = buildChunkGeometry(state.chunkColumn, state.chunkRow, state.targetLevel, edgeLevels);
      if (mirrorLevels > 0) state.part.lods = buildMirrorLods(state);
      triangleTotal += state.part.geometry.indices.length / 3;
      state.level = state.targetLevel;
      state.edgeLevels = edgeLevels;
      changed.push(state.part);
    }
    return changed;
  }

  update(eye ?? [0, highest + size * 0.5, 0]);
  return { parts, heightAt, normalAt, isHole, bounds, update, get triangleCount() { return triangleTotal; }, chunkSize, resolution, levels, chunkLevels: () => chunkStates.map(state => state.level) };
}

function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
