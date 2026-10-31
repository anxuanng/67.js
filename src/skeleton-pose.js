import { mat4, quat, vec3 } from 'gl-matrix';
import { compileAnimationSampler, createAnimationClip } from './animation.js';
import { updateSkinPose } from './skinning.js';
import { eulerFromQuaternion, quaternionFromEuler } from './rotation-euler.js';
import {
  bindSourceTracks, computeWorldPose, createPoseState, createRigFromSkin, mapHumanoidBones, prepareRigGeometry, validateRigJoints,
} from './retarget.js';

// Layered skeletal poses with inverse kinematics. Each apply(time) rebuilds the whole pose from the rest pose, in order:
// clip layers, then IK solvers. Nothing carries over between calls, so seeking backward gives the same pose as playing
// forward. Quaternions are XYZW; IK targets and poles are in the rig's world space.

const NEAR_ZERO = 1e-9;
const TO_RADIANS = Math.PI / 180;
const IDENTITY_ROTATION = Object.freeze([0, 0, 0, 1]);

function jointResolver(rig, prepared) {
  const names = rig.joints.map(joint => joint.name);
  const canonical = rig.mapping ?? mapHumanoidBones(names).mapping;
  return function resolveJoint(name, label) {
    const jointName = prepared.indexByName.has(name) ? name : canonical[name];
    const index = prepared.indexByName.get(jointName);
    if (index === undefined) {
      const shown = names.slice(0, 12).join(', ');
      throw new RangeError(`${label}: joint ${name} is not in the rig. Use a joint name or a humanoid bone such as leftUpperArm. Joints: ${shown}${names.length > 12 ? ', ...' : ''}`);
    }
    return index;
  };
}

function descendantsOf(prepared, roots) {
  const inside = new Uint8Array(prepared.joints.length);
  for (const root of roots) inside[root] = 1;
  for (const index of prepared.order) {
    const parent = prepared.joints[index].parent;
    if (parent >= 0 && inside[parent]) inside[index] = 1;
  }
  return inside;
}

/** Per-joint layer weights from { joints, descendants = true, exclude }. Without a mask every joint counts fully. */
function maskWeights(prepared, resolveJoint, mask) {
  const weights = new Float64Array(prepared.joints.length);
  if (!mask) return weights.fill(1);
  if (!Array.isArray(mask.joints) || !mask.joints.length) throw new TypeError('A layer mask needs joints: a non-empty list of joint or bone names.');
  const included = mask.joints.map(name => resolveJoint(name, 'Layer mask'));
  if (mask.descendants === false) {
    for (const index of included) weights[index] = 1;
  } else {
    weights.set(descendantsOf(prepared, included));
  }
  if (mask.exclude) {
    const removed = descendantsOf(prepared, mask.exclude.map(name => resolveJoint(name, 'Layer mask exclude')));
    removed.forEach((flag, index) => {
      if (flag) weights[index] = 0;
    });
  }
  return weights;
}

function weightFunction(value, label) {
  if (typeof value === 'function') return value;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be from 0 to 1, or a function of time.`);
  return () => value;
}

function checkedWeight(weight, time, label) {
  const value = weight(time);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} returned ${value} at time ${time}; it must be from 0 to 1.`);
  return value;
}

function createLayer(definition, position, prepared, resolveJoint) {
  const label = `Layer ${position}`;
  if (!definition?.clip) throw new TypeError(`${label} needs a clip from createAnimationClip.`);
  const sampler = compileAnimationSampler(definition.clip);
  const bindings = bindSourceTracks(sampler, prepared);
  if (!bindings.length) throw new RangeError(`${label}: no clip track names a joint of this rig.`);
  const additive = definition.additive === true;
  const referenceTime = definition.reference ?? 0;
  if (!Number.isFinite(referenceTime)) throw new RangeError(`${label} reference must be a clip time in seconds.`);
  let references = [];
  if (additive) {
    sampler.sample(referenceTime);
    references = bindings.map(binding => Float64Array.from(binding.output));
  }
  const speed = definition.speed ?? 1;
  const offset = definition.offset ?? 0;
  if (!Number.isFinite(speed) || !Number.isFinite(offset)) throw new RangeError(`${label} speed and offset must be finite.`);
  return {
    label, sampler, bindings, additive, references, speed, offset,
    weight: weightFunction(definition.weight ?? 1, `${label} weight`),
    mask: maskWeights(prepared, resolveJoint, definition.mask),
  };
}

const scratchDelta = new Float64Array(4);
const scratchInverse = new Float64Array(4);

function applyAdditiveRotation(rotation, sample, reference, weight) {
  // delta = inverse(reference) * sample, applied in the joint's own frame: local = local * delta.
  quat.multiply(scratchDelta, quat.invert(scratchInverse, reference), sample);
  quat.slerp(scratchDelta, IDENTITY_ROTATION, scratchDelta, weight);
  quat.normalize(rotation, quat.multiply(rotation, rotation, scratchDelta));
}

