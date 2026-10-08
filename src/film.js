import { mat4, quat, vec3 } from 'gl-matrix';
import { box, cylinder, sphere, torus } from './geometry.js';

export const FILM_DURATION = 32;
const FULL_TURN = Math.PI * 2;
const HALF_PI = Math.PI / 2;

const materials = {
  steel: { tag: 'steel', color: [0.35, 0.39, 0.42], metallic: 0.94, roughness: 0.25, emission: 0 },
  graphite: { tag: 'graphite', color: [0.035, 0.043, 0.05], metallic: 0.7, roughness: 0.34, emission: 0 },
  copper: { tag: 'copper', color: [0.63, 0.25, 0.08], metallic: 0.92, roughness: 0.28, emission: 0 },
  ceramic: { tag: 'armor', color: [0.78, 0.75, 0.65], metallic: 0.12, roughness: 0.38, emission: 0 },
  orbit: { tag: 'light', color: [0.63, 0.83, 1], metallic: 0.15, roughness: 0.24, emission: 5 },
  amber: { tag: 'indicator', color: [1, 0.34, 0.035], metallic: 0.1, roughness: 0.3, emission: 4 },
  terrain: { tag: 'terrain', color: [0.38, 0.27, 0.17], metallic: 0, roughness: 0.94, emission: 0 },
  rock: { tag: 'terrain', color: [0.24, 0.19, 0.14], metallic: 0, roughness: 0.95, emission: 0 },
  ash: { tag: 'terrain', color: [0.055, 0.046, 0.042], metallic: 0, roughness: 0.96, emission: 0 },
  fire: { tag: 'fire', color: [1, 0.24, 0.012], metallic: 0, roughness: 0.7, emission: 8 },
  core: { tag: 'fire', color: [1, 0.75, 0.26], metallic: 0, roughness: 0.5, emission: 18 },
  smoke: { tag: 'smoke', color: [0.2, 0.14, 0.1], metallic: 0, roughness: 1, emission: 0.04 },
  particle: { tag: 'particle', color: [1, 0.37, 0.035], metallic: 0, roughness: 0.65, emission: 6 },
};

function createBuilder(meshes) {
  const parts = [];
  function add(name, mesh, position, scale, material, rotation = [0, 0, 0]) {
    const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
    const matrix = mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
    parts.push({ name, geometry: meshes[mesh], matrix, material: materials[material] });
  }
  function beam(name, start, end, radius, material = 'steel') {
    const difference = vec3.subtract(vec3.create(), end, start);
    const length = vec3.length(difference);
    const direction = vec3.scale(vec3.create(), difference, 1 / length);
    const orientation = quat.rotationTo(quat.create(), [0, 1, 0], direction);
    const center = start.map((value, axis) => (value + end[axis]) / 2);
    parts.push({
      name,
      geometry: meshes.cylinder,
      matrix: mat4.fromRotationTranslationScale(mat4.create(), orientation, center, [radius, length, radius]),
      material: materials[material],
    });
  }
  return { parts, add, beam };
}

