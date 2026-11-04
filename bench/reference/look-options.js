// Named looks for the grand scenes (issue #168), drawn with `npm run reference -- --option mountain-valley:dawn`. Each option changes
// composition and light (camera, sun, terrain and ground cover, hall openings, city massing and facades) and builds only what
// Blender draws too: terrain vertex colours, plain geometry, Emission, volume fog and material graphs. The default scenes of
// scenes.js and the letters of grand-scenes.js stay as they are; nothing here touches the baseline.
//
// No downloaded assets are used: ground cover is vertex colour noise on the terrain, and facades are material graphs, so
// Blender evaluates the same nodes. Real CC0 textures would need UV sets on the terrain chunks, which the export does not carry.
import { createNoiseHeight, createTerrain } from '/src/terrain.js';
import { materialPatternTextures, normalizeMaterialPattern } from '/src/material-patterns.js';
import { scatterVegetation, selectLevels } from '/src/vegetation.js';
import {
  GROUND, ROAD, STONE, FLOOR_STONE, UNIT_BOX, UNIT_CYLINDER, UNIT_SPHERE, WATER, NAVE_LENGTH, NAVE_MIDDLE,
  boulderParts, closedNaveParts, downtown, fogBox, gridSites, lampParts, peopleParts, range, skyGradient, turnedPart,
} from './grand-scenes.js';
import {
  HALL, HALL_BLOCK, VALLEY_TERRAIN, constantLighting, environment, hallRoofParts, mixColors, normalized, part,
  seededRandom, smoothBetween, sunShadow,
} from './scenes.js';

// ---------------------------------------------------------------------------------------------------------------------
// Mountain valley