function applyLayer(layer, time, localRotations, localTranslations) {
  const layerWeight = checkedWeight(layer.weight, time, `${layer.label} weight`);
  if (layerWeight === 0) return;
  layer.sampler.sample(time * layer.speed + layer.offset);
  layer.bindings.forEach((binding, slot) => {
    const weight = layerWeight * layer.mask[binding.index];
    if (weight === 0) return;
    if (binding.property === 'rotation') {
      const rotation = localRotations[binding.index];
      if (layer.additive) {
        applyAdditiveRotation(rotation, binding.output, layer.references[slot], weight);
      } else {
        quat.normalize(rotation, quat.slerp(rotation, rotation, binding.output, weight));
      }
      return;
    }
    const translation = localTranslations[binding.index];
    for (let axis = 0; axis < 3; axis++) {
      if (layer.additive) {
        translation[axis] += (binding.output[axis] - layer.references[slot][axis]) * weight;
      } else {
        translation[axis] += (binding.output[axis] - translation[axis]) * weight;
      }
    }
  });
}

function isDescendant(prepared, index, ancestor) {
  let current = prepared.joints[index].parent;
  while (current >= 0) {
    if (current === ancestor) return true;
    current = prepared.joints[current].parent;
  }
  return false;
}

function checkedVector(value, label) {
  if (value?.length !== 3 || !Number.isFinite(value[0]) || !Number.isFinite(value[1]) || !Number.isFinite(value[2])) {
    throw new RangeError(`${label} must be three finite numbers.`);
  }
  return value;
}

const LIMIT_AXES = ['x', 'y', 'z'];
// The solver stops just short of full stretch (a 2 to 3 degree bend), so a locked limb reads as about 177 degrees.
const HYPEREXTENSION_ANGLE = 175 * TO_RADIANS;
const MIN_BEND_FRACTION = 0.01;
const MIN_REST_BEND_FRACTION = 0.02;

/**
 * Joint limits from { root: { x: [min, max], y, z }, middle: {...} } in degrees. Angles are the joint's turn away from its
 * rest rotation, in its own axes, as Euler XYZ (the order Blender uses). An axis left out is free.
 */
function createJointLimits(definition, label, jointIndices, prepared) {
  if (definition === undefined) return [];
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new TypeError(`${label} limits must be { root, middle } with an x, y or z range each.`);
  return Object.entries(definition).map(([role, axes]) => {
    if (!Object.hasOwn(jointIndices, role)) throw new RangeError(`${label} limits: ${role} must be root or middle.`);
    const unknownAxis = Object.keys(axes ?? {}).find(axis => !LIMIT_AXES.includes(axis));
    if (unknownAxis !== undefined) throw new RangeError(`${label} limits ${role}: ${unknownAxis} must be x, y or z.`);
    const ranges = LIMIT_AXES.map(axis => {
      const range = axes[axis];
      if (range === undefined) return null;
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1] || range[0] < -180 || range[1] > 180) {
        throw new RangeError(`${label} limits ${role}.${axis} must be [min, max] degrees within -180 and 180, min first.`);
      }
      return range.map(degrees => degrees * TO_RADIANS);
    });
    const index = jointIndices[role];
    return { index, name: prepared.joints[index].name, ranges };
  });
}

function roundedDegrees(radians) {
  return Number((radians / TO_RADIANS).toFixed(4));
}

/** Clamp each limited joint's local rotation. Returns one { joint, axis, requested, applied } (degrees) per change. */
function applyJointLimits(limits, prepared, localRotations) {
  const changes = [];
  for (const limit of limits) {
    const rest = prepared.restRotations[limit.index];
    const delta = quat.multiply(new Float64Array(4), quat.invert(new Float64Array(4), rest), localRotations[limit.index]);
    const angles = eulerFromQuaternion(delta);
    let changed = false;
    angles.forEach((angle, axis) => {
      const range = limit.ranges[axis];
      if (!range) return;
      const clamped = Math.min(range[1], Math.max(range[0], angle));
      if (Math.abs(clamped - angle) < 1e-9) return;
      changes.push({ joint: limit.name, axis: LIMIT_AXES[axis], requested: roundedDegrees(angle), applied: roundedDegrees(clamped) });
      angles[axis] = clamped;
      changed = true;
    });
    if (!changed) continue;
    quaternionFromEuler(delta, angles[0], angles[1], angles[2]);
    quat.normalize(localRotations[limit.index], quat.multiply(localRotations[limit.index], rest, delta));
  }
  return changes;
}

