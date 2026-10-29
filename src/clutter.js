// Ground clutter: pebbles, rocks, twigs and fallen leaves scattered over terrain in streamable tiles.
// Stones are noise-displaced spheres cut by a few random planes, so rocks get flat chipped faces while pebbles stay
// round. They sink into the ground, darken underneath and near the soil line, and rocks gather moss on top.
// Everything is vertex-coloured and untextured, so tiles stream with `renderer.replaceParts`.

import {
  FULL_TURN, addTube, clamp, createMeshBuilder, createRandom, crossProduct, lerp, lerpVectors, normalized, valueNoise,
} from './vegetation-geometry.js';
import { createTileField, hashTile, tileMatrix } from './tile-field.js';

// Rocks draw their keep key below this value and everything else above it, so the farthest level keeps only rocks.
const ROCK_KEY_LIMIT = 0.04;

export const CLUTTER_LEVELS = Object.freeze([
  Object.freeze({ distance: 12, keep: 1, detail: 1 }),
  Object.freeze({ distance: 30, keep: 0.2, detail: 0 }),
  Object.freeze({ distance: 70, keep: ROCK_KEY_LIMIT, detail: 0 }),
]);

/** Items per square metre near the camera. */
export const CLUTTER_PRESETS = Object.freeze({
  meadow: Object.freeze({ pebbles: 0.8, rocks: 0.03, twigs: 0.08, leaves: 0.3, moss: 0.4 }),
  forest: Object.freeze({ pebbles: 0.5, rocks: 0.06, twigs: 1.2, leaves: 16, moss: 0.8 }),
  riverbed: Object.freeze({ pebbles: 14, rocks: 0.6, twigs: 0.15, leaves: 0.1, moss: 0.15 }),
  scree: Object.freeze({ pebbles: 12, rocks: 1.4, twigs: 0, leaves: 0, moss: 0.05 }),
});

const DEFAULTS = Object.freeze({
  pebbleSize: [0.012, 0.05],
  rockSize: [0.08, 0.38],
  stoneColor: [0.13, 0.125, 0.11],
  mossColor: [0.06, 0.09, 0.025],
  soilColor: [0.07, 0.055, 0.04],
  twigColor: [0.11, 0.075, 0.045],
  leafColors: [[0.2, 0.1, 0.035], [0.32, 0.19, 0.05], [0.1, 0.065, 0.03], [0.14, 0.12, 0.04]],
  clumping: 0.6,
});

const KINDS = Object.freeze(['pebbles', 'rocks', 'twigs', 'leaves']);
const MAXIMUM_ITEMS_PER_KIND = 20000;
// Sphere resolution per detail level (index 0 far, 1 near). Pebbles are small and many, so they get coarser spheres,
// down to an octahedron far away, where one covers a pixel or two.
const ROCK_DETAIL = Object.freeze([Object.freeze({ segments: 6, rings: 4 }), Object.freeze({ segments: 12, rings: 7 })]);
const PEBBLE_DETAIL = Object.freeze([Object.freeze({ segments: 4, rings: 2 }), Object.freeze({ segments: 6, rings: 4 })]);

