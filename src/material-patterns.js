import { MATERIAL_PATTERN_TYPES } from './agent-scene-capabilities.js';

// Procedural surface patterns for recipe materials: seeded, tileable and baked on the CPU into the same texture
// descriptors a loaded material uses. Texture coordinates run 0 to 1 and every noise is periodic over that square, so
// a pattern repeats without a visible seam. Directional patterns (wood, planks, brushed metal) run along V.

function hashCell(cellX, cellY, seed) {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

const wrapCell = (cell, period) => ((cell % period) + period) % period;
const smootherStep = value => value * value * value * (value * (value * 6 - 15) + 10);
const clampUnit = value => Math.min(1, Math.max(0, value));
const smoothStep = (minimum, maximum, value) => {
  const position = clampUnit((value - minimum) / (maximum - minimum));
  return position * position * (3 - 2 * position);
};

function cornerGradient(cellX, cellY, offsetX, offsetY, seed) {
  const angle = hashCell(cellX, cellY, seed) / 4294967296 * Math.PI * 2;
  return Math.cos(angle) * offsetX + Math.sin(angle) * offsetY;
}

/** Gradient noise in about -1 to 1, periodic over [0, 1) with the given whole number of cells per axis. */
export function gradientNoise(positionU, positionV, cellsU, cellsV, seed = 0) {
  const scaledU = positionU * cellsU;
  const scaledV = positionV * cellsV;
  const floorU = Math.floor(scaledU);
  const floorV = Math.floor(scaledV);
  const fractionU = scaledU - floorU;
  const fractionV = scaledV - floorV;
  const left = wrapCell(floorU, cellsU);
  const right = wrapCell(floorU + 1, cellsU);
  const bottom = wrapCell(floorV, cellsV);
  const top = wrapCell(floorV + 1, cellsV);
  const blendU = smootherStep(fractionU);
  const blendV = smootherStep(fractionV);
  const lower = cornerGradient(left, bottom, fractionU, fractionV, seed) * (1 - blendU)
    + cornerGradient(right, bottom, fractionU - 1, fractionV, seed) * blendU;
  const upper = cornerGradient(left, top, fractionU, fractionV - 1, seed) * (1 - blendU)
    + cornerGradient(right, top, fractionU - 1, fractionV - 1, seed) * blendU;
  return (lower * (1 - blendV) + upper * blendV) * 1.5;
}

/** Fractal sum of gradientNoise in about -1 to 1. Each octave doubles the cells, so it stays periodic. */
export function fractalNoise(positionU, positionV, cellsU, cellsV, seed = 0, octaves = 5, gain = 0.5) {
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  for (let octave = 0; octave < octaves; octave++) {
    total += gradientNoise(positionU, positionV, cellsU << octave, cellsV << octave, seed + octave * 131) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= gain;
  }
  return total / amplitudeSum;
}

/** Ridged fractal noise in 0 to 1: sharp crests where the gradient noise crosses zero. */
export function ridgedNoise(positionU, positionV, cellsU, cellsV, seed = 0, octaves = 4) {
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const ridge = 1 - Math.abs(gradientNoise(positionU, positionV, cellsU << octave, cellsV << octave, seed + octave * 211));
    total += ridge * ridge * amplitude;
    amplitudeSum += amplitude;
    amplitude *= 0.5;
  }
  return total / amplitudeSum;
}

/** Periodic Worley noise: distances to the nearest and second nearest feature point, in cell units. */
export function cellularNoise(positionU, positionV, cells, seed = 0) {
  const scaledU = positionU * cells;
  const scaledV = positionV * cells;
  const floorU = Math.floor(scaledU);
  const floorV = Math.floor(scaledV);
  let nearest = Infinity;
  let second = Infinity;
  for (let offsetV = -1; offsetV <= 1; offsetV++) {
    for (let offsetU = -1; offsetU <= 1; offsetU++) {
      const cellU = floorU + offsetU;
      const cellV = floorV + offsetV;
      const hash = hashCell(wrapCell(cellU, cells), wrapCell(cellV, cells), seed);
      const pointU = cellU + (hash & 0xffff) / 65536;
      const pointV = cellV + (hash >>> 16) / 65536;
      const distance = Math.hypot(pointU - scaledU, pointV - scaledV);
      if (distance < nearest) {
        second = nearest;
        nearest = distance;
      } else if (distance < second) {
        second = distance;
      }
    }
  }
  return { nearest, second };
}