function createApparatus(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  add('Optical bench', 'box', [0, -0.55, 0], [7, 0.22, 4.5], 'graphite');
  add('Pressure chamber', 'cylinder', [0, 0.5, 0], [0.92, 2.5, 0.92], 'graphite', [HALF_PI, 0, 0]);
  for (let index = 0; index < 11; index++) {
    const depth = -1.2 + index * 0.24;
    add('Machined cooling collar', 'ring', [0, 0.5, depth], [1.02, 1.02, 0.6], index % 2 ? 'steel' : 'copper');
    for (let bolt = 0; bolt < 12; bolt++) {
      const angle = bolt / 12 * FULL_TURN;
      add('Hexagonal collar fastener', 'bolt', [Math.cos(angle) * 1.02, 0.5 + Math.sin(angle) * 1.02, depth + 0.055], [0.04, 0.09, 0.04], 'steel', [HALF_PI, 0, 0]);
    }
  }
  add('Front iris', 'cylinder', [0, 0.5, 1.3], [0.8, 0.05, 0.8], 'steel', [HALF_PI, 0, 0]);
  add('Dark optical aperture', 'cylinder', [0, 0.5, 1.34], [0.5, 0.06, 0.5], 'graphite', [HALF_PI, 0, 0]);
  add('Incandescent filament rim', 'thinRing', [0, 0.5, 1.385], [0.48, 0.48, 0.48], 'amber');
  for (let index = 0; index < 64; index++) {
    const angle = index / 64 * FULL_TURN;
    add('Engraved calibration mark', 'box', [Math.cos(angle) * 0.68, 0.5 + Math.sin(angle) * 0.68, 1.342], [index % 8 ? 0.036 : 0.08, 0.009, 0.009], 'graphite', [0, 0, angle]);
  }
  for (const side of [-1, 1]) {
    add('Ceramic stand', 'box', [side * 1.2, -0.05, 0], [0.28, 0.8, 2.8], 'ceramic');
    for (let index = 0; index < 9; index++) {
      const depth = -1 + index * 0.25;
      beam('Copper vacuum pipe', [side * 1.06, 0.38, depth], [side * 1.8, 0.65, depth], 0.035, 'copper');
      add('Electrical feedthrough', 'cylinder', [side * 1.8, 0.44, depth], [0.075, 0.38, 0.075], 'ceramic');
      add('Feedthrough terminal', 'sphere', [side * 1.8, 0.67, depth], [0.065, 0.065, 0.065], 'copper');
    }
  }
  for (let index = 0; index < 6; index++) {
    add('Instrument rack', 'box', [-2.4, -0.27 + index * 0.23, -0.6], [0.8, 0.2, 1.4], 'graphite');
    add('Analog dial bezel', 'ring', [-2.4, -0.27 + index * 0.23, 0.13], [0.075, 0.075, 0.4], 'steel');
  }
  return builder.parts;
}

function createAtom(meshes) {
  const { parts, add } = createBuilder(meshes);
  for (let orbit = 0; orbit < 5; orbit++) {
    add('Intersecting luminous orbit', 'thinRing', [0, 0, 0], [2.9, 1.7, 2.5], 'orbit', [orbit * 0.58, orbit * 0.81, orbit * 0.39]);
    const angle = orbit * 1.37;
    add('Orbital electron', 'sphere', [Math.cos(angle) * 2.6, Math.sin(angle) * 1.7, Math.sin(orbit * 2.4) * 1.2], [0.07, 0.07, 0.07], 'core');
  }
  for (let index = 0; index < 39; index++) {
    const angle = index * 2.399963;
    const elevation = 1 - 2 * (index + 0.5) / 39;
    const radius = Math.sqrt(1 - elevation * elevation) * 0.53;
    add('Nucleus cluster', 'sphere', [Math.cos(angle) * radius, elevation * 0.53, Math.sin(angle) * radius], [0.19, 0.19, 0.19], index % 3 ? 'copper' : 'steel');
  }
  for (let index = 0; index < 110; index++) {
    const angle = index * 2.399963;
    const radius = 4 + index % 7 * 0.48;
    add('Suspended speck', 'sphere', [Math.cos(angle) * radius, Math.sin(index * 1.7) * 3.5, Math.sin(angle) * radius], [0.008, 0.008, 0.008], 'orbit');
  }
  return parts;
}

function createWaveChamber(meshes) {
  const { parts, add, beam } = createBuilder(meshes);
  add('Wave chamber slab', 'box', [0, -0.12, 0], [12, 0.16, 7], 'graphite');
  for (let index = -24; index <= 24; index++) {
    beam('Scientific grid', [index * 0.22, 0, -3], [index * 0.22, 0, 3], 0.007, 'steel');
  }
  for (let index = -14; index <= 14; index++) {
    beam('Scientific grid', [-5.3, 0, index * 0.22], [5.3, 0, index * 0.22], 0.007, 'steel');
  }
  for (let index = 0; index < 170; index++) {
    const horizontal = -5 + index * 10 / 169;
    const next = -5 + (index + 1) * 10 / 169;
    const wave = value => Math.sin(value * 5.2) * Math.exp(-value * value * 0.055);
    beam('Wave trace', [horizontal, 0.12 + wave(horizontal) * 0.75, 0], [next, 0.12 + wave(next) * 0.75, 0], 0.023, 'orbit');
  }
  for (let index = 0; index < 14; index++) {
    add('Concentric interference shell', 'thinRing', [0, 0.1, -0.6], [0.2 + index * 0.21, 0.2 + index * 0.21, 0.3], 'steel', [HALF_PI, 0, 0]);
  }
  return parts;
}

