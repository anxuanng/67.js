import { createAnimationClip, compileAnimationSampler } from './animation.js';
import { createCameraPath } from './camera-path.js';
import { createSkeletonPose } from './skeleton-pose.js';

const PROPERTIES = {
  node: { translation: 3, rotation: 4, scale: 3 },
  material: { color: 3, emissiveColor: 3, emission: 1, metallic: 1, roughness: 1 },
  camera: { eye: 3, target: 3, fov: 1, roll: 1 },
};
const INTERPOLATIONS = ['LINEAR', 'STEP', 'SMOOTH', 'CUBICSPLINE'];
const MAX_IK_SOLVERS = 16;
const IK_SWEEP_SAMPLES = 33;
const CAMERA_DEFAULTS = { eye: [4, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 1000 };

function knownKeys(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`Unknown or unsupported ${label} field: ${String(key)}.`);
    }
  }
}

function finite(value, label) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${label} must be finite at Float32 precision.`);
  }
  return value;
}

function bounded(value, minimum, maximum, label) {
  finite(value, label);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be within ${minimum} and ${maximum}.`);
  }
  return value;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).some((key, index) => key !== String(index))) {
    throw new TypeError(`${label} must be a bounded dense array.`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, index), 'value')) {
      throw new TypeError(`${label} cannot contain accessors.`);
    }
  }
  return value;
}

function valueFrom(value, size, label) {
  if (size === 1) {
    return finite(value, label);
  }
  denseArray(value, size, label);
  if (value.length !== size) {
    throw new TypeError(`${label} needs ${size} components.`);
  }
  return value.map(component => finite(component, label));
}

function validateValue(kind, property, value) {
  const components = typeof value === 'number' ? [value] : value;
  for (const component of components) {
    finite(component, `${kind} ${property}`);
  }
  if (property === 'scale' && components.some(component => Math.fround(component) <= 0)) {
    throw new RangeError('Motion scale must remain positive at Float32 precision.');
  }
  if (kind === 'material') {
    if (components.some(component => component < 0)) {
      throw new RangeError(`Motion ${property} cannot be negative.`);
    }
    if (['color', 'metallic', 'roughness'].includes(property) && components.some(component => component > 1)) {
      throw new RangeError(`Motion ${property} must stay within zero and one.`);
    }
  }
  if (kind === 'camera' && property === 'fov' && (Math.fround(value) <= 0 || Math.fround(value) >= 180)) {
    throw new RangeError('Motion fov must stay between zero and 180 at Float32 precision.');
  }
}

function coreProperty(track) {
  if (track.property === 'rotation') {
    return 'rotation';
  }
  return PROPERTIES[track.kind][track.property] === 1 ? 'value' : 'translation';
}

function copiedKeyframe(keyframe, interpolation) {
  const result = {
    time: keyframe.time,
    value: Array.isArray(keyframe.value) ? [...keyframe.value] : keyframe.value,
  };
  if (interpolation === 'CUBICSPLINE') {
    result.inTangent = Array.isArray(keyframe.inTangent) ? [...keyframe.inTangent] : keyframe.inTangent;
    result.outTangent = Array.isArray(keyframe.outTangent) ? [...keyframe.outTangent] : keyframe.outTangent;
  }
  return result;
}

function normalizedKeyframe(keyframe, track, duration, interpolation) {
  knownKeys(keyframe, ['time', 'value', 'inTangent', 'outTangent'], 'motion keyframe');
  const size = PROPERTIES[track.kind][track.property];
  const result = {
    time: bounded(keyframe.time, 0, duration, 'Keyframe time'),
    value: valueFrom(keyframe.value, size, 'Keyframe value'),
  };
  validateValue(track.kind, track.property, result.value);
  if (interpolation === 'CUBICSPLINE') {
    result.inTangent = valueFrom(keyframe.inTangent, size, 'Incoming tangent');
    result.outTangent = valueFrom(keyframe.outTangent, size, 'Outgoing tangent');
  } else if (Object.hasOwn(keyframe, 'inTangent') || Object.hasOwn(keyframe, 'outTangent')) {
    throw new TypeError('Tangents require CUBICSPLINE interpolation.');
  }
  return result;
}

