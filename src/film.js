import { mat4, quat, vec3 } from 'gl-matrix';
import { box, cylinder, sphere, torus } from './geometry.js';

export const FILM_DURATION = 187;
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
  fire: { tag: 'fire', color: [1, 0.24, 0.012], metallic: 0, roughness: 0.7, emission: 8 },
  core: { tag: 'fire', color: [1, 0.75, 0.26], metallic: 0, roughness: 0.5, emission: 18 },
  smoke: { tag: 'smoke', color: [0.2, 0.14, 0.1], metallic: 0, roughness: 1, emission: 0.04 },
  particle: { tag: 'particle', color: [1, 0.37, 0.035], metallic: 0, roughness: 0.65, emission: 6 },
  wood: { tag: 'wood', color: [0.17, 0.085, 0.035], metallic: 0, roughness: 0.82, emission: 0 },
  plaster: { tag: 'plaster', color: [0.42, 0.38, 0.29], metallic: 0, roughness: 0.95, emission: 0 },
  cloth: { tag: 'cloth', color: [0.045, 0.055, 0.049], metallic: 0, roughness: 0.91, emission: 0 },
  skin: { tag: 'skin', color: [0.44, 0.26, 0.16], metallic: 0, roughness: 0.76, emission: 0 },
  paper: { tag: 'paper', color: [0.73, 0.66, 0.48], metallic: 0, roughness: 0.96, emission: 0 },
  window: { tag: 'window', color: [0.48, 0.66, 0.71], metallic: 0, roughness: 0.8, emission: 1.2 },
  olive: { tag: 'paint', color: [0.13, 0.16, 0.08], metallic: 0.2, roughness: 0.65, emission: 0 },
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

function addDesert(builder) {
  const { add } = builder;
  add('Desert floor', 'box', [0, -0.65, 0], [260, 1, 260], 'terrain');
  for (let index = 0; index < 180; index++) {
    const angle = index * 2.399963;
    const radius = 14 + Math.sqrt(index / 180) * 108;
    const width = 0.5 + (index % 9) * 0.22;
    add('Weathered desert stone', 'rock', [Math.cos(angle) * radius, -0.05, Math.sin(angle) * radius], [width, width * 0.3, width * 0.7], 'rock', [0.12, angle, 0.1]);
  }
  for (let index = 0; index < 24; index++) {
    const angle = index / 24 * FULL_TURN;
    add('Distant broken ridge', 'rock', [Math.cos(angle) * 114, 0.7, Math.sin(angle) * 114], [14 + index % 4 * 4, 3 + index % 5 * 1.8, 9], 'rock', [0, angle, 0]);
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
    add('Dust shock ring', 'gasRing', [0, 0.12 + index * 0.03, 0], [10 + index * 2.3, 10 + index * 2.3, 0.12], 'smoke', [HALF_PI, 0, 0]);
  }
  for (let index = 0; index < 130; index++) {
    const angle = index * 2.399963;
    const radius = 8 + index % 19 * 0.56;
    add('Ejected ember', 'sphere', [Math.cos(angle) * radius, 1 + index % 17 * 0.6, Math.sin(angle) * radius], [0.035, 0.09, 0.035], 'particle');
  }
  return builder.parts;
}

