import { box, cylinder, sphere, torus } from './geometry.js';
import { mat4, quat } from 'gl-matrix';
import { addDetailOffsets } from './assembly.js';

const QUARTER_TURN = Math.PI / 2;
const materials = {
  armor: { tag: 'armor', weathered: true, color: [0.73, 0.43, 0.065], metallic: 0.62, roughness: 0.43, emission: 0 },
  steel: { tag: 'steel', color: [0.34, 0.37, 0.36], metallic: 0.88, roughness: 0.3, emission: 0 },
  silver: { tag: 'silver', color: [0.59, 0.61, 0.59], metallic: 0.85, roughness: 0.24, emission: 0 },
  dark: { tag: 'dark', color: [0.035, 0.042, 0.041], metallic: 0.65, roughness: 0.38, emission: 0 },
  rubber: { tag: 'rubber', color: [0.019, 0.022, 0.02], metallic: 0.05, roughness: 0.74, emission: 0 },
  lens: { tag: 'lens', color: [0.009, 0.025, 0.036], metallic: 0.8, roughness: 0.1, emission: 0 },
  copper: { tag: 'copper', color: [0.51, 0.19, 0.065], metallic: 0.9, roughness: 0.3, emission: 0 },
  board: { tag: 'board', color: [0.025, 0.15, 0.078], metallic: 0.15, roughness: 0.5, emission: 0 },
  red: { tag: 'red', color: [0.43, 0.045, 0.025], metallic: 0.2, roughness: 0.46, emission: 0 },
  light: { tag: 'light', color: [0.18, 0.55, 0.32], metallic: 0.1, roughness: 0.32, emission: 0.5 },
};

