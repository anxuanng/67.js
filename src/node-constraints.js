import { mat4, quat, vec3 } from 'gl-matrix';
import { compileMotionExpression } from './motion-expression.js';
import { bounded, denseArray, knownKeys, valueFrom } from './motion-validation.js';
import { eulerFromQuaternion, quaternionFromEuler } from './rotation-euler.js';

// Node constraints and drivers, evaluated in this order for any time, with no state kept between calls:
//   1. Base pose: the node values after tracks and IK.
//   2. Drivers, in list order. They read the base pose, so one driver never sees another's result.
//   3. Constraints, in list order. Each reads the pose the ones before it left, including its target's constrained pose.
// Seeking to a time therefore gives the same pose as playing up to it. Constraints act on a node's world matrix and
// keep Blender's meaning: Euler angles are XYZ in degrees, copy and limit work per axis, influence blends the matrix
// before and after, and child_of multiplies the owner by the target's matrix and an inverse.

export const MAX_CONSTRAINTS = 32;
export const MAX_DRIVERS = 32;
const AXES = ['x', 'y', 'z'];
const SIGNED_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];
const TO_RADIANS = Math.PI / 180;
const NEAR_ZERO = 1e-9;
const MAX_COORDINATE = 1e6;
const SPACES = ['world', 'local'];
const MATERIAL_SCALARS = ['emission', 'metallic', 'roughness'];
const MATERIAL_VECTORS = ['color', 'emissiveColor'];

const COMMON_FIELDS = ['type', 'node', 'influence'];
const CONSTRAINT_FIELDS = {
  copy_location: ['target', 'axes', 'invert', 'offset', 'space'],
  copy_rotation: ['target', 'axes', 'invert', 'mix', 'space'],
  copy_scale: ['target', 'axes', 'offset', 'space'],
  limit_location: ['x', 'y', 'z', 'space'],
  limit_rotation: ['x', 'y', 'z', 'space'],
  track_to: ['target', 'trackAxis', 'upAxis', 'worldUp'],
  child_of: ['target', 'inverse'],
  floor: ['target', 'axis', 'offset'],
};
export const CONSTRAINT_TYPES = Object.freeze(Object.keys(CONSTRAINT_FIELDS));

// ---------------------------------------------------------------------------------------------------------------
// Input

function axisList(value, label) {
  if (value === undefined) return [...AXES];
  denseArray(value, 3, label);
  if (!value.length || value.some(axis => !AXES.includes(axis)) || new Set(value).size !== value.length) {
    throw new RangeError(`${label} must list distinct axes from x, y and z.`);
  }
  return [...value];
}

function oneOf(value, allowed, fallback, label) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new RangeError(`${label} must be one of ${allowed.join(', ')}.`);
  return value;
}

function axisRanges(input, limit, label) {
  const ranges = {};
  for (const axis of AXES) {
    if (input[axis] === undefined) continue;
    const range = valueFrom(input[axis], 2, `${label} ${axis}`);
    if (range[0] > range[1] || Math.abs(range[0]) > limit || Math.abs(range[1]) > limit) {
      throw new RangeError(`${label} ${axis} must be [min, max] within ${-limit} and ${limit}, min first.`);
    }
    ranges[axis] = range;
  }
  if (!Object.keys(ranges).length) throw new RangeError(`${label} needs an x, y or z range.`);
  return ranges;
}

function influenceFrom(value, nodeIds, label) {
  if (value === undefined) return 1;
  if (typeof value === 'number') return bounded(value, 0, 1, `${label} influence`);
  compileMotionExpression(value, nodeIds, `${label} influence`);
  return structuredClone(value);
}