function addScientist(builder, position = [0, 0, 0], hat = true, rotation = 0) {
  const { add, beam } = builder;
  const transform = point => [position[0] + point[0] * Math.cos(rotation) + point[2] * Math.sin(rotation), position[1] + point[1], position[2] - point[0] * Math.sin(rotation) + point[2] * Math.cos(rotation)];
  const shape = (name, mesh, point, scale, material, angles = [0, 0, 0]) => add(name, mesh, transform(point), scale, material, [angles[0], rotation + angles[1], angles[2]]);
  for (const side of [-1, 1]) {
    shape('Polished leather shoe', 'sphere', [side * 0.14, 0.09, 0.09], [0.11, 0.08, 0.22], 'graphite');
    beam('Trouser leg', transform([side * 0.14, 0.18, 0]), transform([side * 0.12, 0.88, 0]), 0.095, 'cloth');
    shape('Coat shoulder', 'sphere', [side * 0.24, 1.43, 0], [0.14, 0.15, 0.15], 'cloth');
    beam('Coat sleeve', transform([side * 0.27, 1.4, 0]), transform([side * 0.33, 0.9, 0.04]), 0.09, 'cloth');
    shape('Resting hand', 'sphere', [side * 0.33, 0.85, 0.04], [0.07, 0.1, 0.065], 'skin');
    shape('Wool lapel', 'box', [side * 0.095, 1.36, 0.17], [0.09, 0.29, 0.025], 'graphite', [0, 0, side * 0.25]);
    shape('Eye socket', 'sphere', [side * 0.068, 1.805, 0.13], [0.043, 0.02, 0.025], 'graphite');
    shape('Catchlight', 'sphere', [side * 0.068, 1.807, 0.151], [0.009, 0.009, 0.009], 'ceramic');
    shape('Brow ridge', 'sphere', [side * 0.07, 1.846, 0.124], [0.065, 0.025, 0.034], 'skin');
    shape('Ear', 'sphere', [side * 0.149, 1.77, 0], [0.034, 0.065, 0.039], 'skin');
  }
  shape('Coat body', 'sphere', [0, 1.19, 0], [0.28, 0.4, 0.17], 'cloth');
  shape('Coat skirt', 'sphere', [0, 0.88, -0.02], [0.27, 0.3, 0.16], 'cloth');
  shape('Ivory shirt front', 'box', [0, 1.42, 0.16], [0.11, 0.26, 0.035], 'paper');
  shape('Narrow tie', 'box', [0, 1.39, 0.19], [0.027, 0.25, 0.017], 'graphite', [0, 0, -0.05]);
  shape('Neck', 'cylinder', [0, 1.6, 0], [0.075, 0.15, 0.075], 'skin');
  shape('Long angular head', 'sphere', [0, 1.79, 0], [0.15, 0.225, 0.14], 'skin');
  shape('Cheek plane', 'sphere', [0, 1.75, 0.088], [0.115, 0.12, 0.065], 'skin');
  shape('Bridge of nose', 'sphere', [0, 1.795, 0.156], [0.024, 0.07, 0.033], 'skin');
  shape('Mouth line', 'box', [0, 1.7, 0.137], [0.063, 0.008, 0.007], 'wood');
  shape('Combed hair', 'sphere', [0, 1.94, -0.023], [0.154, 0.09, 0.132], 'graphite');
  if (hat) {
    shape('Fedora sweeping brim', 'cylinder', [0, 1.983, 0], [0.29, 0.025, 0.235], 'cloth', [0.035, 0, -0.04]);
    shape('Fedora pinched crown', 'sphere', [0, 2.075, -0.015], [0.168, 0.16, 0.145], 'cloth');
    shape('Fedora grosgrain band', 'cylinder', [0, 2.012, -0.012], [0.168, 0.046, 0.145], 'graphite');
  }
}

function addRoom(builder, laboratory = false) {
  const { add, beam } = builder;
  add('Timber floor', 'box', [0, -0.09, 0], [12, 0.15, 10], 'wood');
  add('Rear plaster wall', 'box', [0, 2.2, -4.8], [12, 4.5, 0.15], 'plaster');
  add('Side plaster wall', 'box', [-5.8, 2.2, 0], [0.15, 4.5, 10], 'plaster');
  for (let index = 0; index < 4; index++) {
    const horizontal = -4.2 + index * 2.8;
    add('Tall daylight window', 'box', [horizontal, 2.75, -4.69], [1.8, 2.35, 0.04], 'window');
    for (const side of [-1, 1]) {
      add('Window jamb', 'box', [horizontal + side * 0.94, 2.75, -4.61], [0.08, 2.5, 0.12], 'wood');
    }
    for (let pane = 0; pane < 3; pane++) {
      add('Window sash', 'box', [horizontal, 1.6 + pane * 1.15, -4.6], [1.9, 0.065, 0.12], 'wood');
    }
    add('Window mullion', 'box', [horizontal, 2.75, -4.6], [0.055, 2.4, 0.1], 'wood');
  }
  add('Work desk top', 'box', [0, 0.84, 0], [3.5, 0.13, 1.65], laboratory ? 'steel' : 'wood');
  for (const horizontal of [-1.5, 1.5]) {
    for (const depth of [-0.65, 0.65]) {
      beam('Desk leg', [horizontal, 0, depth], [horizontal, 0.78, depth], 0.055, 'wood');
    }
  }
  add('Chalkboard frame', 'box', [3.2, 2.2, -4.5], [3.1, 1.6, 0.15], 'wood');
  add('Slate chalkboard', 'box', [3.2, 2.2, -4.4], [2.92, 1.4, 0.035], 'cloth');
  for (let index = 0; index < 44; index++) {
    const horizontal = 1.9 + index % 11 * 0.23;
    const height = 1.72 + Math.floor(index / 11) * 0.27;
    beam('Chalk calculation', [horizontal, height, -4.36], [horizontal + 0.12, height + Math.sin(index * 2.7) * 0.1, -4.36], 0.007, 'paper');
  }
  for (let index = 0; index < 12; index++) {
    add('Loose research sheet', 'box', [-1 + index % 4 * 0.48, 0.916 + index * 0.003, -0.4 + Math.floor(index / 4) * 0.3], [0.4, 0.004, 0.26], 'paper', [0, index * 0.13, 0]);
  }
  for (let shelf = 0; shelf < 3; shelf++) {
    add('Bookshelf', 'box', [-4, 0.45 + shelf * 0.52, -3.5], [2.5, 0.06, 0.4], 'wood');
    for (let index = 0; index < 16; index++) {
      add('Cloth bound volume', 'box', [-5 + index * 0.135, 0.68 + shelf * 0.52, -3.5], [0.095, 0.4 + index % 3 * 0.025, 0.32], index % 3 ? 'wood' : 'cloth');
    }
  }
}

