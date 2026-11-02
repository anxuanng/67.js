// Options for the three grand scenes (issue #168). Each option is a different composition, light and time of day, not a tweak:
// a letter names it, `-a`, `-b` and `-c`, and a later change promotes the pick into REFERENCE_SCENES. They are drawn with
// `npm run reference -- --grand` (?set=grand), so baseline.json and the default images stay as they are.
// The rules of scenes.js hold: only what Blender draws too (terrain vertex colours, Emission, volume fog, plain geometry).
import { box, cylinder, sphere } from '/src/geometry.js';
import { createEnvironmentMap } from '/src/hdri.js';
import { createNoiseHeight, createTerrain } from '/src/terrain.js';
import { scatterVegetation, selectLevels } from '/src/vegetation.js';
import {
  HALL, HALL_BLOCK, VALLEY_TERRAIN, cityTowerParts, clamp01, constantLighting, environment, hallColumnParts, mixColors,
  normalized, part, seededRandom, smoothBetween, sunShadow,
} from './scenes.js';

const UNIT_BOX = box(0, 1);
const UNIT_CYLINDER = cylinder(32, 0, 1);
const UNIT_SPHERE = sphere(20, 14);

// A part with a turn about Y (yaw) and then about X (pitch), which `part` does not have.
function turnedPart(name, geometry, translation, scale, material, yaw = 0, pitch = 0) {
  const [cosYaw, sinYaw] = [Math.cos(yaw), Math.sin(yaw)];
  const [cosPitch, sinPitch] = [Math.cos(pitch), Math.sin(pitch)];
  const turn = ([x, y, z]) => [cosYaw * x + sinYaw * z, y, -sinYaw * x + cosYaw * z];
  const [xAxis, yAxis, zAxis] = [turn([scale[0], 0, 0]), turn([0, cosPitch * scale[1], sinPitch * scale[1]]), turn([0, -sinPitch * scale[2], cosPitch * scale[2]])];
  const built = part(name, geometry, translation, scale, material);
  built.matrix = new Float32Array([...xAxis, 0, ...yAxis, 0, ...zAxis, 0, ...translation, 1]);
  return built;
}

// Sky colour by elevation: horizon to zenith above the horizon (raised to `power`), horizon to ground below it.
// render-blender.py (gradient_sky_image) uses the same formula, and `intensity` scales all three colours.
function skyGradient({ zenith, horizon, ground = horizon, power = 0.5, intensity = 1 }) {
  const [width, height] = [256, 128];
  const scaled = colors => colors.map(color => color.map(channel => channel * intensity));
  const [zenithColor, horizonColor, groundColor] = scaled([zenith, horizon, ground]);
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const sine = Math.sin((0.5 - (row + 0.5) / height) * Math.PI);
    const above = clamp01(sine) ** power;
    const below = clamp01(-sine * 4);
    const color = mixColors(mixColors(horizonColor, zenithColor, above), groundColor, below);
    for (let column = 0; column < width; column++) data.set(color, (row * width + column) * 3);
  }
  const map = createEnvironmentMap({ width, height, data, showBackground: true });
  return { map, blenderWorld: { type: 'gradient', zenith: zenithColor, horizon: horizonColor, ground: groundColor, power } };
}

const WATER = { color: [0.02, 0.05, 0.08], roughness: 0.04 };

// ---------------------------------------------------------------------------------------------------------------------
// Mountain valley

// The reference valley (floor hills, a rim of ridged peaks, a far wall) with options: a flatter floor, a hero peak, and
// `carve(x, z, height)` for a lake or a river.
function valleyHeight({ floorScale = 1, floorOffset = 0, rimScale = 1, hero = null, carve = (x, z, height) => height }) {
  const floorHills = createNoiseHeight({ amplitude: 14, featureSize: 260, mountainMask: () => 0 }, 3);
  const peaks = createNoiseHeight({ amplitude: 0, mountainAmplitude: 1100, featureSize: 800, octaves: 7, warp: 260, warpFeatureSize: 700, mountainMask: () => 1 }, 11);
  return (x, z) => {
    const radius = Math.hypot(x, z * 0.75);
    const rise = smoothBetween(520, 1500, radius);
    const farWall = smoothBetween(2000, 2600, radius) * 600;
    const peakHeight = peaks(x, z);
    let height = floorHills(x, z) * floorScale + floorOffset + rise * (peakHeight * 1.5 * rimScale + 90) + farWall;
    if (hero) {
      const distance = Math.hypot(x - hero.x, z - hero.z) / hero.radius;
      height += hero.height * Math.exp(-distance * distance) * (0.75 + 0.5 * peakHeight / 1000);
    }
    return carve(x, z, height, rise);
  };
}