function latticeHash(cellX, cellZ, seed) {
  const value = Math.sin(cellX * 127.1 + cellZ * 311.7 + seed * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

// Smooth value noise in [0, 1]; `scale` is the size of one feature in metres.
function groundNoise(x, z, scale, seed) {
  const [cellX, cellZ] = [Math.floor(x / scale), Math.floor(z / scale)];
  const [fractionX, fractionZ] = [x / scale - cellX, z / scale - cellZ];
  const [easedX, easedZ] = [fractionX * fractionX * (3 - 2 * fractionX), fractionZ * fractionZ * (3 - 2 * fractionZ)];
  const top = latticeHash(cellX, cellZ, seed) * (1 - easedX) + latticeHash(cellX + 1, cellZ, seed) * easedX;
  const bottom = latticeHash(cellX, cellZ + 1, seed) * (1 - easedX) + latticeHash(cellX + 1, cellZ + 1, seed) * easedX;
  return top * (1 - easedZ) + bottom * easedZ;
}

function carveDisc(center, radii, depth) {
  return (x, z, height) => {
    const basin = 1 - smoothBetween(0.45, 1, Math.hypot((x - center[0]) / radii[0], (z - center[1]) / radii[1]));
    return height * (1 - basin) + depth * basin;
  };
}

function carveRiver(centreAt, depth, halfWidth) {
  return (x, z, height, rise) => {
    const channel = (1 - smoothBetween(halfWidth * 0.3, halfWidth, Math.abs(x - centreAt(z)))) * (1 - smoothBetween(0, 0.02, rise));
    return height * (1 - channel) + depth * channel;
  };
}

// Rim of rounded massifs (erosion noise, smooth flanks and rough crests) instead of the reference's needle ridges; `ridgeMix` adds
// a little of the ridged noise back for crags.
function lookValleyHeight({ ridgeMix = 0.25, rimScale = 1, floorScale = 1, floorOffset = 0, hero = null, carve = (x, z, height) => height }) {
  const floorHills = createNoiseHeight({ amplitude: 14, featureSize: 260, mountainMask: () => 0 }, 3);
  const massifs = createNoiseHeight({ amplitude: 1000, featureSize: 900, octaves: 6, warp: 300, warpFeatureSize: 700, mountainMask: () => 0 }, 17);
  const crags = createNoiseHeight({ amplitude: 0, mountainAmplitude: 1100, featureSize: 800, octaves: 7, warp: 260, warpFeatureSize: 700, mountainMask: () => 1 }, 11);
  return (x, z) => {
    const rise = smoothBetween(520, 1500, Math.hypot(x, z * 0.75));
    const farWall = smoothBetween(2000, 2600, Math.hypot(x, z * 0.75)) * 600;
    const rim = massifs(x, z) * 1.25 * (1 - ridgeMix) + crags(x, z) * 1.5 * ridgeMix + 420;
    let height = floorHills(x, z) * floorScale + floorOffset + rise * rim * rimScale + farWall;
    if (hero) {
      const distance = Math.hypot(x - hero.x, z - hero.z) / hero.radius;
      height += hero.height * Math.exp(-distance * distance);
    }
    return carve(x, z, height, rise);
  };
}

// Ground cover as colour: two greens in drifts, dry patches, flower drifts, darker forest floor, strata in the rock, snow with a
// ragged edge, wet gravel at the shore, and the far ground pulled toward the haze colour so ridges separate by depth.
function paintLookTerrain(terrain, { eye, palette, waterLevel, haze }) {
  const { grassLight, grassDark, dry, flowers, rock, rockDark, snow, shore, treeLine, snowLine } = palette;
  for (const terrainPart of terrain.parts) {
    const { positions, normals } = terrainPart.geometry;
    const colors = new Float32Array(positions.length);
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      const [x, height, z] = [positions[vertex], positions[vertex + 1], positions[vertex + 2]];
      const flatness = normals[vertex + 1];
      const drift = groundNoise(x, z, 70, 1);
      let color = mixColors(grassDark, grassLight, smoothBetween(0.3, 0.7, drift));
      color = mixColors(color, dry, smoothBetween(0.55, 0.8, groundNoise(x, z, 190, 2)) * 0.8);
      color = mixColors(color, flowers[Math.floor(groundNoise(x, z, 400, 4) * flowers.length) % flowers.length], smoothBetween(0.72, 0.9, groundNoise(x, z, 28, 3)) * smoothBetween(0.9, 0.97, flatness) * (1 - smoothBetween(treeLine * 0.5, treeLine * 0.8, height)));
      color = mixColors(color, grassDark.map(channel => channel * 0.6), smoothBetween(0.5, 0.75, groundNoise(x, z, 110, 5)) * (1 - smoothBetween(treeLine * 0.9, treeLine * 1.2, height)) * 0.7);
      color = mixColors(color, rockDark, smoothBetween(treeLine * 0.8, treeLine * 1.6, height) * 0.6);
      const strata = groundNoise(x, z, 120, 6) * 0.6 + groundNoise(x, z, 35, 8) * 0.4;
      color = mixColors(color, mixColors(rock, rockDark, strata), smoothBetween(0.9, 0.68, flatness));
      const snowEdge = snowLine + (groundNoise(x, z, 45, 7) - 0.5) * 90;
      color = mixColors(color, snow, smoothBetween(snowEdge, snowEdge + 70, height) * smoothBetween(0.5, 0.78, flatness));
      if (Number.isFinite(waterLevel)) color = mixColors(color, shore, 1 - smoothBetween(waterLevel + 0.5, waterLevel + 3.5, height));
      const distance = Math.hypot(x - eye[0], z - eye[2]);
      color = mixColors(color, haze.color, smoothBetween(haze.start, haze.end, distance) * haze.amount);
      colors.set(color, vertex);
    }
    terrainPart.geometry.colors = colors;
  }
}

function lookValleyScene({ sky, key, sunDirection, height, palette, water, haze, eyeGround, eyeLift, target, fov = 50, boulders, forestDensity = 0.0018, forestMix = { conifer: 1 }, treeExclusion = () => false, mist, seed = 5 }) {
  const waterLevel = water ? water.level : -Infinity;
  const eyeHeightGuess = [eyeGround[0], 100, eyeGround[1]];
  const terrain = createTerrain({ ...VALLEY_TERRAIN, height, eye: eyeHeightGuess, material: { color: [1, 1, 1], metallic: 0, roughness: 0.95, emission: 0 } });
  const eye = [eyeGround[0], terrain.heightAt(eyeGround[0], eyeGround[1]) + eyeLift, eyeGround[1]];
  paintLookTerrain(terrain, { eye, palette, waterLevel, haze });
  const forest = scatterVegetation({
    area: { minX: -1500, maxX: 1500, minZ: -1700, maxZ: 1100 }, density: forestDensity, terrainHeight: terrain.heightAt, slopeLimit: 28,
    exclusion: (x, z) => terrain.heightAt(x, z) > palette.treeLine || (water && terrain.heightAt(x, z) < waterLevel + 2.5) || treeExclusion(x, z, eye),
    mix: forestMix, variants: 3, scale: [0.8, 1.4], seed,
  });
  const parts = [...terrain.parts, ...selectLevels(forest.instances, eye, { cullDistance: 1800, distanceScale: 3 }).parts];
  if (water) parts.push(part('water', UNIT_BOX, [water.center[0], waterLevel - 0.5, water.center[1]], [water.size[0], 1, water.size[1]], water.material ?? WATER));
  if (boulders) parts.push(...boulderParts({ terrain, center: [eye[0], eye[2]], ...boulders }));
  return {
    parts, blenderWorld: sky.blenderWorld,
    environment: environment(sky, { keyColor: key, lightDirection: normalized(sunDirection), ...(mist ? { volumeFog: mist } : {}) }),
    camera: { eye, target, up: [0, 1, 0], fov, near: 0.5, far: 8000 },
    shadow: sunShadow(sunDirection, [0, 150, -400], 2300, 3500),
  };
}

const ALPINE = {
  grassLight: [0.17, 0.27, 0.08], grassDark: [0.08, 0.16, 0.05], dry: [0.3, 0.27, 0.12],
  flowers: [[0.55, 0.45, 0.08], [0.5, 0.5, 0.5], [0.3, 0.12, 0.4]],
  rock: [0.4, 0.34, 0.29], rockDark: [0.19, 0.17, 0.16], snow: [0.88, 0.9, 0.94], shore: [0.28, 0.26, 0.21],
  treeLine: 520, snowLine: 640,
};

const DAWN_RIVER = z => 120 * Math.sin(z / 280) + 35 * Math.sin(z / 90);

// Dawn: a cool, misty valley seen from the meadow edge with the sun rising behind the far massif, so the forest and the river
// are backlit and the ridges stack into pale layers.
function mountainValleyDawn() {
  return lookValleyScene({
    sky: skyGradient({ zenith: [0.14, 0.24, 0.55], horizon: [1, 0.66, 0.55], ground: [0.2, 0.17, 0.2], power: 0.4, intensity: 1.1 }),
    key: [6.2, 3.7, 2.4], sunDirection: [0.45, 0.24, -0.85],
    height: lookValleyHeight({ ridgeMix: 0.2, floorScale: 0.6, floorOffset: 9, hero: { x: 80, z: -1250, radius: 380, height: 700 }, carve: carveRiver(DAWN_RIVER, -6, 60) }),
    palette: { ...ALPINE, snowLine: 820 }, water: { level: -1, center: [0, -400], size: [3000, 3000] },
    haze: { color: [0.75, 0.62, 0.64], start: 900, end: 4200, amount: 0.55 },
    eyeGround: [-200, 430], eyeLift: 45, target: [60, 330, -1500], fov: 52, forestDensity: 0.002,
    forestMix: { conifer: 1, birch: 0.12 },
    boulders: { innerRadius: 8, outerRadius: 70, count: 40, size: [0.5, 2.6], seed: 8, facing: -0.3 },
    treeExclusion: (x, z, eye) => Math.hypot(x - eye[0], z - eye[2]) < 70,
    // The sun sits behind the massif, so this mist is lit by the sky, which Cycles does for any volume; the 0.02 ambient of the
    // sunlit scenes left the veil dark and the far forest black. It is dense at the valley floor and thins with height, with
    // coarse noise for patches, so it reads as valley mist and not as one uniform box over the forest (option G, chosen 2026-11-04).
    mist: { density: 0.004, heightFalloff: 35, minimum: [-1600, 0, -1800], maximum: [1600, 140, 1200], color: [1, 0.92, 0.9], ambient: [0.85, 0.72, 0.75], anisotropy: 0.6, noiseAmount: 0.8, noiseScale: 0.0025, steps: 48, maxDistance: 2600 },
  });
}

const TARN = { x: -60, z: -220 };

// Tarn: midday on the shore of a turquoise lake, a forest across the water and snowy massifs behind it, a few boulders at the camera.
function mountainValleyTarn() {
  return lookValleyScene({
    sky: skyGradient({ zenith: [0.08, 0.28, 0.72], horizon: [0.62, 0.78, 0.95], ground: [0.2, 0.22, 0.2], power: 0.5, intensity: 1 }),
    key: [4.8, 4.4, 3.8], sunDirection: [-0.3, 0.8, 0.3],
    height: lookValleyHeight({ ridgeMix: 0.3, rimScale: 0.92, carve: carveDisc([TARN.x, TARN.z], [420, 260], -14) }),
    palette: { ...ALPINE, rock: [0.27, 0.23, 0.19], rockDark: [0.13, 0.12, 0.11], snowLine: 950, treeLine: 560 },
    water: { level: -1.2, center: [TARN.x, TARN.z], size: [1000, 1000], material: { color: [0.02, 0.17, 0.2], roughness: 0.03 } },
    haze: { color: [0.62, 0.74, 0.9], start: 900, end: 4200, amount: 0.45 },
    eyeGround: [-130, 140], eyeLift: 3.2, target: [60, 260, -1500], fov: 55, forestDensity: 0.0021,
    boulders: { innerRadius: 4, outerRadius: 70, count: 40, size: [0.4, 2], seed: 14, facing: 0.1 },
    treeExclusion: (x, z, eye) => Math.hypot(x - eye[0], z - eye[2]) < 30,
  });
}

// Meadow at sunset: a low orange sun from the left throws long tree shadows across wildflower drifts, one massif lit pink.
function mountainValleySunset() {
  return lookValleyScene({
    sky: skyGradient({ zenith: [0.09, 0.14, 0.42], horizon: [1, 0.45, 0.2], ground: [0.22, 0.12, 0.1], power: 0.42, intensity: 1 }),
    key: [7.4, 3.5, 1.4], sunDirection: [-0.85, 0.2, -0.15],
    height: lookValleyHeight({ ridgeMix: 0.4, hero: { x: 140, z: -1100, radius: 340, height: 650 }, floorScale: 1.4 }),
    palette: { ...ALPINE, grassLight: [0.3, 0.38, 0.1], grassDark: [0.13, 0.21, 0.06], flowers: [[0.6, 0.5, 0.05], [0.5, 0.3, 0.1], [0.45, 0.45, 0.5]], snowLine: 820, snow: [0.95, 0.85, 0.82] },
    haze: { color: [0.8, 0.45, 0.35], start: 600, end: 3400, amount: 0.65 },
    eyeGround: [-300, 400], eyeLift: 2.4, target: [100, 330, -1400], fov: 50, forestDensity: 0.0026,
    forestMix: { conifer: 1, birch: 0.2 },
    boulders: { innerRadius: 5, outerRadius: 40, count: 25, size: [0.5, 2], seed: 3, facing: 0.5 },
    treeExclusion: (x, z, eye) => Math.hypot(x - eye[0], z - eye[2]) < 18,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Temple hall

const SANDSTONE = { color: [0.74, 0.62, 0.46], roughness: 0.8 };
const SANDSTONE_FLOOR = { color: [0.55, 0.46, 0.34], roughness: 0.55 };
const GOLD = { color: [0.85, 0.62, 0.2], metallic: 0.9, roughness: 0.3 };

// The reference nave's stone is dark; the options that need a lit hall get sandstone, swapped by colour identity.
function lightenStone(parts) {
  for (const { material } of parts) {
    if (material.color === STONE.color) material.color = SANDSTONE.color;
    else if (material.color === FLOOR_STONE.color) material.color = SANDSTONE_FLOOR.color;
  }
  return parts;
}

function glowPart(name, translation, scale, color, emission) {
  return part(name, HALL_BLOCK, translation, scale, { color, roughness: 1, emission });
}

// A stained glass rose window and three lancets in the far wall, every pane Emission so Cycles lights the nave from them.
function roseWindowParts() {
  const parts = [];
  const [centreY, glassZ] = [21, HALL.back + 0.4];
  const [red, blue, amber, green] = [[0.95, 0.12, 0.08], [0.1, 0.25, 1], [1, 0.62, 0.15], [0.15, 0.8, 0.3]];
  parts.push(turnedPart('rose-frame', UNIT_CYLINDER, [0, centreY, HALL.back + 0.1], [11.4, 0.3, 11.4], STONE, 0, Math.PI / 2));
  parts.push(turnedPart('rose-core', UNIT_CYLINDER, [0, centreY, glassZ], [2.6, 0.2, 2.6], { color: amber, roughness: 1, emission: 7 }, 0, Math.PI / 2));
  for (let petal = 0; petal < 12; petal++) {
    const angle = (petal / 12) * Math.PI * 2;
    parts.push(turnedPart(`rose-petal-${petal}`, UNIT_CYLINDER, [Math.cos(angle) * 5.2, centreY + Math.sin(angle) * 5.2, glassZ], [2.2, 0.2, 2.2], { color: petal % 2 ? blue : red, roughness: 1, emission: 6 }, 0, Math.PI / 2));
  }
  for (let jewel = 0; jewel < 24; jewel++) {
    const angle = ((jewel + 0.5) / 24) * Math.PI * 2;
    parts.push(turnedPart(`rose-jewel-${jewel}`, UNIT_CYLINDER, [Math.cos(angle) * 9, centreY + Math.sin(angle) * 9, glassZ], [0.85, 0.2, 0.85], { color: jewel % 3 === 0 ? green : jewel % 3 === 1 ? amber : red, roughness: 1, emission: 6 }, 0, Math.PI / 2));
  }
  [[-22, amber], [-11, blue], [0, red], [11, blue], [22, amber]].forEach(([x, color], index) => {
    parts.push(part(`lancet-frame-${index}`, HALL_BLOCK, [x, 8, HALL.back + 0.1], [5.4, 15.4, 0.3], STONE));
    parts.push(glowPart(`lancet-${index}`, [x, 8, glassZ], [4.2, 14.2, 0.2], color, 5));
  });
  return parts;
}

function candleParts(spots) {
  return spots.flatMap(([x, z], index) => [
    part(`candle-stand-${index}`, UNIT_CYLINDER, [x, 0.7, z], [0.18, 1.4, 0.18], { color: [0.2, 0.17, 0.1], metallic: 0.8, roughness: 0.4 }),
    part(`candle-flame-${index}`, UNIT_SPHERE, [x, 1.6, z], [0.22, 0.34, 0.22], { color: [1, 0.7, 0.3], roughness: 1, emission: 12 }),
  ]);
}

// Rose window: the nave seen down its axis toward a wall of stained glass, sun shafts through the roof openings, candles along
// the carpet and people for scale.
function templeHallRose() {
  const lighting = constantLighting(0.3);
  const sunDirection = [0.3, 0.82, 0.25];
  const parts = lightenStone(closedNaveParts().filter(({ name }) => name !== 'roof'));
  hallRoofParts(parts, SANDSTONE);
  parts.push(
    part('wall-left', HALL_BLOCK, [-HALL.halfWidth - 1, HALL.roofHeight / 2, NAVE_MIDDLE], [2, HALL.roofHeight + 1, NAVE_LENGTH], STONE),
    part('wall-far', HALL_BLOCK, [0, HALL.roofHeight / 2, HALL.back - 1], [HALL.halfWidth * 2 + 4, HALL.roofHeight + 1, 2], STONE),
    part('altar-step-low', HALL_BLOCK, [0, 0.35, HALL.back + 8], [30, 0.7, 14], FLOOR_STONE),
    part('altar-step-high', HALL_BLOCK, [0, 1.05, HALL.back + 5], [16, 0.7, 7], STONE),
    part('altar', HALL_BLOCK, [0, 2.2, HALL.back + 5], [6, 1.7, 2.4], GOLD),
  );
  parts.push(...roseWindowParts());
  parts.push(...candleParts(range(30, -100, 13).flatMap(z => [[-3.4, z], [3.4, z]])));
  parts.push(...peopleParts([[-1.5, 24], [1.4, 12, 1], [-1.2, -2, 2], [1.5, -18], [-12, 6, 1], [14, -8, 2], [0.8, -40, 3], [-16, -30, 2]]));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [11, 9.6, 7.4], lightDirection: normalized(sunDirection), volumeFog: fogBox(0.012, [-HALL.halfWidth, 0, HALL.back], [HALL.halfWidth, HALL.roofHeight - 1, HALL.front + 2], 190, 0.55) }),
    camera: { eye: [0, 1.8, HALL.front - 3], target: [0, 13, HALL.back], up: [0, 1, 0], fov: 58, near: 0.1, far: 300 },
    shadow: sunShadow(sunDirection, [0, 15, NAVE_MIDDLE], 105, 200),
    // Used by `--bake temple-hall-rose` (the hall has more parts and texels than the CPU bake takes): the GPU bake at the density the
    // closed `temple-hall` scene uses. Without --bake the hall is drawn as before.
    bakeOptions: { backend: 'gpu', texelsPerUnit: 2, samples: 128, maxSeconds: 300 },
  };
}

// A seated colossus from boxes and a sphere: plinth, legs, torso, arms, head and a flat crown.
function colossusParts(prefix, x, z, scale, material) {
  const at = (offsetX, y, offsetZ, sizeX, sizeY, sizeZ, name, geometry = HALL_BLOCK) => part(`${prefix}-${name}`, geometry, [x + offsetX * scale, y * scale, z + offsetZ * scale], [sizeX * scale, sizeY * scale, sizeZ * scale], material);
  return [
    at(0, 1.5, 0, 9, 3, 9, 'plinth'),
    at(0, 4.5, 0.6, 7, 3, 7, 'legs'),
    at(0, 9.5, 0, 5.4, 7, 3.4, 'torso'),
    at(-3.2, 8.2, 1.4, 1.4, 1.6, 3.6, 'arm-left'),
    at(3.2, 8.2, 1.4, 1.4, 1.6, 3.6, 'arm-right'),
    at(0, 14.2, 0, 2.8, 3, 2.8, 'head', UNIT_SPHERE),
    at(0, 16.2, 0, 4.2, 1.2, 3.2, 'crown'),
  ];
}

// Open court: the roof is open over the nave, so the hall is lit from above by a high sun and a blue sky, the columns throw
// bars of shadow across a pale floor, and two colossi sit at the far end.
function templeHallCourt() {
  const lighting = constantLighting(0.42);
  const sunDirection = [0.42, 0.78, 0.3];
  const parts = lightenStone(closedNaveParts().filter(({ name }) => name !== 'roof'));
  const aisleWidth = HALL.halfWidth - 17;
  for (const side of [-1, 1]) {
    parts.push(part(`roof-aisle-${side}`, HALL_BLOCK, [side * (17 + aisleWidth / 2 + 2), HALL.roofHeight, NAVE_MIDDLE], [aisleWidth + 4, 2, NAVE_LENGTH], SANDSTONE));
  }
  parts.push(
    part('wall-left', HALL_BLOCK, [-HALL.halfWidth - 1, HALL.roofHeight / 2, NAVE_MIDDLE], [2, HALL.roofHeight + 1, NAVE_LENGTH], SANDSTONE),
    part('wall-far', HALL_BLOCK, [0, HALL.roofHeight / 2, HALL.back - 1], [HALL.halfWidth * 2 + 4, HALL.roofHeight + 1, 2], SANDSTONE),
    part('far-door-glow', HALL_BLOCK, [0, 10, HALL.back + 0.2], [9, 20, 0.3], { color: [1, 0.78, 0.45], roughness: 1, emission: 5 }),
    part('far-door-lintel', HALL_BLOCK, [0, 21, HALL.back + 0.5], [12, 2, 1.4], SANDSTONE),
  );
  parts.push(...colossusParts('colossus-left', -22, HALL.back + 9, 0.9, GOLD), ...colossusParts('colossus-right', 22, HALL.back + 9, 0.9, GOLD));
  parts.push(...candleParts(range(30, -100, 13).flatMap(z => [[-3.4, z], [3.4, z]])));
  parts.push(...peopleParts([[-1.5, 30], [1.4, 18, 1], [-1.2, 4, 2], [1.5, -14], [-8, 12, 1], [8, -2, 2], [0.8, -45, 3], [-14, -26, 2], [15, -60, 1]]));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [9, 8.2, 6.6], lightDirection: normalized(sunDirection), volumeFog: fogBox(0.006, [-HALL.halfWidth, 0, HALL.back], [HALL.halfWidth, HALL.roofHeight - 1, HALL.front + 2], 190, 0.6) }),
    camera: { eye: [-8, 1.7, HALL.front - 3], target: [4, 11, -110], up: [0, 1, 0], fov: 60, near: 0.1, far: 300 },
    shadow: sunShadow(sunDirection, [0, 15, NAVE_MIDDLE], 105, 200),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Megacity

