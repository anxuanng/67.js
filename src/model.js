import { box, cylinder, sphere, torus } from './geometry.js';
import { mat4, quat } from 'gl-matrix';

const HALF_TURN = Math.PI;
const QUARTER_TURN = Math.PI / 2;

const materials = {
  armor: { tag: 'armor', color: [0.53, 0.39, 0.24], metallic: 0.88, roughness: 0.32, emission: 0 },
  pale: { tag: 'satin', color: [0.61, 0.6, 0.52], metallic: 0.78, roughness: 0.25, emission: 0 },
  dark: { tag: 'graphite', color: [0.032, 0.045, 0.047], metallic: 0.76, roughness: 0.29, emission: 0 },
  rubber: { tag: 'rubber', color: [0.012, 0.018, 0.02], metallic: 0.08, roughness: 0.66, emission: 0 },
  steel: { tag: 'steel', color: [0.43, 0.48, 0.47], metallic: 0.96, roughness: 0.22, emission: 0 },
  copper: { tag: 'copper', color: [0.52, 0.19, 0.075], metallic: 0.9, roughness: 0.31, emission: 0 },
  mint: { tag: 'light', color: [0.16, 0.8, 0.61], metallic: 0.15, roughness: 0.18, emission: 2.6 },
  lens: { tag: 'lens', color: [0.018, 0.16, 0.13], metallic: 0.68, roughness: 0.12, emission: 0.15 },
  amber: { tag: 'indicator', color: [1, 0.29, 0.035], metallic: 0.1, roughness: 0.3, emission: 2 },
};