function paintGrandTerrain(terrain, { grass, alpine, rock, snow, shore, treeLine, snowLine, waterLevel = -Infinity }) {
  for (const terrainPart of terrain.parts) {
    const { positions, normals } = terrainPart.geometry;
    const colors = new Float32Array(positions.length);
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      const height = positions[vertex + 1];
      const flatness = normals[vertex + 1];
      let color = mixColors(grass, alpine, smoothBetween(treeLine * 0.7, treeLine * 1.5, height));
      color = mixColors(color, rock, smoothBetween(0.9, 0.7, flatness));
      color = mixColors(color, snow, smoothBetween(snowLine, snowLine + 120, height) * smoothBetween(0.55, 0.8, flatness));
      if (Number.isFinite(waterLevel)) color = mixColors(color, shore, 1 - smoothBetween(waterLevel + 0.5, waterLevel + 3.5, height));
      colors.set(color, vertex);
    }
    terrainPart.geometry.colors = colors;
  }
}

// Boulders around a point: squashed spheres and tilted blocks, so the near ground reads as rock and not as a bare slope.
function boulderParts({ terrain, center, innerRadius, outerRadius, count, size, seed, facing = 0 }) {
  const random = seededRandom(seed);
  const parts = [];
  const tones = [[0.3, 0.27, 0.24], [0.24, 0.23, 0.22], [0.36, 0.32, 0.27], [0.2, 0.22, 0.17]];
  for (let index = 0; index < count; index++) {
    const angle = facing + (random() - 0.5) * 2.4;
    const distance = innerRadius + (outerRadius - innerRadius) * random() ** 1.5;
    const x = center[0] + Math.sin(angle) * distance;
    const z = center[1] - Math.cos(angle) * distance;
    const radius = size[0] + (size[1] - size[0]) * random() ** 2;
    const material = { color: tones[Math.floor(random() * tones.length)], roughness: 0.9 };
    const sunk = radius * 0.25;
    if (random() < 0.2) {
      parts.push(turnedPart(`boulder-${index}`, UNIT_SPHERE, [x, terrain.heightAt(x, z) + radius * 0.3 - sunk, z], [radius * 1.3, radius * 0.8, radius], material, random() * 6.28, (random() - 0.5) * 0.4));
    } else {
      parts.push(turnedPart(`boulder-${index}`, UNIT_BOX, [x, terrain.heightAt(x, z) + radius * 0.35 - sunk, z], [radius * 1.5, radius * 0.9, radius * 1.1], material, random() * 6.28, (random() - 0.5) * 0.5));
    }
  }
  return parts;
}

async function grandValleyScene({ lighting, key, sunDirection, height, palette, waterLevel, water, eyeGround, eyeLift, target, fov = 50, boulders, forestDensity = 0.0016, treeExclusion, seed = 5 }) {
  const eyeXZ = eyeGround;
  const terrain = createTerrain({ ...VALLEY_TERRAIN, height, eye: [eyeXZ[0], 100, eyeXZ[1]], material: { color: [1, 1, 1], metallic: 0, roughness: 0.95, emission: 0 } });
  paintGrandTerrain(terrain, { ...palette, waterLevel: water ? waterLevel : -Infinity });
  const eye = [eyeXZ[0], terrain.heightAt(eyeXZ[0], eyeXZ[1]) + eyeLift, eyeXZ[1]];
  const forest = scatterVegetation({
    area: { minX: -1500, maxX: 1500, minZ: -1700, maxZ: 1100 }, density: forestDensity, terrainHeight: terrain.heightAt, slopeLimit: 26,
    exclusion: (x, z) => terrain.heightAt(x, z) > palette.treeLine || (water && terrain.heightAt(x, z) < waterLevel + 2.5) || (treeExclusion ?? (() => false))(x, z, eye),
    mix: { conifer: 1 }, variants: 3, scale: [0.8, 1.3], seed,
  });
  const visibleForest = selectLevels(forest.instances, eye, { cullDistance: 1800, distanceScale: 3 });
  const parts = [...terrain.parts, ...visibleForest.parts];
  if (water) parts.push(part('water', UNIT_BOX, [water.center[0], waterLevel - 0.5, water.center[1]], [water.size[0], 1, water.size[1]], WATER));
  if (boulders) parts.push(...boulderParts({ terrain, center: [eye[0], eye[2]], ...boulders }));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: key, lightDirection: normalized(sunDirection) }),
    camera: { eye, target, up: [0, 1, 0], fov, near: 0.5, far: 8000 },
    shadow: sunShadow(sunDirection, [0, 150, -400], 2300, 3500),
  };
}

const MEADOW = { grass: [0.14, 0.22, 0.07], alpine: [0.2, 0.19, 0.12], rock: [0.27, 0.25, 0.23], snow: [0.85, 0.87, 0.9], shore: [0.3, 0.28, 0.22], treeLine: 420, snowLine: 520 };