// A facade as a material graph: a grid of window panes in a wall, a share of them lit warm or cool in drifts. Blender builds the
// same nodes. The tile is 36 m, 6 window columns by 10 floors.
function facadeMaterial({ wall, glass, lit, litShare, warm, cool, seed }) {
  const across = { smoothstep: [0.22, 0.34, { wave: { frequency: 6, direction: 'u', shape: 'triangle' } }] };
  const along = { smoothstep: [0.18, 0.3, { wave: { frequency: 10, direction: 'v', shape: 'triangle' } }] };
  const pane = { min: [across, along] };
  // The lit test reads a noise at the centre of each window cell (the same 6 by 10 grid as the panes), so a window is lit or dark
  // as a whole and the lit ones fall in drifts. A voronoi cell does not follow the grid and cut panes into shards.
  const windowCentre = {
    vec: [
      { div: [{ add: [{ floor: { mul: [{ uv: 'u' }, 6] } }, 0.5] }, 6] },
      { div: [{ add: [{ floor: { mul: [{ uv: 'v' }, 10] } }, 0.5] }, 10] },
      0,
    ],
  };
  const litThreshold = 0.5 + (0.5 - litShare) * 0.5;
  const litPane = { mul: [pane, { smoothstep: [litThreshold, litThreshold + 0.03, { noise: { scale: 9, seed, tile: false, at: windowCentre } }] }] };
  const tint = { ramp: { value: { noise: { scale: 4, seed: seed + 5, tile: false } }, stops: [[0, warm], [1, cool]] } };
  const graph = { color: { mix: [wall, glass, pane] }, emission: { mix: [[0, 0, 0], tint, litPane] } };
  const pattern = normalizeMaterialPattern({ type: 'graph', graph, size: 36, bump: 0, resolution: 512 });
  const textures = materialPatternTextures(pattern);
  // emissiveColor white, so only the graph's lit panes glow; without it the renderer emits the base colour map everywhere.
  return { color: [1, 1, 1], emissiveColor: [1, 1, 1], roughness: 0.4, metallic: 0.2, emission: lit, ...textures, graph: pattern.graph, graphBump: 0 };
}