/** How far the middle joint sits off the straight line from root to end, as a vector. */
function bendVector(rootPosition, middlePosition, endPosition) {
  const line = vec3.subtract(new Float64Array(3), endPosition, rootPosition);
  const toMiddle = vec3.subtract(new Float64Array(3), middlePosition, rootPosition);
  const lineLengthSquared = vec3.squaredLength(line);
  if (lineLengthSquared < NEAR_ZERO) return toMiddle;
  return vec3.scaleAndAdd(toMiddle, toMiddle, line, -vec3.dot(toMiddle, line) / lineLengthSquared);
}

/** The side the limb bent toward at rest, in the frame of the joint above the root. Null when the rest limb is straight. */
function restBendInParentFrame(prepared, root, middle, end) {
  const { positions, rotations } = prepared.restWorld;
  const bend = bendVector(positions[root], positions[middle], positions[end]);
  const chainLength = vec3.distance(positions[root], positions[middle]) + vec3.distance(positions[middle], positions[end]);
  if (vec3.length(bend) < chainLength * MIN_REST_BEND_FRACTION) return null;
  const parent = prepared.joints[root].parent;
  const parentRotation = parent >= 0 ? rotations[parent] : prepared.rootRotation;
  return vec3.transformQuat(new Float64Array(3), bend, quat.invert(new Float64Array(4), parentRotation));
}

/** Sanity checks on a solved limb: locked straight, or bent the opposite way to its natural direction. */
function bendWarnings(solver, state, prepared) {
  const warnings = [];
  const rootPosition = state.positions[solver.root];
  const middlePosition = state.positions[solver.middle];
  const endPosition = state.positions[solver.end];
  const interiorAngle = vec3.angle(vec3.subtract(new Float64Array(3), rootPosition, middlePosition), vec3.subtract(new Float64Array(3), endPosition, middlePosition));
  if (interiorAngle > HYPEREXTENSION_ANGLE) {
    warnings.push({ code: 'hyperextended', message: `${prepared.joints[solver.middle].name} is locked straight (${roundedDegrees(interiorAngle)} degrees). The target is at or beyond the limb's reach, so a real joint would hyperextend.` });
  }
  let expected = solver.bendToward;
  if (!expected && solver.restBend) {
    const parent = prepared.joints[solver.root].parent;
    expected = vec3.transformQuat(new Float64Array(3), solver.restBend, parent >= 0 ? state.rotations[parent] : prepared.rootRotation);
  }
  if (!expected) return warnings;
  const bend = bendVector(rootPosition, middlePosition, endPosition);
  const chainLength = vec3.distance(rootPosition, middlePosition) + vec3.distance(middlePosition, endPosition);
  if (vec3.length(bend) >= chainLength * MIN_BEND_FRACTION && vec3.dot(bend, expected) < 0) {
    warnings.push({ code: 'wrong-bend', message: `${prepared.joints[solver.middle].name} bends away from its natural direction. Move the pole to the other side, or set bendToward.` });
  }
  return warnings;
}

function createSolver(definition, position, prepared, resolveJoint) {
  const label = `IK ${position}`;
  const weight = weightFunction(definition?.weight ?? 1, `${label} weight`);
  if (typeof definition?.target !== 'function') checkedVector(definition?.target, `${label} target`);
  if (definition.type === 'two-bone') {
    const root = resolveJoint(definition.root, label);
    const middle = resolveJoint(definition.middle, label);
    const end = resolveJoint(definition.end, label);
    if (!isDescendant(prepared, middle, root) || !isDescendant(prepared, end, middle)) {
      throw new RangeError(`${label}: end must descend from middle, and middle from root.`);
    }
    if (definition.pole !== undefined && typeof definition.pole !== 'function') checkedVector(definition.pole, `${label} pole`);
    const limits = createJointLimits(definition.limits, label, { root, middle }, prepared);
    const bendToward = definition.bendToward === undefined ? null : vec3.normalize(new Float64Array(3), checkedVector(definition.bendToward, `${label} bendToward`));
    return {
      type: 'two-bone', label, weight, root, middle, end, target: definition.target, pole: definition.pole, limits, bendToward,
      restBend: restBendInParentFrame(prepared, root, middle, end),
      keepEndRotation: definition.keepEndRotation !== false,
    };
  }
  if (definition.type === 'aim') {
    const names = definition.joints ?? (definition.joint === undefined ? [] : [definition.joint]);
    if (!names.length) throw new TypeError(`${label} needs joint, or joints listed from the base of the chain to the aiming joint.`);
    const joints = names.map(name => resolveJoint(name, label));
    joints.slice(1).forEach((joint, slot) => {
      if (!isDescendant(prepared, joint, joints[slot])) throw new RangeError(`${label}: list joints from the base of the chain to the aiming joint.`);
    });
    if (definition.forward !== undefined && definition.worldForward !== undefined) throw new TypeError(`${label} takes forward or worldForward, not both.`);
    const forward = vec3.normalize(new Float64Array(3), checkedVector(definition.forward ?? definition.worldForward ?? [0, 0, 1], `${label} forward`));
    if (definition.worldForward !== undefined) {
      // Bone axes differ by rig, but which way a character faces at rest does not: bring that direction into the joint.
      const restRotation = prepared.restWorld.rotations[joints[joints.length - 1]];
      vec3.transformQuat(forward, forward, quat.invert(new Float64Array(4), restRotation));
    }
    const maxAngle = definition.maxAngle ?? 180;
    if (!Number.isFinite(maxAngle) || maxAngle <= 0) throw new RangeError(`${label} maxAngle must be a positive number of degrees.`);
    return { type: 'aim', label, weight, joints, forward, maxRadians: maxAngle * TO_RADIANS, target: definition.target };
  }
  throw new RangeError(`${label} type must be two-bone or aim.`);
}