// A: golden hour at a lake. A low warm sun behind the peaks, a lake on the floor that mirrors the sky, rock in the near foreground.
const LAKE = { x: -20, z: -150 };
function lakeCarve(x, z, height) {
  const distance = Math.hypot((x - LAKE.x) / 330, (z - LAKE.z) / 220);
  const basin = 1 - smoothBetween(0.45, 1, distance);
  return height * (1 - basin) + -16 * basin;
}
async function mountainValleyA() {
  return grandValleyScene({
    lighting: skyGradient({ zenith: [0.12, 0.2, 0.5], horizon: [1, 0.55, 0.3], ground: [0.25, 0.15, 0.1], power: 0.45, intensity: 0.7 }),
    key: [7, 3.8, 1.8], sunDirection: [-0.75, 0.42, 0.3],
    height: valleyHeight({ floorScale: 1, carve: lakeCarve }), palette: MEADOW, waterLevel: -1.5,
    water: { center: [LAKE.x, -150], size: [900, 900] },
    eyeGround: [-150, 230], eyeLift: 12, target: [60, 220, -1500],
    boulders: { innerRadius: 10, outerRadius: 120, count: 120, size: [0.6, 4], seed: 21 },
    treeExclusion: (x, z, eye) => Math.hypot(x - eye[0], z - eye[2]) < 45,
  });
}

// B: midday from a high slope. A river winds down a flat valley floor from the camera to the far peaks.
function riverCentre(z) {
  return 150 * Math.sin(z / 300) + 40 * Math.sin(z / 97);
}
function riverCarve(x, z, height, rise) {
  const channel = (1 - smoothBetween(16, 55, Math.abs(x - riverCentre(z)))) * (1 - smoothBetween(0.05, 0.3, rise));
  return height * (1 - channel) + -6 * channel;
}
async function mountainValleyB() {
  return grandValleyScene({
    lighting: skyGradient({ zenith: [0.1, 0.3, 0.75], horizon: [0.65, 0.78, 0.95], ground: [0.2, 0.22, 0.2], power: 0.5, intensity: 1 }),
    key: [4.6, 4.2, 3.6], sunDirection: [0.35, 0.78, 0.25],
    height: valleyHeight({ floorScale: 0.5, floorOffset: 3, carve: riverCarve }), palette: { ...MEADOW, treeLine: 650, snowLine: 720 }, waterLevel: -1,
    water: { center: [0, -400], size: [3000, 3000] },
    eyeGround: [-700, 420], eyeLift: 30, target: [120, 60, -800], fov: 55, forestDensity: 0.0014,
    treeExclusion: (x, z, eye) => Math.hypot(x - eye[0], z - eye[2]) < 60,
  });
}