const WARM = [1, 0.66, 0.3];
const COOL = [0.65, 0.8, 1];

function facadePalette(litShare, lit) {
  return [
    facadeMaterial({ wall: [0.12, 0.13, 0.16], glass: [0.03, 0.05, 0.09], lit, litShare, warm: WARM, cool: COOL, seed: 3 }),
    facadeMaterial({ wall: [0.42, 0.38, 0.32], glass: [0.07, 0.08, 0.1], lit, litShare, warm: WARM, cool: [1, 0.9, 0.7], seed: 8 }),
    facadeMaterial({ wall: [0.3, 0.17, 0.12], glass: [0.06, 0.05, 0.05], lit, litShare, warm: [1, 0.55, 0.22], cool: WARM, seed: 13 }),
    facadeMaterial({ wall: [0.22, 0.26, 0.3], glass: [0.04, 0.07, 0.1], lit, litShare, warm: WARM, cool: COOL, seed: 21 }),
  ];
}

const snapTo = (value, step) => Math.max(step, Math.round(value / step) * step);

// A tower with a podium (lit shopfronts), one to three setbacks, and a crown: flat with plant, stepped, or a spire and beacon.
// Sizes snap to a grid so towers share box projections.
function massedTower(parts, random, x, z, totalHeight, index, materials, shopMaterial) {
  const width = [26, 30, 36, 42][Math.floor(random() * 4)];
  const depth = [26, 30, 36, 42][Math.floor(random() * 4)];
  const facade = materials[Math.floor(random() * materials.length)];
  const podiumHeight = snapTo(10 + random() * 12, 4);
  parts.push(part(`podium-${index}`, UNIT_BOX, [x, podiumHeight / 2, z], [width + 10, podiumHeight, depth + 10], shopMaterial));
  const tiers = totalHeight > 140 ? 2 + Math.floor(random() * 2) : 1;
  let baseY = podiumHeight;
  let tierWidth = width;
  let tierDepth = depth;
  for (let tier = 0; tier < tiers; tier++) {
    const remaining = totalHeight - baseY;
    const tierHeight = snapTo(tier === tiers - 1 ? remaining : remaining * (0.42 + random() * 0.16), 6);
    parts.push(part(`tower-${index}-${tier}`, UNIT_BOX, [x, baseY + tierHeight / 2, z], [tierWidth, tierHeight, tierDepth], facade));
    baseY += tierHeight;
    tierWidth = snapTo(tierWidth * 0.78, 6);
    tierDepth = snapTo(tierDepth * 0.78, 6);
  }
  const crown = random();
  const topWidth = tierWidth / 0.78;
  const topDepth = tierDepth / 0.78;
  if (crown < 0.4) {
    parts.push(part(`plant-${index}`, UNIT_BOX, [x + 2, baseY + 3, z - 2], [topWidth * 0.5, 6, topDepth * 0.4], { color: [0.2, 0.2, 0.22], roughness: 0.6 }));
  } else if (crown < 0.75 && totalHeight > 100) {
    parts.push(part(`crown-${index}`, UNIT_BOX, [x, baseY + 9, z], [topWidth * 0.55, 18, topDepth * 0.55], facade));
    parts.push(part(`crown-glow-${index}`, UNIT_BOX, [x, baseY + 18.4, z], [topWidth * 0.55 + 0.4, 1.2, topDepth * 0.55 + 0.4], { color: [1, 0.85, 0.6], roughness: 1, emission: 6 }));
  } else if (totalHeight > 140) {
    parts.push(part(`spire-${index}`, UNIT_BOX, [x, baseY + 24, z], [1.6, 48, 1.6], { color: [0.2, 0.2, 0.22], roughness: 0.4, metallic: 0.8 }));
    parts.push(part(`beacon-${index}`, UNIT_BOX, [x, baseY + 49, z], [2.4, 2.4, 2.4], { color: [1, 0.15, 0.1], roughness: 1, emission: 12 }));
  }
}