function normalizeConstraint(input, position, movableIds, visibleIds) {
  const label = `Motion constraint ${position}`;
  if (!input || !Object.hasOwn(CONSTRAINT_FIELDS, input.type)) {
    throw new RangeError(`${label} type must be one of ${CONSTRAINT_TYPES.join(', ')}.`);
  }
  knownKeys(input, [...COMMON_FIELDS, ...CONSTRAINT_FIELDS[input.type]], label);
  if (!movableIds.has(input.node)) throw new RangeError(`${label} node must be a node ID in this recipe; got ${JSON.stringify(input.node)}.`);
  const result = { type: input.type, node: input.node, influence: influenceFrom(input.influence, visibleIds, label) };
  if (CONSTRAINT_FIELDS[input.type].includes('target')) {
    if (!visibleIds.has(input.target)) throw new RangeError(`${label} target must be a node ID in this recipe; got ${JSON.stringify(input.target)}.`);
    if (input.target === input.node) throw new RangeError(`${label} target cannot be the constrained node itself.`);
    result.target = input.target;
  }
  if (CONSTRAINT_FIELDS[input.type].includes('space')) result.space = oneOf(input.space, SPACES, 'world', `${label} space`);
  switch (input.type) {
    case 'copy_location':
    case 'copy_rotation':
    case 'copy_scale':
      result.axes = axisList(input.axes, `${label} axes`);
      if (input.invert !== undefined) {
        if (input.type === 'copy_scale') throw new TypeError(`${label} does not take invert.`);
        result.invert = axisList(input.invert, `${label} invert`);
      }
      if (input.offset !== undefined) {
        if (typeof input.offset !== 'boolean' || input.type === 'copy_rotation') throw new TypeError(`${label} offset must be a boolean on copy_location and copy_scale.`);
        result.offset = input.offset;
      }
      if (input.type === 'copy_rotation') result.mix = oneOf(input.mix, ['replace', 'add'], 'replace', `${label} mix`);
      break;
    case 'limit_location':
      Object.assign(result, axisRanges(input, MAX_COORDINATE, label));
      break;
    case 'limit_rotation':
      Object.assign(result, axisRanges(input, 180, label));
      break;
    case 'track_to': {
      result.trackAxis = oneOf(input.trackAxis, SIGNED_AXES, '-z', `${label} trackAxis`);
      result.upAxis = oneOf(input.upAxis, AXES, 'y', `${label} upAxis`);
      if (result.trackAxis.slice(1) === result.upAxis) throw new RangeError(`${label} trackAxis and upAxis must be different axes.`);
      result.worldUp = input.worldUp === undefined ? [0, 1, 0] : valueFrom(input.worldUp, 3, `${label} worldUp`);
      if (vec3.length(result.worldUp) < NEAR_ZERO) throw new RangeError(`${label} worldUp cannot be zero.`);
      break;
    }
    case 'child_of':
      result.inverse = oneOf(input.inverse, ['rest', 'none'], 'rest', `${label} inverse`);
      break;
    default:
      result.axis = oneOf(input.axis, SIGNED_AXES, '+y', `${label} axis`);
      result.offset = input.offset === undefined ? 0 : bounded(input.offset, -MAX_COORDINATE, MAX_COORDINATE, `${label} offset`);
  }
  return result;
}

/** Validate a constraint list against the node IDs a motion may move and the ones it may read. Returns plain data. */
export function normalizeConstraints(input, movableIds, visibleIds) {
  denseArray(input, MAX_CONSTRAINTS, 'Motion constraints');
  return input.map((constraint, position) => normalizeConstraint(constraint, position, movableIds, visibleIds));
}