// C: cool morning with alpenglow. One tall peak rim lit by the low sun, a forest edge close to the camera.
async function mountainValleyC() {
  return grandValleyScene({
    lighting: skyGradient({ zenith: [0.1, 0.2, 0.55], horizon: [1, 0.62, 0.5], ground: [0.2, 0.17, 0.2], power: 0.4, intensity: 0.75 }),
    key: [6.5, 3.4, 1.9], sunDirection: [0.7, 0.5, 0.35],
    height: valleyHeight({ hero: { x: 60, z: -1150, radius: 360, height: 900 } }),
    palette: { ...MEADOW, snowLine: 380, treeLine: 460, snow: [0.95, 0.88, 0.88] }, waterLevel: -Infinity,
    eyeGround: [-420, 480], eyeLift: 7, target: [60, 480, -1150], fov: 46, forestDensity: 0.0022,
    boulders: { innerRadius: 6, outerRadius: 50, count: 30, size: [0.5, 2.4], seed: 3, facing: 0.4 },
    treeExclusion: (x, z, eye) => Math.hypot(x - eye[0], z - eye[2]) < 22,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Temple hall

const ROBES = [[0.5, 0.1, 0.08], [0.1, 0.2, 0.45], [0.55, 0.45, 0.15], [0.15, 0.3, 0.18], [0.4, 0.4, 0.42], [0.6, 0.3, 0.1]];

// People at the given [x, z] spots: a robe and a head, 1.5 to 1.8 m tall, for scale.
function peopleParts(spots, prefix = 'person') {
  const parts = [];
  spots.forEach(([x, z, yaw = 0], index) => {
    const height = 1.55 + (index % 4) * 0.08;
    parts.push(turnedPart(`${prefix}-body-${index}`, UNIT_CYLINDER, [x, height / 2, z], [0.22, height, 0.22], { color: ROBES[index % ROBES.length], roughness: 0.8 }, yaw));
    parts.push(part(`${prefix}-head-${index}`, UNIT_SPHERE, [x, height + 0.14, z], [0.14, 0.14, 0.14], { color: [0.75, 0.55, 0.42], roughness: 0.7 }));
  });
  return parts;
}

function fogBox(density, minimum, maximum, maxDistance, anisotropy = 0.6) {
  return { density, minimum, maximum, color: [1, 0.95, 0.85], ambient: [0.02, 0.02, 0.02], anisotropy, noiseAmount: 0, steps: 48, maxDistance };
}

const NAVE_LENGTH = HALL.front - HALL.back;
const NAVE_MIDDLE = (HALL.front + HALL.back) / 2;
const STONE = { color: [0.52, 0.45, 0.36], roughness: 0.85 };
const FLOOR_STONE = { color: [0.36, 0.32, 0.27], roughness: 0.6 };

// The reference nave without the roof openings: floor, carpet, solid roof, the far wall and the columns.
function closedNaveParts() {
  const roofY = HALL.roofHeight;
  const parts = [
    part('hall-floor', HALL_BLOCK, [0, -0.5, NAVE_MIDDLE], [HALL.halfWidth * 2, 1, NAVE_LENGTH], FLOOR_STONE),
    part('hall-carpet', HALL_BLOCK, [0, 0.03, NAVE_MIDDLE], [5, 0.06, NAVE_LENGTH - 8], { color: [0.45, 0.06, 0.05], roughness: 0.9 }),
    part('wall-right', HALL_BLOCK, [HALL.halfWidth + 1, roofY / 2, NAVE_MIDDLE], [2, roofY + 1, NAVE_LENGTH], STONE),
    part('wall-front', HALL_BLOCK, [0, roofY / 2, HALL.front + 1], [HALL.halfWidth * 2 + 4, roofY + 1, 2], STONE),
    part('roof', HALL_BLOCK, [0, roofY, NAVE_MIDDLE], [HALL.halfWidth * 2 + 4, 2, NAVE_LENGTH], STONE),
  ];
  hallColumnParts(parts, STONE);
  return parts;
}

// A: a strong sun shaft across the nave. Four clerestory windows in the left wall throw slanted beams through fog onto the
// columns and the floor, and people stand in the light for scale.
const CLERESTORY_CENTRES = [-12, -42, -72, -102];
async function templeHallA() {
  const lighting = constantLighting(0.08);
  const sunDirection = [-0.78, 0.62, 0.1];
  const parts = closedNaveParts();
  const [windowBottom, windowTop, windowWidth] = [11, 26, 10];
  parts.push(part('wall-far', HALL_BLOCK, [0, HALL.roofHeight / 2, HALL.back - 1], [HALL.halfWidth * 2 + 4, HALL.roofHeight + 1, 2], STONE));
  parts.push(part('wall-left-low', HALL_BLOCK, [-HALL.halfWidth - 1, windowBottom / 2, NAVE_MIDDLE], [2, windowBottom, NAVE_LENGTH], STONE));
  parts.push(part('wall-left-high', HALL_BLOCK, [-HALL.halfWidth - 1, (windowTop + HALL.roofHeight + 1) / 2, NAVE_MIDDLE], [2, HALL.roofHeight + 1 - windowTop, NAVE_LENGTH], STONE));
  let pierStart = HALL.front;
  for (const [index, centre] of [...CLERESTORY_CENTRES, HALL.back - windowWidth].entries()) {
    const pierEnd = centre + windowWidth / 2;
    if (pierStart - pierEnd > 0.5) {
      parts.push(part(`wall-left-pier-${index}`, HALL_BLOCK, [-HALL.halfWidth - 1, (windowBottom + windowTop) / 2, (pierStart + pierEnd) / 2], [2, windowTop - windowBottom, pierStart - pierEnd], STONE));
    }
    pierStart = centre - windowWidth / 2;
  }
  parts.push(
    part('altar-steps-low', HALL_BLOCK, [0, 0.4, HALL.back + 9], [26, 0.8, 18], STONE),
    part('altar-steps-high', HALL_BLOCK, [0, 1.2, HALL.back + 6], [16, 0.8, 11], STONE),
    part('altar', HALL_BLOCK, [0, 2.8, HALL.back + 6], [4, 2.4, 3], FLOOR_STONE),
  );
  parts.push(...peopleParts([[-8, -13], [-5, -15, 1], [-13, -17, 2], [-4, -44], [-9, -41, 1], [-7, -71], [-2, -75, 3], [-9, 0, 1], [-6, 3, 2], [-14, -4, 4]]));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [14, 12, 9], lightDirection: normalized(sunDirection), volumeFog: fogBox(0.04, [-HALL.halfWidth, 0, HALL.back], [HALL.halfWidth, HALL.roofHeight - 1, HALL.front + 2], 190) }),
    camera: { eye: [12, 1.7, 16], target: [-10, 8, -45], up: [0, 1, 0], fov: 64, near: 0.1, far: 300 },
    shadow: sunShadow(sunDirection, [0, 15, NAVE_MIDDLE], 105, 200),
  };
}