function streetTreeParts(prefix, spots) {
  return spots.flatMap(([x, z], index) => [
    part(`${prefix}-trunk-${index}`, UNIT_CYLINDER, [x, 2, z], [0.3, 4, 0.3], { color: [0.2, 0.14, 0.09], roughness: 0.9 }),
    part(`${prefix}-crown-${index}`, UNIT_SPHERE, [x, 6, z], [2.8, 2.6, 2.8], { color: [0.1, 0.22, 0.07], roughness: 0.9 }),
  ]);
}

function trafficStreak(name, x, z, length, axis, color, emission) {
  const scale = axis === 'z' ? [0.9, 0.4, length] : [length, 0.4, 0.9];
  return part(name, UNIT_BOX, [x, 0.3, z], scale, { color, roughness: 1, emission });
}

function cityTowers(sites, seed, materials, shopMaterial) {
  const random = seededRandom(seed);
  const parts = [];
  sites.forEach(([x, z, height], index) => massedTower(parts, random, x, z, height, index, materials, shopMaterial));
  return parts;
}

// Golden avenue: street level on a broad avenue at sunset. The sun is low behind the camera on the left, so the right-hand towers
// glow gold, the left ones stand in blue shade, and the road is lines of car lights between street trees and lamps.
function megacityGoldenAvenue() {
  const lighting = skyGradient({ zenith: [0.15, 0.3, 0.62], horizon: [1, 0.62, 0.35], ground: [0.2, 0.15, 0.12], power: 0.42, intensity: 0.8 });
  const sunDirection = [-0.7, 0.16, 0.5];
  const materials = facadePalette(0.3, 0.2);
  const shop = facadeMaterial({ wall: [0.3, 0.25, 0.2], glass: [0.08, 0.07, 0.06], lit: 0.3, litShare: 0.45, warm: WARM, cool: [1, 0.85, 0.6], seed: 30 });
  const parts = [
    part('city-ground', UNIT_BOX, [0, -1, -500], [9000, 2, 9000], GROUND),
    part('avenue', UNIT_BOX, [0, 0.05, -500], [60, 0.1, 2600], ROAD),
    part('sidewalk-left', UNIT_BOX, [-38, 0.15, -500], [16, 0.3, 2600], { color: [0.3, 0.29, 0.28], roughness: 0.7 }),
    part('sidewalk-right', UNIT_BOX, [38, 0.15, -500], [16, 0.3, 2600], { color: [0.3, 0.29, 0.28], roughness: 0.7 }),
  ];
  for (const lane of [-18, -9, 9, 18]) {
    parts.push(trafficStreak(`lane-${lane}`, lane, -500, 2500, 'z', lane < 0 ? [1, 0.12, 0.08] : [1, 0.92, 0.75], 2.6));
  }
  parts.push(...lampParts('avenue-lamp', range(260, -1000, 36).flatMap(z => [[-31, z], [31, z]]), { height: 10, emission: 12 }));
  parts.push(...streetTreeParts('avenue-tree', range(240, -1000, 24).flatMap(z => [[-44, z], [44, z]])));
  const sites = gridSites({
    xs: range(70, 70 + 4 * 52, 52).flatMap(x => [x, -x]), zs: range(250, -1250, 44), seed: 52, jitter: 4,
    heightAt: (x, z, random) => snapTo(36 + Math.exp(-(((z + 650) / 420) ** 2)) * 380 * (0.35 + random() * 0.8), 6),
    skip: (x, z) => Math.abs(x) < 62,
  });
  parts.push(...cityTowers(sites.map(([x, z, height]) => [x + Math.sign(x) * 0, z, height]), 53, materials, shop));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [7.2, 4.1, 2], lightDirection: normalized(sunDirection) }),
    camera: { eye: [0, 7, 270], target: [0, 70, -700], up: [0, 1, 0], fov: 58, near: 0.5, far: 5000 },
    shadow: sunShadow(sunDirection, [0, 0, -400], 1000, 2500),
  };
}