function smoothstep(edgeLow, edgeHigh, value) {
  const amount = clamp((value - edgeLow) / (edgeHigh - edgeLow), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function groundNormal(terrainHeight, x, z) {
  const step = 0.25;
  const slopeX = terrainHeight(x + step, z) - terrainHeight(x - step, z);
  const slopeZ = terrainHeight(x, z + step) - terrainHeight(x, z - step);
  return normalized([-slopeX, 2 * step, -slopeZ]);
}

/**
 * Right-handed frame on the ground: `up` is the terrain normal and `forward` follows `yaw` across it. Local x, y
 * and z map to forward, up and side; a mirrored frame would turn every stone inside out.
 */
function groundFrame(up, yaw) {
  const heading = [Math.cos(yaw), 0, Math.sin(yaw)];
  const side = normalized(crossProduct(heading, up));
  const forward = normalized(crossProduct(up, side));
  return { up, forward, side };
}

function placeInFrame(frame, origin, local) {
  return [0, 1, 2].map(axis => origin[axis] + frame.forward[axis] * local[0] + frame.up[axis] * local[1] + frame.side[axis] * local[2]);
}

/** Field-scale clumping: items gather into patches of about 7 m instead of spreading evenly. */
function clumpWeight(x, z, settings, salt) {
  const patch = smoothstep(0.3, 0.75, valueNoise(x * 0.15, z * 0.15, settings.seed + salt));
  return lerp(1, patch * 2, settings.clumping);
}

function planTileItems(tile, settings) {
  const items = [];
  KINDS.forEach((kind, kindIndex) => {
    const density = settings[kind];
    if (!(density > 0)) return;
    const random = createRandom(hashTile(settings.seed + kindIndex * 7907, tile.column, tile.row));
    // Twice the candidates, each accepted with half its clump weight, so the mean density matches `density`.
    const candidates = Math.min(MAXIMUM_ITEMS_PER_KIND, Math.round(density * settings.tileSize * settings.tileSize * 2));
    for (let index = 0; index < candidates; index++) {
      const x = tile.tileX + random() * settings.tileSize;
      const z = tile.tileZ + random() * settings.tileSize;
      const acceptRoll = random();
      const keepRoll = random();
      const shapeRolls = [random(), random(), random(), random(), random(), random()];
      const coverage = settings.mask ? clamp(settings.mask(x, z), 0, 1) : 1;
      if (acceptRoll * 2 >= clumpWeight(x, z, settings, 131 + kindIndex * 17) * coverage) continue;
      const keepKey = kind === 'rocks' ? keepRoll * ROCK_KEY_LIMIT : lerp(ROCK_KEY_LIMIT, 1, keepRoll);
      items.push({ kind, x, z, keepKey, shapeRolls });
    }
  });
  return items;
}

/** Radius multiplier of a stone along `direction`: smooth noise, then flat chipped faces from cutting planes. */
function stoneRadius(direction, stone) {
  const [x, y, z] = direction;
  const phases = stone.phases;
  let radius = 1 + stone.roughness * (
    Math.sin(x * 2.6 + phases[0]) * Math.sin(y * 2.6 + phases[1])
    + 0.5 * Math.sin(z * 4.4 + phases[2]) * Math.cos(x * 3.4 + phases[3])
  );
  for (const plane of stone.planes) {
    const facing = x * plane.normal[0] + y * plane.normal[1] + z * plane.normal[2];
    if (facing > 0.05) radius = Math.min(radius, plane.distance / facing);
  }
  return radius;
}

function stoneColor(normal, localPoint, heightAboveGround, stone, vertexIndex, settings) {
  const underside = lerp(0.45, 1, smoothstep(-0.6, 0.7, normal[1]));
  const speckle = lerp(0.82, 1.12, (hashTile(stone.colorSeed, vertexIndex, 3) & 1023) / 1023);
  // Blotches and veins across the surface, in the stone's own space so they stay put as it turns.
  const blotch = valueNoise(localPoint[0] * stone.grain + localPoint[1] * 0.7 * stone.grain, localPoint[2] * stone.grain, stone.colorSeed);
  const stain = lerp(0.6, 1.25, blotch);
  let color = stone.base.map(channel => channel * underside * speckle * stain);
  const moss = stone.moss * smoothstep(0.35, 0.85, normal[1]) * smoothstep(0.3, 0.6, valueNoise(normal[0] * 3 + stone.phases[0], normal[2] * 3, stone.colorSeed));
  color = lerpVectors(color, settings.mossColor, moss);
  // Soil clings to the stone where it meets the ground.
  const soil = 1 - smoothstep(0, stone.height * 0.35, heightAboveGround);
  return lerpVectors(color, settings.soilColor, soil * 0.7);
}

function addStone(builder, item, tileOrigin, settings, detail) {
  const isRock = item.kind === 'rocks';
  const { segments, rings } = (isRock ? ROCK_DETAIL : PEBBLE_DETAIL)[detail];
  const rolls = item.shapeRolls;
  const sizeRange = isRock ? settings.rockSize : settings.pebbleSize;
  // Most stones are small: a power curve leaves a few large ones.
  const radius = lerp(sizeRange[0], sizeRange[1], rolls[0] ** 2.5);
  const random = createRandom(hashTile(settings.seed, Math.floor(item.x * 977), Math.floor(item.z * 977)));
  const stone = {
    roughness: isRock ? 0.16 : 0.08,
    phases: [random() * FULL_TURN, random() * FULL_TURN, random() * FULL_TURN, random() * FULL_TURN],
    planes: [],
    moss: isRock ? settings.moss : settings.moss * 0.2,
    colorSeed: hashTile(settings.seed + 17, Math.floor(item.x * 977), Math.floor(item.z * 977)),
    height: radius * lerp(0.45, 0.75, rolls[1]),
  };
  if (isRock) {
    for (let plane = 0; plane < 4; plane++) {
      const theta = random() * FULL_TURN;
      const lift = random() * 1.6 - 0.4;
      stone.planes.push({ normal: normalized([Math.cos(theta), lift, Math.sin(theta)]), distance: lerp(0.68, 0.9, random()) });
    }
  }
  // Each stone gets its own tone and hue, from blue-grey to rust, as a mixed riverbed has.
  const tone = lerp(0.55, 1.45, rolls[2]);
  const warmth = rolls[3] * 2 - 1;
  stone.base = settings.stoneColor.map((channel, index) => channel * tone * [1 + warmth * 0.25, 1 + warmth * 0.04, 1 - warmth * 0.3][index]);
  stone.grain = lerp(2.5, 5, random());
  const scale = [radius * lerp(0.75, 1.1, rolls[4]), stone.height, radius * lerp(0.7, 1, rolls[5])];
  const ground = settings.terrainHeight(item.x, item.z);
  const frame = groundFrame(groundNormal(settings.terrainHeight, item.x, item.z), rolls[5] * FULL_TURN);
  // Sink a third to a half of the stone so it sits in the ground instead of resting on it.
  const sink = lerp(0.3, 0.5, rolls[1]);
  const center = [item.x - tileOrigin[0], ground + stone.height * (1 - 2 * sink), item.z - tileOrigin[1]];

  const directions = [[0, 1, 0]];
  for (let ring = 1; ring < rings; ring++) {
    const polar = Math.PI * ring / rings;
    for (let segment = 0; segment < segments; segment++) {
      const azimuth = FULL_TURN * segment / segments;
      directions.push([Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)]);
    }
  }
  directions.push([0, -1, 0]);
  const localPoints = directions.map(direction => {
    const distance = stoneRadius(direction, stone);
    return direction.map((component, axis) => component * distance * scale[axis]);
  });
  const triangles = [];
  const ringStart = ring => 1 + (ring - 1) * segments;
  const bottom = directions.length - 1;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    triangles.push([0, ringStart(1) + next, ringStart(1) + segment]);
    for (let ring = 1; ring < rings - 1; ring++) {
      const upper = ringStart(ring);
      const lower = ringStart(ring + 1);
      triangles.push([upper + segment, upper + next, lower + segment]);
      triangles.push([upper + next, lower + next, lower + segment]);
    }
    const last = ringStart(rings - 1);
    triangles.push([last + segment, last + next, bottom]);
  }
  // Smooth normals from the faces around each vertex; the sphere has no seam, so none show.
  const localNormals = localPoints.map(() => [0, 0, 0]);
  for (const [first, second, third] of triangles) {
    const edgeOne = [0, 1, 2].map(axis => localPoints[second][axis] - localPoints[first][axis]);
    const edgeTwo = [0, 1, 2].map(axis => localPoints[third][axis] - localPoints[first][axis]);
    const face = crossProduct(edgeOne, edgeTwo);
    for (const vertex of [first, second, third]) for (let axis = 0; axis < 3; axis++) localNormals[vertex][axis] += face[axis];
  }
  const firstVertex = builder.vertexCount;
  localPoints.forEach((point, index) => {
    const position = placeInFrame(frame, center, point);
    const normal = normalized(placeInFrame(frame, [0, 0, 0], normalized(localNormals[index])));
    const color = stoneColor(normal, point.map((component, axis) => component / scale[axis]), position[1] - ground, stone, index, settings);
    builder.addVertex(position, normal, 0, 0, color);
  });
  for (const [first, second, third] of triangles) builder.addTriangle(firstVertex + first, firstVertex + second, firstVertex + third);
}