// B: an oculus hall. A square chamber 64 m across and 36 m high with a ring of columns, one square opening in the middle of the
// roof, and a gilded seated figure on a stepped plinth where the beam lands.
async function templeHallB() {
  const lighting = constantLighting(0.08);
  const sunDirection = [0.35, 0.88, 0.3];
  const [half, height, roofThickness, opening] = [32, 36, 2, 8];
  const gold = { color: [0.85, 0.62, 0.2], metallic: 0.9, roughness: 0.3 };
  const parts = [
    part('floor', HALL_BLOCK, [0, -0.5, 0], [half * 2 + 4, 1, half * 2 + 4], FLOOR_STONE),
    part('floor-ring', UNIT_CYLINDER, [0, 0.02, 0], [34, 0.04, 34], { color: [0.55, 0.5, 0.42], roughness: 0.5 }),
    part('wall-left', HALL_BLOCK, [-half - 1, height / 2, 0], [2, height, half * 2 + 4], STONE),
    part('wall-right', HALL_BLOCK, [half + 1, height / 2, 0], [2, height, half * 2 + 4], STONE),
    part('wall-back', HALL_BLOCK, [0, height / 2, -half - 1], [half * 2 + 4, height, 2], STONE),
    part('wall-front', HALL_BLOCK, [0, height / 2, half + 1], [half * 2 + 4, height, 2], STONE),
    part('roof-near', HALL_BLOCK, [0, height + roofThickness / 2, (half + opening) / 2 + 1], [half * 2 + 4, roofThickness, half - opening + 2], STONE),
    part('roof-far', HALL_BLOCK, [0, height + roofThickness / 2, -(half + opening) / 2 - 1], [half * 2 + 4, roofThickness, half - opening + 2], STONE),
    part('roof-left', HALL_BLOCK, [-(half + opening) / 2 - 1, height + roofThickness / 2, 0], [half - opening + 2, roofThickness, opening * 2], STONE),
    part('roof-right', HALL_BLOCK, [(half + opening) / 2 + 1, height + roofThickness / 2, 0], [half - opening + 2, roofThickness, opening * 2], STONE),
  ];
  const ringCount = 16;
  for (let index = 0; index < ringCount; index++) {
    const angle = (index / ringCount) * Math.PI * 2;
    const [x, z] = [Math.cos(angle) * 24, Math.sin(angle) * 24];
    parts.push(part(`ring-column-${index}`, UNIT_CYLINDER, [x, 14, z], [1.5, 28, 1.5], STONE));
    parts.push(part(`ring-base-${index}`, HALL_BLOCK, [x, 0.7, z], [3.6, 1.4, 3.6], STONE));
    parts.push(part(`ring-capital-${index}`, HALL_BLOCK, [x, 28.7, z], [3.6, 1.4, 3.6], STONE));
  }
  // The beam lands about 14 m toward -x and -z of the opening.
  const [statueX, statueZ] = [-14, -12];
  parts.push(
    part('plinth-low', HALL_BLOCK, [statueX, 0.4, statueZ], [13, 0.8, 13], FLOOR_STONE),
    part('plinth-mid', HALL_BLOCK, [statueX, 1.2, statueZ], [10, 0.8, 10], STONE),
    part('plinth-high', HALL_BLOCK, [statueX, 2, statueZ], [7, 0.8, 7], FLOOR_STONE),
    part('statue-legs', HALL_BLOCK, [statueX, 3.4, statueZ], [5.2, 2, 3.4], gold),
    part('statue-torso', UNIT_CYLINDER, [statueX, 6.6, statueZ], [1.9, 4.4, 1.5], gold),
    part('statue-arms', HALL_BLOCK, [statueX, 6, statueZ + 1.4], [4.2, 1.2, 1.6], gold),
    part('statue-head', UNIT_SPHERE, [statueX, 9.6, statueZ], [1.15, 1.35, 1.15], gold),
    part('statue-crown', UNIT_CYLINDER, [statueX, 11, statueZ], [0.35, 1.2, 0.35], gold),
  );
  parts.push(...peopleParts([[-8, -2], [-12, 1, 1], [-3, -8, 2], [4, -5], [-19, -4, 4], [-2, 6, 5], [8, 14, 2], [11, 17, 1]]));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [10, 8.8, 6.8], lightDirection: normalized(sunDirection), volumeFog: fogBox(0.016, [-half, 0, -half], [half, height - 0.5, half], 120) }),
    camera: { eye: [22, 1.8, 29], target: [-12, 7, -10], up: [0, 1, 0], fov: 62, near: 0.1, far: 200 },
    shadow: sunShadow(sunDirection, [0, 18, 0], 60, 120),
  };
}