function resolvedPoint(value, time, reference, label) {
  return checkedVector(typeof value === 'function' ? value(time, Array.from(reference)) : value, label);
}

function perpendicularTo(direction) {
  const reference = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return vec3.normalize(new Float64Array(3), vec3.cross(new Float64Array(3), direction, reference));
}

function createSolverContext(prepared, state, localRotations, localTranslations) {
  const update = () => computeWorldPose(prepared, state, localRotations, localTranslations);
  const scratch = new Float64Array(4);
  // Give a joint a new world rotation, faded in by weight against the local rotation it has now.
  function setWorldRotation(index, worldRotation, weight) {
    const parent = prepared.joints[index].parent;
    const parentRotation = parent >= 0 ? state.rotations[parent] : prepared.rootRotation;
    quat.multiply(scratch, quat.invert(new Float64Array(4), parentRotation), worldRotation);
    quat.normalize(localRotations[index], quat.slerp(localRotations[index], localRotations[index], scratch, weight));
    update();
  }
  return { state, prepared, localRotations, update, setWorldRotation };
}

/**
 * Analytic two-bone IK. Places the middle joint in the plane of the target and the pole (or of the current bend), then
 * turns the two upper joints with the shortest rotations, so twist already in the pose survives.
 */
function solveTwoBone(solver, time, context) {
  const { state, prepared, localRotations, update, setWorldRotation } = context;
  const weight = checkedWeight(solver.weight, time, `${solver.label} weight`);
  const endPosition = state.positions[solver.end];
  const target = resolvedPoint(solver.target, time, endPosition, `${solver.label} target`);
  if (weight === 0) return { reached: true, error: 0, warnings: [], limited: [] };
  const rootPosition = Float64Array.from(state.positions[solver.root]);
  const middlePosition = Float64Array.from(state.positions[solver.middle]);
  const startEnd = Float64Array.from(endPosition);
  const endRotation = Float64Array.from(state.rotations[solver.end]);
  const upperLength = vec3.distance(rootPosition, middlePosition);
  const lowerLength = vec3.distance(middlePosition, startEnd);
  const toTarget = vec3.subtract(new Float64Array(3), target, rootPosition);
  const targetDistance = vec3.length(toTarget);
  if (targetDistance < NEAR_ZERO || upperLength < NEAR_ZERO || lowerLength < NEAR_ZERO) {
    return { reached: false, error: vec3.distance(startEnd, target), warnings: [], limited: [] };
  }
  const direction = vec3.scale(new Float64Array(3), toTarget, 1 / targetDistance);
  // Stop just short of the limits: a fully straight limb has no defined bend plane for the next frame.
  const margin = (upperLength + lowerLength) * 1e-4;
  const reachLimit = upperLength + lowerLength - margin;
  const reach = Math.min(reachLimit, Math.max(Math.abs(upperLength - lowerLength) + margin, targetDistance));
  const bendReference = solver.pole === undefined
    ? vec3.subtract(new Float64Array(3), middlePosition, rootPosition)
    : vec3.subtract(new Float64Array(3), resolvedPoint(solver.pole, time, middlePosition, `${solver.label} pole`), rootPosition);
  const alongTarget = vec3.dot(bendReference, direction);
  const bend = vec3.scaleAndAdd(new Float64Array(3), bendReference, direction, -alongTarget);
  if (vec3.length(bend) < NEAR_ZERO * Math.max(1, upperLength)) {
    vec3.copy(bend, perpendicularTo(direction));
  } else {
    vec3.normalize(bend, bend);
  }
  const alongLimb = (upperLength * upperLength - lowerLength * lowerLength + reach * reach) / (2 * reach);
  const height = Math.sqrt(Math.max(0, upperLength * upperLength - alongLimb * alongLimb));
  const newMiddle = vec3.scaleAndAdd(new Float64Array(3), rootPosition, direction, alongLimb);
  vec3.scaleAndAdd(newMiddle, newMiddle, bend, height);
  const newEnd = vec3.scaleAndAdd(new Float64Array(3), rootPosition, direction, reach);

  const upperFrom = vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), middlePosition, rootPosition));
  const upperTo = vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), newMiddle, rootPosition));
  const rootTurn = quat.rotationTo(new Float64Array(4), upperFrom, upperTo);
  const endAfterRoot = vec3.transformQuat(new Float64Array(3), vec3.subtract(new Float64Array(3), startEnd, rootPosition), rootTurn);
  vec3.add(endAfterRoot, endAfterRoot, rootPosition);
  const lowerFrom = vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), endAfterRoot, newMiddle));
  const lowerTo = vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), newEnd, newMiddle));
  const middleTurn = quat.rotationTo(new Float64Array(4), lowerFrom, lowerTo);

  const newRootRotation = quat.multiply(new Float64Array(4), rootTurn, state.rotations[solver.root]);
  const newMiddleRotation = quat.multiply(new Float64Array(4), middleTurn, quat.multiply(new Float64Array(4), rootTurn, state.rotations[solver.middle]));
  setWorldRotation(solver.root, newRootRotation, weight);
  setWorldRotation(solver.middle, newMiddleRotation, weight);
  const limited = applyJointLimits(solver.limits, prepared, localRotations);
  if (limited.length) update();
  if (solver.keepEndRotation) setWorldRotation(solver.end, endRotation, weight);
  const error = vec3.distance(state.positions[solver.end], target);
  return { reached: error <= margin * 2 + NEAR_ZERO, error, warnings: bendWarnings(solver, state, prepared), limited };
}