function createOffice(meshes, laboratory = false) {
  const builder = createBuilder(meshes);
  addRoom(builder, laboratory);
  addScientist(builder, [0, 0, -1.7], !laboratory);
  if (laboratory) {
    addScientist(builder, [2.8, 0, -1], false, -0.7);
    for (let index = 0; index < 8; index++) {
      builder.add('Vacuum amplifier housing', 'box', [-1.2 + index % 4 * 0.8, 1.09, -0.4 + Math.floor(index / 4) * 0.8], [0.54, 0.32, 0.4], 'graphite');
      builder.add('Glowing glass tube', 'cylinder', [-1.2 + index % 4 * 0.8, 1.45, -0.4 + Math.floor(index / 4) * 0.8], [0.1, 0.42, 0.1], 'amber');
    }
  } else {
    builder.add('Brass desk lamp stem', 'cylinder', [1.3, 1.25, -0.3], [0.035, 0.7, 0.035], 'copper');
    builder.add('Lamp shade', 'sphere', [1.3, 1.57, -0.3], [0.3, 0.1, 0.2], 'olive');
  }
  return builder.parts;
}

function addVehicle(builder, position) {
  const { add, beam } = builder;
  const place = point => point.map((value, axis) => value + position[axis]);
  add('Army jeep chassis', 'box', place([0, 0.54, 0]), [1.6, 0.26, 3.1], 'olive');
  add('Flat hood', 'box', place([0, 0.95, 0.9]), [1.55, 0.42, 1.2], 'olive');
  add('Rear tub', 'box', place([0, 0.87, -1.1]), [1.5, 0.48, 0.5], 'olive');
  for (const side of [-1, 1]) {
    add('Jeep body side', 'box', place([side * 0.73, 0.84, -0.5]), [0.12, 0.42, 1.55], 'olive');
    for (const depth of [-1, 1]) {
      add('Rubber road tire', 'cylinder', place([side * 0.85, 0.47, depth]), [0.42, 0.22, 0.42], 'graphite', [0, 0, HALF_PI]);
      add('Steel wheel hub', 'cylinder', place([side * 0.98, 0.47, depth]), [0.2, 0.025, 0.2], 'olive', [0, 0, HALF_PI]);
    }
    beam('Windshield pillar', place([side * 0.7, 1.05, 0.3]), place([side * 0.7, 1.9, 0.15]), 0.035, 'olive');
    add('Headlight', 'sphere', place([side * 0.53, 1.01, 1.54]), [0.14, 0.14, 0.04], 'ceramic');
  }
  beam('Windshield top rail', place([-0.7, 1.9, 0.15]), place([0.7, 1.9, 0.15]), 0.035, 'olive');
  for (let index = 0; index < 8; index++) {
    add('Radiator grille slot', 'box', place([-0.4 + index * 0.115, 0.9, 1.56]), [0.04, 0.34, 0.025], 'graphite');
  }
  add('Spare wheel', 'cylinder', place([0, 0.95, -1.54]), [0.42, 0.24, 0.42], 'graphite', [HALF_PI, 0, 0]);
  add('Driver seat', 'box', place([-0.38, 0.98, -0.55]), [0.55, 0.14, 0.65], 'cloth');
}

