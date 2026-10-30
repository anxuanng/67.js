// A grass field made of real blade geometry, in the style of the Ghost of Tsushima grass talk and the open
// GodotGrass and Quick_Grass ports: curved tapered blades, clumps from cellular noise that share height, facing
// and lean, rounded normals, a dark base fading to a bright tip, dry patches, and tiles whose level of detail
// keeps a stable subset of the same blades. Wind lives in the vertex shader (`grass` tag).

import {
  FULL_TURN, WORLD_UP, clamp, createMeshBuilder, createRandom, crossProduct, lerp, lerpVectors, normalized, valueNoise,
} from './vegetation-geometry.js';
import { createTileField, hashTile, tileMatrix } from './tile-field.js';

export const GRASS_LEVELS = Object.freeze([
  Object.freeze({ distance: 10, keep: 1, segments: 4, widthScale: 1 }),
  Object.freeze({ distance: 26, keep: 0.35, segments: 2, widthScale: 2 }),
  Object.freeze({ distance: 60, keep: 0.12, segments: 1, widthScale: 4.5 }),
]);

export const GRASS_PRESETS = Object.freeze({
  meadow: Object.freeze({ height: [0.25, 0.6], width: 0.022, density: 260, clumpSize: 0.55, clumpStrength: 0.55, dryness: 0.25, patchiness: 0.55, stalks: 0.012, bend: [0.18, 0.6], base: [0.012, 0.03, 0.006], tip: [0.15, 0.27, 0.045], dry: [0.36, 0.29, 0.1] }),
  lawn: Object.freeze({ height: [0.07, 0.14], width: 0.012, density: 900, clumpSize: 0.3, clumpStrength: 0.25, dryness: 0.05, patchiness: 0.2, stalks: 0, bend: [0.05, 0.25], base: [0.01, 0.035, 0.006], tip: [0.11, 0.26, 0.04], dry: [0.3, 0.3, 0.09] }),
  savanna: Object.freeze({ height: [0.45, 0.95], width: 0.018, density: 170, clumpSize: 0.8, clumpStrength: 0.7, dryness: 0.75, patchiness: 0.65, stalks: 0.035, bend: [0.25, 0.8], base: [0.04, 0.035, 0.01], tip: [0.36, 0.3, 0.1], dry: [0.5, 0.39, 0.15] }),
  wild: Object.freeze({ height: [0.3, 0.9], width: 0.026, density: 200, clumpSize: 0.7, clumpStrength: 0.65, dryness: 0.35, patchiness: 0.75, stalks: 0.025, bend: [0.25, 0.75], base: [0.012, 0.028, 0.008], tip: [0.14, 0.24, 0.05], dry: [0.4, 0.32, 0.12] }),
});

const MAXIMUM_BLADES_PER_TILE = 40000;
const ROUNDING_TILT = 0.55;
const CANOPY_BLEND = 0.3;
// Share of blades that fold over at the middle, as trampled or overgrown grass does.
const FOLDED_SHARE = 0.06;
// A seed stalk is this much thinner than a blade below its head; the head swells to HEAD_WIDTH past HEAD_START.
const STALK_WIDTH = 0.22;
const HEAD_START = 0.7;
const HEAD_WIDTH = 0.75;

/**
 * Field-scale entropy at (x, z): `height` and `density` multipliers and a `lush` shade, from two octaves of value noise
 * (about 8 m and 25 m). With `patchiness` 0 the field is uniform; at 1 some patches are short and thin, others tall and dense.
 */
function fieldPatch(x, z, settings) {
  const amount = settings.patchiness;
  const broad = valueNoise(x * 0.04, z * 0.04, settings.seed + 57);
  const local = valueNoise(x * 0.13, z * 0.13, settings.seed + 83);
  const growth = broad * 0.6 + local * 0.4;
  return {
    height: lerp(1, lerp(0.45, 1.35, growth), amount),
    density: lerp(1, smoothstep(0.28, 0.62, growth), amount * 0.85),
    lush: lerp(1, lerp(0.68, 1.2, valueNoise(x * 0.07, z * 0.07, settings.seed + 97)), amount),
  };
}

// Independent value in [0, 1) per clump cell; `salt` picks which property it is.
function cellHash(column, row, seed, salt) {
  return hashTile(seed + salt * 1013, column, row) / 4294967296;
}

