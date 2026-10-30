import { mat4, quat, vec3 } from 'gl-matrix';
import { compileAnimationSampler } from './animation.js';
import { updateSkinPose } from './skinning.js';
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
    return { type: 'two-bone', label, weight, root, middle, end, target: definition.target, pole: definition.pole, keepEndRotation: definition.keepEndRotation !== false };
  }
  if (definition.type === 'aim') {
    const names = definition.joints ?? (definition.joint === undefined ? [] : [definition.joint]);
    if (!names.length) throw new TypeError(`${label} needs joint, or joints listed from the base of the chain to the aiming joint.`);
    const joints = names.map(name => resolveJoint(name, label));
    joints.slice(1).forEach((joint, slot) => {
      if (!isDescendant(prepared, joint, joints[slot])) throw new RangeError(`${label}: list joints from the base of the chain to the aiming joint.`);
    });
    const forward = vec3.normalize(new Float64Array(3), checkedVector(definition.forward ?? [0, 0, 1], `${label} forward`));
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
  return { state, update, setWorldRotation };
}

/**
 * Analytic two-bone IK. Places the middle joint in the plane of the target and the pole (or of the current bend), then
 * turns the two upper joints with the shortest rotations, so twist already in the pose survives.
 */
function solveTwoBone(solver, time, context) {
  const { state, setWorldRotation } = context;
  const weight = checkedWeight(solver.weight, time, `${solver.label} weight`);
  const endPosition = state.positions[solver.end];
  const target = resolvedPoint(solver.target, time, endPosition, `${solver.label} target`);
  if (weight === 0) return { reached: true, error: 0 };
  const rootPosition = Float64Array.from(state.positions[solver.root]);
  const middlePosition = Float64Array.from(state.positions[solver.middle]);
  const startEnd = Float64Array.from(endPosition);
  const endRotation = Float64Array.from(state.rotations[solver.end]);
  const upperLength = vec3.distance(rootPosition, middlePosition);
  const lowerLength = vec3.distance(middlePosition, startEnd);
  const toTarget = vec3.subtract(new Float64Array(3), target, rootPosition);
  const targetDistance = vec3.length(toTarget);
  if (targetDistance < NEAR_ZERO || upperLength < NEAR_ZERO || lowerLength < NEAR_ZERO) {
    return { reached: false, error: vec3.distance(startEnd, target) };
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
  if (solver.keepEndRotation) setWorldRotation(solver.end, endRotation, weight);
  const error = vec3.distance(state.positions[solver.end], target);
  return { reached: error <= margin * 2 + NEAR_ZERO, error };
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
  return { reached: error < 1e-3, error };
}

const SOLVERS = { 'two-bone': solveTwoBone, aim: solveAim };

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
    /** Rebuild the pose for an absolute time in seconds. Returns the skin when there is one. */
    apply(time) {
      if (!Number.isFinite(time)) throw new RangeError('Pose time must be finite.');
      for (let index = 0; index < jointCount; index++) {
        localRotations[index].set(prepared.restRotations[index]);
        localTranslations[index].set(prepared.restTranslations[index]);
      }
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
    /** One { reached, error } per IK solver from the last apply: metres for two-bone, radians for aim. */
    get ikResults() {
      return results;
    },
  };
}