function createSettlement(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addDesert(builder);
  add('Unpaved main street', 'box', [0, -0.12, 0], [8, 0.045, 90], 'rock');
  for (const side of [-1, 1]) {
    for (let index = 0; index < 7; index++) {
      const horizontal = side * (12 + index % 2 * 4);
      const depth = -32 + index * 11;
      add('Research hut walls', 'box', [horizontal, 1.4, depth], [7, 2.8, 5.6], index % 3 ? 'wood' : 'plaster');
      for (const pitch of [-1, 1]) {
        add('Pitched corrugated roof', 'box', [horizontal + pitch * 1.8, 3.15, depth], [4.15, 0.11, 6.2], 'graphite', [0, 0, pitch * -0.36]);
      }
      for (const offset of [-2.2, 0, 2.2]) {
        add('Research hut window', 'box', [horizontal + offset, 1.6, depth + 2.83], [1, 0.9, 0.05], 'window');
        add('Window divider', 'box', [horizontal + offset, 1.6, depth + 2.87], [0.06, 0.95, 0.06], 'wood');
      }
      beam('Telephone pole', [side * 5.5, 0, depth], [side * 5.5, 6, depth], 0.095, 'wood');
      beam('Pole crossbar', [side * 4.5, 5.5, depth], [side * 6.5, 5.5, depth], 0.055, 'wood');
      if (index < 6) {
        beam('Telephone wire', [side * 5.1, 5.6, depth], [side * 5.1, 5.6, depth + 11], 0.012, 'graphite');
      }
    }
  }
  addVehicle(builder, [1, 0, 8]);
  addVehicle(builder, [-2, 0, -12]);
  addScientist(builder, [4, 0, 6]);
  addScientist(builder, [5.3, 0, 5.5], false, -0.8);
  return builder.parts;
}

function addGadget(builder, center = [0, 2, 0]) {
  const { add, beam } = builder;
  const place = point => point.map((value, axis) => value + center[axis]);
  add('Gadget explosive vessel', 'sphere', center, [1, 1, 1], 'graphite');
  for (let latitude = 0; latitude < 5; latitude++) {
    const elevation = -0.8 + latitude * 0.4;
    const radius = Math.sqrt(1 - elevation * elevation);
    add('Spherical seam collar', 'ring', place([0, elevation, 0]), [radius, radius, radius], 'steel', [HALF_PI, 0, 0]);
    for (let terminal = 0; terminal < 12; terminal++) {
      const angle = terminal / 12 * FULL_TURN + latitude * 0.17;
      const tip = [Math.cos(angle) * radius * 1.09, elevation * 1.09, Math.sin(angle) * radius * 1.09];
      add('Gadget electrical terminal', 'sphere', place(tip), [0.075, 0.075, 0.075], 'ceramic');
      const anchor = [Math.cos(angle) * 1.4, 1.5, Math.sin(angle) * 1.4];
      const bend = [tip[0] * 1.22, tip[1] + 0.45, tip[2] * 1.22];
      beam('Detonator cable lower', place(tip), place(bend), 0.017, 'copper');
      beam('Detonator cable upper', place(bend), place(anchor), 0.017, 'graphite');
    }
  }
  add('Suspension yoke', 'box', place([0, 1.55, 0]), [3, 0.12, 0.12], 'steel');
  beam('Gadget hoist', place([0, 1.55, 0]), place([0, 3.2, 0]), 0.04, 'steel');
}

function createGadget(meshes) {
  const builder = createBuilder(meshes);
  addRoom(builder, true);
  addGadget(builder, [0, 2.25, -1.3]);
  for (const horizontal of [-2, 2]) {
    builder.beam('Assembly gantry upright', [horizontal, 0, -1.3], [horizontal, 5.7, -1.3], 0.095);
  }
  builder.beam('Assembly gantry lintel', [-2, 5.7, -1.3], [2, 5.7, -1.3], 0.095);
  return builder.parts;
}