// C: the setting sun down the axis of the nave. The far wall has a tall opening onto a glowing sky, so the columns stand as
// silhouettes in a glowing fog, their shadows run toward the camera, and a few people walk the carpet.
async function templeHallC() {
  const lighting = constantLighting(0.06);
  const sunDirection = [0.06, 0.2, -0.98];
  const [openingHalf, openingTop] = [10, 27];
  const parts = closedNaveParts();
  parts.push(
    part('wall-left', HALL_BLOCK, [-HALL.halfWidth - 1, HALL.roofHeight / 2, NAVE_MIDDLE], [2, HALL.roofHeight + 1, NAVE_LENGTH], STONE),
    part('wall-far-left', HALL_BLOCK, [-(HALL.halfWidth + openingHalf + 2) / 2, HALL.roofHeight / 2, HALL.back - 1], [HALL.halfWidth - openingHalf + 2, HALL.roofHeight + 1, 2], STONE),
    part('wall-far-right', HALL_BLOCK, [(HALL.halfWidth + openingHalf + 2) / 2, HALL.roofHeight / 2, HALL.back - 1], [HALL.halfWidth - openingHalf + 2, HALL.roofHeight + 1, 2], STONE),
    part('wall-far-top', HALL_BLOCK, [0, (openingTop + HALL.roofHeight + 1) / 2, HALL.back - 1], [openingHalf * 2, HALL.roofHeight + 1 - openingTop, 2], STONE),
    part('sky-glow', HALL_BLOCK, [0, 20, HALL.back - 40], [150, 90, 0.1], { color: [1, 0.62, 0.28], roughness: 1, emission: 7 }),
    part('sill', HALL_BLOCK, [0, 0.4, HALL.back - 5], [openingHalf * 2, 0.8, 8], FLOOR_STONE),
  );
  parts.push(...peopleParts([[0.8, 30], [-1.2, 22, 3], [1, 8], [-0.9, -6, 1], [1.2, -26, 2], [-1, -50], [0.5, -70, 4], [-10, 20], [12, 14, 1], [-16, -20, 2]]));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [11, 8.4, 5.2], lightDirection: normalized(sunDirection), volumeFog: fogBox(0.011, [-HALL.halfWidth, 0, HALL.back], [HALL.halfWidth, HALL.roofHeight - 1, HALL.front + 2], 190, 0.65) }),
    camera: { eye: [0, 1.7, HALL.front - 3], target: [0, 10, -130], up: [0, 1, 0], fov: 58, near: 0.1, far: 400 },
    shadow: sunShadow(sunDirection, [0, 15, NAVE_MIDDLE], 105, 200),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Megacity

const GROUND = { color: [0.1, 0.1, 0.11], roughness: 0.95 };
const ROAD = { color: [0.14, 0.14, 0.15], roughness: 0.6 };

function lampParts(prefix, positions, { height = 10, emission = 14, color = [1, 0.75, 0.4] } = {}) {
  const parts = [];
  positions.forEach(([x, z], index) => {
    parts.push(part(`${prefix}-post-${index}`, UNIT_BOX, [x, height / 2, z], [0.5, height, 0.5], { color: [0.15, 0.15, 0.16], roughness: 0.5, metallic: 0.8 }));
    parts.push(part(`${prefix}-head-${index}`, UNIT_BOX, [x, height + 0.2, z], [1.8, 0.5, 1.2], { color, roughness: 1, emission }));
  });
  return parts;
}

// Towers from a list of [x, z, height] sites, with the reference city's facades, windows and spires.
function towerParts(sites, seed) {
  const parts = [];
  const random = seededRandom(seed);
  sites.forEach(([x, z, towerHeight], index) => cityTowerParts(parts, UNIT_BOX, x, z, random, index, towerHeight));
  return parts;
}

// Sites on a grid with jitter. `heightAt(x, z, random)` gives the height, `skip(x, z)` leaves a gap.
function gridSites({ xs, zs, jitter = 6, heightAt, skip = () => false, seed }) {
  const random = seededRandom(seed);
  const sites = [];
  for (const z of zs) {
    for (const x of xs) {
      const [siteX, siteZ] = [x + (random() - 0.5) * jitter, z + (random() - 0.5) * jitter];
      if (random() < 0.12 || skip(siteX, siteZ)) continue;
      sites.push([siteX, siteZ, heightAt(siteX, siteZ, random)]);
    }
  }
  return sites;
}

// Values from `from` to `to` inclusive, in either direction.
const range = (from, to, step) => Array.from({ length: Math.floor(Math.abs(to - from) / step) + 1 }, (_, index) => from + Math.sign(to - from) * index * step);
const downtown = (x, z, centreZ, spreadX, spreadZ) => Math.exp(-(((z - centreZ) / spreadZ) ** 2)) * Math.exp(-((x / spreadX) ** 2));