// Blue hour skyline: an elevated bank above a river, a tall landmark tower in the middle of the skyline, lit windows in drifts
// and a warm band on the horizon. Parkland trees on the near bank.
function megacityBlueHour() {
  const lighting = skyGradient({ zenith: [0.02, 0.07, 0.3], horizon: [0.8, 0.45, 0.35], ground: [0.05, 0.06, 0.1], power: 0.35, intensity: 0.65 });
  const materials = facadePalette(0.42, 0.25);
  const shop = facadeMaterial({ wall: [0.3, 0.25, 0.2], glass: [0.08, 0.07, 0.06], lit: 0.35, litShare: 0.5, warm: WARM, cool: [1, 0.85, 0.6], seed: 31 });
  const parts = [
    part('far-land', UNIT_BOX, [0, -1.5, -1400], [9000, 2, 2400], GROUND),
    part('river', UNIT_BOX, [0, -1.19, 0], [9000, 1.4, 1500], WATER),
    part('near-bank', UNIT_BOX, [0, 1, 460], [9000, 4, 160], { color: [0.12, 0.16, 0.08], roughness: 0.95 }),
    part('embankment', UNIT_BOX, [0, 0.4, -230], [6000, 1.6, 30], ROAD),
  ];
  parts.push(...lampParts('embankment-lamp', range(-700, 700, 36).map(x => [x, -218]), { height: 9, emission: 14 }));
  parts.push(...streetTreeParts('bank-tree', range(-300, 300, 17).flatMap(x => [[x, 430 + (x % 3) * 9], [x + 8, 470 + (x % 5) * 6]])));
  for (const [index, x] of [-260, 40, 330].entries()) {
    parts.push(part(`bridge-deck-${index}`, UNIT_BOX, [x, 6, -230 + 0], [22, 2.4, 520], { color: [0.12, 0.12, 0.13], roughness: 0.5 }));
    parts.push(part(`bridge-light-${index}`, UNIT_BOX, [x, 7.6, -230], [0.5, 0.5, 520], { color: [1, 0.8, 0.5], roughness: 1, emission: 9 }));
  }
  const sites = gridSites({
    xs: range(-900, 900, 60), zs: range(-300, -1300, 46), seed: 71, jitter: 8,
    heightAt: (x, z, random) => snapTo(34 + downtown(x, z, -820, 420, 380) * 380 * (0.3 + random() * 0.85), 6),
    skip: (x, z) => Math.abs(x - 20) < 28 && Math.abs(z + 800) < 40,
  });
  const landmark = [[20, -800, 560]];
  parts.push(...cityTowers([...sites, ...landmark], 72, materials, shop));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [0, 0, 0], lightDirection: normalized([0, 1, 0]) }),
    camera: { eye: [-70, 34, 420], target: [20, 150, -800], up: [0, 1, 0], fov: 50, near: 1, far: 5000 },
    shadow: sunShadow([0, 1, 0], [0, 0, -420], 900, 2500),
  };
}