function addDesert(builder, aftermath = false) {
  const { add } = builder;
  add('Desert floor', 'box', [0, -0.65, 0], [260, 1, 260], aftermath ? 'ash' : 'terrain');
  for (let index = 0; index < 180; index++) {
    const angle = index * 2.399963;
    const radius = 14 + Math.sqrt(index / 180) * 108;
    const width = 0.5 + (index % 9) * 0.22;
    add('Weathered desert stone', 'rock', [Math.cos(angle) * radius, -0.05, Math.sin(angle) * radius], [width, width * 0.3, width * 0.7], aftermath ? 'ash' : 'rock', [0.12, angle, 0.1]);
  }
  for (let index = 0; index < 24; index++) {
    const angle = index / 24 * FULL_TURN;
    add('Distant broken ridge', 'rock', [Math.cos(angle) * 114, 0.7, Math.sin(angle) * 114], [14 + index % 4 * 4, 3 + index % 5 * 1.8, 9], aftermath ? 'ash' : 'rock', [0, angle, 0]);
  }
}

function createDesert(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addDesert(builder);
  for (const horizontal of [-1.3, 1.3]) {
    for (const depth of [-1.3, 1.3]) {
      beam('Test tower leg', [horizontal * 1.5, 0, depth * 1.5], [horizontal, 10, depth], 0.065);
      for (let level = 0; level < 5; level++) {
        beam('Tower diagonal brace', [horizontal, level * 2, depth], [-horizontal, level * 2 + 2, depth], 0.035);
        beam('Tower transverse brace', [horizontal, level * 2, depth], [horizontal, level * 2 + 2, -depth], 0.035);
      }
    }
  }
  add('Tower platform', 'box', [0, 10, 0], [3.2, 0.18, 3.2], 'steel');
  add('Suspended test vessel', 'sphere', [0, 11, 0], [0.85, 0.95, 0.85], 'graphite');
  add('Vessel equatorial seam', 'ring', [0, 11, 0], [0.87, 0.87, 0.87], 'steel', [HALF_PI, 0, 0]);
  for (let index = 0; index < 10; index++) {
    add('Ladder rung', 'cylinder', [1.5, 0.5 + index, 1.4], [0.027, 0.7, 0.027], 'steel', [0, 0, HALF_PI]);
  }
  beam('Signal cable', [0.15, 10, 0], [9, 0, 2], 0.021, 'graphite');
  add('Remote junction box', 'box', [9, 0.3, 2], [0.8, 0.7, 0.8], 'graphite');
  return builder.parts;
}

function createIgnition(meshes) {
  const builder = createBuilder(meshes);
  const { add } = builder;
  addDesert(builder);
  add('Incandescent ignition core', 'sphere', [0, 7, 0], [6.8, 7, 6.8], 'core');
  for (let index = 0; index < 160; index++) {
    const angle = index * 2.399963;
    const elevation = 1 - 2 * (index + 0.5) / 160;
    const radius = Math.sqrt(1 - elevation * elevation) * (6.2 + index % 5 * 0.18);
    const size = 0.8 + index % 7 * 0.19;
    add('Boiling fire cell', 'sphere', [Math.cos(angle) * radius, 7.5 + elevation * 6.6, Math.sin(angle) * radius], [size, size * 1.16, size], index % 4 ? 'fire' : 'core');
  }
  for (let index = 0; index < 110; index++) {
    const angle = index * 2.399963;
    const radius = 2 + index % 11 * 0.48;
    const height = 12 + index / 110 * 10;
    const size = 1.4 + index % 6 * 0.22;
    add('Rolling smoke crown', 'sphere', [Math.cos(angle) * radius, height, Math.sin(angle) * radius], [size * 1.3, size, size * 1.3], 'smoke');
  }
  for (let index = 0; index < 6; index++) {
    add('Dust shock ring', 'gasRing', [0, 0.2 + index * 0.14, 0], [10 + index * 2.3, 10 + index * 2.3, 2.5], 'smoke', [HALF_PI, 0, index * 0.07]);
  }
  for (let index = 0; index < 130; index++) {
    const angle = index * 2.399963;
    const radius = 8 + index % 19 * 0.56;
    add('Ejected ember', 'sphere', [Math.cos(angle) * radius, 1 + index % 17 * 0.6, Math.sin(angle) * radius], [0.035, 0.09, 0.035], 'particle');
  }
  return builder.parts;
}