function unitHash(cellX, cellY, seed) {
  return hashCell(cellX, cellY, seed) / 4294967296;
}

/** Laid-out courses of blocks with a running bond: which block a point is in and how far it is from the joint. */
function blockLayout(positionU, positionV, columns, rows, jointWidth, offset) {
  const scaledV = positionV * rows;
  const row = Math.floor(scaledV);
  const scaledU = positionU * columns + (row % 2 === 1 ? offset : 0);
  const column = Math.floor(scaledU);
  const fractionU = scaledU - column;
  const fractionV = scaledV - row;
  const jointU = Math.min(fractionU, 1 - fractionU) / columns;
  const jointV = Math.min(fractionV, 1 - fractionV) / rows;
  const edge = Math.min(jointU, jointV);
  return { row, column: wrapCell(column, columns), body: smoothStep(jointWidth * 0.5, jointWidth * 1.5, edge) };
}

function woodGrain(positionU, positionV, seed, rings) {
  // Long, gentle waves: real grain drifts sideways far less than it runs along the board.
  const warp = fractalNoise(positionU, positionV, 2, 1, seed, 3) * 1.6;
  const ringPosition = positionU * rings + warp;
  const ring = ringPosition - Math.floor(ringPosition);
  // Slow growth across the ring, then a quick dark edge, softened so it does not read as a drawn line.
  const earlyLate = ring < 0.85 ? ring / 0.85 : (1 - ring) / 0.15;
  const fibre = fractalNoise(positionU, positionV, 128, 2, seed + 7, 3) * 0.5 + 0.5;
  const pore = fractalNoise(positionU, positionV, 256, 8, seed + 11, 2) * 0.5 + 0.5;
  return { tone: clampUnit(earlyLate * 0.45 + fibre * 0.4 + pore * 0.15), fibre };
}