/** Turn a joint, or a chain sharing the turn evenly, so its forward axis points at the target. */
function solveAim(solver, time, context) {
  const { state, setWorldRotation } = context;
  const weight = checkedWeight(solver.weight, time, `${solver.label} weight`);
  const aiming = solver.joints[solver.joints.length - 1];
  const target = resolvedPoint(solver.target, time, state.positions[aiming], `${solver.label} target`);
  if (weight === 0) return { reached: true, error: 0 };
  const forwardNow = () => vec3.transformQuat(new Float64Array(3), solver.forward, state.rotations[aiming]);
  const toTarget = vec3.subtract(new Float64Array(3), target, state.positions[aiming]);
  if (vec3.length(toTarget) < NEAR_ZERO) return { reached: false, error: Math.PI };
  vec3.normalize(toTarget, toTarget);
  const start = forwardNow();
  const totalTurn = quat.rotationTo(new Float64Array(4), start, toTarget);
  const totalAngle = 2 * Math.acos(Math.min(1, Math.abs(totalTurn[3])));
  // maxAngle limits the whole turn, so the chain ends up pointing along this direction when the target is too far around.
  const allowed = totalAngle > solver.maxRadians ? solver.maxRadians / totalAngle : 1;
  const limitedTurn = quat.slerp(new Float64Array(4), IDENTITY_ROTATION, totalTurn, allowed);
  const goal = vec3.transformQuat(new Float64Array(3), start, limitedTurn);
  solver.joints.forEach((joint, slot) => {
    const remaining = solver.joints.length - slot;
    const turn = quat.rotationTo(new Float64Array(4), forwardNow(), goal);
    quat.slerp(turn, IDENTITY_ROTATION, turn, 1 / remaining);
    setWorldRotation(joint, quat.multiply(new Float64Array(4), turn, state.rotations[joint]), weight);
  });
  const finalForward = forwardNow();
  const direct = vec3.subtract(new Float64Array(3), target, state.positions[aiming]);
  const error = vec3.angle(finalForward, direct);
  // A chain's own joints move as it turns, so about a degree is as close as one pass gets.
  return { reached: error < 0.02, error };
}

const SOLVERS = { 'two-bone': solveTwoBone, aim: solveAim };

const GLTF_TRACK_PROPERTIES = { position: 'translation', quaternion: 'rotation', scale: 'scale' };
const GLTF_STEP_INTERPOLATION = 2300;
const GLTF_LINEAR_INTERPOLATION = 2301;
const GLTF_CUBIC_INTERPOLATION = 2302;
const RESAMPLE_RATE = 30;

