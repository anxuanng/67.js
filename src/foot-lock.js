import { createSkeletonPose, rigFromAssetNodes } from './skeleton-pose.js';
import { bounded, knownKeys, valueFrom } from './motion-validation.js';

// Foot lock for an asset's layered motion. The clip is sampled once to find when each foot is planted (low and slow), then
// every pose pins that foot where it touched down with the two-bone IK solver and, when a ground is known, lays the sole
// on the ground normal. Everything is a function of time, so a seek gives the same pose as playing.

const ANALYSIS_RATE = 30;
const MINIMUM_CONTACT_FRAMES = 3;
const SIDES = ['left', 'right'];
const DEFAULTS = Object.freeze({ contactHeight: 0.05, contactSpeed: 0.35, blend: 0.1 });

/** `true` or { contactHeight (m above the clip's lowest ankle), contactSpeed (m/s), blend (s), ground: { height, normal } }. */
export function normalizeFootLock(input) {
  if (input === true) return { ...DEFAULTS };
  knownKeys(input, ['contactHeight', 'contactSpeed', 'blend', 'ground'], 'Motion footLock');
  const result = {
    contactHeight: bounded(input.contactHeight ?? DEFAULTS.contactHeight, 0.001, 1, 'footLock contactHeight'),
    contactSpeed: bounded(input.contactSpeed ?? DEFAULTS.contactSpeed, 0.01, 5, 'footLock contactSpeed'),
    blend: bounded(input.blend ?? DEFAULTS.blend, 0.01, 1, 'footLock blend'),
  };
  if (input.ground !== undefined) {
    knownKeys(input.ground, ['height', 'normal'], 'Motion footLock ground');
    const normal = valueFrom(input.ground.normal ?? [0, 1, 0], 3, 'footLock ground normal');
    const length = Math.hypot(...normal);
    if (!(length > 0) || normal[1] / length < 0.5) throw new RangeError('footLock ground normal must point up within 60 degrees of +Y.');
    result.ground = { height: bounded(input.ground.height ?? 0, -1000, 1000, 'footLock ground height'), normal: normal.map(value => value / length) };
  }
  return result;
}

function smoothstep(fraction) {
  return fraction * fraction * (3 - 2 * fraction);
}

/** Contact runs of one foot from its sampled positions: low (within contactHeight of its lowest) and slow, for several frames. */
function contactPhases(positions, settings) {
  const step = 1 / ANALYSIS_RATE;
  const lowest = Math.min(...positions.map(position => position[1]));
  const contact = positions.map((position, index) => {
    const before = positions[Math.max(0, index - 1)];
    const after = positions[Math.min(positions.length - 1, index + 1)];
    const span = (Math.min(positions.length - 1, index + 1) - Math.max(0, index - 1)) * step;
    const speed = Math.hypot(after[0] - before[0], after[2] - before[2]) / span;
    return position[1] - lowest <= settings.contactHeight && speed <= settings.contactSpeed;
  });
  const phases = [];
  let first = null;
  for (let index = 0; index <= contact.length; index++) {
    if (contact[index] && first === null) first = index;
    if (!contact[index] && first !== null) {
      if (index - first >= MINIMUM_CONTACT_FRAMES) phases.push({ first, last: index - 1 });
      first = null;
    }
  }
  return { lowest, phases };
}

/** Where the ankle goes for a phase: where it touched down, or that point put on the ground plane at the clip's standing clearance. */
function plantedPoint(touchdown, lowest, ground) {
  if (!ground) return touchdown;
  const [normalX, normalY, normalZ] = ground.normal;
  const aboveGround = touchdown[0] * normalX + (touchdown[1] - ground.height) * normalY + touchdown[2] * normalZ;
  return ground.normal.map((component, axis) => touchdown[axis] - component * (aboveGround - lowest));
}

/**
 * Foot lock for `nodes` (an asset's decoded nodes) under `layers` (pose layer definitions with clips in the asset's joint
 * names). `rootMatrix` places the asset in the world; the ground is in that world, and the character's own floor is y = 0.
 */