function addTwig(builder, item, tileOrigin, settings, detail) {
  const rolls = item.shapeRolls;
  const length = lerp(0.1, 0.45, rolls[0] ** 1.5);
  const thickness = lerp(0.003, 0.011, rolls[1]) * (0.6 + length);
  const yaw = rolls[2] * FULL_TURN;
  const bend = (rolls[3] - 0.5) * 0.6;
  const pointCount = detail ? 4 : 2;
  const points = [];
  const radii = [];
  for (let index = 0; index < pointCount; index++) {
    const progress = index / (pointCount - 1);
    const angle = yaw + bend * progress;
    const along = (progress - 0.5) * length;
    const x = item.x + Math.cos(angle) * along;
    const z = item.z + Math.sin(angle) * along;
    const radius = thickness * lerp(1, 0.45, progress);
    points.push([x - tileOrigin[0], settings.terrainHeight(x, z) + radius * 0.7, z - tileOrigin[1]]);
    radii.push(radius);
  }
  const color = settings.twigColor.map(channel => channel * lerp(0.7, 1.3, rolls[4]));
  addTube(builder, points, radii, detail ? 5 : 3, 1, color);
}

function addLeaf(builder, item, tileOrigin, settings, detail) {
  const rolls = item.shapeRolls;
  const length = lerp(0.04, 0.1, rolls[0]);
  const width = length * lerp(0.4, 0.65, rolls[1]);
  const curl = width * lerp(0.05, 0.45, rolls[2]);
  const palette = settings.leafColors;
  const base = palette[Math.floor(rolls[3] * palette.length) % palette.length];
  const color = base.map(channel => channel * lerp(0.75, 1.25, rolls[4]));
  const ground = settings.terrainHeight(item.x, item.z);
  const frame = groundFrame(groundNormal(settings.terrainHeight, item.x, item.z), rolls[5] * FULL_TURN);
  const origin = [item.x - tileOrigin[0], ground + 0.004, item.z - tileOrigin[1]];
  const rows = detail ? 3 : 2;
  const grid = [];
  for (let row = 0; row < rows; row++) {
    const progress = row / (rows - 1);
    const halfWidth = width * 0.5 * Math.sin(Math.PI * lerp(0.08, 1, progress)) ** 0.8;
    const rowVertices = [];
    for (let across = -1; across <= 1; across++) {
      // Edges curl up and the leaf lies cupped; the midrib is a little darker.
      const lift = curl * across * across;
      const local = [(progress - 0.5) * length, lift, across * halfWidth];
      const normal = normalized(placeInFrame(frame, [0, 0, 0], [0, 1, -across * curl / Math.max(halfWidth, 1e-4)]));
      const shade = across === 0 ? 0.82 : 1;
      rowVertices.push(builder.addVertex(placeInFrame(frame, origin, local), normal, (across + 1) / 2, progress, color.map(channel => channel * shade)));
    }
    grid.push(rowVertices);
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < 2; column++) {
      // Counter-clockwise from above, so the upper face is the front and keeps its sky-facing normal.
      builder.addTriangle(grid[row][column], grid[row][column + 1], grid[row + 1][column]);
      builder.addTriangle(grid[row][column + 1], grid[row + 1][column + 1], grid[row + 1][column]);
    }
  }
}