// Each sampler returns tone (0 picks the first colour, 1 the second), height, roughness and metal, all 0 to 1.
const PATTERN_SAMPLERS = {
  noise(positionU, positionV, seed, count) {
    const value = fractalNoise(positionU, positionV, count, count, seed, 6) * 0.5 + 0.5;
    return { tone: smoothStep(0.25, 0.75, value), height: value, roughness: 0.75 + value * 0.25, metal: 1 };
  },
  wood(positionU, positionV, seed, count) {
    const { tone, fibre } = woodGrain(positionU, positionV, seed, count);
    return { tone, height: tone * 0.5 + fibre * 0.5, roughness: 0.75 + (1 - tone) * 0.25, metal: 1 };
  },
  planks(positionU, positionV, seed, count) {
    const scaled = positionU * count;
    const plank = Math.floor(scaled);
    const fraction = scaled - plank;
    const stagger = unitHash(plank, 0, seed);
    const length = positionV + stagger;
    const endJoint = Math.min(length - Math.floor(length), 1 - (length - Math.floor(length)));
    const edge = Math.min(Math.min(fraction, 1 - fraction) / count, endJoint);
    const body = smoothStep(0.0015, 0.005, edge);
    const shift = unitHash(wrapCell(plank, count), 1, seed);
    const { tone, fibre } = woodGrain(positionU, wrapUnit(positionV + shift), seed + wrapCell(plank, count) * 17, 12);
    const plankTone = clampUnit(tone * 0.8 + unitHash(wrapCell(plank, count), 2, seed) * 0.2);
    return { tone: plankTone * body, height: (0.55 + fibre * 0.25) * body, roughness: 0.75 + (1 - plankTone) * 0.2 + (1 - body) * 0.05, metal: 1 };
  },
  bricks(positionU, positionV, seed, count) {
    const rows = count * 2;
    const { row, column, body } = blockLayout(positionU, positionV, count, rows, 0.006, 0.5);
    const shade = unitHash(column, wrapCell(row, rows), seed);
    const surface = fractalNoise(positionU, positionV, 24, 24, seed + 3, 4) * 0.5 + 0.5;
    const tone = clampUnit(shade * 0.6 + surface * 0.4);
    return { tone, joint: 1 - body, height: body * (0.75 + surface * 0.25), roughness: 0.85 + surface * 0.15, metal: 1 };
  },
  tiles(positionU, positionV, seed, count) {
    const { row, column, body } = blockLayout(positionU, positionV, count, count, 0.004, 0);
    const shade = unitHash(column, wrapCell(row, count), seed);
    const surface = fractalNoise(positionU, positionV, 8, 8, seed + 5, 3) * 0.5 + 0.5;
    const tone = clampUnit(0.75 + shade * 0.2 + surface * 0.05);
    return { tone: tone * body, height: body * (0.9 + surface * 0.1), roughness: body > 0.5 ? 0.45 + surface * 0.15 : 1, metal: 1 };
  },
  marble(positionU, positionV, seed, count) {
    const cloud = fractalNoise(positionU, positionV, count, count, seed, 5) * 0.5 + 0.5;
    const veins = ridgedNoise(positionU, positionV, count, count, seed + 11, 4);
    const vein = smoothStep(0.72, 0.95, veins);
    return { tone: clampUnit(0.75 + cloud * 0.25 - vein), height: 0.5, roughness: 0.3 + vein * 0.2, metal: 1 };
  },
  stone(positionU, positionV, seed, count) {
    const ridges = ridgedNoise(positionU, positionV, count, count, seed, 5);
    const { nearest, second } = cellularNoise(positionU, positionV, count * 2, seed + 9);
    const crack = smoothStep(0, 0.07, second - nearest);
    const value = clampUnit(ridges * 0.8 + 0.1);
    return { tone: value * (0.6 + crack * 0.4), height: value * 0.7 + crack * 0.3, roughness: 0.85 + (1 - value) * 0.15, metal: 1 };
  },
  concrete(positionU, positionV, seed, count) {
    const cloud = fractalNoise(positionU, positionV, count, count, seed, 6) * 0.5 + 0.5;
    const { nearest } = cellularNoise(positionU, positionV, count * 16, seed + 13);
    const pit = smoothStep(0.02, 0.12, nearest);
    return { tone: clampUnit(cloud * 0.9 + 0.05) * (0.7 + pit * 0.3), height: 0.5 + (pit - 1) * 0.4 + cloud * 0.1, roughness: 0.85 + cloud * 0.15, metal: 1 };
  },
  metal(positionU, positionV, seed, count) {
    const streak = fractalNoise(positionU, positionV, count * 16, 2, seed, 4) * 0.5 + 0.5;
    const blotch = fractalNoise(positionU, positionV, 4, 4, seed + 3, 3) * 0.5 + 0.5;
    return { tone: clampUnit(streak * 0.7 + blotch * 0.3), height: streak * 0.25, roughness: 0.55 + streak * 0.35 + blotch * 0.1, metal: 1 };
  },
  rust(positionU, positionV, seed, count) {
    const patches = fractalNoise(positionU, positionV, count, count, seed, 6) * 0.5 + 0.5;
    const flakes = fractalNoise(positionU, positionV, count * 16, count * 16, seed + 3, 3) * 0.5 + 0.5;
    const rusted = smoothStep(0.42, 0.58, patches + (flakes - 0.5) * 0.15);
    return { tone: rusted * (0.5 + flakes * 0.5), height: rusted * (0.4 + flakes * 0.6), roughness: 0.45 + rusted * 0.55, metal: 1 - rusted };
  },
  fabric(positionU, positionV, seed, count) {
    const threads = count * 16;
    const warpThread = Math.sin(positionU * threads * Math.PI * 2) * 0.5 + 0.5;
    const weftThread = Math.sin(positionV * threads * Math.PI * 2) * 0.5 + 0.5;
    const cell = Math.floor(positionU * threads) + Math.floor(positionV * threads);
    const over = cell % 2 === 0 ? warpThread : weftThread;
    const slub = fractalNoise(positionU, positionV, 16, 16, seed, 3) * 0.5 + 0.5;
    return { tone: clampUnit(over * 0.5 + slub * 0.5), height: over, roughness: 0.9 + slub * 0.1, metal: 1 };
  },
};

function wrapUnit(value) {
  return value - Math.floor(value);
}