function createAftermath(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addDesert(builder, true);
  add('Scorched impact basin', 'cylinder', [0, -0.02, 0], [12, 0.16, 12], 'graphite');
  for (let index = 0; index < 18; index++) {
    const angle = index * 2.399963;
    const radius = 1 + index % 6;
    beam('Collapsed tower strut', [Math.cos(angle) * radius, 0.1, Math.sin(angle) * radius], [Math.cos(angle + 0.5) * (radius + 3), 0.22, Math.sin(angle + 0.5) * (radius + 3)], 0.06, 'graphite');
  }
  for (let index = 0; index < 55; index++) {
    const angle = index * 2.399963;
    const radius = 1 + index % 7 * 0.8;
    add('Low ember', 'sphere', [Math.cos(angle) * radius, 0.16, Math.sin(angle) * radius], [0.12, 0.025, 0.12], 'particle');
  }
  for (let index = 0; index < 34; index++) {
    const angle = index * 2.399963;
    const height = 1.6 + index * 0.33;
    const size = 0.8 + index / 34 * 1.1;
    add('Residual smoke plume', 'sphere', [Math.cos(angle) * 1.4 + height * 0.14, height, Math.sin(angle) * 1.4], [size, size * 1.2, size], 'smoke');
  }
  return builder.parts;
}

export function createFilmScenes() {
  const meshes = {
    box: box(0.04, 3),
    cylinder: cylinder(24),
    bolt: cylinder(6),
    sphere: sphere(24, 16),
    rock: sphere(12, 8),
    ring: torus(0.055, 64, 8),
    thinRing: torus(0.008, 96, 6),
    gasRing: torus(0.045, 96, 8),
  };
  const studio = {
    fogColor: [0.007, 0.009, 0.012], fogDensity: 0.028,
    skyTop: [0.009, 0.013, 0.02], skyBottom: [0.025, 0.032, 0.04],
    lightDirection: [-0.4, 0.8, 0.5], daylight: 0.65,
  };
  const desert = {
    fogColor: [0.14, 0.105, 0.075], fogDensity: 0.007,
    skyTop: [0.075, 0.11, 0.15], skyBottom: [0.5, 0.33, 0.21],
    lightDirection: [-0.65, 0.22, -0.5], daylight: 0.7,
  };
  const desertShadows = { extent: 55, target: [0, 6, 0], eye: [-35, 45, -35], near: 1, far: 140 };
  return {
    apparatus: { parts: createApparatus(meshes), environment: studio, ground: false },
    atom: {
      parts: createAtom(meshes), ground: false,
      environment: { ...studio, fogDensity: 0.06, skyTop: [0.002, 0.004, 0.009], skyBottom: [0.008, 0.012, 0.02], daylight: 0.2 },
    },
    waves: { parts: createWaveChamber(meshes), environment: studio, ground: false },
    desert: { parts: createDesert(meshes), environment: desert, ground: false, shadowBounds: desertShadows },
    ignition: { parts: createIgnition(meshes), environment: desert, ground: false, shadowBounds: desertShadows },
    aftermath: {
      parts: createAftermath(meshes), ground: false, shadowBounds: desertShadows,
      environment: {
        fogColor: [0.023, 0.018, 0.015], fogDensity: 0.016,
        skyTop: [0.013, 0.022, 0.032], skyBottom: [0.13, 0.075, 0.042],
        lightDirection: [-0.6, 0.3, -0.4], daylight: 0.3,
      },
    },
  };
}

