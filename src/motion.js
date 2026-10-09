import { mat4, quat } from 'gl-matrix';
import { box, cylinder, sphere, torus } from './geometry.js';
import { createAnimationClip, createAnimationPlayer, sampleAnimationClip } from './animation.js';

export const MOTION_DURATION = 12;

function rotation(axis, angle) {
  return Array.from(quat.setAxisAngle(quat.create(), axis, angle));
}

function transform(position, scale, angles = [0, 0, 0]) {
  return mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), ...angles), position, scale);
}

function surface(color, metallic, roughness, emission = 0) {
  return { tag: emission ? 'light' : 'mechanism', color, metallic, roughness, emission };
}

function cameraClip(start, end, fov) {
  return createAnimationClip({ duration: 4, tracks: [
    { target: 'eye', property: 'translation', interpolation: 'SMOOTH', keyframes: [{ time: 0, value: start }, { time: 4, value: end }] },
    { target: 'fov', property: 'value', keyframes: [{ time: 0, value: fov }] },
  ] });
}

/** One geometry graph and one bound player serve every frame and aspect ratio. */
export function createMotionScene() {
  const parts = [];
  const tracks = [];
  const meshes = { ring: torus(0.045, 64, 10), collar: cylinder(32), plate: box(0.07, 4), bead: sphere(20, 12), bolt: cylinder(8) };
  const gold = surface([0.52, 0.29, 0.075], 0.87, 0.28);
  const dark = surface([0.018, 0.029, 0.033], 0.72, 0.36);
  const steel = surface([0.32, 0.4, 0.43], 0.93, 0.23);
  const glow = surface([0.035, 0.58, 0.37], 0.14, 0.26, 3.2);
  const amber = surface([0.74, 0.16, 0.025], 0.1, 0.3, 1.7);

  function add(name, mesh, position, scale, material, angles) {
    parts.push({ name, geometry: meshes[mesh], matrix: transform(position, scale, angles), material });
    return name;
  }
  function spin(name, axis, turns = 1, duration = MOTION_DURATION) {
    tracks.push({ target: name, property: 'rotation', keyframes: Array.from({ length: 9 }, (_, index) => ({ time: duration * index / 8, value: rotation(axis, index / 8 * Math.PI * 2 * turns) })) });
  }

  add('Reactor housing', 'collar', [0, 0, 0], [0.64, 1.15, 0.64], dark);
  for (let layer = 0; layer < 5; layer++) {
    const height = -0.52 + layer * 0.26;
    const name = add(`Rotor ${layer}`, 'collar', [0, height, 0], [0.75, 0.09, 0.75], layer % 2 ? steel : gold);
    spin(name, [0, 1, 0], layer % 2 ? -1 : 1);
    for (let tooth = 0; tooth < 20; tooth++) {
      const angle = tooth / 20 * Math.PI * 2;
      const name = add(`Rotor ${layer} tooth ${tooth}`, 'plate', [Math.cos(angle) * 0.73, height, Math.sin(angle) * 0.73], [0.16, 0.085, 0.13], layer % 2 ? steel : gold, [0, -angle * 180 / Math.PI, 0]);
      tracks.push({ target: name, property: 'translation', keyframes: Array.from({ length: 17 }, (_, index) => {
        const rotationAngle = angle + index / 16 * Math.PI * 2 * (layer % 2 ? -1 : 1);
        return { time: index / 16 * MOTION_DURATION, value: [Math.cos(rotationAngle) * 0.73, height, Math.sin(rotationAngle) * 0.73] };
      }) });
      tracks.push({ target: name, property: 'rotation', keyframes: Array.from({ length: 17 }, (_, index) => ({ time: index / 16 * MOTION_DURATION, value: rotation([0, 1, 0], -angle - index / 16 * Math.PI * 2 * (layer % 2 ? -1 : 1)) })) });
    }
  }
  add('Core lens', 'bead', [0, 0.74, 0], [0.38, 0.38, 0.38], glow);
  tracks.push({ target: 'Core lens', property: 'emission', interpolation: 'SMOOTH', keyframes: [
    { time: 0, value: 0.7 }, { time: 3, value: 3.2 }, { time: 6, value: 5 }, { time: 9, value: 2.5 }, { time: 12, value: 0.7 },
  ] });
  for (let ring = 0; ring < 3; ring++) {
    const radius = 1.1 + ring * 0.27;
    const name = add(`Gimbal ${ring}`, 'ring', [0, 0.12, 0], [radius, radius, radius], ring === 1 ? steel : gold);
    const axis = ring === 0 ? [1, 0, 0] : ring === 1 ? [0, 1, 0] : [0, 0, 1];
    spin(name, axis, ring === 1 ? -1 : 1);
  }
  for (let pod = 0; pod < 8; pod++) {
    const angle = pod / 8 * Math.PI * 2;
    const name = add(`Orbit pod ${pod}`, 'bead', [Math.cos(angle) * 1.8, 0.2, Math.sin(angle) * 1.8], [0.115, 0.115, 0.115], pod % 2 ? glow : amber);
    tracks.push({ target: name, property: 'translation', interpolation: 'SMOOTH', keyframes: Array.from({ length: 25 }, (_, index) => {
      const progress = index / 24;
      const orbit = angle + progress * Math.PI * 2;
      const radius = 1.8 + Math.sin(progress * Math.PI) * 0.2;
      return { time: progress * MOTION_DURATION, value: [Math.cos(orbit) * radius, 0.25 + Math.sin(orbit * 2) * 0.65, Math.sin(orbit) * radius] };
    }) });
  }
  for (let index = 0; index < 16; index++) {
    const angle = index / 16 * Math.PI * 2;
    add(`Housing fastener ${index}`, 'bolt', [Math.cos(angle) * 0.51, 0.61, Math.sin(angle) * 0.51], [0.033, 0.1, 0.033], steel);
  }
  add('Lower spindle', 'collar', [0, -0.9, 0], [0.13, 0.75, 0.13], steel);
  add('Spindle tip', 'bead', [0, -1.31, 0], [0.18, 0.18, 0.18], gold);
  const clip = createAnimationClip({ duration: MOTION_DURATION, tracks });
  const player = createAnimationPlayer(clip, parts);
  const cameras = [
    cameraClip([4.8, 2.7, 7.4], [3.5, 1.8, 6.1], 40),
    cameraClip([3.2, 0.85, 4.7], [1.1, 1.8, 4.3], 38),
    cameraClip([-4.4, 2.6, 7], [-2.7, 1.5, 7.7], 42),
  ];

  function sample(time, aspect = 'landscape') {
    if (!Number.isFinite(time)) throw new TypeError('Motion time must be finite.');
    if (!['landscape', 'portrait', 'square'].includes(aspect)) throw new RangeError('Unknown motion aspect.');
    const current = Math.max(0, Math.min(MOTION_DURATION, time));
    player.apply(current);
    const shot = Math.min(2, Math.floor(current / 4));
    const cameraValues = Object.fromEntries(sampleAnimationClip(cameras[shot], current - shot * 4).map(value => [value.target, value.value]));
    const framing = aspect === 'portrait' ? 2.35 : aspect === 'square' ? 1.18 : 1;
    return {
      time: current,
      shot,
      camera: { eye: cameraValues.eye.map(value => value * framing), target: [0, 0.1, 0], fov: cameraValues.fov },
      effects: { bloom: { strength: 0.32, threshold: 0.82, radius: 1.4 }, saturation: 0.95, contrast: 1.07, temperature: 0.06, vignette: 0.17, grain: 0.012 },
      exposure: 1,
    };
  }
  return { name: 'Clockwork orbit', duration: MOTION_DURATION, parts, clip, player, sample };
}