function transform(position, scale, rotation) {
  const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

export function createModel() {
  const parts = [];
  const meshes = {
    plate: box(0.07, 3),
    shell: box(0.15, 7),
    sphere: sphere(),
    cylinder: cylinder(),
    bolt: cylinder(6),
    ring: torus(0.045),
    fineRing: torus(0.025),
  };
  function group(layer, section, offset) {
    return { layer, section, offset };
  }
  const frame = group('interior', 'Structural frame', [0, 0, 0]);
  const battery = group('interior', 'Battery cassette', [0, -0.08, 0.22]);
  const electronics = group('interior', 'Control electronics', [0, 0.1, 0.3]);
  const drive = group('interior', 'Differential drive', [0, -0.04, -0.16]);
  const front = group('exterior', 'Front compactor panel', [0, 0, 1.7]);
  const rear = group('exterior', 'Rear service panel', [0, 0, -1.4]);
  const roof = group('exterior', 'Roof panel', [0, 1.35, 0]);
  const neck = group('interior', 'Neck linkage', [0, 0.2, 0]);
  function add(name, mesh, position, scale, material, assembly, rotation = [0, 0, 0]) {
    parts.push({ name, geometry: meshes[mesh], matrix: transform(position, scale, rotation), material: materials[material], assembly });
  }
  function plate(name, position, scale, material, assembly, rotation = [0, 0, 0]) {
    add(name, 'plate', position, scale, material, assembly, rotation);
  }
  function barrel(name, position, radius, length, material, assembly, axis = 'z') {
    const rotation = axis === 'x' ? [0, 0, QUARTER_TURN] : axis === 'z' ? [QUARTER_TURN, 0, 0] : [0, 0, 0];
    add(name, 'cylinder', position, [radius, length, radius], material, assembly, rotation);
  }
  function ring(name, position, radius, material, assembly, axis = 'z', fine = false) {
    add(name, fine ? 'fineRing' : 'ring', position, [radius, radius, radius], material, assembly, axis === 'x' ? [0, QUARTER_TURN, 0] : [0, 0, 0]);
  }
  function bolt(name, position, assembly, axis = 'z', radius = 0.025) {
    add(name, 'bolt', position, [radius, 0.018, radius], 'silver', assembly, axis === 'x' ? [0, 0, QUARTER_TURN] : axis === 'y' ? [0, 0, 0] : [QUARTER_TURN, 0, 0]);
  }
  function rod(name, start, end, radius, material, assembly) {
    const delta = end.map((value, axis) => value - start[axis]);
    const length = Math.hypot(...delta);
    const center = start.map((value, axis) => (value + end[axis]) / 2);
    add(name, 'cylinder', center, [radius, length, radius], material, assembly, [Math.acos(delta[1] / length), Math.atan2(delta[0], delta[2]), 0]);
  }
  function wire(name, points, radius, material, assembly) {
    points.forEach((point, index) => {
      add(`${name} bend`, 'sphere', point, [radius, radius, radius], material, assembly);
      if (index > 0) rod(name, points[index - 1], point, radius, material, assembly);
    });
  }

  // Thin removable sheet-metal panels surround an actual chassis, rather than a solid body block.
  plate('Chassis floor', [0, 0.72, 0], [1.43, 0.09, 0.98], 'steel', frame);
  plate('Compactor front yellow panel', [0, 1.255, 0.536], [1.42, 1.04, 0.075], 'armor', front);
  plate('Front raised door', [0, 1.21, 0.589], [1.17, 0.73, 0.042], 'armor', front);
  plate('Front upper dark control strip', [0, 1.68, 0.592], [1.22, 0.15, 0.033], 'dark', front);
  plate('Solar charge gauge inset', [-0.34, 1.68, 0.614], [0.37, 0.085, 0.015], 'rubber', front);
  for (let index = 0; index < 5; index++) {
    plate('Charge gauge bar', [-0.48 + index * 0.068, 1.68, 0.628], [0.037, 0.04, 0.009], index < 3 ? 'light' : 'steel', front);
  }
  barrel('Red power switch', [0.39, 1.68, 0.628], 0.036, 0.018, 'red', front);
  plate('Front horizontal door recess', [0, 1.06, 0.616], [0.97, 0.018, 0.006], 'dark', front);
  plate('Identification badge', [-0.27, 1.39, 0.621], [0.52, 0.16, 0.014], 'steel', front);
  for (const [horizontal, roll] of [[-0.465, 0.22], [-0.399, -0.22], [-0.333, 0.22], [-0.267, -0.22]]) {
    plate('Badge W stroke', [horizontal, 1.39, 0.633], [0.014, 0.084, 0.009], 'dark', front, [0, 0, roll]);
  }
  plate('Badge separator', [-0.207, 1.39, 0.633], [0.032, 0.009, 0.009], 'dark', front);
  plate('Badge E stem', [-0.16, 1.39, 0.633], [0.012, 0.082, 0.009], 'dark', front);
  for (const height of [1.355, 1.39, 1.425]) {
    plate('Badge E stroke', [-0.135, height, 0.633], [0.06, 0.012, 0.009], 'dark', front);
  }
  plate('Rear yellow service panel', [0, 1.255, -0.536], [1.42, 1.04, 0.075], 'armor', rear);
  plate('Rear cooling recess', [0, 1.34, -0.584], [0.86, 0.43, 0.018], 'dark', rear);
  for (let index = 0; index < 8; index++) {
    plate('Rear cooling grille', [0, 1.17 + index * 0.048, -0.6], [0.75, 0.018, 0.017], 'steel', rear);
  }
  plate('Top yellow shell', [0, 1.802, 0], [1.43, 0.085, 1.04], 'armor', roof);
  plate('Roof solar access inset', [0.31, 1.85, -0.06], [0.48, 0.022, 0.56], 'dark', roof);
  for (let index = 0; index < 5; index++) {
    plate('Roof access rib', [0.12 + index * 0.095, 1.868, -0.06], [0.022, 0.016, 0.46], 'steel', roof);
  }
  for (const side of [-1, 1]) {
    const sidePanel = group('exterior', side < 0 ? 'Left body panel' : 'Right body panel', [side * 1.15, 0.15, 0]);
    plate('Yellow side shell', [side * 0.735, 1.255, 0], [0.065, 1.04, 1.04], 'armor', sidePanel);
    plate('Side embossed service inset', [side * 0.775, 1.14, -0.08], [0.021, 0.4, 0.61], 'steel', sidePanel);
    for (const height of [0.83, 1.69]) {
      for (const depth of [-0.43, 0.43]) {
        bolt('Side shell screw', [side * 0.785, height, depth], sidePanel, 'x');
      }
    }
    for (const depth of [-0.43, 0.43]) {
      plate('Internal frame upright', [side * 0.62, 1.25, depth], [0.065, 0.99, 0.065], 'steel', frame);
      bolt('Frame fastener', [side * 0.62, 1.68, depth + 0.04], frame);
    }
    plate('Chassis upper longitudinal rail', [side * 0.62, 1.72, 0], [0.07, 0.07, 0.91], 'silver', frame);
  }
  for (const depth of [-0.43, 0.43]) {
    plate('Chassis crossmember', [0, 1.72, depth], [1.27, 0.07, 0.07], 'steel', frame);
  }
  for (const horizontal of [-0.6, 0.6]) {
    for (const height of [0.83, 1.67]) {
      bolt('Front panel fastener', [horizontal, height, 0.623], front);
    }
  }

  // Battery, drivetrain and controller occupy separate interior shelves.
  plate('Battery retaining tray', [0, 0.9, 0.14], [1.03, 0.045, 0.57], 'dark', battery);
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 6; column++) {
      const horizontal = -0.43 + column * 0.17;
      const depth = -0.005 + row * 0.27;
      barrel('Battery cylindrical cell', [horizontal, 1.05, depth], 0.07, 0.27, 'copper', battery, 'y');
      barrel('Battery terminal', [horizontal, 1.194, depth], 0.04, 0.016, 'silver', battery, 'y');
      plate('Cell nickel bridge', [horizontal + 0.065, 1.205, depth], [0.12, 0.009, 0.022], 'silver', battery);
    }
  }
  plate('Battery restraint', [0, 1.14, 0.13], [1.05, 0.07, 0.032], 'dark', battery);
  plate('Main controller circuit board', [0, 1.46, 0.09], [1.06, 0.034, 0.69], 'board', electronics);
  plate('Processor package', [-0.14, 1.495, 0.04], [0.24, 0.025, 0.23], 'dark', electronics);
  for (let index = 0; index < 7; index++) {
    plate('Processor cooling fin', [-0.23 + index * 0.031, 1.54, 0.04], [0.014, 0.085, 0.22], 'silver', electronics);
  }
  for (let index = 0; index < 5; index++) {
    barrel('Controller capacitor', [0.23 + (index % 2) * 0.13, 1.537, -0.17 + Math.floor(index / 2) * 0.13], 0.039, 0.11, 'dark', electronics, 'y');
    plate('Board gold trace', [-0.39 + index * 0.18, 1.483, 0.27], [0.085, 0.005, 0.009], 'copper', electronics);
    plate('Board connector', [-0.37 + index * 0.17, 1.51, -0.21], [0.11, 0.055, 0.065], 'rubber', electronics);
  }
  for (let index = 0; index < 8; index++) {
    plate('Memory chip', [-0.43 + (index % 4) * 0.11, 1.488, 0.16 + Math.floor(index / 4) * 0.1], [0.075, 0.015, 0.045], 'dark', electronics);
  }
  barrel('Compactor main motor', [0, 1.1, -0.31], 0.17, 0.59, 'steel', drive, 'x');
  for (let index = 0; index < 7; index++) {
    ring('Motor cooling collar', [-0.21 + index * 0.07, 1.1, -0.31], 0.168, 'dark', drive, 'x', true);
  }
  barrel('Differential shaft', [0, 0.68, -0.04], 0.075, 1.69, 'silver', drive, 'x');
  barrel('Differential gearbox', [0, 0.7, -0.04], 0.19, 0.34, 'dark', drive, 'x');
  for (const side of [-1, 1]) {
    barrel('Drive transmission gear', [side * 0.37, 0.82, -0.24], 0.15, 0.075, 'copper', drive, 'x');
    for (let index = 0; index < 18; index++) {
      const angle = index / 18 * Math.PI * 2;
      plate('Transmission gear tooth', [side * 0.37, 0.82 + Math.sin(angle) * 0.151, -0.24 + Math.cos(angle) * 0.151], [0.08, 0.036, 0.027], 'steel', drive, [angle, 0, 0]);
    }
    const points = [];
    for (let index = 0; index < 12; index++) {
      const fraction = index / 11;
      points.push([side * (0.44 + 0.025 * Math.sin(fraction * Math.PI)), 1.12 + fraction * 0.47, -0.15 + Math.sin(fraction * Math.PI) * 0.2]);
    }
    wire('Interior harness copper lead', points, 0.012, 'copper', electronics);
    wire('Interior harness red lead', points.map(point => [point[0] + side * 0.028, point[1], point[2]]), 0.011, 'red', electronics);
  }

  // Continuous polygonal caterpillar loops carry separate steel shoes and rubber traction ribs.
  const trackOutline = [[0.095, -0.59], [0.095, 0.6], [0.32, 0.73], [0.66, 0.48], [0.7, -0.37], [0.38, -0.73]];
  for (const side of [-1, 1]) {
    const tracks = group('exterior', side < 0 ? 'Left track assembly' : 'Right track assembly', [side * 1.7, 0, 0]);
    const arm = group('exterior', side < 0 ? 'Left arm and claw' : 'Right arm and claw', [side * 1.8, 0.3, 0.25]);
    for (let edge = 0; edge < trackOutline.length; edge++) {
      const start = trackOutline[edge];
      const end = trackOutline[(edge + 1) % trackOutline.length];
      const heightDelta = end[0] - start[0];
      const depthDelta = end[1] - start[1];
      const count = Math.ceil(Math.hypot(heightDelta, depthDelta) / 0.115);
      const rotation = [-Math.atan2(heightDelta, depthDelta), 0, 0];
      for (let index = 0; index < count; index++) {
        const fraction = (index + 0.5) / count;
        const position = [side * 0.99, start[0] + heightDelta * fraction, start[1] + depthDelta * fraction];
        plate('Caterpillar steel shoe', position, [0.39, 0.065, 0.111], 'steel', tracks, rotation);
        plate('Caterpillar rubber traction pad', position, [0.41, 0.087, 0.075], 'rubber', tracks, rotation);
      }
    }
    for (const [height, depth, radius] of [[0.36, -0.43, 0.255], [0.41, 0.43, 0.275], [0.3, 0, 0.19]]) {
      barrel('Track sprocket drum', [side * 0.99, height, depth], radius, 0.31, 'dark', tracks, 'x');
      barrel('Track exposed wheel disc', [side * 1.165, height, depth], radius * 0.79, 0.035, 'steel', tracks, 'x');
      ring('Track wheel rim', [side * 1.19, height, depth], radius * 0.77, 'silver', tracks, 'x');
      barrel('Track wheel hub', [side * 1.205, height, depth], radius * 0.27, 0.038, 'dark', tracks, 'x');
      bolt('Track hub retaining bolt', [side * 1.232, height, depth], tracks, 'x', 0.032);
      for (let index = 0; index < 6; index++) {
        const angle = index / 6 * Math.PI * 2;
        bolt('Track wheel bolt', [side * 1.193, height + Math.sin(angle) * radius * 0.54, depth + Math.cos(angle) * radius * 0.54], tracks, 'x', 0.013);
      }
    }
    plate('Track tension beam', [side * 1.185, 0.43, 0], [0.038, 0.075, 0.66], 'armor', tracks);
    barrel('Shoulder pivot', [side * 0.8, 1.55, 0.07], 0.125, 0.18, 'dark', arm, 'x');
    plate('Upper arm yellow housing', [side * 0.935, 1.425, 0.14], [0.14, 0.4, 0.22], 'armor', arm, [0.1, 0, side * 0.31]);
    plate('Arm exposed piston rail', [side * 0.94, 1.34, 0.265], [0.08, 0.36, 0.038], 'silver', arm, [0.1, 0, side * 0.31]);
    barrel('Elbow bearing', [side * 1.015, 1.25, 0.22], 0.095, 0.16, 'steel', arm, 'x');
    plate('Forearm steel linkage', [side * 1.075, 1.17, 0.39], [0.13, 0.13, 0.39], 'steel', arm, [-0.28, side * -0.13, 0]);
    plate('Forearm yellow cuff', [side * 1.075, 1.175, 0.35], [0.16, 0.17, 0.2], 'armor', arm);
    plate('Claw palm', [side * 1.065, 1.13, 0.605], [0.29, 0.105, 0.25], 'silver', arm);
    for (const finger of [-1, 1]) {
      plate('Claw finger root', [side * 1.065 + finger * 0.09, 1.13, 0.775], [0.073, 0.1, 0.2], 'steel', arm);
      plate('Claw curved fingertip', [side * 1.065 + finger * 0.083, 1.095, 0.886], [0.08, 0.15, 0.064], 'silver', arm, [0.25, 0, finger * -0.08]);
      bolt('Claw finger rivet', [side * 1.065 + finger * 0.09, 1.186, 0.77], arm, 'y', 0.016);
    }
    bolt('Elbow pivot screw', [side * 1.108, 1.25, 0.22], arm, 'x', 0.033);
  }

  // Tilted binocular housings and a bent hydraulic neck establish the character's expression.
  barrel('Neck yaw bearing', [0, 1.86, -0.04], 0.17, 0.14, 'dark', neck, 'y');
  plate('Neck lower yellow hinge', [0, 2.02, -0.12], [0.25, 0.27, 0.24], 'armor', neck, [-0.22, 0, 0]);
  rod('Neck articulated spine', [0, 2.05, -0.11], [0, 2.36, 0.14], 0.065, 'steel', neck);
  for (const side of [-1, 1]) {
    rod('Neck hydraulic piston', [side * 0.11, 1.91, -0.05], [side * 0.11, 2.34, 0.13], 0.034, 'silver', neck);
  }
  barrel('Head tilt axle', [0, 2.38, 0.12], 0.095, 0.66, 'dark', neck, 'x');
  plate('Binocular central bridge', [0, 2.57, 0.13], [0.28, 0.12, 0.2], 'steel', neck);
  for (const side of [-1, 1]) {
    const headShell = group('exterior', side < 0 ? 'Left eye housing' : 'Right eye housing', [side * 0.52, 0.82, -0.12]);
    const headCore = group('interior', side < 0 ? 'Left optical mechanism' : 'Right optical mechanism', [side * 0.14, 0.3, 0.12]);
    const lens = group('exterior', side < 0 ? 'Left lens assembly' : 'Right lens assembly', [side * 0.52, 0.82, 1.03]);
    const horizontal = side * 0.39;
    const roll = side * -0.16;
    add('Binocular rear rounded housing', 'shell', [horizontal, 2.575, 0.095], [0.72, 0.48, 0.46], 'steel', headShell, [0, 0, roll]);
    add('Binocular upper silver brow', 'shell', [horizontal, 2.787, 0.263], [0.69, 0.085, 0.13], 'silver', headShell, [0, 0, roll]);
    add('Binocular lower rim', 'shell', [horizontal, 2.359, 0.265], [0.6, 0.06, 0.12], 'dark', headShell, [0, 0, roll]);
    barrel('Eye optical chassis', [horizontal, 2.56, 0.24], 0.232, 0.22, 'dark', headCore);
    ring('Eye focusing actuator', [horizontal, 2.56, 0.32], 0.202, 'copper', headCore);
    plate('Eye sensor circuit board', [horizontal, 2.56, 0.095], [0.29, 0.28, 0.027], 'board', headCore, [0, 0, roll]);
    barrel('Eye lens retaining barrel', [horizontal, 2.56, 0.37], 0.247, 0.1, 'dark', lens);
    ring('Eye outer silver rim', [horizontal, 2.56, 0.429], 0.229, 'silver', lens);
    add('Eye dark glass', 'sphere', [horizontal, 2.56, 0.429], [0.213, 0.213, 0.045], 'lens', lens);
    barrel('Eye central pupil', [horizontal, 2.56, 0.473], 0.09, 0.012, 'rubber', lens);
    ring('Eye concentric glass reflection ring', [horizontal, 2.56, 0.477], 0.136, 'dark', lens, 'z', true);
    for (let index = 0; index < 8; index++) {
      const angle = index / 8 * Math.PI * 2;
      plate('Eye iris blade', [horizontal + Math.cos(angle) * 0.162, 2.56 + Math.sin(angle) * 0.162, 0.463], [0.06, 0.011, 0.006], 'steel', lens, [0, 0, angle + 0.45]);
    }
    for (const depth of [0.23, 0.28, 0.33]) {
      ring('Eye internal focus collar', [horizontal, 2.56, depth], 0.184, 'steel', headCore, 'z', true);
    }
    for (const shift of [-0.25, 0.25]) {
      bolt('Binocular housing fastener', [horizontal + shift, 2.55 + shift * roll, 0.336], headShell, 'z', 0.018);
    }
    wire('Head sensor lead', [[horizontal, 2.44, 0.02], [horizontal * 0.8, 2.37, 0.02], [horizontal * 0.35, 2.33, 0.05]], 0.015, 'copper', headCore);
  }
  return addDetailOffsets(parts);
}