// Each shot owns its camera endpoints. Cuts are deliberate; motion within a shot is continuous.
const shots = [
  { start: 0, end: 5, scene: 'apparatus', eye: [[0.37, 0.73, 2.12], [1.65, 1.02, 3.65]], target: [[0, 0.5, 1.28], [0, 0.48, 0.4]], fov: [34, 39], exposure: 0.95, monochrome: 0.25 },
  { start: 5, end: 10, scene: 'atom', eye: [[0.5, 0.3, 6.8], [4.8, 2.5, 5.1]], target: [[0, 0, 0], [0, 0, 0]], fov: [48, 43], exposure: 0.82, monochrome: 0 },
  { start: 10, end: 13.5, scene: 'waves', eye: [[-3.8, 3.4, 5.3], [0.5, 2.2, 4.4]], target: [[-0.8, 0, 0], [0.8, 0.05, 0]], fov: [49, 42], exposure: 0.85, monochrome: 1 },
  { start: 13.5, end: 17, scene: 'desert', eye: [[29, 6, 37], [21, 5, 29]], target: [[0, 6, 0], [0, 7.5, 0]], fov: [44, 40], exposure: 0.8, monochrome: 0.12 },
  { start: 17, end: 19, scene: 'desert', eye: [[4.7, 9.1, 6.2], [3.8, 10, 4.8]], target: [[0, 10.7, 0], [0, 11, 0]], fov: [36, 31], exposure: 0.68, monochrome: 0.25 },
  { start: 19, end: 26, scene: 'ignition', eye: [[28, 7, 39], [37, 11, 49]], target: [[0, 7, 0], [0, 11, 0]], fov: [48, 53], exposure: 0.66, monochrome: 0 },
  { start: 26, end: 32, scene: 'aftermath', eye: [[18, 3.2, 24], [22, 5, 30]], target: [[0, 2.5, 0], [0, 3.7, 0]], fov: [45, 46], exposure: 0.72, monochrome: 0.35 },
];

function smoothstep(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function interpolate(first, second, fraction) {
  return first + (second - first) * fraction;
}

export function sampleFilm(time) {
  if (!Number.isFinite(time)) throw new TypeError('Film time must be finite.');
  const boundedTime = Math.max(0, Math.min(FILM_DURATION, time));
  const shotIndex = shots.findIndex(shot => boundedTime < shot.end);
  const shot = shots[shotIndex < 0 ? shots.length - 1 : shotIndex];
  const progress = (boundedTime - shot.start) / (shot.end - shot.start);
  const eased = smoothstep(progress);
  const sceneStart = shots.find(candidate => candidate.scene === shot.scene).start;
  const sceneTime = boundedTime - sceneStart;
  const explosionProgress = shot.scene === 'ignition' ? smoothstep(sceneTime / 5.5) : shot.scene === 'aftermath' ? 1 : 0;
  const camera = {
    eye: shot.eye[0].map((value, axis) => interpolate(value, shot.eye[1][axis], eased)),
    target: shot.target[0].map((value, axis) => interpolate(value, shot.target[1][axis], eased)),
    fov: interpolate(...shot.fov, eased),
  };
  let title = '';
  let subtitle = '';
  if (boundedTime >= 28) {
    title = 'CRITICAL';
    subtitle = 'A 67.js short';
  }
  const visibility = smoothstep(boundedTime / 0.8) * (1 - smoothstep((boundedTime - 31) / 1));
  const flash = boundedTime >= 19 && boundedTime < 19.65 ? Math.exp(-(boundedTime - 19) * 7) : 0;
  return {
    scene: shot.scene,
    camera,
    exposure: shot.exposure + flash * 1.5,
    monochrome: shot.monochrome,
    fade: 1 - visibility,
    title,
    subtitle,
    time: boundedTime,
    sceneTime,
    explosionProgress,
    flash,
    titleOpacity: boundedTime >= 28 ? smoothstep((boundedTime - 28) / 1.2) * visibility : 0,
  };
}