function requireRange(value, name) {
  if (!Array.isArray(value) || value.length !== 2 || !(value[0] > 0) || !(value[1] >= value[0])) throw new RangeError(`Clutter ${name} must be [minimum, maximum] in metres.`);
}

function requireColor(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new TypeError(`Clutter ${name} must be three linear RGB numbers.`);
}

function resolveSettings(options) {
  const preset = CLUTTER_PRESETS[options.preset ?? 'meadow'];
  if (!preset) throw new RangeError(`Unknown clutter preset: ${options.preset}. Use ${Object.keys(CLUTTER_PRESETS).join(', ')}.`);
  const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  const settings = { tileSize: 4, seed: 1, terrainHeight: () => 0, castShadow: true, ...DEFAULTS, ...preset, ...defined };
  const { area } = settings;
  if (!area || ![area.minX, area.maxX, area.minZ, area.maxZ].every(Number.isFinite) || area.maxX <= area.minX || area.maxZ <= area.minZ) {
    throw new TypeError('Clutter area needs finite minX < maxX and minZ < maxZ.');
  }
  for (const kind of KINDS) {
    if (!(settings[kind] >= 0)) throw new RangeError(`Clutter ${kind} must be a non-negative count per square metre.`);
  }
  for (const name of ['moss', 'clumping']) {
    if (!(settings[name] >= 0 && settings[name] <= 1)) throw new RangeError(`Clutter ${name} must be between 0 and 1.`);
  }
  if (!(settings.tileSize > 0)) throw new RangeError('Clutter tileSize must be positive.');
  requireRange(settings.pebbleSize, 'pebbleSize');
  requireRange(settings.rockSize, 'rockSize');
  for (const name of ['stoneColor', 'mossColor', 'soilColor', 'twigColor']) requireColor(settings[name], name);
  if (!Array.isArray(settings.leafColors) || settings.leafColors.length === 0) throw new TypeError('Clutter leafColors must be a non-empty list of colours.');
  settings.leafColors.forEach((color, index) => requireColor(color, `leafColors[${index}]`));
  if (typeof settings.terrainHeight !== 'function') throw new TypeError('Clutter terrainHeight must be a function (x, z) => y.');
  if (settings.mask !== undefined && typeof settings.mask !== 'function') throw new TypeError('Clutter mask must be a function (x, z) => 0..1.');
  settings.levels = settings.levels ?? CLUTTER_LEVELS;
  settings.cullDistance = settings.cullDistance ?? settings.levels.at(-1).distance;
  return settings;
}