export function createFootLock({ settings, nodes, rootMatrix, layers, duration, loop }) {
  const rig = rigFromAssetNodes(nodes, { rootMatrix });
  const chains = SIDES.map(side => {
    const bones = ['UpperLeg', 'LowerLeg', 'Foot'].map(name => rig.mapping[`${side}${name}`]);
    if (bones.some(bone => bone === undefined)) {
      throw new RangeError(`Motion footLock needs the ${side} leg mapped to the humanoid bones (${side}UpperLeg, ${side}LowerLeg, ${side}Foot). scene_inspect lists the unmapped joints.`);
    }
    return { side, root: bones[0], middle: bones[1], end: bones[2] };
  });
  const idByName = new Map(nodes.map(node => [node.name, node.id]));
  const nodeLayers = layers.map(({ morphs, ...layer }) => layer).filter(layer => layer.clip);
  let plan = null;

  function analyse() {
    const analysisPose = createSkeletonPose({ rig, layers: nodeLayers });
    const frames = Math.max(2, Math.round(duration * ANALYSIS_RATE) + 1);
    const positions = chains.map(() => []);
    for (let frame = 0; frame < frames; frame++) {
      analysisPose.apply(Math.min(duration, frame / ANALYSIS_RATE));
      chains.forEach((chain, slot) => positions[slot].push(analysisPose.jointWorld(chain.end).position));
    }
    return chains.map((chain, slot) => {
      const { lowest, phases } = contactPhases(positions[slot], settings);
      return phases.map(({ first, last }) => ({
        start: first / ANALYSIS_RATE, end: last / ANALYSIS_RATE,
        target: plantedPoint(positions[slot][first], lowest, settings.ground),
      }));
    });
  }

  function planned() {
    plan ??= analyse();
    return plan;
  }

  function clockTime(time) {
    return loop ? time % duration : Math.min(time, duration);
  }

  /** The phase that holds or is about to hold the foot at a time, and how strongly. */
  function holdAt(phases, time) {
    let best = { weight: 0, phase: phases[0] };
    for (const phase of phases) {
      let weight = 0;
      if (time >= phase.start && time <= phase.end) weight = 1;
      else if (time < phase.start && time >= phase.start - settings.blend) weight = smoothstep((time - (phase.start - settings.blend)) / settings.blend);
      else if (time > phase.end && time <= phase.end + settings.blend) weight = smoothstep(1 - (time - phase.end) / settings.blend);
      if (weight > best.weight) best = { weight, phase };
    }
    return best;
  }

  let solver = null;
  function createSolver() {
    const phasesByFoot = planned();
    const definitions = chains.map((chain, slot) => {
      const phases = phasesByFoot[slot];
      return {
        type: 'two-bone', root: chain.root, middle: chain.middle, end: chain.end,
        target: (time, current) => (phases.length ? holdAt(phases, clockTime(time)).phase.target : current),
        weight: time => (phases.length ? holdAt(phases, clockTime(time)).weight : 0),
        ...(settings.ground ? { groundNormal: settings.ground.normal } : {}),
      };
    });
    solver = createSkeletonPose({ rig, ik: definitions });
    return solver;
  }

  return {
    /** Node overrides ({ id, rotation }) that plant the feet in the staged pose ({ id, translation, rotation } per node). */
    solve(time, nodePoses) {
      const pose = solver ?? createSolver();
      const poseById = new Map(nodePoses.map(nodePose => [nodePose.id, nodePose]));
      pose.apply(time, (localRotations, localTranslations) => {
        rig.joints.forEach((joint, index) => {
          const nodePose = poseById.get(idByName.get(joint.name));
          localRotations[index].set(nodePose.rotation);
          localTranslations[index].set(nodePose.translation);
        });
      });
      const phasesByFoot = planned();
      const active = chains.some((chain, slot) => phasesByFoot[slot].length && holdAt(phasesByFoot[slot], clockTime(time)).weight > 0);
      if (!active) return [];
      const indexByName = new Map(rig.joints.map((joint, index) => [joint.name, index]));
      return chains.flatMap(chain => [chain.root, chain.middle, chain.end].map(name => ({
        id: idByName.get(name), rotation: Array.from(pose.localRotation(indexByName.get(name))),
      })));
    },
    /** For scene_inspect: when each foot is planted. */
    report() {
      const phasesByFoot = planned();
      return {
        feet: chains.map((chain, slot) => ({
          bone: `${chain.side}Foot`,
          phases: phasesByFoot[slot].map(phase => ({ start: Number(phase.start.toFixed(3)), end: Number(phase.end.toFixed(3)) })),
        })),
        ...(settings.ground ? { ground: settings.ground } : {}),
      };
    },
  };
}