/** Nearest jittered clump centre around (x, z): cellular noise, as the clumping in the Ghost of Tsushima talk. */
function nearestClump(x, z, clumpSize, seed) {
  const cellColumn = Math.floor(x / clumpSize);
  const cellRow = Math.floor(z / clumpSize);
  let best = null;
  for (let offsetRow = -1; offsetRow <= 1; offsetRow++) {
    for (let offsetColumn = -1; offsetColumn <= 1; offsetColumn++) {
      const column = cellColumn + offsetColumn;
      const row = cellRow + offsetRow;
      const centerX = (column + cellHash(column, row, seed, 1)) * clumpSize;
      const centerZ = (row + cellHash(column, row, seed, 2)) * clumpSize;
      const distance = Math.hypot(x - centerX, z - centerZ);
      if (!best || distance < best.distance) best = { centerX, centerZ, distance, column, row };
    }
  }
  return {
    ...best,
    heightScale: lerp(0.72, 1.28, cellHash(best.column, best.row, seed, 3)),
    facing: cellHash(best.column, best.row, seed, 4) * FULL_TURN,
    shade: lerp(0.82, 1.15, cellHash(best.column, best.row, seed, 5)),
    bendScale: lerp(0.7, 1.3, cellHash(best.column, best.row, seed, 6)),
  };
}