function trackKeyframes(track, size) {
  const interpolation = track.getInterpolation?.();
  if (interpolation === GLTF_LINEAR_INTERPOLATION || interpolation === GLTF_STEP_INTERPOLATION) {
    return Array.from(track.times, (time, index) => ({ time, value: Array.from(track.values.subarray(index * size, (index + 1) * size)) }));
  }
  // Cubic glTF tracks store tangents in their values; sample them instead of carrying a second tangent convention.
  const interpolant = track.createInterpolant(new Float64Array(size));
  const start = track.times[0];
  const end = track.times[track.times.length - 1];
  const steps = Math.max(1, Math.ceil((end - start) * RESAMPLE_RATE));
  return Array.from({ length: steps + 1 }, (_, step) => {
    const time = start + (end - start) * step / steps;
    return { time, value: Array.from(interpolant.evaluate(time)) };
  });
}

/**
 * Convert an animation from a loaded glTF asset (`asset.animations[n]`) into a clip layers and retargetClip can use.
 * Node tracks keep their decoded node names. Morph weight tracks are skipped. Step keys stay step; cubic keys are
 * resampled at 30 frames per second.
 */
export function clipFromGltfAnimation(animation, { loop = false, rename = {} } = {}) {
  if (!Array.isArray(animation?.tracks) || !Number.isFinite(animation.duration)) throw new TypeError('clipFromGltfAnimation needs an animation from asset.animations.');
  const tracks = [];
  for (const track of animation.tracks) {
    const separator = track.name.lastIndexOf('.');
    const property = GLTF_TRACK_PROPERTIES[track.name.slice(separator + 1)];
    if (!property || !track.times.length) continue;
    const size = property === 'rotation' ? 4 : 3;
    const trackTarget = track.name.slice(0, separator);
    tracks.push({
      target: Object.hasOwn(rename, trackTarget) ? rename[trackTarget] : trackTarget, property,
      interpolation: track.getInterpolation?.() === GLTF_STEP_INTERPOLATION ? 'STEP' : 'LINEAR',
      keyframes: trackKeyframes(track, size),
    });
  }
  return createAnimationClip({ duration: Math.max(animation.duration, 1e-3), loop, tracks });
}

const MORPH_TRACK_SUFFIX = '.morphTargetInfluences';

/**
 * The morph weight tracks of a loaded glTF animation, which `clipFromGltfAnimation` leaves out. Each track names the mesh
 * part it moves and is sampled with the decoder's own interpolant, so step, linear and cubic keys all play as authored.
 * Pass the result as `morphs` on a layer of `createAssetPose`.
 */
export function morphClipFromGltfAnimation(animation, { loop = false } = {}) {
  if (!Array.isArray(animation?.tracks) || !Number.isFinite(animation.duration)) throw new TypeError('morphClipFromGltfAnimation needs an animation from asset.animations.');
  const tracks = animation.tracks
    .filter(track => track.name.endsWith(MORPH_TRACK_SUFFIX) && track.times.length)
    .map(track => {
      const valuesPerKey = track.values.length / track.times.length;
      const count = track.getInterpolation?.() === GLTF_CUBIC_INTERPOLATION ? valuesPerKey / 3 : valuesPerKey;
      return { part: track.name.slice(0, -MORPH_TRACK_SUFFIX.length), count, interpolant: track.createInterpolant(new Float64Array(count)) };
    });
  return { duration: Math.max(animation.duration, 1e-3), loop, tracks };
}

function morphClipTime(morphs, layerTime) {
  if (!morphs.loop) return Math.min(morphs.duration, Math.max(0, layerTime));
  return ((layerTime % morphs.duration) + morphs.duration) % morphs.duration;
}

/** The deepest asset node that owns each mesh part, by index, so a layer mask can include or leave out a part by its bone. */
function ownerNodeByPart(nodes) {
  const owners = new Map();
  nodes.forEach((node, index) => {
    for (const meshId of node.meshIds ?? []) owners.set(Number(meshId.slice('mesh-'.length)), index);
  });
  return owners;
}

function createMorphLayers(asset, nodes, layers, rig) {
  const prepared = prepareRigGeometry(rig, 'Pose');
  const resolveJoint = jointResolver(rig, prepared);
  const owners = ownerNodeByPart(nodes);
  return layers.filter(layer => layer.morphs?.tracks.length).map(layer => {
    const mask = maskWeights(prepared, resolveJoint, layer.mask);
    const partIndices = new Map();
    for (const track of layer.morphs.tracks) {
      const matching = [...asset.parts.keys()].filter(index => {
        const part = asset.parts[index];
        return part.name === track.part && part.morph?.weights.length === track.count && mask[owners.get(index)] > 0;
      });
      partIndices.set(track, matching);
    }
    return {
      morphs: layer.morphs, partIndices, mask, owners, additive: layer.additive === true,
      speed: layer.speed ?? 1, offset: layer.offset ?? 0, weight: weightFunction(layer.weight ?? 1, 'Morph layer weight'),
      reference: layer.reference ?? 0,
    };
  });
}