function normalizeDriver(input, position, movableIds, materialIds, visibleIds) {
  const label = `Motion driver ${position}`;
  knownKeys(input, ['target', 'expression'], label);
  knownKeys(input.target, ['kind', 'id', 'property', 'component'], `${label} target`);
  const { kind, id, property, component } = input.target;
  if (component !== undefined && !AXES.includes(component)) throw new RangeError(`${label} component must be x, y or z.`);
  if (kind === 'node') {
    if (!movableIds.has(id)) throw new RangeError(`${label} node must be a node ID in this recipe; got ${JSON.stringify(id)}.`);
    if (!['translation', 'rotation', 'scale'].includes(property)) throw new RangeError(`${label} property must be translation, rotation or scale.`);
    if (component === undefined) throw new RangeError(`${label} needs a component: x, y or z. Rotation is Euler XYZ in degrees.`);
  } else if (kind === 'material') {
    if (!materialIds.has(id)) throw new RangeError(`${label} material was not found: ${JSON.stringify(id)}.`);
    const isVector = MATERIAL_VECTORS.includes(property);
    if (!isVector && !MATERIAL_SCALARS.includes(property)) throw new RangeError(`${label} property must be one of ${[...MATERIAL_VECTORS, ...MATERIAL_SCALARS].join(', ')}.`);
    if (isVector !== (component !== undefined)) throw new RangeError(`${label}: color properties need a component (x, y, z for red, green, blue); the others take none.`);
  } else {
    throw new RangeError(`${label} target kind must be node or material.`);
  }
  compileMotionExpression(input.expression, visibleIds, `${label} expression`);
  return { target: { kind, id, property, ...(component === undefined ? {} : { component }) }, expression: structuredClone(input.expression) };
}