function nodeIdFrom(value, nodes, label) {
  if (typeof value !== 'string' || !nodes.has(value)) {
    throw new RangeError(`${label} must be a node ID in this recipe; got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Keyframed IK channels share the motion's clip clock and keyframe budget. */
function ikKeyframes(input, size, duration, label) {
  knownKeys(input, ['keyframes', 'interpolation'], label);
  const interpolation = input.interpolation ?? 'LINEAR';
  if (!['LINEAR', 'STEP', 'SMOOTH'].includes(interpolation)) {
    throw new RangeError(`${label} interpolation must be LINEAR, STEP or SMOOTH.`);
  }
  denseArray(input.keyframes, 64, `${label} keyframes`);
  if (!input.keyframes.length) {
    throw new RangeError(`${label} needs at least one keyframe.`);
  }
  const keyframes = input.keyframes.map(keyframe => {
    knownKeys(keyframe, ['time', 'value'], `${label} keyframe`);
    return { time: bounded(keyframe.time, 0, duration, 'Keyframe time'), value: valueFrom(keyframe.value, size, `${label} value`) };
  });
  return { interpolation, keyframes };
}

function ikPoint(input, nodes, duration, label) {
  if (Array.isArray(input)) {
    return valueFrom(input, 3, label);
  }
  if (input && Object.hasOwn(input, 'node')) {
    knownKeys(input, ['node'], label);
    return { node: nodeIdFrom(input.node, nodes, `${label} node`) };
  }
  if (input && Object.hasOwn(input, 'keyframes')) {
    return ikKeyframes(input, 3, duration, label);
  }
  throw new TypeError(`${label} must be [x, y, z], { "node": id } or { "keyframes": [{ "time", "value" }] }.`);
}

function ikWeight(input, duration, label) {
  if (input === undefined) {
    return 1;
  }
  if (typeof input === 'number') {
    return bounded(input, 0, 1, label);
  }
  const weight = ikKeyframes(input, 1, duration, label);
  weight.keyframes.forEach(keyframe => bounded(keyframe.value, 0, 1, label));
  return weight;
}

function normalizeIkSolver(input, position, nodes, visibleNodes, duration) {
  const label = `Motion ik ${position}`;
  if (input?.type === 'two-bone') {
    knownKeys(input, ['type', 'root', 'middle', 'end', 'target', 'pole', 'weight', 'keepEndRotation'], label);
    const solver = {
      type: 'two-bone',
      root: nodeIdFrom(input.root, nodes, `${label} root`),
      middle: nodeIdFrom(input.middle, nodes, `${label} middle`),
      end: nodeIdFrom(input.end, nodes, `${label} end`),
      target: ikPoint(input.target, visibleNodes, duration, `${label} target`),
      weight: ikWeight(input.weight, duration, `${label} weight`),
    };
    if (input.pole !== undefined) {
      solver.pole = ikPoint(input.pole, visibleNodes, duration, `${label} pole`);
    }
    if (input.keepEndRotation !== undefined) {
      if (typeof input.keepEndRotation !== 'boolean') {
        throw new TypeError(`${label} keepEndRotation must be boolean.`);
      }
      solver.keepEndRotation = input.keepEndRotation;
    }
    return solver;
  }
  if (input?.type === 'aim') {
    knownKeys(input, ['type', 'joint', 'joints', 'forward', 'worldForward', 'target', 'maxAngle', 'weight'], label);
    if (input.forward !== undefined && input.worldForward !== undefined) {
      throw new TypeError(`${label} takes forward or worldForward, not both.`);
    }
    if ((input.joint === undefined) === (input.joints === undefined)) {
      throw new TypeError(`${label} needs joint, or joints listed from the base of the chain to the aiming node.`);
    }
    const names = input.joints === undefined ? [input.joint] : denseArray(input.joints, 16, `${label} joints`);
    if (!names.length) {
      throw new RangeError(`${label} joints cannot be empty.`);
    }
    const solver = {
      type: 'aim',
      joints: names.map(name => nodeIdFrom(name, nodes, `${label} joint`)),
      target: ikPoint(input.target, visibleNodes, duration, `${label} target`),
      weight: ikWeight(input.weight, duration, `${label} weight`),
    };
    if (input.worldForward !== undefined) {
      solver.worldForward = valueFrom(input.worldForward, 3, `${label} worldForward`);
    } else {
      solver.forward = valueFrom(input.forward ?? [0, 0, 1], 3, `${label} forward`);
    }
    if (input.maxAngle !== undefined) {
      solver.maxAngle = bounded(input.maxAngle, 0.001, 180, `${label} maxAngle`);
    }
    return solver;
  }
  throw new RangeError(`${label} type must be two-bone or aim.`);
}

function solverNodes(solver) {
  return solver.type === 'two-bone' ? [solver.root, solver.middle, solver.end] : solver.joints;
}

function pointNodes(solver) {
  return [solver.target, solver.pole].filter(point => point?.node).map(point => point.node);
}

function ancestorsOf(id, nodesById) {
  const found = [];
  let current = nodesById.get(id)?.parent;
  while (current !== undefined && current !== null) {
    found.push(current);
    current = nodesById.get(current)?.parent;
  }
  return found;
}

// The rig math assumes uniform scale. A non-uniform parent would shear what the solver thinks is a rigid chain. A node's
// own scale only reaches its children, so the end of a chain or a lone aimed box can have any size.
function checkIkScales(ik, tracks, recipe) {
  const nodesById = new Map(ikHierarchy(recipe).map(node => [node.id, node]));
  const scaledByTrack = new Set(tracks.filter(track => track.kind === 'node' && track.property === 'scale').map(track => track.id));
  const uniformRequired = new Set();
  for (const solver of ik) {
    for (const id of [...solverNodes(solver), ...pointNodes(solver)]) {
      ancestorsOf(id, nodesById).forEach(ancestor => uniformRequired.add(ancestor));
    }
  }
  for (const id of uniformRequired) {
    if (scaledByTrack.has(id)) {
      throw new RangeError(`Motion ik: node ${id} has IK nodes below it, so it cannot have a scale track.`);
    }
    const scale = nodesById.get(id).scale ?? [1, 1, 1];
    if (Math.max(...scale) - Math.min(...scale) > 1e-3 * Math.max(...scale)) {
      throw new RangeError(`Motion ik: node ${id} has non-uniform scale ${JSON.stringify(scale)}. It has IK nodes below it, so keep it at uniform scale and put the size on a child node with the geometry.`);
    }
  }
}

/** Every node IK can see. An imported asset's editable nodes can sit under fixed ones, which still carry them. */
function ikHierarchy(recipe) {
  return recipe.ikHierarchy ?? recipe.nodes;
}

function normalizeIk(input, recipe, tracks, duration) {
  denseArray(input, MAX_IK_SOLVERS, 'Motion ik');
  const movableNodes = new Set(recipe.nodes.map(node => node.id));
  const visibleNodes = new Set(ikHierarchy(recipe).map(node => node.id));
  const ik = input.map((solver, position) => normalizeIkSolver(solver, position, movableNodes, visibleNodes, duration));
  checkIkScales(ik, tracks, recipe);
  return ik;
}

function ikKeyframeCount(ik) {
  let count = 0;
  for (const solver of ik) {
    for (const channel of [solver.target, solver.pole, solver.weight]) {
      count += channel?.keyframes?.length ?? 0;
    }
  }
  return count;
}

/** Normalize bounded authored data without storing bindings or sampled poses. */
export function normalizeAgentMotion(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, ['duration', 'loop', 'tracks', 'ik'], 'motion');
  const duration = bounded(input.duration, 0.1, 30, 'Motion duration');
  const loop = input.loop === undefined ? false : input.loop;
  if (typeof loop !== 'boolean') {
    throw new TypeError('Motion loop must be boolean.');
  }
  denseArray(input.tracks, 128, 'Motion tracks');
  if (!input.tracks.length && !input.ik?.length) {
    throw new RangeError('Motion needs at least one track or IK solver. Use null to clear it.');
  }
  const nodes = new Set((recipe.nodes ?? []).map(node => node.id));
  const materials = new Set((recipe.materials ?? []).map(material => material.id));
  const identities = new Set();
  let keyframeCount = 0;
  const tracks = input.tracks.map((track, index) => {
    knownKeys(track, ['kind', 'id', 'property', 'interpolation', 'keyframes'], 'motion track');
    if (!Object.hasOwn(PROPERTIES, track.kind) || !Object.hasOwn(PROPERTIES[track.kind], track.property)) {
      throw new RangeError('Unsupported motion target or property.');
    }
    if (track.kind === 'camera') {
      if (Object.hasOwn(track, 'id')) {
        throw new TypeError('Camera tracks cannot have an ID.');
      }
    } else {
      if (typeof track.id !== 'string' || !track.id.trim() || track.id.length > 128) {
        throw new TypeError('Motion target IDs need 1 to 128 characters.');
      }
      const references = track.kind === 'node' ? nodes : materials;
      if (!references.has(track.id)) {
        throw new RangeError(`Motion target was not found: ${track.id}.`);
      }
    }
    const identity = JSON.stringify([track.kind, track.id ?? null, track.property]);
    if (identities.has(identity)) {
      throw new RangeError('Duplicate motion target property.');
    }
    identities.add(identity);
    const interpolation = track.interpolation ?? 'LINEAR';
    if (!INTERPOLATIONS.includes(interpolation)) {
      throw new RangeError('Unsupported motion interpolation.');
    }
    denseArray(track.keyframes, 64, 'Motion keyframes');
    keyframeCount += track.keyframes.length;
    if (keyframeCount > 2048) {
      throw new RangeError('Motion exceeds 2048 total keyframes.');
    }
    const keyframes = track.keyframes.map(keyframe => normalizedKeyframe(keyframe, track, duration, interpolation));
    const clip = createAnimationClip({
      duration, loop,
      tracks: [{ target: String(index), property: coreProperty(track), interpolation, keyframes }],
    });
    const result = {
      kind: track.kind,
      property: track.property,
      interpolation,
      keyframes: clip.tracks[0].keyframes.map(keyframe => copiedKeyframe(keyframe, interpolation)),
    };
    if (track.kind !== 'camera') {
      result.id = track.id;
    }
    return result;
  });
  const result = { duration, loop, tracks };
  if (input.ik !== undefined) {
    result.ik = normalizeIk(input.ik, recipe, tracks, duration);
    if (keyframeCount + ikKeyframeCount(result.ik) > 2048) {
      throw new RangeError('Motion exceeds 2048 total keyframes.');
    }
  }
  return result;
}

/** A rig of just the nodes IK needs: chains, the nodes their targets follow, and all their ancestors. */
function ikRig(ik, recipe) {
  const hierarchy = ikHierarchy(recipe);
  const nodesById = new Map(hierarchy.map(node => [node.id, node]));
  const needed = new Set();
  for (const solver of ik) {
    for (const id of [...solverNodes(solver), ...pointNodes(solver)]) {
      needed.add(id);
      ancestorsOf(id, nodesById).forEach(ancestor => needed.add(ancestor));
    }
  }
  const members = hierarchy.filter(node => needed.has(node.id));
  const indexById = new Map(members.map((node, index) => [node.id, index]));
  return {
    // Identifying joints by node ID alone keeps a node named like a humanoid bone from being mapped to another one.
    mapping: {},
    ...(recipe.ikRootMatrix ? { rootMatrix: recipe.ikRootMatrix } : {}),
    joints: members.map(node => ({
      name: node.id,
      parent: node.parent === undefined || node.parent === null ? -1 : indexById.get(node.parent),
      translation: node.translation ?? [0, 0, 0],
      rotation: node.rotation ?? [0, 0, 0, 1],
      scale: node.scale ?? [1, 1, 1],
    })),
  };
}

function ikChannelClip(ik, duration, loop) {
  const tracks = [];
  ik.forEach((solver, position) => {
    if (solver.target.keyframes) tracks.push({ target: `target ${position}`, property: 'translation', interpolation: solver.target.interpolation, keyframes: solver.target.keyframes });
    if (solver.pole?.keyframes) tracks.push({ target: `pole ${position}`, property: 'translation', interpolation: solver.pole.interpolation, keyframes: solver.pole.keyframes });
    if (solver.weight.keyframes) tracks.push({ target: `weight ${position}`, property: 'value', interpolation: solver.weight.interpolation, keyframes: solver.weight.keyframes });
  });
  return tracks.length ? createAnimationClip({ duration, loop, tracks }) : null;
}

/** Solve a motion's IK on top of its sampled node tracks. Returns staged rotations per node ID. */
function createIkEvaluator(motion, recipe, stagedNodeTracks) {
  const rig = ikRig(motion.ik, recipe);
  const clip = ikChannelClip(motion.ik, motion.duration, motion.loop);
  const channelSampler = clip ? compileAnimationSampler(clip) : null;
  const channelOutput = name => channelSampler.tracks.find(track => track.target === name).output;
  let pose = null;
  const pointReader = (point, name) => {
    if (Array.isArray(point)) return () => point;
    if (point.node) return () => pose.jointWorld(point.node).position;
    const output = channelOutput(name);
    return () => output;
  };
  const definitions = motion.ik.map((solver, position) => {
    const weightOutput = solver.weight.keyframes ? channelOutput(`weight ${position}`) : null;
    const common = {
      target: pointReader(solver.target, `target ${position}`),
      weight: weightOutput ? () => Math.min(1, Math.max(0, weightOutput[0])) : solver.weight,
    };
    if (solver.type === 'aim') {
      return { ...common, type: 'aim', joints: solver.joints, forward: solver.forward, worldForward: solver.worldForward, maxAngle: solver.maxAngle };
    }
    return {
      ...common, type: 'two-bone', root: solver.root, middle: solver.middle, end: solver.end,
      ...(solver.pole ? { pole: pointReader(solver.pole, `pole ${position}`) } : {}),
      keepEndRotation: solver.keepEndRotation,
    };
  });
  pose = createSkeletonPose({ rig, ik: definitions });
  const indexById = new Map(rig.joints.map((joint, index) => [joint.name, index]));
  const baseBindings = rig.joints.map((joint, index) => ({ index, tracks: stagedNodeTracks.get(joint.name) }));
  const solvedIds = new Set(motion.ik.flatMap(solver => {
    if (solver.type === 'aim') return solver.joints;
    return solver.keepEndRotation === false ? [solver.root, solver.middle] : [solver.root, solver.middle, solver.end];
  }));
  const staged = new Map([...solvedIds].map(id => [id, new Float64Array(4)]));
  function setBaseFromTracks(localRotations, localTranslations) {
    for (const { index, tracks } of baseBindings) {
      if (tracks?.rotation) localRotations[index].set(tracks.rotation);
      if (tracks?.translation) localTranslations[index].set(tracks.translation);
    }
  }
  return {
    staged,
    /** Solve for a time. `nodePoses` is a staged { id, translation, rotation } list; without it the base is the tracks. */
    solve(time, nodePoses) {
      channelSampler?.sample(time);
      if (nodePoses) {
        const poseById = new Map(nodePoses.map(nodePose => [nodePose.id, nodePose]));
        pose.apply(time, (localRotations, localTranslations) => {
          rig.joints.forEach((joint, index) => {
            const nodePose = poseById.get(joint.name);
            localRotations[index].set(nodePose.rotation);
            localTranslations[index].set(nodePose.translation);
          });
        });
      } else {
        pose.apply(time, setBaseFromTracks);
      }
      for (const [id, rotation] of staged) {
        rotation.set(pose.localRotation(indexById.get(id)));
        if (!rotation.every(Number.isFinite)) throw new RangeError(`Motion ik produced an invalid rotation for node ${id}.`);
      }
      return pose.ikResults;
    },
  };
}

function validateRadiance(material) {
  const emission = material.emission ?? 0;
  const color = material.emissiveColor ?? material.color ?? [0.5, 0.5, 0.5];
  for (const component of color) {
    const radiance = Math.fround(component) * Math.fround(emission);
    if (!Number.isFinite(Math.fround(radiance))) {
      throw new RangeError('Motion emissive radiance exceeds Float32 range.');
    }
    if (material.tag === 'unlit' && radiance > 65500) {
      throw new RangeError('Motion unlit radiance exceeds the HDR range.');
    }
  }
}

/** Retains published maps and vectors. A failed sample leaves them unchanged. */
export function compileAgentMotion(input, recipe) {
  const motion = normalizeAgentMotion(input, recipe);
  if (motion === null) {
    return null;
  }
  const ordinaryTracks = motion.tracks.filter(track => track.kind !== 'camera');
  const clip = createAnimationClip({
    duration: motion.duration,
    loop: motion.loop,
    tracks: ordinaryTracks.map((track, index) => ({
      target: String(index),
      property: coreProperty(track),
      interpolation: track.interpolation,
      keyframes: track.keyframes,
    })),
  });
  const sampler = compileAnimationSampler(clip);
  const output = { nodes: new Map(), materials: new Map(), camera: null };
  const bindings = ordinaryTracks.map((track, index) => {
    const patches = track.kind === 'node' ? output.nodes : output.materials;
    if (!patches.has(track.id)) {
      patches.set(track.id, {});
    }
    const patch = patches.get(track.id);
    const size = PROPERTIES[track.kind][track.property];
    patch[track.property] = size === 1 ? 0 : new Float64Array(size);
    return { track, patch, staged: sampler.tracks[index].output };
  });
  const stagedNodeTracks = new Map();
  for (const { track, staged } of bindings) {
    if (track.kind !== 'node') continue;
    if (!stagedNodeTracks.has(track.id)) stagedNodeTracks.set(track.id, {});
    stagedNodeTracks.get(track.id)[track.property] = staged;
  }
  const ikEvaluator = motion.ik?.length ? createIkEvaluator(motion, recipe, stagedNodeTracks) : null;
  // An imported asset's base pose comes from its decoder, so it asks for IK itself with solveStagedIk.
  const ikUsesStagedPose = Boolean(ikEvaluator && recipe.ikHierarchy);
  if (ikEvaluator && !ikUsesStagedPose) {
    for (const id of ikEvaluator.staged.keys()) {
      if (!output.nodes.has(id)) output.nodes.set(id, {});
      const nodePatch = output.nodes.get(id);
      if (!nodePatch.rotation) nodePatch.rotation = new Float64Array(4);
    }
  }
  const baselines = new Map((recipe.materials ?? []).map(material => [material.id, structuredClone(material)]));
  const cameraTracks = motion.tracks.filter(track => track.kind === 'camera');
  const cameraInput = {
    ...structuredClone(CAMERA_DEFAULTS),
    ...structuredClone(recipe.camera ?? {}),
    duration: motion.duration,
    loop: motion.loop,
  };
  for (const track of cameraTracks) {
    cameraInput[track.property] = { interpolation: track.interpolation, keyframes: track.keyframes };
  }
  const cameraPath = cameraTracks.length ? createCameraPath(cameraInput) : null;
  const stagedCamera = cameraPath ? { eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3) } : null;
  if (cameraPath) {
    output.camera = {
      eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3),
      fov: 45, near: cameraInput.near, far: cameraInput.far, projection: 'perspective',
    };
  }
  const materialSamples = new Map([...output.materials.keys()].map(id => [id, { ...baselines.get(id) }]));
  return Object.freeze({
    ikUsesStagedPose,
    /** Solve IK over a pose an asset staged for this time. Returns the node rotations to add. */
    solveStagedIk(time, nodePoses) {
      ikEvaluator.solve(time, nodePoses);
      return [...ikEvaluator.staged].map(([id, rotation]) => ({ id, rotation: Array.from(rotation) }));
    },
    /**
     * How IK fares across the whole clip: one { type, reached, worstError, atTime } per solver. Moves the sampler.
     * `stagedPoseAt(time)` supplies the base pose when the asset owns it.
     */
    sweepIk(stagedPoseAt) {
      if (!ikEvaluator) return [];
      const worst = motion.ik.map(solver => ({ type: solver.type, reached: true, worstError: 0, atTime: 0 }));
      for (let sample = 0; sample < IK_SWEEP_SAMPLES; sample++) {
        const time = motion.duration * sample / (IK_SWEEP_SAMPLES - 1);
        sampler.sample(time);
        ikEvaluator.solve(time, stagedPoseAt?.(time)).forEach((result, position) => {
          const record = worst[position];
          record.reached = record.reached && result.reached;
          if (result.error > record.worstError) {
            record.worstError = Number(result.error.toFixed(6));
            record.atTime = Number(time.toFixed(3));
          }
        });
      }
      return worst;
    },
    sample(time) {
      bounded(time, 0, 3600, 'Motion sample time');
      sampler.sample(time);
      for (const { track, staged } of bindings) {
        const value = staged.length === 1 ? staged[0] : staged;
        validateValue(track.kind, track.property, value);
        if (track.kind === 'material') {
          materialSamples.get(track.id)[track.property] = value;
        }
      }
      for (const material of materialSamples.values()) {
        validateRadiance(material);
      }
      if (cameraPath) {
        cameraPath.sample(time, stagedCamera);
        for (const field of ['fov', 'near', 'far']) {
          finite(stagedCamera[field], `Camera ${field}`);
        }
        if (Math.fround(stagedCamera.fov) <= 0 || Math.fround(stagedCamera.fov) >= 180 ||
            Math.fround(stagedCamera.near) <= 0 || Math.fround(stagedCamera.far) <= Math.fround(stagedCamera.near)) {
          throw new RangeError('Sampled camera lens is invalid at Float32 precision.');
        }
      }
      if (!ikUsesStagedPose) ikEvaluator?.solve(time);
      // Publish only after every track, material product, camera pose and IK solve passes.
      for (const { track, patch, staged } of bindings) {
        if (staged.length === 1) {
          patch[track.property] = staged[0];
        } else {
          patch[track.property].set(staged);
        }
      }
      if (ikEvaluator && !ikUsesStagedPose) {
        for (const [id, rotation] of ikEvaluator.staged) output.nodes.get(id).rotation.set(rotation);
      }
      if (cameraPath) {
        for (const field of ['eye', 'target', 'up']) {
          output.camera[field].set(stagedCamera[field]);
        }
        for (const field of ['fov', 'near', 'far']) {
          output.camera[field] = stagedCamera[field];
        }
      }
      return output;
    },
  });
}