function transform(position, scale, rotation) {
  const degrees = rotation.map(angle => angle * 180 / Math.PI);
  const orientation = quat.fromEuler(quat.create(), ...degrees);
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

export function createModel() {
  const parts = [];
  const meshes = {
    plate: box(0.08, 3),
    shell: box(0.18, 8),
    sphere: sphere(),
    cylinder: cylinder(),
    bolt: cylinder(6),
    ring: torus(0.045),
    heavyRing: torus(0.105),
    fineRing: torus(0.022),
    brow: torus(0.09, 80, 24, HALF_TURN * 0.84, HALF_TURN * 0.08),
  };
  function add(name, mesh, position, scale, material = 'armor', rotation = [0, 0, 0]) {
    parts.push({ name, geometry: meshes[mesh], matrix: transform(position, scale, rotation), material: materials[material] });
  }
  function plate(name, position, scale, material = 'armor', rotation = [0, 0, 0]) {
    add(name, 'plate', position, scale, material, rotation);
  }
  function ring(name, position, radius, material = 'steel', thickness = 'ring', depth = 1) {
    add(name, thickness, position, [radius, radius, radius * depth], material);
  }
  function barrel(name, position, radius, length, material = 'dark') {
    add(name, 'cylinder', position, [radius, length, radius], material, [QUARTER_TURN, 0, 0]);
  }
  function bolt(name, position, radius = 0.036, rotation = [QUARTER_TURN, 0, 0]) {
    add(name, 'bolt', position, [radius, 0.024, radius], 'steel', rotation);
  }
  function cable(name, points, radius, material = 'rubber') {
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index];
      const end = points[index + 1];
      const delta = end.map((value, axis) => value - start[axis]);
      const length = Math.hypot(...delta);
      const pitch = Math.acos(delta[1] / length);
      const yaw = Math.atan2(delta[0], delta[2]);
      const center = start.map((value, axis) => (value + end[axis]) / 2);
      add(`${name} / ${index}`, 'cylinder', center, [radius, length, radius], material, [pitch, yaw, 0]);
      add(`${name} joint / ${index}`, 'sphere', start, [radius, radius, radius], material);
    }
  }

  // A low machined plinth and exposed gimbal make the head read as a laboratory instrument.
  add('Machined display base', 'cylinder', [0, 0.11, 0], [0.97, 0.18, 0.75], 'dark');
  add('Titanium base lip', 'cylinder', [0, 0.205, 0], [0.92, 0.035, 0.7], 'armor');
  plate('Base inset', [0, 0.233, 0], [1.12, 0.035, 0.74], 'rubber');
  for (const side of [-1, 1]) {
    plate('Mount foot', [side * 0.58, 0.29, 0], [0.27, 0.1, 0.43], 'steel');
    bolt('Base fastener', [side * 0.64, 0.352, 0.12], 0.045, [0, 0, 0]);
    bolt('Base fastener', [side * 0.64, 0.352, -0.12], 0.045, [0, 0, 0]);
    plate('Gimbal support', [side * 0.48, 0.6, -0.04], [0.16, 0.65, 0.24], 'armor', [0, 0, side * -0.12]);
    add('Pivot bearing', 'cylinder', [side * 0.49, 0.86, -0.04], [0.18, 0.19, 0.18], 'steel', [0, 0, QUARTER_TURN]);
  }
  add('Neck spine', 'cylinder', [0, 0.94, -0.12], [0.27, 0.74, 0.27], 'dark');
  for (let index = 0; index < 7; index++) {
    add('Neck compression collar', 'cylinder', [0, 0.66 + index * 0.074, -0.12], [0.29, 0.033, 0.29], index % 2 ? 'steel' : 'dark');
  }
  add('Lower jaw chassis', 'shell', [0, 1.19, 0.035], [1.24, 0.24, 0.75], 'dark');
  add('Lower jaw armor', 'shell', [0, 1.22, 0.49], [1.09, 0.16, 0.17], 'armor');
  plate('Jaw inset panel', [0, 1.225, 0.58], [0.66, 0.065, 0.035], 'rubber');
  for (let index = 0; index < 9; index++) {
    plate('Jaw grille', [-0.28 + index * 0.07, 1.225, 0.607], [0.025, 0.055, 0.012], 'steel');
  }

  add('Inner pressure vessel', 'sphere', [0, 1.83, -0.03], [0.82, 0.73, 0.61], 'dark');
  add('Rear controller enclosure', 'shell', [0, 1.86, -0.51], [0.96, 1.02, 0.3], 'dark');
  add('Rear service hatch', 'shell', [0, 1.86, -0.685], [0.72, 0.8, 0.045], 'armor');
  for (const side of [-1, 1]) {
    add('Cheek armor', 'shell', [side * 0.71, 1.69, 0.27], [0.24, 0.79, 0.6], 'armor', [0, side * 0.18, side * -0.16]);
    add('Temple sculpted cap', 'sphere', [side * 0.62, 2.25, -0.035], [0.26, 0.22, 0.49], 'pale');
    add('Temporal bearing body', 'cylinder', [side * 0.79, 1.93, -0.1], [0.34, 0.19, 0.34], 'dark', [0, 0, QUARTER_TURN]);
    add('Temporal bearing retaining ring', 'ring', [side * 0.905, 1.93, -0.1], [0.29, 0.29, 0.29], 'armor', [0, QUARTER_TURN, 0]);
    add('Temporal silver locking ring', 'fineRing', [side * 0.916, 1.93, -0.1], [0.235, 0.235, 0.235], 'steel', [0, QUARTER_TURN, 0]);
    add('Temporal bearing cover', 'cylinder', [side * 0.902, 1.93, -0.1], [0.205, 0.042, 0.205], 'dark', [0, 0, QUARTER_TURN]);
    for (let index = 0; index < 6; index++) {
      const angle = index / 6 * Math.PI * 2;
      bolt('Temporal bearing fastener', [side * 0.925, 1.93 + Math.cos(angle) * 0.26, -0.1 + Math.sin(angle) * 0.26], 0.019, [0, 0, QUARTER_TURN]);
    }
    add('Cheek inset', 'shell', [side * 0.836, 1.61, 0.19], [0.035, 0.35, 0.36], 'rubber');
    for (let index = 0; index < 8; index++) {
      plate('Side cooling lamella', [side * 0.865, 1.42 + index * 0.048, 0.17], [0.074, 0.018, 0.34], 'steel', [0, 0.1 * side, 0]);
    }
    for (const height of [1.39, 2.08]) {
      bolt('Cheek face fastener', [side * 0.72, height, 0.578]);
    }
    // A copper conduit loops behind each cheek with a graphite strain relief at the neck.
    const cablePoints = [];
    for (let index = 0; index <= 18; index++) {
      const fraction = index / 18;
      cablePoints.push([side * (0.22 + Math.sin(fraction * Math.PI) * 0.47), 0.82 + fraction * 0.81, -0.32 - Math.sin(fraction * Math.PI) * 0.42]);
    }
    cable('Rear power conduit', cablePoints, 0.044, 'copper');
    const ribPoints = cablePoints.filter((point, index) => index % 3 === 0);
    ribPoints.forEach((point, index) => add(`Conduit ferrule ${index}`, 'sphere', point, [0.065, 0.048, 0.065], 'dark'));
  }

  // Nested lens rings carry the focal point; the pupil remains dark inside a luminous annulus.
  barrel('Optic pressure housing', [0, 1.87, 0.5], 0.645, 0.34);
  for (let index = 0; index < 4; index++) {
    ring('Optic barrel machining groove', [0, 1.87, 0.48 + index * 0.053], 0.641, 'steel', 'fineRing', 0.45);
  }
  for (let index = 0; index < 48; index++) {
    const angle = index / 48 * Math.PI * 2;
    plate('Focus grip flute', [Math.cos(angle) * 0.642, 1.87 + Math.sin(angle) * 0.642, 0.576], [0.015, 0.026, 0.135], 'dark', [0, 0, angle]);
  }
  barrel('Optic machined bezel', [0, 1.87, 0.695], 0.61, 0.14, 'armor');
  ring('Bezel raised rim', [0, 1.87, 0.77], 0.56, 'pale', 'heavyRing', 0.48);
  barrel('Optic inner recess', [0, 1.87, 0.772], 0.51, 0.05, 'rubber');
  ring('Optic steel retaining ring', [0, 1.87, 0.813], 0.472, 'steel');
  ring('Optic mint light guide', [0, 1.87, 0.838], 0.403, 'mint', 'ring', 0.6);
  ring('Light guide inner lip', [0, 1.87, 0.857], 0.366, 'dark', 'fineRing');
  add('Optical glass dome', 'sphere', [0, 1.87, 0.854], [0.354, 0.354, 0.072], 'lens');
  barrel('Pupil', [0, 1.87, 0.923], 0.142, 0.012, 'rubber');
  ring('Pupil silver rim', [0, 1.87, 0.929], 0.147, 'steel', 'fineRing');
  ring('Pupil illuminated reticle', [0, 1.87, 0.94], 0.104, 'mint', 'fineRing', 0.4);
  for (let index = 0; index < 32; index++) {
    const angle = index / 32 * Math.PI * 2;
    const radius = 0.53;
    plate('Bezel calibration tick', [Math.cos(angle) * radius, 1.87 + Math.sin(angle) * radius, 0.837], [index % 4 === 0 ? 0.055 : 0.027, 0.009, 0.012], 'dark', [0, 0, angle]);
    if (index % 4 === 0) {
      bolt('Optic bezel fastener', [Math.cos(angle) * 0.591, 1.87 + Math.sin(angle) * 0.591, 0.805], 0.022);
    }
  }
  for (let index = 0; index < 12; index++) {
    const angle = index / 12 * Math.PI * 2;
    plate('Iris radial segment', [Math.cos(angle) * 0.26, 1.87 + Math.sin(angle) * 0.26, 0.906], [0.128, 0.033, 0.008], 'dark', [0, 0, angle + 0.7]);
  }
  add('Interrupted armored brow', 'brow', [0, 1.88, 0.46], [0.77, 0.72, 0.75], 'armor');
  add('Crown sculpted shell', 'sphere', [0, 2.38, -0.03], [0.64, 0.22, 0.53], 'pale');
  add('Crown bridge', 'shell', [0, 2.525, -0.055], [0.65, 0.095, 0.63], 'armor', [-0.075, 0, 0]);
  for (let index = -2; index <= 2; index++) {
    plate('Crown graphite seam', [index * 0.11, 2.576, -0.05], [0.011, 0.01, 0.42], 'dark');
  }
  for (const side of [-1, 1]) {
    plate('Brow hinge', [side * 0.56, 2.37, 0.48], [0.21, 0.1, 0.22], 'steel', [0, 0, side * -0.45]);
    bolt('Brow hinge bolt', [side * 0.55, 2.37, 0.602], 0.042);
  }

  // Offset rangefinder and copper aerial break the symmetry without competing with the lens.
  add('Rangefinder mounting wing', 'shell', [0.94, 2.12, 0.13], [0.32, 0.29, 0.47], 'dark');
  barrel('Rangefinder brass body', [1.03, 2.13, 0.44], 0.175, 0.26, 'armor');
  ring('Rangefinder ring', [1.03, 2.13, 0.585], 0.142, 'steel', 'heavyRing', 0.55);
  barrel('Rangefinder glass', [1.03, 2.13, 0.592], 0.117, 0.026, 'lens');
  ring('Rangefinder illuminated rim', [1.03, 2.13, 0.613], 0.102, 'mint', 'fineRing');
  plate('Serial badge plate', [-0.7, 1.62, 0.571], [0.19, 0.17, 0.025], 'pale');
  for (let index = 0; index < 7; index++) {
    plate('Serial badge engraving', [-0.755 + index * 0.018, 1.62, 0.588], [0.006, index % 2 ? 0.075 : 0.105, 0.006], 'dark');
  }
  for (let index = 0; index < 3; index++) {
    barrel('Status LED', [0.61, 1.37 + index * 0.074, 0.617], 0.022, 0.016, index === 2 ? 'amber' : 'mint');
  }
  add('Aerial socket', 'cylinder', [-0.48, 2.54, -0.25], [0.1, 0.16, 0.1], 'dark');
  add('Copper aerial', 'cylinder', [-0.5, 2.75, -0.25], [0.019, 0.34, 0.019], 'copper', [0, 0, 0.1]);
  add('Aerial terminal', 'sphere', [-0.517, 2.921, -0.25], [0.043, 0.043, 0.043], 'dark');
  for (let index = 0; index < 7; index++) {
    plate('Rear heat spreader', [0, 1.6 + index * 0.085, -0.727], [0.59, 0.026, 0.105], 'steel');
  }
  for (const horizontal of [-0.29, 0.29]) {
    for (const height of [1.54, 2.18]) {
      bolt('Service hatch fastener', [horizontal, height, -0.721]);
    }
  }
  return parts;
}