function createControl(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addRoom(builder, true);
  add('Detonator console', 'box', [0, 1.06, 0], [2.8, 0.38, 1.35], 'olive');
  for (let index = 0; index < 5; index++) {
    const horizontal = -1 + index * 0.5;
    add('Analog voltmeter bezel', 'ring', [horizontal, 1.266, -0.12], [0.19, 0.19, 0.19], 'steel', [HALF_PI, 0, 0]);
    add('Ivory meter face', 'cylinder', [horizontal, 1.26, -0.12], [0.177, 0.014, 0.177], 'paper');
    beam('Meter pointer', [horizontal, 1.277, -0.12], [horizontal - 0.08, 1.277, -0.02], 0.006, 'graphite');
    add('Console switch', 'cylinder', [horizontal, 1.32, 0.35], [0.035, 0.1, 0.035], 'steel');
    add('Signal pilot light', 'sphere', [horizontal, 1.29, -0.48], [0.045, 0.025, 0.045], 'amber');
  }
  add('Red firing button', 'cylinder', [0.9, 1.31, 0.38], [0.12, 0.065, 0.12], 'copper');
  addScientist(builder, [0, 0, -1.5], false);
  return builder.parts;
}

function createPortrait(meshes) {
  const builder = createBuilder(meshes);
  addDesert(builder);
  addScientist(builder);
  for (let index = 0; index < 20; index++) {
    builder.add('Out of focus fence post', 'cylinder', [-12 + index * 1.3, 0.9, -12], [0.07, 1.8, 0.07], 'wood');
  }
  return builder.parts;
}

function createSparks(meshes) {
  const builder = createBuilder(meshes);
  for (let index = 0; index < 360; index++) {
    const angle = index * 2.399963;
    const radius = 0.15 + (index % 47) / 47 * 4.7;
    const start = [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.6, Math.sin(index * 1.31) * 2];
    const end = [start[0] * 1.045, start[1] * 1.045 + 0.015, start[2] + 0.03];
    builder.beam('Incandescent particle streak', start, end, 0.008 + index % 4 * 0.002, index % 7 ? 'particle' : 'core');
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
    fogColor: [0.014, 0.018, 0.018], fogDensity: 0.018,
    skyTop: [0.024, 0.035, 0.035], skyBottom: [0.1, 0.12, 0.11],
    lightDirection: [-0.4, 0.8, 0.5], daylight: 0.85,
  };
  const interior = {
    ...studio, fogDensity: 0.008, daylight: 1.05,
    skyTop: [0.12, 0.17, 0.18], skyBottom: [0.22, 0.23, 0.18],
    lightDirection: [-0.45, 0.65, 0.8],
  };
  const desert = {
    fogColor: [0.23, 0.18, 0.12], fogDensity: 0.004,
    skyTop: [0.25, 0.36, 0.42], skyBottom: [0.62, 0.52, 0.35],
    lightDirection: [-0.65, 0.48, 0.5], daylight: 1.1,
  };
  const night = {
    fogColor: [0.004, 0.007, 0.012], fogDensity: 0.007,
    skyTop: [0.004, 0.009, 0.017], skyBottom: [0.04, 0.06, 0.08],
    lightDirection: [-0.5, 0.6, 0.5], daylight: 0.42,
  };
  const desertShadows = { extent: 55, target: [0, 6, 0], eye: [-35, 45, 35], near: 1, far: 140 };
  const set = (parts, environment, shadowBounds) => ({ parts, environment, ground: false, ...(shadowBounds ? { shadowBounds } : {}) });
  const towerParts = createDesert(meshes);
  const towerBuilder = createBuilder(meshes);
  addGadget(towerBuilder, [0, 11.3, 0]);
  towerParts.push(...towerBuilder.parts);
  return {
    apparatus: set(createApparatus(meshes), studio),
    office: set(createOffice(meshes), interior),
    laboratory: set(createOffice(meshes, true), interior),
    settlement: set(createSettlement(meshes), desert, desertShadows),
    portrait: set(createPortrait(meshes), desert, desertShadows),
    gadget: set(createGadget(meshes), interior),
    control: set(createControl(meshes), interior),
    atom: set(createAtom(meshes), { ...studio, daylight: 0.25, fogDensity: 0.035 }),
    waves: set(createWaveChamber(meshes), studio),
    sparks: set(createSparks(meshes), { ...night, daylight: 0.1 }),
    desert: set(towerParts, desert, desertShadows),
    night: set(towerParts, night, desertShadows),
    ignition: set(createIgnition(meshes), night, desertShadows),
  };
}