/** Blend each morph layer's weights over the ones before it. Returns [{ part, weights }] for the parts any layer drives. */
function evaluateMorphLayers(morphLayers, time) {
  const blended = new Map();
  for (const layer of morphLayers) {
    const layerWeight = checkedWeight(layer.weight, time, 'Morph layer weight');
    if (layerWeight === 0) continue;
    const layerTime = time * layer.speed + layer.offset;
    for (const track of layer.morphs.tracks) {
      const sampled = Array.from(track.interpolant.evaluate(morphClipTime(layer.morphs, layerTime)));
      const reference = layer.additive ? Array.from(track.interpolant.evaluate(morphClipTime(layer.morphs, layer.reference))) : null;
      for (const part of layer.partIndices.get(track)) {
        const weights = blended.get(part) ?? new Array(track.count).fill(0);
        const strength = layerWeight * layer.mask[layer.owners.get(part)];
        weights.forEach((current, index) => {
          const target = reference ? current + sampled[index] - reference[index] : sampled[index];
          weights[index] = Math.min(1, Math.max(0, current + (target - current) * strength));
        });
        blended.set(part, weights);
      }
    }
  }
  return [...blended].map(([part, weights]) => ({ part, weights }));
}

function rigFromAssetNodes(nodes) {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const jointNames = nodes.filter(node => node.joint).map(node => node.name);
  return {
    mapping: mapHumanoidBones(jointNames).mapping,
    joints: nodes.map(node => ({
      name: node.name,
      parent: node.parent === null ? -1 : indexById.get(node.parent),
      translation: node.translation, rotation: node.rotation, scale: node.scale,
    })),
  };
}

function checkAssetIkScales(rig, solvedNames) {
  const indexByName = new Map(rig.joints.map((joint, index) => [joint.name, index]));
  for (const name of solvedNames) {
    let current = rig.joints[indexByName.get(name)]?.parent ?? -1;
    while (current >= 0) {
      const joint = rig.joints[current];
      const [first, second, third] = joint.scale;
      if (Math.max(first, second, third) - Math.min(first, second, third) > 1e-3 * Math.max(first, second, third)) {
        throw new RangeError(`IK: node ${joint.name} above ${name} has non-uniform scale ${JSON.stringify(joint.scale)}, which IK cannot solve through.`);
      }
      current = joint.parent;
    }
  }
}

function createAssetPoseParts(asset, layers, ik) {
  if (typeof asset?.stagePose !== 'function' || !Array.isArray(asset.nodes)) throw new TypeError('createAssetPose needs an asset from loadGltf or parseGltf.');
  if (!Array.isArray(layers) || !Array.isArray(ik)) throw new TypeError('layers and ik must be arrays.');
  const nodes = asset.nodes;
  const rig = rigFromAssetNodes(nodes);
  const nodeLayers = layers.filter(layer => layer?.clip || !layer?.morphs);
  const pose = createSkeletonPose({ rig, layers: nodeLayers, ik });
  checkAssetIkScales(rig, pose.solvedJointNames);
  const written = pose.writtenJoints.filter(({ index }) => nodes[index].editable);
  const morphLayers = createMorphLayers(asset, nodes, layers, rig);
  /** Rebuild the pose for a time and return what the asset needs to stage it. */
  function evaluate(time) {
    pose.apply(time);
    const nodeOverrides = written.map(({ index, translation }) => {
      const override = { id: nodes[index].id, rotation: Array.from(pose.localRotation(index)) };
      if (translation) override.translation = Array.from(pose.localTranslation(index));
      return override;
    });
    return { nodeOverrides, morphWeights: evaluateMorphLayers(morphLayers, time) };
  }
  return { pose, evaluate };
}

/**
 * Evaluate layers alone, without IK and without committing anything: for a host that stages the result itself, as the
 * MCP asset recipe does before it solves IK. `evaluate(time)` gives `{ nodeOverrides, morphWeights }` for
 * `asset.stagePose`. The same time always gives the same result.
 */
export function createAssetLayerEvaluator(asset, layers) {
  return { evaluate: createAssetPoseParts(asset, layers, []).evaluate };
}

/**
 * Pose a loaded glTF asset from { layers, ik }. Unlike a skin palette this moves every skin and every rigid part attached
 * to the hierarchy, and IK targets are in the asset's world space. Joints are named by decoded node name or humanoid bone.
 * A layer may carry `morphs` from `morphClipFromGltfAnimation` to drive morph weights too; its mask picks parts by the
 * bone that owns them. `apply(time)` commits the pose and returns `asset.parts`; pass them to `renderer.updateParts`.
 */
export function createAssetPose(asset, { layers = [], ik = [] } = {}) {
  const { pose, evaluate } = createAssetPoseParts(asset, layers, ik);
  return {
    apply(time) {
      const { nodeOverrides, morphWeights } = evaluate(time);
      return asset.stagePose({ animation: null, nodeOverrides, morphWeights }).commit();
    },
    jointWorld: pose.jointWorld,
    get ikResults() {
      return pose.ikResults;
    },
  };
}