export function normalizeDrivers(input, movableIds, materialIds, visibleIds) {
  denseArray(input, MAX_DRIVERS, 'Motion drivers');
  const seen = new Set();
  return input.map((driver, position) => {
    const normalized = normalizeDriver(driver, position, movableIds, materialIds, visibleIds);
    const identity = JSON.stringify(Object.values(normalized.target));
    if (seen.has(identity)) throw new RangeError(`Motion driver ${position} drives the same property as an earlier driver.`);
    seen.add(identity);
    return normalized;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Matrices and frames. A frame is { translation, rotation, scale }.

// gl-matrix's getRotation divides the wrong entries by the scale, so non-uniform scale gives a wrong rotation.
function rotationOfMatrix(matrix, scale) {
  const axes = [0, 4, 8].map((start, column) => Array.from(matrix.slice(start, start + 3), component => component / (scale[column] || 1)));
  return quat.normalize(new Float64Array(4), quat.fromMat3(new Float64Array(4), axes.flat()));
}

function decompose(matrix) {
  const scale = mat4.getScaling(new Float64Array(3), matrix);
  return { translation: mat4.getTranslation(new Float64Array(3), matrix), rotation: rotationOfMatrix(matrix, scale), scale };
}

function compose(frame) {
  return mat4.fromRotationTranslationScale(new Float64Array(16), frame.rotation, frame.translation, frame.scale);
}

function copyFrame(frame) {
  return { translation: Float64Array.from(frame.translation), rotation: Float64Array.from(frame.rotation), scale: Float64Array.from(frame.scale) };
}

/** Blend two world matrices the way Blender blends a constraint's influence: location, rotation and scale separately. */
function blendMatrices(before, after, influence) {
  if (influence >= 1) return after;
  const from = decompose(before);
  const to = decompose(after);
  return compose({
    translation: vec3.lerp(new Float64Array(3), from.translation, to.translation, influence),
    rotation: quat.slerp(new Float64Array(4), from.rotation, to.rotation, influence),
    scale: vec3.lerp(new Float64Array(3), from.scale, to.scale, influence),
  });
}

function signOf(axis) {
  return axis.startsWith('-') ? -1 : 1;
}

function axisIndex(axis) {
  return AXES.indexOf(axis.replace(/^[+-]/, ''));
}

// ---------------------------------------------------------------------------------------------------------------
// Constraint operators on frames (copy and limit) and on matrices (track_to, child_of, floor).

function copyLocation(owner, target, constraint) {
  for (const axis of constraint.axes) {
    const index = axisIndex(axis);
    const sign = constraint.invert?.includes(axis) ? -1 : 1;
    owner.translation[index] = (constraint.offset ? owner.translation[index] : 0) + sign * target.translation[index];
  }
}

function copyRotation(owner, target, constraint) {
  const angles = eulerFromQuaternion(owner.rotation);
  const wanted = eulerFromQuaternion(target.rotation);
  for (const axis of constraint.axes) {
    const index = axisIndex(axis);
    const sign = constraint.invert?.includes(axis) ? -1 : 1;
    angles[index] = (constraint.mix === 'add' ? angles[index] : 0) + sign * wanted[index];
  }
  quaternionFromEuler(owner.rotation, angles[0], angles[1], angles[2]);
}

function copyScale(owner, target, constraint) {
  for (const axis of constraint.axes) {
    const index = axisIndex(axis);
    owner.scale[index] = (constraint.offset ? owner.scale[index] : 1) * target.scale[index];
  }
}

function limitLocation(owner, target, constraint) {
  for (const axis of AXES) {
    if (!constraint[axis]) continue;
    const index = axisIndex(axis);
    owner.translation[index] = Math.min(constraint[axis][1], Math.max(constraint[axis][0], owner.translation[index]));
  }
}

function limitRotation(owner, target, constraint) {
  const angles = eulerFromQuaternion(owner.rotation);
  for (const axis of AXES) {
    if (!constraint[axis]) continue;
    const index = axisIndex(axis);
    angles[index] = Math.min(constraint[axis][1] * TO_RADIANS, Math.max(constraint[axis][0] * TO_RADIANS, angles[index]));
  }
  quaternionFromEuler(owner.rotation, angles[0], angles[1], angles[2]);
}

const FRAME_CONSTRAINTS = {
  copy_location: copyLocation, copy_rotation: copyRotation, copy_scale: copyScale,
  limit_location: limitLocation, limit_rotation: limitRotation,
};

function perpendicularTo(direction) {
  const reference = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return vec3.normalize(new Float64Array(3), vec3.cross(new Float64Array(3), direction, reference));
}

/** Turn the owner so its track axis points at the target and its up axis leans toward worldUp. Position and scale stay. */
function trackTo(ownerWorld, targetWorld, constraint) {
  const frame = decompose(ownerWorld);
  const forward = vec3.subtract(new Float64Array(3), mat4.getTranslation(new Float64Array(3), targetWorld), frame.translation);
  if (vec3.length(forward) < NEAR_ZERO) return ownerWorld;
  vec3.normalize(forward, forward);
  const worldUp = vec3.normalize(new Float64Array(3), constraint.worldUp);
  const up = vec3.scaleAndAdd(new Float64Array(3), worldUp, forward, -vec3.dot(worldUp, forward));
  if (vec3.length(up) < 1e-6) vec3.copy(up, perpendicularTo(forward));
  vec3.normalize(up, up);
  const trackIndex = axisIndex(constraint.trackAxis);
  const upIndex = AXES.indexOf(constraint.upAxis);
  const columns = [null, null, null];
  columns[trackIndex] = vec3.scale(new Float64Array(3), forward, signOf(constraint.trackAxis));
  columns[upIndex] = up;
  const thirdIndex = 3 - trackIndex - upIndex;
  columns[thirdIndex] = vec3.cross(new Float64Array(3), columns[(thirdIndex + 1) % 3], columns[(thirdIndex + 2) % 3]);
  frame.rotation = quat.normalize(new Float64Array(4), quat.fromMat3(new Float64Array(4), columns.flatMap(column => Array.from(column))));
  return compose(frame);
}

function floorConstraint(ownerWorld, targetWorld, constraint) {
  const normal = new Float64Array(3);
  normal[axisIndex(constraint.axis)] = signOf(constraint.axis);
  const position = mat4.getTranslation(new Float64Array(3), ownerWorld);
  const planePoint = mat4.getTranslation(new Float64Array(3), targetWorld);
  const height = vec3.dot(vec3.subtract(new Float64Array(3), position, planePoint), normal);
  if (height >= constraint.offset) return ownerWorld;
  const lifted = mat4.clone(ownerWorld);
  const raise = constraint.offset - height;
  for (let index = 0; index < 3; index++) lifted[12 + index] += normal[index] * raise;
  return lifted;
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation

function topologicalOrder(hierarchy, indexById) {
  const order = [];
  const visited = new Uint8Array(hierarchy.length);
  const visit = index => {
    if (visited[index]) return;
    visited[index] = 1;
    const parent = hierarchy[index].parent;
    if (parent !== undefined && parent !== null) visit(indexById.get(parent));
    order.push(index);
  };
  hierarchy.forEach((node, index) => visit(index));
  return order;
}

function restFrame(node) {
  return {
    translation: Float64Array.from(node.translation ?? [0, 0, 0]),
    rotation: Float64Array.from(node.rotation ?? [0, 0, 0, 1]),
    scale: Float64Array.from(node.scale ?? [1, 1, 1]),
  };
}

function wantsEvaluation(constraints, drivers) {
  return Boolean(constraints?.length || drivers?.length);
}

/**
 * Build an evaluator over { hierarchy, rootMatrix, constraints, drivers, materials }. `hierarchy` lists every node as
 * { id, parent, translation, rotation, scale }. `evaluate(time, bases)` takes the base pose as a Map of node ID to
 * { translation, rotation, scale } (missing parts use the rest pose) and returns the final local frames of every node
 * a driver or constraint writes, plus driven material values. The base arrays are not changed.
 */
export function createNodeConstraintEvaluator({ hierarchy, rootMatrix, constraints = [], drivers = [], materials = [] }) {
  if (!wantsEvaluation(constraints, drivers)) return null;
  const indexById = new Map(hierarchy.map((node, index) => [node.id, index]));
  const order = topologicalOrder(hierarchy, indexById);
  const parentIndices = hierarchy.map(node => (node.parent === undefined || node.parent === null ? -1 : indexById.get(node.parent)));
  const rootWorld = rootMatrix ? mat4.clone(rootMatrix) : mat4.create();
  const nodeIds = new Set(indexById.keys());
  const materialBaselines = new Map(materials.map(material => [material.id, material]));
  const compiledDrivers = drivers.map(driver => ({ ...driver, compiled: compileMotionExpression(driver.expression, nodeIds, 'Motion driver expression') }));
  const compiledConstraints = constraints.map(constraint => ({
    ...constraint,
    compiledInfluence: typeof constraint.influence === 'number' ? null : compileMotionExpression(constraint.influence, nodeIds, 'Motion constraint influence'),
  }));

  function computeWorlds(locals) {
    const worlds = new Array(hierarchy.length);
    for (const index of order) {
      const parentWorld = parentIndices[index] >= 0 ? worlds[parentIndices[index]] : rootWorld;
      worlds[index] = mat4.multiply(new Float64Array(16), parentWorld, compose(locals[index]));
    }
    return worlds;
  }

  const restLocals = hierarchy.map(restFrame);
  const restWorlds = computeWorlds(restLocals);

  function readFrom(locals, worlds) {
    return (id, property, component, space) => {
      const index = indexById.get(id);
      const frame = space === 'world' ? decompose(worlds[index]) : locals[index];
      if (property === 'rotation') return eulerFromQuaternion(frame.rotation)[component] / TO_RADIANS;
      return frame[property][component];
    };
  }

  function applyDriver(driver, locals, context, touchedMaterials) {
    const value = driver.compiled.evaluate(context);
    const { kind, id, property, component } = driver.target;
    const index = AXES.indexOf(component);
    if (kind === 'material') {
      if (index < 0) {
        touchedMaterials.set(id, { ...touchedMaterials.get(id), [property]: value });
        return;
      }
      const current = touchedMaterials.get(id)?.[property] ?? Array.from(materialBaselines.get(id)?.[property] ?? [0.5, 0.5, 0.5]);
      current[index] = value;
      touchedMaterials.set(id, { ...touchedMaterials.get(id), [property]: current });
      return;
    }
    const frame = locals[indexById.get(id)];
    if (property === 'rotation') {
      const angles = eulerFromQuaternion(frame.rotation);
      angles[index] = value * TO_RADIANS;
      quaternionFromEuler(frame.rotation, angles[0], angles[1], angles[2]);
      return;
    }
    if (property === 'scale' && !(Math.fround(value) > 0)) throw new RangeError(`Motion driver made the scale of ${id} not positive (${value}).`);
    frame[property][index] = value;
  }

  function applyConstraint(constraint, locals, context) {
    const worlds = computeWorlds(locals);
    const ownerIndex = indexById.get(constraint.node);
    const parentWorld = parentIndices[ownerIndex] >= 0 ? worlds[parentIndices[ownerIndex]] : rootWorld;
    const ownerWorld = worlds[ownerIndex];
    const targetIndex = constraint.target === undefined ? -1 : indexById.get(constraint.target);
    const influence = constraint.compiledInfluence ? Math.min(1, Math.max(0, constraint.compiledInfluence.evaluate(context))) : constraint.influence;
    let result;
    if (FRAME_CONSTRAINTS[constraint.type]) {
      const inLocalSpace = constraint.space === 'local';
      const owner = inLocalSpace ? copyFrame(locals[ownerIndex]) : decompose(ownerWorld);
      const target = targetIndex < 0 ? null : (inLocalSpace ? locals[targetIndex] : decompose(worlds[targetIndex]));
      FRAME_CONSTRAINTS[constraint.type](owner, target, constraint);
      result = inLocalSpace ? mat4.multiply(new Float64Array(16), parentWorld, compose(owner)) : compose(owner);
    } else if (constraint.type === 'track_to') {
      result = trackTo(ownerWorld, worlds[targetIndex], constraint);
    } else if (constraint.type === 'floor') {
      result = floorConstraint(ownerWorld, worlds[targetIndex], constraint);
    } else {
      const inverse = constraint.inverse === 'rest' ? mat4.invert(new Float64Array(16), restWorlds[targetIndex]) : mat4.create();
      const parent = mat4.multiply(new Float64Array(16), worlds[targetIndex], inverse);
      result = mat4.multiply(new Float64Array(16), parent, ownerWorld);
    }
    const blended = blendMatrices(ownerWorld, result, influence);
    const local = mat4.multiply(new Float64Array(16), mat4.invert(new Float64Array(16), parentWorld), blended);
    locals[ownerIndex] = decompose(local);
  }

  return Object.freeze({
    evaluate(time, bases = new Map()) {
      const baseLocals = hierarchy.map((node, index) => {
        const base = bases.get(node.id);
        const frame = copyFrame(restLocals[index]);
        if (base?.translation) frame.translation.set(base.translation);
        if (base?.rotation) frame.rotation.set(base.rotation);
        if (base?.scale) frame.scale.set(base.scale);
        return frame;
      });
      const context = { time, read: readFrom(baseLocals, computeWorlds(baseLocals)) };
      const locals = baseLocals.map(copyFrame);
      const touchedMaterials = new Map();
      for (const driver of compiledDrivers) applyDriver(driver, locals, context, touchedMaterials);
      for (const constraint of compiledConstraints) applyConstraint(constraint, locals, context);
      const written = new Set([...compiledDrivers.filter(driver => driver.target.kind === 'node').map(driver => driver.target.id), ...compiledConstraints.map(constraint => constraint.node)]);
      const nodes = new Map([...written].map(id => [id, locals[indexById.get(id)]]));
      for (const [id, frame] of nodes) {
        if (![...frame.translation, ...frame.rotation, ...frame.scale].every(Number.isFinite)) throw new RangeError(`Motion constraints produced an invalid pose for node ${id}.`);
        if (frame.scale.some(component => !(Math.fround(component) > 0))) throw new RangeError(`Motion constraints made the scale of node ${id} not positive.`);
      }
      return { nodes, materials: touchedMaterials };
    },
  });
}