function smoothstep(edgeLow, edgeHigh, value) {
  const amount = clamp((value - edgeLow) / (edgeHigh - edgeLow), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

/** Every blade of one tile at full density, in a stable order; each level keeps the blades whose `keepKey` is below its share. */
function planTileBlades(column, row, settings, keepLimit) {
  const { tileSize, origin, seed, terrainHeight, mask, density } = settings;
  const random = createRandom(hashTile(seed, column, row));
  const count = Math.min(MAXIMUM_BLADES_PER_TILE, Math.round(density * tileSize * tileSize));
  const blades = [];
  for (let index = 0; index < count; index++) {
    let x = origin[0] + (column + random()) * tileSize;
    let z = origin[1] + (row + random()) * tileSize;
    const keepKey = random();
    const maskRoll = random();
    const shapeRolls = [random(), random(), random(), random(), random(), random(), random(), random()];
    // Every roll is drawn before skipping, so a blade keeps its shape whatever share of the tile is built.
    if (keepKey >= keepLimit) continue;
    const coverage = mask ? clamp(mask(x, z), 0, 1) : 1;
    const patch = fieldPatch(x, z, settings);
    if (maskRoll >= coverage * patch.density) continue;
    const clump = nearestClump(x, z, settings.clumpSize, seed);
    const pull = settings.clumpStrength * 0.35;
    x = lerp(x, clump.centerX, pull);
    z = lerp(z, clump.centerZ, pull);
    const awayX = x - clump.centerX;
    const awayZ = z - clump.centerZ;
    const awayLength = Math.hypot(awayX, awayZ) || 1;
    const randomLean = shapeRolls[0] * FULL_TURN;
    const leanX = lerp(Math.cos(randomLean), awayX / awayLength, settings.clumpStrength);
    const leanZ = lerp(Math.sin(randomLean), awayZ / awayLength, settings.clumpStrength);
    const leanLength = Math.hypot(leanX, leanZ) || 1;
    // One roll picks the blade kind: a seed stalk at the low end, a folded blade at the high end, a plain blade between.
    const stalk = shapeRolls[7] < settings.stalks;
    const folded = !stalk && shapeRolls[7] > 1 - FOLDED_SHARE;
    const bladeHeight = lerp(settings.height[0], settings.height[1], shapeRolls[1]) * clump.heightScale * patch.height;
    // Stalks rise above the sward around them but stay under 1.5 times the tallest blade.
    const stalkHeight = Math.min(bladeHeight * lerp(1.3, 1.6, shapeRolls[3]), settings.height[1] * 1.5);
    const height = (stalk ? stalkHeight : bladeHeight) * coverage ** 0.35;
    const dryPatch = smoothstep(0.45, 0.8, valueNoise(x * 0.09, z * 0.09, seed + 31)) * settings.dryness;
    const bend = lerp(settings.bend[0], settings.bend[1], shapeRolls[3]) * clump.bendScale;
    blades.push({
      x, z, y: terrainHeight(x, z), keepKey, height, stalk,
      yaw: lerp(shapeRolls[2] * FULL_TURN, clump.facing, settings.clumpStrength * 0.6),
      leanX: leanX / leanLength, leanZ: leanZ / leanLength,
      bend: stalk ? bend * 0.35 : (folded ? Math.min(1.6, bend * 2.4 + 0.5) : bend),
      shade: clump.shade * patch.lush * lerp(0.85, 1.12, shapeRolls[4]),
      hue: shapeRolls[6] * 2 - 1,
      dryness: clamp(dryPatch + (shapeRolls[5] < settings.dryness * 0.25 ? 0.6 : 0), 0, 1),
    });
  }
  return blades;
}

/** Point and tangent on the blade's quadratic curve: straight up at the base, bending over toward its lean at the tip. */
function bladeCurve(blade, progress) {
  const rise = blade.height * (1 - blade.bend * 0.45);
  const reach = blade.height * blade.bend;
  const control = [0, blade.height * 0.75, 0];
  const tip = [blade.leanX * reach, rise, blade.leanZ * reach];
  const inverse = 1 - progress;
  const point = [0, 1, 2].map(axis => 2 * inverse * progress * control[axis] + progress * progress * tip[axis]);
  const tangent = normalized([0, 1, 2].map(axis => 2 * inverse * control[axis] + 2 * progress * (tip[axis] - control[axis])));
  return { point, tangent };
}

function bladeColor(blade, progress, settings) {
  if (blade.stalk) {
    // Green stem ripening to a straw seed head.
    const stem = lerpVectors(settings.base, lerpVectors(settings.tip, settings.dry, 0.35), progress ** 0.6);
    const head = settings.dry.map(channel => channel * 0.5);
    const colour = lerpVectors(stem, head, smoothstep(HEAD_START - 0.08, HEAD_START + 0.05, progress));
    return colour.map(channel => channel * blade.shade * lerp(0.4, 1, smoothstep(0, 0.3, progress)));
  }
  const green = lerpVectors(settings.base, settings.tip, progress ** 0.75);
  const dryTip = lerpVectors(settings.base.map(channel => channel * 1.6), settings.dry, progress ** 0.6);
  const mixed = lerpVectors(green, dryTip, blade.dryness);
  const occlusion = lerp(0.3, 1, smoothstep(0, 0.45, progress));
  // Hue drift per blade: some lean yellow, some blue-green, as in a real sward.
  const hue = [1 + blade.hue * 0.14, 1, 1 - blade.hue * 0.2];
  return mixed.map((channel, index) => channel * occlusion * blade.shade * hue[index]);
}

/** Width of a seed stalk along its length: a thin stem, then a spindle-shaped head that closes at the tip. */
function stalkProfile(progress) {
  if (progress <= HEAD_START) return STALK_WIDTH;
  return STALK_WIDTH + HEAD_WIDTH * Math.sin(Math.PI * (progress - HEAD_START) / (1 - HEAD_START));
}

function addBlade(builder, blade, tileX, tileZ, level, settings) {
  const right = [Math.cos(blade.yaw), 0, Math.sin(blade.yaw)];
  const width = settings.width * level.widthScale * (0.7 + 0.6 * blade.height / settings.height[1]);
  const base = [blade.x - tileX, blade.y, blade.z - tileZ];
  const rows = [];
  for (let segment = 0; segment <= level.segments; segment++) {
    const progress = segment / level.segments;
    const { point, tangent } = bladeCurve(blade, progress);
    const center = [base[0] + point[0], base[1] + point[1], base[2] + point[2]];
    const faceNormal = normalized(crossProduct(right, tangent));
    const halfWidth = width * 0.5 * (blade.stalk ? stalkProfile(progress) : 1 - progress ** 1.7);
    const color = bladeColor(blade, progress, settings);
    const vertexFor = (side) => {
      // Rounded normals: each edge tilts outward, so a flat blade shades like a curved leaf.
      const tilted = normalized(faceNormal.map((component, axis) => component + right[axis] * side * ROUNDING_TILT));
      const shading = normalized(tilted.map((component, axis) => component * (1 - CANOPY_BLEND) + WORLD_UP[axis] * CANOPY_BLEND));
      const position = center.map((component, axis) => component + right[axis] * side * halfWidth);
      return builder.addVertex(position, shading, (side + 1) / 2, 1 - progress, color);
    };
    if (segment === level.segments) {
      const tipNormal = normalized(faceNormal.map((component, axis) => component * (1 - CANOPY_BLEND) + WORLD_UP[axis] * CANOPY_BLEND));
      rows.push([builder.addVertex(center, tipNormal, 0.5, 0, color)]);
    } else {
      rows.push([vertexFor(-1), vertexFor(1)]);
    }
  }
  for (let segment = 0; segment < level.segments; segment++) {
    const [left, rightIndex] = rows[segment];
    const next = rows[segment + 1];
    if (next.length === 1) {
      builder.addTriangle(left, rightIndex, next[0]);
    } else {
      builder.addTriangle(left, rightIndex, next[0]);
      builder.addTriangle(rightIndex, next[1], next[0]);
    }
  }
}

function resolveSettings(options) {
  const preset = GRASS_PRESETS[options.preset ?? 'meadow'];
  if (!preset) throw new RangeError(`Unknown grass preset: ${options.preset}. Use ${Object.keys(GRASS_PRESETS).join(', ')}.`);
  const settings = { ...preset, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
  const { area } = settings;
  if (!area || ![area.minX, area.maxX, area.minZ, area.maxZ].every(Number.isFinite) || area.maxX <= area.minX || area.maxZ <= area.minZ) {
    throw new TypeError('Grass area needs finite minX < maxX and minZ < maxZ.');
  }
  if (!(settings.density > 0)) throw new RangeError('Grass density must be a positive number of blades per square metre.');
  if (!(settings.tileSize > 0)) throw new RangeError('Grass tileSize must be positive.');
  if (!Array.isArray(settings.height) || !(settings.height[0] > 0) || !(settings.height[1] >= settings.height[0])) throw new RangeError('Grass height must be [minimum, maximum] in metres.');
  if (!(settings.width > 0)) throw new RangeError('Grass width must be positive.');
  for (const name of ['patchiness', 'stalks', 'dryness']) {
    if (!(settings[name] >= 0 && settings[name] <= 1)) throw new RangeError(`Grass ${name} must be between 0 and 1.`);
  }
  if (settings.mask !== undefined && typeof settings.mask !== 'function') throw new TypeError('Grass mask must be a function (x, z) => 0..1.');
  if (typeof settings.terrainHeight !== 'function') throw new TypeError('Grass terrainHeight must be a function (x, z) => y.');
  for (const name of ['base', 'tip', 'dry']) {
    if (!Array.isArray(settings[name]) || settings[name].length !== 3 || !settings[name].every(Number.isFinite)) throw new TypeError(`Grass ${name} colour must be three linear RGB numbers.`);
  }
  settings.levels = settings.levels ?? GRASS_LEVELS;
  settings.cullDistance = settings.cullDistance ?? settings.levels.at(-1).distance;
  settings.origin = [area.minX, area.minZ];
  return settings;
}

/**
 * Builds a grass field over `area` ({ minX, maxX, minZ, maxZ }) in tiles of `tileSize` metres.
 * Options: `preset` ('meadow', 'lawn', 'savanna', 'wild'), `terrainHeight(x, z)`, `mask(x, z)` (0..1 coverage),
 * `density` (blades per square metre near the camera), `height` [min, max], `width`, `clumpSize`, `clumpStrength`,
 * `bend` [min, max], `dryness`, `patchiness` (0..1 field-scale height and density patches), `stalks` (share of seed
 * stalks), linear `base`, `tip` and `dry` colours, `castShadow`, `levels`, `cullDistance`, `seed`, `eye`.
 * Returns `{ parts, update(eye), material, stats(), groundColor }`; tint the ground under the grass with `groundColor`. `update` returns true when tiles changed level; then call
 * `renderer.replaceParts([...otherParts, ...grass.parts])`. Grass parts are rigid and untextured, so they stream.
 */
export function createGrass(options = {}) {
  const settings = resolveSettings({ tileSize: 4, seed: 1, terrainHeight: () => 0, castShadow: false, ...options });
  const material = { tag: 'grass', color: [1, 1, 1], roughness: 0.8, metallic: 0, emission: 0, doubleSided: true };

  function buildParts(tile, levelIndex) {
    const level = settings.levels[levelIndex];
    if (!tile.cache.blades || tile.cache.plannedKeep < level.keep) {
      tile.cache.blades = planTileBlades(tile.column, tile.row, settings, level.keep);
      tile.cache.plannedKeep = level.keep;
    }
    const builder = createMeshBuilder({ withColors: true });
    for (const blade of tile.cache.blades) {
      if (blade.keepKey < level.keep) addBlade(builder, blade, tile.tileX, tile.tileZ, level, settings);
    }
    if (builder.vertexCount === 0) return [];
    return [{ name: `Grass tile ${tile.column},${tile.row}`, geometry: builder.build(), matrix: tileMatrix(tile), material, castShadow: settings.castShadow }];
  }

  const field = createTileField({ ...settings, buildParts });
  field.update(settings.eye ?? [(settings.area.minX + settings.area.maxX) / 2, 2, (settings.area.minZ + settings.area.maxZ) / 2]);
  // Colour for the ground under the blades: gaps then read as shaded grass instead of bare soil.
  const groundColor = lerpVectors(settings.base, settings.tip, 0.3);
  return { get parts() { return field.parts; }, update: field.update, material, stats: field.stats, settings, groundColor };
}