// Camera endpoints belong to shots; reused sets never carry playback state.
function shot(start, end, scene, eye, nextEye, target, nextTarget = target, fov = [40, 38], monochrome = 0, exposure = 0.95) {
  return { start, end, scene, eye: [eye, nextEye], target: [target, nextTarget], fov, monochrome, exposure };
}

export const FILM_SHOTS = [
  shot(0, 7, 'apparatus', [0.37, 0.73, 2.12], [0.65, 0.8, 2.5], [0, 0.5, 1.28], [0, 0.48, 1.1], [34, 36], 0.2),
  shot(7, 13, 'control', [1.8, 2.2, 2.2], [1.4, 1.9, 1.8], [0.3, 1.25, 0], [0.1, 1.25, 0], [35, 32]),
  shot(13, 20, 'apparatus', [-3.5, 1.8, 3.4], [-2.8, 1.3, 2.7], [-0.5, 0.5, 0], [0, 0.5, 0], [43, 40]),
  shot(20, 29, 'office', [1.1, 1.9, 2.3], [0.8, 1.8, 1.3], [0, 1.65, -1.7], [0, 1.72, -1.7], [35, 32]),
  shot(29, 34, 'sparks', [0, 0.3, 7], [0.6, 0.5, 6], [0, 0, 0], [0.2, 0, 0], [47, 45]),
  shot(34, 39, 'laboratory', [-3, 2.1, 3.7], [-2.5, 1.7, 2.8], [0, 1.25, 0], [0.4, 1.4, -0.5], [43, 39]),
  shot(39, 45, 'desert', [29, 6, 37], [24, 7, 30], [0, 6, 0], [0, 7, 0], [44, 40]),
  shot(45, 56, 'settlement', [0, 6.5, 46], [0.6, 4, 34], [0, 1.8, -9], [0, 1.8, -12], [48, 45]),
  shot(56, 64, 'settlement', [7, 2.5, 16], [5.5, 2.1, 12], [1, 0.8, 8], [1, 1, 8], [41, 38]),
  shot(64, 73, 'settlement', [8.4, 1.8, 11], [7.2, 1.8, 9.5], [4.6, 1.4, 5.7], [4.5, 1.6, 5.7], [36, 33]),
  shot(73, 85, 'office', [-3.2, 1.8, 3], [-2.2, 1.9, 2], [0, 1.4, -1.7], [0, 1.6, -1.7], [41, 36], 1),
  shot(85, 91, 'waves', [-3.8, 3.4, 5.3], [0.5, 2.2, 4.4], [-0.8, 0, 0], [0.8, 0.05, 0], [49, 42], 0.4),
  shot(91, 98, 'atom', [0.5, 0.3, 6.8], [4.8, 2.5, 5.1], [0, 0, 0], [0, 0, 0], [48, 43]),
  shot(98, 105, 'gadget', [2.8, 3.1, 3.2], [2.2, 2.8, 2.6], [0, 2.25, -1.3], [0, 2.4, -1.3], [36, 32]),
  shot(105, 110, 'office', [0.65, 1.85, -0.1], [0.45, 1.82, -0.4], [0, 1.8, -1.7], [0, 1.8, -1.7], [31, 28], 1),
  shot(110, 118, 'desert', [4.7, 9.1, 6.2], [3.8, 10, 4.8], [0, 11, 0], [0, 11.3, 0], [36, 31]),
  shot(118, 126, 'gadget', [-1.6, 2.9, 1.4], [-1.2, 2.7, 1], [0, 2.5, -1.3], [0.1, 2.4, -1.3], [33, 30]),
  shot(126, 133, 'laboratory', [3.6, 2.2, 3.4], [2.8, 1.8, 2.6], [1.2, 1.4, -1.1], [1, 1.6, -1.4], [40, 35]),
  shot(133, 140, 'control', [-1.5, 2.1, 1.9], [-0.8, 1.8, 1.4], [0, 1.25, 0], [0.3, 1.25, 0], [35, 32]),
  shot(140, 145, 'desert', [14, 1.5, 20], [11, 1.8, 16], [0, 8, 0], [0, 9, 0], [43, 40]),
  shot(145, 154, 'portrait', [0.55, 1.9, 3], [0.3, 1.85, 2.6], [0, 1.76, 0], [0, 1.8, 0], [30, 27]),
  shot(154, 161, 'night', [31, 4.4, 40], [27, 5, 35], [0, 7, 0], [0, 8, 0], [42, 39], 0.1, 1.05),
  shot(161, 165, 'portrait', [0.2, 1.83, 1.5], [0.1, 1.82, 1.35], [0, 1.8, 0], [0, 1.8, 0], [28, 26]),
  shot(165, 168, 'control', [1.35, 1.85, 1.65], [1.1, 1.65, 1.3], [0.8, 1.27, 0.28], [0.85, 1.27, 0.3], [32, 28]),
  shot(168, 170, 'gadget', [1.7, 2.5, 0.8], [1.5, 2.5, 0.6], [0, 2.4, -1.3], [0, 2.4, -1.3], [30, 28]),
  shot(170, 172, 'sparks', [-0.3, 0.2, 5], [0.2, 0.1, 4.6], [0, 0, 0], [0, 0, 0], [45, 43]),
  shot(172, 174, 'night', [5, 10, 7], [4.5, 10.4, 6.5], [0, 11.3, 0], [0, 11.3, 0], [35, 32]),
  shot(174, 176, 'office', [0.5, 1.83, -0.2], [0.35, 1.83, -0.4], [0, 1.8, -1.7], [0, 1.8, -1.7], [30, 28], 1),
  shot(176, 178, 'control', [-0.3, 1.9, 1.5], [0.2, 1.8, 1.35], [0, 1.26, 0], [0.1, 1.26, 0], [32, 29]),
  shot(178, 179.5, 'sparks', [0, 0, 4.5], [0.3, 0.1, 4.1], [0, 0, 0], [0, 0, 0], [44, 42]),
  shot(179.5, 181, 'night', [28, 5, 38], [26, 5.5, 36], [0, 9, 0], [0, 9, 0], [42, 40]),
  shot(181, 184, 'ignition', [28, 7, 39], [32, 9, 43], [0, 7, 0], [0, 11, 0], [48, 51], 0, 0.72),
  shot(184, 187, 'ignition', [37, 11, 49], [40, 13, 53], [0, 11, 0], [0, 12, 0], [51, 53], 0, 0.72),
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
  const shotIndex = FILM_SHOTS.findIndex(candidate => boundedTime < candidate.end);
  const selected = FILM_SHOTS[shotIndex < 0 ? FILM_SHOTS.length - 1 : shotIndex];
  const eased = smoothstep((boundedTime - selected.start) / (selected.end - selected.start));
  const camera = {
    eye: selected.eye[0].map((value, axis) => interpolate(value, selected.eye[1][axis], eased)),
    target: selected.target[0].map((value, axis) => interpolate(value, selected.target[1][axis], eased)),
    fov: interpolate(...selected.fov, eased),
  };
  const ignitionTime = boundedTime - 181;
  const flash = ignitionTime >= 0 && ignitionTime < 0.7 ? Math.exp(-ignitionTime * 7) : 0;
  const visibility = smoothstep(boundedTime / 0.8) * (1 - smoothstep((boundedTime - 185.8) / 1.2));
  const titleVisible = boundedTime >= 181;
  return {
    scene: selected.scene,
    shotIndex: shotIndex < 0 ? FILM_SHOTS.length - 1 : shotIndex,
    camera,
    exposure: selected.exposure + flash * 1.5,
    monochrome: selected.monochrome,
    fade: 1 - visibility,
    title: titleVisible ? 'OPPENHEIMER' : '',
    subtitle: titleVisible ? 'A 67.js trailer study' : '',
    time: boundedTime,
    sceneTime: boundedTime - FILM_SHOTS.find(candidate => candidate.scene === selected.scene).start,
    explosionProgress: selected.scene === 'ignition' ? smoothstep(ignitionTime / 3.6) : 0,
    flash,
    titleOpacity: titleVisible ? smoothstep((boundedTime - 181.65) / 1.15) * visibility : 0,
    effects: {
      bloom: { strength: selected.scene === 'sparks' || selected.scene === 'atom' ? 0.3 : 0.12 },
      saturation: 0.82,
      contrast: 1.08,
      temperature: selected.scene === 'night' ? -0.08 : 0.035,
      vignette: 0.22,
      grain: 0.035,
    },
  };
}