// Night grid: a high view over avenues of car lights, dense towers with most windows lit, and a few lit signs in cyan and
// magenta on the tower faces.
function megacityNightGrid() {
  const lighting = skyGradient({ zenith: [0.004, 0.008, 0.03], horizon: [0.07, 0.05, 0.1], power: 0.4, intensity: 1 });
  const materials = facadePalette(0.5, 0.3);
  const shop = facadeMaterial({ wall: [0.25, 0.22, 0.2], glass: [0.06, 0.05, 0.05], lit: 0.4, litShare: 0.55, warm: WARM, cool: [1, 0.85, 0.6], seed: 32 });
  const parts = [part('city-ground', UNIT_BOX, [0, -1.5, -400], [9000, 2, 9000], GROUND)];
  for (const x of range(-500, 500, 125)) {
    parts.push(part(`avenue-x-${x}`, UNIT_BOX, [x, 0.05, -350], [26, 0.1, 1700], ROAD));
    parts.push(trafficStreak(`cars-white-${x}`, x - 4, -350, 1700, 'z', [1, 0.9, 0.7], 3));
    parts.push(trafficStreak(`cars-red-${x}`, x + 4, -350, 1700, 'z', [1, 0.12, 0.08], 3));
  }
  for (const z of range(300, -1000, 130)) {
    parts.push(part(`avenue-z-${z}`, UNIT_BOX, [0, 0.06, z], [1300, 0.1, 26], ROAD));
    parts.push(trafficStreak(`cars-z-white-${z}`, 0, z - 4, 1300, 'x', [1, 0.9, 0.7], 3));
    parts.push(trafficStreak(`cars-z-red-${z}`, 0, z + 4, 1300, 'x', [1, 0.12, 0.08], 3));
  }
  const sites = gridSites({
    xs: range(-560, 560, 125).map(value => value + 62), zs: range(240, -1000, 130).map(value => value - 65), jitter: 8, seed: 91,
    heightAt: (x, z, random) => snapTo(40 + downtown(x, z, -380, 420, 520) * 470 * (0.3 + random() * 0.95), 6),
  });
  const blockSites = sites.flatMap(([x, z, height]) => [[x - 24, z - 24, height], [x + 24, z + 24, height * 0.7], [x + 24, z - 24, height * 0.45], [x - 24, z + 24, height * 0.6]]);
  parts.push(...cityTowers(blockSites, 92, materials, shop));
  const signRandom = seededRandom(93);
  sites.forEach(([x, z, height], index) => {
    if (height < 150 || signRandom() < 0.4) return;
    const color = signRandom() < 0.5 ? [0.1, 0.9, 1] : [1, 0.15, 0.7];
    parts.push(part(`sign-${index}`, UNIT_BOX, [x - 24, height * 0.55, z - 24 + 22], [12, 30, 0.8], { color, roughness: 1, emission: 6 }));
  });
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [0, 0, 0], lightDirection: normalized([0, 1, 0]) }),
    camera: { eye: [300, 470, 760], target: [0, 20, -250], up: [0, 1, 0], fov: 54, near: 1, far: 5000 },
    shadow: sunShadow([0, 1, 0], [0, 0, -400], 900, 2500),
  };
}

// Option ids are `<scene>-<option>`; the command line writes them `<scene>:<option>`.
export const LOOK_OPTIONS = {
  'mountain-valley-dawn': mountainValleyDawn,
  'mountain-valley-tarn': mountainValleyTarn,
  'mountain-valley-sunset': mountainValleySunset,
  'temple-hall-rose': templeHallRose,
  'temple-hall-court': templeHallCourt,
  'megacity-dusk-golden-avenue': megacityGoldenAvenue,
  'megacity-dusk-blue-hour': megacityBlueHour,
  'megacity-dusk-night-grid': megacityNightGrid,
};

// The three looks An picked (issue #168, 2026-11-04). The grand set of harness.js draws them beside the letters of grand-scenes.js, so
// `npm run reference -- --grand --scene mountain-valley-dawn,temple-hall-rose,megacity-dusk-blue-hour` scores them into grand.json.
export const GRAND_PICKS = {
  'mountain-valley-dawn': LOOK_OPTIONS['mountain-valley-dawn'],
  'temple-hall-rose': LOOK_OPTIONS['temple-hall-rose'],
  'megacity-dusk-blue-hour': LOOK_OPTIONS['megacity-dusk-blue-hour'],
};