// Colours are linear RGB, as recipe colours are. `size` is metres per repeat of the texture.
const PATTERN_DEFAULTS = {
  noise: { colors: [[0.2, 0.2, 0.2], [0.7, 0.7, 0.7]], size: 1, count: 4, bump: 0.5 },
  wood: { colors: [[0.16, 0.07, 0.025], [0.5, 0.27, 0.11]], size: 0.6, count: 12, bump: 0.4 },
  planks: { colors: [[0.12, 0.055, 0.02], [0.46, 0.25, 0.1]], size: 1, count: 6, bump: 0.8 },
  bricks: { colors: [[0.33, 0.1, 0.06], [0.52, 0.2, 0.12], [0.45, 0.42, 0.38]], size: 1, count: 4, bump: 1 },
  tiles: { colors: [[0.32, 0.32, 0.31], [0.75, 0.75, 0.72]], size: 1, count: 4, bump: 0.8 },
  marble: { colors: [[0.2, 0.2, 0.22], [0.85, 0.84, 0.82]], size: 1, count: 3, bump: 0 },
  stone: { colors: [[0.09, 0.085, 0.08], [0.42, 0.4, 0.37]], size: 1.5, count: 4, bump: 1.4 },
  concrete: { colors: [[0.24, 0.24, 0.23], [0.5, 0.5, 0.48]], size: 2, count: 4, bump: 0.4 },
  metal: { colors: [[0.5, 0.5, 0.52], [0.8, 0.8, 0.82]], size: 0.5, count: 4, bump: 0.15 },
  rust: { colors: [[0.55, 0.55, 0.56], [0.22, 0.07, 0.025]], size: 1, count: 4, bump: 0.7 },
  fabric: { colors: [[0.2, 0.2, 0.25], [0.45, 0.45, 0.55]], size: 0.25, count: 4, bump: 0.5 },
};

const RESOLUTIONS = [256, 512, 1024];
const MAX_COUNT = 64;

function patternError(message) {
  return new RangeError(`Material pattern ${message}`);
}

function checkedColors(value, type) {
  const fieldHint = 'colors must be two linear RGB colours from 0 to 1 (three for bricks: the third is the mortar)';
  const expected = PATTERN_DEFAULTS[type].colors.length;
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== expected)) throw patternError(fieldHint);
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3 || entry.some(component => !Number.isFinite(component) || component < 0 || component > 1)) throw patternError(fieldHint);
  }
  return value.map(entry => [...entry]);
}

function checkedNumber(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw patternError(`${name} must be a number from ${minimum} to ${maximum}.`);
  return value;
}

/** Validate a recipe pattern and fill in its defaults. A normalized pattern normalizes to itself. */
export function normalizeMaterialPattern(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw patternError(`must be an object such as { "type": "wood" }. Types: ${MATERIAL_PATTERN_TYPES.join(', ')}.`);
  const known = ['type', 'colors', 'size', 'count', 'bump', 'seed', 'axis', 'resolution'];
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw patternError(`does not take ${key}. Fields: ${known.join(', ')}.`);
  }
  if (!Object.hasOwn(PATTERN_DEFAULTS, value.type ?? '')) throw patternError(`type must be one of ${MATERIAL_PATTERN_TYPES.join(', ')}.`);
  const defaults = PATTERN_DEFAULTS[value.type];
  const count = value.count ?? defaults.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw patternError(`count must be a whole number from 1 to ${MAX_COUNT}.`);
  const seed = value.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) throw patternError('seed must be a nonnegative whole number.');
  const axis = value.axis ?? 'y';
  if (!['x', 'y', 'z'].includes(axis)) throw patternError('axis must be x, y or z: the object axis the grain runs along.');
  const resolution = value.resolution ?? 512;
  if (!RESOLUTIONS.includes(resolution)) throw patternError(`resolution must be one of ${RESOLUTIONS.join(', ')}.`);
  return {
    type: value.type,
    colors: value.colors === undefined ? defaults.colors.map(entry => [...entry]) : checkedColors(value.colors, value.type),
    size: checkedNumber(value.size ?? defaults.size, 'size', 0.01, 100),
    count,
    bump: checkedNumber(value.bump ?? defaults.bump, 'bump', 0, 4),
    seed,
    axis,
    resolution,
  };
}

function linearToSrgbByte(value) {
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(clampUnit(encoded) * 255);
}

function createImage(data, width, height) {
  // Browsers upload ImageData directly; Node only reads the pixels, as tests and tools do.
  return typeof ImageData === 'function' ? new ImageData(data, width, height) : { width, height, data };
}