// A: blue hour on a river. The sun is down, the sky goes from deep blue to a warm band on the horizon, and every bridge and
// quay is a line of light. Towers stand on both banks.
async function megacityDuskA() {
  const lighting = skyGradient({ zenith: [0.02, 0.06, 0.28], horizon: [0.7, 0.4, 0.35], ground: [0.05, 0.06, 0.1], power: 0.35, intensity: 0.6 });
  const riverHalf = 70;
  const parts = [
    part('city-ground', UNIT_BOX, [0, -1.5, -500], [9000, 2, 9000], GROUND),
    part('river', UNIT_BOX, [0, -1.2, -500], [riverHalf * 2, 1.4, 3200], WATER),
  ];
  for (const side of [-1, 1]) {
    parts.push(part(`quay-${side}`, UNIT_BOX, [side * (riverHalf + 18), 0.1, -500], [36, 0.3, 3200], ROAD));
    parts.push(part(`quay-edge-${side}`, UNIT_BOX, [side * (riverHalf + 0.6), 0.5, -500], [1.2, 1, 3200], { color: [0.2, 0.2, 0.21], roughness: 0.7 }));
  }
  parts.push(...lampParts('quay-lamp', range(260, -1040, 34).flatMap(z => [[-riverHalf - 4, z], [riverHalf + 4, z]]), { height: 9, emission: 16 }));
  const bridgeCentres = [60, -150, -380, -640];
  bridgeCentres.forEach((z, index) => {
    parts.push(part(`bridge-deck-${index}`, UNIT_BOX, [0, 6, z], [riverHalf * 2 + 30, 2.4, 22], { color: [0.12, 0.12, 0.13], roughness: 0.5 }));
    for (const edge of [-1, 1]) {
      parts.push(part(`bridge-light-${index}-${edge}`, UNIT_BOX, [0, 7.6, z + edge * 10.5], [riverHalf * 2 + 30, 0.5, 0.5], { color: [1, 0.8, 0.5], roughness: 1, emission: 9 }));
      parts.push(part(`bridge-rail-${index}-${edge}`, UNIT_BOX, [0, 7, z + edge * 11], [riverHalf * 2 + 30, 1.2, 0.3], { color: [0.15, 0.15, 0.16], roughness: 0.5, metallic: 0.7 }));
    }
    for (const pier of [-45, -15, 15, 45]) {
      parts.push(part(`bridge-pier-${index}-${pier}`, UNIT_BOX, [pier, 1.5, z], [4, 8, 14], { color: [0.2, 0.2, 0.21], roughness: 0.8 }));
    }
    parts.push(...lampParts(`bridge-lamp-${index}`, range(-60, 60, 30).flatMap(x => [[x, z - 9], [x, z + 9]]), { height: 7, emission: 12 }));
  });
  const xs = [...range(riverHalf + 60, riverHalf + 60 + 5 * 58, 58)].flatMap(x => [x, -x]);
  const sites = gridSites({
    xs, zs: range(280, -1100, 44), seed: 41,
    heightAt: (x, z, random) => 30 + downtown(x, z, -460, 380, 320) * 360 * (0.3 + random() * 0.95) * (random() < 0.05 ? 1.4 : 1),
  });
  parts.push(...towerParts(sites, 42));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [0, 0, 0], lightDirection: normalized([0, 1, 0]) }),
    camera: { eye: [15, 28, 250], target: [0, 70, -600], up: [0, 1, 0], fov: 55, near: 1, far: 4000 },
    shadow: sunShadow([0, 1, 0], [0, 0, -420], 900, 2500),
  };
}

// B: sunrise across a bay. The camera stands at the end of a pier, the water between it and a skyline carries the glow, and
// the sun rises behind the towers.
async function megacityDuskB() {
  const lighting = skyGradient({ zenith: [0.1, 0.25, 0.65], horizon: [1, 0.55, 0.32], ground: [0.3, 0.2, 0.15], power: 0.4, intensity: 0.7 });
  const sunDirection = [0.18, 0.1, -0.98];
  const parts = [
    part('land', UNIT_BOX, [0, -1.5, -1600], [6000, 2, 2400], GROUND),
    part('bay', UNIT_BOX, [0, -1.2, 150], [6000, 1.4, 1100], WATER),
    part('harbour-quay', UNIT_BOX, [0, 0.1, -400], [6000, 0.5, 40], ROAD),
  ];
  parts.push(part('pier', UNIT_BOX, [0, 1.6, 300], [6, 0.5, 420], { color: [0.4, 0.3, 0.22], roughness: 0.7 }));
  for (let beam = 0; beam < 26; beam++) {
    parts.push(part(`pier-pile-${beam}`, UNIT_BOX, [beam % 2 ? 2.8 : -2.8, 0, 500 - beam * 16], [0.6, 3.2, 0.6], { color: [0.2, 0.15, 0.1], roughness: 0.9 }));
  }
  parts.push(...lampParts('pier-lamp', range(330, 60, 30).flatMap(z => [[-2.8, z], [2.8, z]]), { height: 5, emission: 6, color: [1, 0.7, 0.4] }));
  const boats = [[-22, 330, 0.2], [-34, 250, -0.15], [26, 280, 0.1], [24, 100, -0.3], [-14, 40, 0.4]];
  boats.forEach(([x, z, yaw], index) => {
    parts.push(turnedPart(`boat-hull-${index}`, UNIT_BOX, [x, 0.6, z], [4.4, 1.4, 12], { color: [0.9, 0.9, 0.88], roughness: 0.4 }, yaw));
    parts.push(turnedPart(`boat-cabin-${index}`, UNIT_BOX, [x, 2.2, z - 1], [3.2, 1.8, 5], { color: [0.2, 0.3, 0.45], roughness: 0.3 }, yaw));
  });
  const sites = gridSites({
    xs: range(-900, 900, 56), zs: range(-440, -1300, 42), seed: 61,
    heightAt: (x, z, random) => 26 + downtown(x, z, -900, 520, 360) * 420 * (0.3 + random() * 0.95) * (random() < 0.05 ? 1.4 : 1),
  });
  parts.push(...towerParts(sites, 62));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [6.5, 3.6, 1.9], lightDirection: normalized(sunDirection) }),
    camera: { eye: [0.6, 8, 440], target: [0, 90, -700], up: [0, 1, 0], fov: 46, near: 1, far: 5000 },
    shadow: sunShadow(sunDirection, [0, 0, -500], 1400, 3000),
  };
}