/**
 * Scatters pebbles, rocks, twigs and fallen leaves over `area` ({ minX, maxX, minZ, maxZ }).
 * Options: `preset` ('meadow', 'forest', 'riverbed', 'scree'), `terrainHeight(x, z)`, `mask(x, z)` (0..1),
 * counts per square metre `pebbles`, `rocks`, `twigs`, `leaves`, `pebbleSize` and `rockSize` radius ranges,
 * `moss` (0..1), `clumping` (0..1), linear `stoneColor`, `mossColor`, `soilColor`, `twigColor` and `leafColors`,
 * `castShadow` (stones only), `tileSize`, `levels`, `cullDistance`, `seed`, `eye`.
 * Returns `{ parts, update(eye), stats(), materials, settings }`. When `update` returns true, call
 * `renderer.replaceParts([...otherParts, ...clutter.parts])`.
 */
export function createClutter(options = {}) {
  const settings = resolveSettings(options);
  const materials = {
    stone: { color: [1, 1, 1], roughness: 0.88, metallic: 0, emission: 0 },
    litter: { color: [1, 1, 1], roughness: 0.8, metallic: 0, emission: 0, doubleSided: true },
  };

  function buildParts(tile, levelIndex) {
    const level = settings.levels[levelIndex];
    tile.cache.items ??= planTileItems(tile, settings);
    const tileOrigin = [tile.tileX, tile.tileZ];
    const stones = createMeshBuilder({ withColors: true });
    const litter = createMeshBuilder({ withColors: true });
    for (const item of tile.cache.items) {
      if (item.keepKey >= level.keep) continue;
      if (item.kind === 'pebbles' || item.kind === 'rocks') addStone(stones, item, tileOrigin, settings, level.detail);
      else if (item.kind === 'twigs') addTwig(litter, item, tileOrigin, settings, level.detail);
      else addLeaf(litter, item, tileOrigin, settings, level.detail);
    }
    const parts = [];
    const matrix = tileMatrix(tile);
    if (stones.vertexCount > 0) parts.push({ name: `Clutter stones ${tile.column},${tile.row}`, geometry: stones.build(), matrix, material: materials.stone, castShadow: settings.castShadow });
    if (litter.vertexCount > 0) parts.push({ name: `Clutter litter ${tile.column},${tile.row}`, geometry: litter.build(), matrix, material: materials.litter, castShadow: false });
    return parts;
  }

  const field = createTileField({ ...settings, buildParts });
  field.update(settings.eye ?? [(settings.area.minX + settings.area.maxX) / 2, 2, (settings.area.minZ + settings.area.maxZ) / 2]);
  return { get parts() { return field.parts; }, update: field.update, stats: field.stats, materials, settings };
}