/**
 * Build a pose evaluator from { skin, rig, meshWorldMatrix, layers, ik }. Give `skin` to write its joint palette, or only
 * `rig` to read joint positions. Layers run in order: each blends its clip over the pose so far, or adds its change from
 * `reference` when `additive` is true. IK solvers run in order after every layer.
 */
export function createSkeletonPose({ skin, rig = skin && createRigFromSkin(skin), meshWorldMatrix, layers = [], ik = [] } = {}) {
  if (!rig) throw new TypeError('createSkeletonPose needs a skin or a rig.');
  validateRigJoints(rig.joints, 'Pose');
  if (!Array.isArray(layers) || !Array.isArray(ik)) throw new TypeError('layers and ik must be arrays.');
  const prepared = prepareRigGeometry(rig, 'Pose');
  const resolveJoint = jointResolver(rig, prepared);
  const compiledLayers = layers.map((layer, position) => createLayer(layer, position, prepared, resolveJoint));
  const solvers = ik.map((solver, position) => createSolver(solver, position, prepared, resolveJoint));
  const solvedIndices = new Set(solvers.flatMap(solver => (solver.type === 'aim' ? solver.joints : [solver.root, solver.middle, solver.end])));
  const translatedIndices = new Set(compiledLayers.flatMap(layer => layer.bindings.filter(binding => binding.property === 'translation').map(binding => binding.index)));
  const writtenIndices = new Set([...solvedIndices, ...translatedIndices, ...compiledLayers.flatMap(layer => layer.bindings.filter(binding => binding.property === 'rotation').map(binding => binding.index))]);
  const jointCount = rig.joints.length;
  const localRotations = prepared.restRotations.map(rotation => Float64Array.from(rotation));
  const localTranslations = prepared.restTranslations.map(translation => Float64Array.from(translation));
  const state = createPoseState(jointCount);
  const context = createSolverContext(prepared, state, localRotations, localTranslations);
  const jointWorldMatrices = new Float32Array(jointCount * 16);
  const scratchMatrix = mat4.create();
  const results = solvers.map(() => ({ reached: true, error: 0 }));
  const bindMatrix = skin?.bindMatrix ?? mat4.create();
  const meshMatrix = meshWorldMatrix ?? bindMatrix;

  function writePalette() {
    for (let index = 0; index < jointCount; index++) {
      const scale = state.scales[index];
      mat4.fromRotationTranslationScale(scratchMatrix, state.rotations[index], state.positions[index], [scale, scale, scale]);
      jointWorldMatrices.set(scratchMatrix, index * 16);
    }
    updateSkinPose(skin, jointWorldMatrices, skin.inverseBindMatrices, meshMatrix, bindMatrix);
  }

  function jointWorld(name) {
    const index = resolveJoint(name, 'jointWorld');
    return { position: Array.from(state.positions[index]), rotation: Array.from(state.rotations[index]) };
  }

  return {
    /**
     * Rebuild the pose for an absolute time in seconds. Returns the skin when there is one. `setBase`, if given, receives
     * the local rotation and translation arrays (by rig joint index) to replace the rest pose before layers and IK.
     */
    apply(time, setBase) {
      if (!Number.isFinite(time)) throw new RangeError('Pose time must be finite.');
      for (let index = 0; index < jointCount; index++) {
        localRotations[index].set(prepared.restRotations[index]);
        localTranslations[index].set(prepared.restTranslations[index]);
      }
      setBase?.(localRotations, localTranslations);
      for (const layer of compiledLayers) applyLayer(layer, time, localRotations, localTranslations);
      context.update();
      solvers.forEach((solver, position) => {
        results[position] = SOLVERS[solver.type](solver, time, context);
      });
      if (skin) writePalette();
      return skin;
    },
    /** World position and rotation of a joint after the last apply. */
    jointWorld,
    /** Local rotation of a joint by rig index after the last apply. The array is reused by the next apply. */
    localRotation(index) {
      return localRotations[index];
    },
    /** Local translation of a joint by rig index after the last apply. The array is reused by the next apply. */
    localTranslation(index) {
      return localTranslations[index];
    },
    /** Rig indices a layer or solver can change, and whether their translation can change too. */
    writtenJoints: [...writtenIndices].map(index => ({ index, translation: translatedIndices.has(index) })),
    /** Names of the joints IK solvers move. */
    solvedJointNames: [...solvedIndices].map(index => rig.joints[index].name),
    /** One { reached, error } per IK solver from the last apply: metres for two-bone, radians for aim. */
    get ikResults() {
      return results;
    },
  };
}