/** Bake a normalized pattern into { map, normalMap, metallicRoughnessMap } texture descriptors. Deterministic. */
export function bakeMaterialPattern(pattern) {
  const { resolution, type, seed, count, colors, bump, size } = pattern;
  const sampler = PATTERN_SAMPLERS[type];
  const pixelCount = resolution * resolution;
  const heights = new Float32Array(pixelCount);
  const colorData = new Uint8ClampedArray(pixelCount * 4);
  const surfaceData = new Uint8ClampedArray(pixelCount * 4);
  const [firstColor, secondColor, jointColor] = colors;
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      const pixel = row * resolution + column;
      const sample = sampler((column + 0.5) / resolution, (row + 0.5) / resolution, seed, count);
      heights[pixel] = sample.height;
      const tone = clampUnit(sample.tone);
      // Bricks have a third colour for the mortar.
      const joint = jointColor ? sample.joint ?? 0 : 0;
      const offset = pixel * 4;
      for (let channel = 0; channel < 3; channel++) {
        const body = firstColor[channel] + (secondColor[channel] - firstColor[channel]) * tone;
        colorData[offset + channel] = linearToSrgbByte(joint > 0 ? body + (jointColor[channel] - body) * joint : body);
      }
      colorData[offset + 3] = 255;
      surfaceData[offset] = 255;
      surfaceData[offset + 1] = Math.round(clampUnit(sample.roughness) * 255);
      surfaceData[offset + 2] = Math.round(clampUnit(sample.metal) * 255);
      surfaceData[offset + 3] = 255;
    }
  }
  const normalData = new Uint8ClampedArray(pixelCount * 4);
  // Height differences are per texel; scale them so a bump of 1 reads the same at any resolution.
  const slopeScale = bump * resolution / 64;
  for (let row = 0; row < resolution; row++) {
    const rowAbove = (row + 1) % resolution;
    const rowBelow = (row + resolution - 1) % resolution;
    for (let column = 0; column < resolution; column++) {
      const columnRight = (column + 1) % resolution;
      const columnLeft = (column + resolution - 1) % resolution;
      const slopeU = (heights[row * resolution + columnRight] - heights[row * resolution + columnLeft]) * slopeScale;
      const slopeV = (heights[rowAbove * resolution + column] - heights[rowBelow * resolution + column]) * slopeScale;
      const length = Math.hypot(slopeU, slopeV, 1);
      const offset = (row * resolution + column) * 4;
      normalData[offset] = Math.round((-slopeU / length * 0.5 + 0.5) * 255);
      normalData[offset + 1] = Math.round((-slopeV / length * 0.5 + 0.5) * 255);
      normalData[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      normalData[offset + 3] = 255;
    }
  }
  return {
    map: { image: createImage(colorData, resolution, resolution), colorSpace: 'srgb' },
    normalMap: { image: createImage(normalData, resolution, resolution), colorSpace: 'linear' },
    metallicRoughnessMap: { image: createImage(surfaceData, resolution, resolution), colorSpace: 'linear' },
    boxMapScale: 1 / size,
    boxMapAxis: ['x', 'y', 'z'].indexOf(pattern.axis),
  };
}

const bakedPatterns = new Map();
const MAX_BAKED_PATTERNS = 32;
// The renderer reads these fields for every part on every update, so a pattern object remembers its result. It also
// keeps the same descriptors alive for as long as a material holds them, because a renderer rejects changed textures.
const bakedByPatternObject = new WeakMap();

/** The baked textures of a pattern, shared by every material with the same definition. */
export function materialPatternTextures(pattern) {
  const remembered = bakedByPatternObject.get(pattern);
  if (remembered) return remembered;
  const key = JSON.stringify(pattern);
  let baked = bakedPatterns.get(key);
  if (baked) {
    bakedPatterns.delete(key);
  } else {
    baked = bakeMaterialPattern(pattern);
    if (bakedPatterns.size >= MAX_BAKED_PATTERNS) bakedPatterns.delete(bakedPatterns.keys().next().value);
  }
  bakedPatterns.set(key, baked);
  bakedByPatternObject.set(pattern, baked);
  return baked;
}

export { PATTERN_DEFAULTS };