// C: a night view from a tower top. Avenues are lines of car lights between dense, lit towers.
async function megacityDuskC() {
  const lighting = skyGradient({ zenith: [0.004, 0.007, 0.025], horizon: [0.06, 0.045, 0.08], power: 0.4, intensity: 1 });
  const parts = [part('city-ground', UNIT_BOX, [0, -1.5, -400], [9000, 2, 9000], GROUND)];
  const avenueXs = range(-500, 500, 125);
  const avenueZs = range(300, -1000, 130);
  for (const x of avenueXs) {
    parts.push(part(`avenue-x-${x}`, UNIT_BOX, [x, 0.05, -350], [26, 0.1, 1700], ROAD));
    parts.push(part(`cars-white-${x}`, UNIT_BOX, [x - 4, 0.3, -350], [1, 0.4, 1700], { color: [1, 0.9, 0.7], roughness: 1, emission: 3 }));
    parts.push(part(`cars-red-${x}`, UNIT_BOX, [x + 4, 0.3, -350], [1, 0.4, 1700], { color: [1, 0.12, 0.08], roughness: 1, emission: 3 }));
  }
  for (const z of avenueZs) {
    parts.push(part(`avenue-z-${z}`, UNIT_BOX, [0, 0.06, z], [1300, 0.1, 26], ROAD));
    parts.push(part(`cars-z-white-${z}`, UNIT_BOX, [0, 0.3, z - 4], [1300, 0.4, 1], { color: [1, 0.9, 0.7], roughness: 1, emission: 3 }));
    parts.push(part(`cars-z-red-${z}`, UNIT_BOX, [0, 0.3, z + 4], [1300, 0.4, 1], { color: [1, 0.12, 0.08], roughness: 1, emission: 3 }));
  }
  const sites = gridSites({
    xs: range(-560, 560, 125).map(value => value + 62), zs: range(240, -1000, 130).map(value => value - 65), jitter: 8, seed: 81,
    skip: () => false,
    heightAt: (siteX, siteZ, random) => 40 + downtown(siteX, siteZ, -380, 420, 520) * 470 * (0.3 + random() * 0.95) * (random() < 0.05 ? 1.4 : 1),
  });
  // Four towers fill each block, so the grid reads as city and not as a few stems.
  const blockSites = sites.flatMap(([siteX, siteZ, towerHeight]) => [[siteX - 22, siteZ - 22, towerHeight], [siteX + 22, siteZ + 22, towerHeight * 0.7], [siteX + 22, siteZ - 22, towerHeight * 0.45], [siteX - 22, siteZ + 22, towerHeight * 0.6]]);
  parts.push(...towerParts(blockSites, 82));
  return {
    parts, blenderWorld: lighting.blenderWorld,
    environment: environment(lighting, { keyColor: [0, 0, 0], lightDirection: normalized([0, 1, 0]) }),
    camera: { eye: [300, 470, 760], target: [0, 20, -250], up: [0, 1, 0], fov: 54, near: 1, far: 5000 },
    shadow: sunShadow([0, 1, 0], [0, 0, -400], 900, 2500),
  };
}

export const GRAND_SCENES = {
  'mountain-valley-a': mountainValleyA,
  'mountain-valley-b': mountainValleyB,
  'mountain-valley-c': mountainValleyC,
  'temple-hall-a': templeHallA,
  'temple-hall-b': templeHallB,
  'temple-hall-c': templeHallC,
  'megacity-dusk-a': megacityDuskA,
  'megacity-dusk-b': megacityDuskB,
  'megacity-dusk-c': megacityDuskC,
};

