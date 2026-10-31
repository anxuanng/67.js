import { mat4, vec3 } from 'gl-matrix';
import { createAnimationClip } from './animation.js';
import { createSkinPose, updateSkinPose } from './skinning.js';
import { presetBones, RIG_PRESETS } from './rig-presets.js';

// Authored rigs. An armature expands into plain recipe nodes (one per bone, parented like the bones), so keyframed bone
// rotation and `motion.ik` run through the same code as for any node. A node with `skin` binds its mesh to those bones.
//
// Weight method: distance to each bone segment with an inverse-power falloff, the nearest four bones kept. It depends only
// on a vertex's position, so the split vertices of a hard edge get identical weights and seams never open. Bone heat
// diffusion would need a sparse solve per bone, and a geodesic falloff would cost a mesh graph walk, for a result that
// differs only where two limbs pass close to each other; the unweighted-vertex and unused-bone diagnostics cover the rest.

export const MAX_ARMATURES = 16;
export const MAX_BONES = 128;
const MAX_INFLUENCES = 4;
const FALLOFF_POWER = 4;
const SOFTNESS_OF_SPAN = 0.02;
const DEFAULT_REACH_OF_SPAN = 0.25;
const STRAIGHT_CHAIN_RATIO = 0.002;
const ZERO_LENGTH = 1e-6;
const MAX_ANCESTOR_DEPTH = 256;
const FORWARD = [0, 0, 1];

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
}

function allowKeys(value, allowed, label) {
  plainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has an unsupported field: ${JSON.stringify(key.slice(0, 48))}.`);
  }
}

function checkedName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new TypeError(`${label} must be a name of 1 to 64 characters.`);
  return value;
}

function checkedVector(value, size, label) {
  if (!Array.isArray(value) || value.length !== size || value.some(component => !Number.isFinite(component))) {
    throw new TypeError(`${label} must be an array of ${size} finite numbers.`);
  }
  return value.slice();
}

function checkedBounds(value, label) {
  allowKeys(value, ['min', 'max'], label);
  const bounds = { min: checkedVector(value.min, 3, `${label} min`), max: checkedVector(value.max, 3, `${label} max`) };
  if (bounds.max.some((component, axis) => component <= bounds.min[axis])) throw new RangeError(`${label} must have max above min on every axis.`);
  return bounds;
}

function orderBones(bones, armatureId) {
  const byName = new Map(bones.map(bone => [bone.name, bone]));
  const ordered = [];
  const state = new Map();
  function visit(bone) {
    if (state.get(bone.name) === 2) return;
    if (state.get(bone.name) === 1) throw new RangeError(`Armature ${armatureId} bones form a cycle at ${bone.name}.`);
    state.set(bone.name, 1);
    if (bone.parent !== null) visit(byName.get(bone.parent));
    state.set(bone.name, 2);
    ordered.push(bone);
  }
  bones.forEach(visit);
  return ordered;
}

function normalizeBones(input, armatureId) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_BONES) throw new RangeError(`Armature ${armatureId} needs 1 to ${MAX_BONES} bones.`);
  const names = new Set();
  const bones = input.map((value, position) => {
    const label = `Armature ${armatureId} bone ${position}`;
    allowKeys(value, ['name', 'parent', 'head', 'tail'], label);
    const name = checkedName(value.name, `${label} name`);
    if (names.has(name)) throw new RangeError(`Armature ${armatureId} repeats bone ${name}.`);
    names.add(name);
    const bone = { name, parent: value.parent === undefined || value.parent === null ? null : checkedName(value.parent, `${label} parent`), head: checkedVector(value.head, 3, `${label} head`) };
    if (value.tail !== undefined) bone.tail = checkedVector(value.tail, 3, `${label} tail`);
    return bone;
  });
  for (const bone of bones) {
    if (bone.parent !== null && !names.has(bone.parent)) throw new RangeError(`Armature ${armatureId} bone ${bone.name} names an unknown parent ${bone.parent}.`);
  }
  return orderBones(bones, armatureId);
}

function fitBounds(armature, fit, resolveBounds) {
  if (fit === undefined) throw new TypeError(`Armature ${armature.id} preset needs fit: { node } or fit: { bounds }.`);
  allowKeys(fit, ['node', 'bounds', 'landmarks'], `Armature ${armature.id} fit`);
  if ((fit.node === undefined) === (fit.bounds === undefined)) throw new TypeError(`Armature ${armature.id} fit takes node or bounds, not both.`);
  return fit.bounds === undefined ? resolveBounds(armature, fit.node) : checkedBounds(fit.bounds, `Armature ${armature.id} fit bounds`);
}

function checkedLandmarks(value, armatureId) {
  if (value === undefined) return {};
  plainObject(value, `Armature ${armatureId} landmarks`);
  return Object.fromEntries(Object.entries(value).map(([name, point]) => [name, checkedVector(point, 3, `Armature ${armatureId} landmark ${name}`)]));
}

/**
 * Validate the recipe `armatures` list. Presets are resolved to explicit bones here, so a stored recipe never changes when
 * the mesh does. `resolveBounds(armature, nodeId)` returns a node's bounds in the armature's own space.
 */
export function normalizeArmatures(input, { resolveBounds }) {
  if (!Array.isArray(input) || input.length > MAX_ARMATURES) throw new RangeError(`armatures must be an array of at most ${MAX_ARMATURES}.`);
  const ids = new Set();
  return input.map(value => {
    allowKeys(value, ['id', 'parent', 'translation', 'rotation', 'prefix', 'preset', 'fit', 'bones'], 'armature');
    const id = checkedName(value.id, 'armature id');
    if (ids.has(id)) throw new RangeError(`Duplicate armature ID: ${id}.`);
    ids.add(id);
    const rotation = checkedVector(value.rotation ?? [0, 0, 0, 1], 4, `Armature ${id} rotation`);
    const length = Math.hypot(...rotation);
    if (length === 0) throw new RangeError(`Armature ${id} rotation must be nonzero.`);
    const armature = {
      id, parent: value.parent === undefined || value.parent === null ? null : checkedName(value.parent, `Armature ${id} parent`),
      translation: checkedVector(value.translation ?? [0, 0, 0], 3, `Armature ${id} translation`),
      rotation: rotation.map(component => component / length),
      prefix: value.prefix === undefined || value.prefix === '' ? '' : checkedName(value.prefix, `Armature ${id} prefix`),
    };
    if ((value.preset === undefined) === (value.bones === undefined)) throw new TypeError(`Armature ${id} needs preset or bones, not both.`);
    if (value.preset === undefined) {
      if (value.fit !== undefined) throw new TypeError(`Armature ${id} fit only applies to a preset.`);
      return { ...armature, bones: normalizeBones(value.bones, id) };
    }
    if (!RIG_PRESETS.includes(value.preset)) throw new RangeError(`Armature ${id} preset must be one of ${RIG_PRESETS.join(', ')}.`);
    const bounds = fitBounds(armature, value.fit, resolveBounds);
    return { ...armature, bones: normalizeBones(presetBones(value.preset, bounds, checkedLandmarks(value.fit.landmarks, id)), id) };
  });
}

/** Node ID of a bone. */
export function boneNodeId(armature, boneName) {
  return `${armature.prefix}${boneName}`;
}

/** The nodes an armature stands for: its root, then each bone parented to the bone before it, placed by head offsets. */
export function armatureNodes(armature) {
  const headByName = new Map(armature.bones.map(bone => [bone.name, bone.head]));
  const rootNode = { id: armature.id, parent: armature.parent, translation: armature.translation, rotation: armature.rotation, scale: [1, 1, 1], armature: armature.id };
  const boneNodes = armature.bones.map(bone => {
    const parentHead = bone.parent === null ? [0, 0, 0] : headByName.get(bone.parent);
    return {
      id: boneNodeId(armature, bone.name), parent: bone.parent === null ? armature.id : boneNodeId(armature, bone.parent),
      translation: bone.head.map((component, axis) => component - parentHead[axis]), rotation: [0, 0, 0, 1], scale: [1, 1, 1], armature: armature.id,
    };
  });
  return [rootNode, ...boneNodes];
}

/** Drop the nodes armatures generated, so the armatures regenerate them. */
export function withoutArmatureNodes(nodes) {
  return Array.isArray(nodes) ? nodes.filter(node => !Object.hasOwn(node ?? {}, 'armature')) : nodes;
}

/** Where a bone ends: its tail, the mean of its children's heads, or its parent's direction continued half as far. */
export function boneTails(armature) {
  const children = new Map();
  for (const bone of armature.bones) {
    if (bone.parent !== null) children.set(bone.parent, [...(children.get(bone.parent) ?? []), bone]);
  }
  const headByName = new Map(armature.bones.map(bone => [bone.name, bone.head]));
  return armature.bones.map(bone => {
    if (bone.tail) return bone.tail;
    const kids = children.get(bone.name);
    if (kids) return [0, 1, 2].map(axis => kids.reduce((total, kid) => total + kid.head[axis], 0) / kids.length);
    if (bone.parent !== null) return bone.head.map((component, axis) => component + (component - headByName.get(bone.parent)[axis]) * 0.5);
    return [bone.head[0], bone.head[1] + 0.1, bone.head[2]];
  });
}

/** World rest matrix of a node or armature root, from the recipe's own transforms. */
export function restWorldMatrix(nodeId, nodesById, armatures = []) {
  let matrix = mat4.create();
  let currentId = nodeId;
  for (let depth = 0; currentId !== null && currentId !== undefined; depth++) {
    if (depth > MAX_ANCESTOR_DEPTH) throw new RangeError(`Node ${nodeId} has a parent chain that never ends.`);
    const record = nodesById.get(currentId) ?? armatures.find(armature => armature.id === currentId);
    if (!record) throw new RangeError(`Unknown node or armature ${JSON.stringify(String(currentId).slice(0, 48))} in a parent chain.`);
    mat4.multiply(matrix, mat4.fromRotationTranslationScale(mat4.create(), record.rotation, record.translation, record.scale ?? [1, 1, 1]), matrix);
    currentId = record.parent;
  }
  return matrix;
}

/** Bounds of a local box carried through `matrix`. */
export function transformedBounds(bounds, matrix) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const point = vec3.transformMat4(vec3.create(), [0, 1, 2].map(axis => (corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis])), matrix);
    point.forEach((component, axis) => {
      minimum[axis] = Math.min(minimum[axis], component);
      maximum[axis] = Math.max(maximum[axis], component);
    });
  }
  return { min: minimum, max: maximum };
}

function squaredDistanceToSegment(px, py, pz, head, tail) {
  const dx = tail[0] - head[0];
  const dy = tail[1] - head[1];
  const dz = tail[2] - head[2];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const along = lengthSquared === 0 ? 0 : ((px - head[0]) * dx + (py - head[1]) * dy + (pz - head[2]) * dz) / lengthSquared;
  const clamped = Math.min(1, Math.max(0, along));
  const ex = px - (head[0] + dx * clamped);
  const ey = py - (head[1] + dy * clamped);
  const ez = pz - (head[2] + dz * clamped);
  return ex * ex + ey * ey + ez * ez;
}

function strongestInfluences(weights, count) {
  const chosen = [];
  const taken = new Set();
  for (let slot = 0; slot < count; slot++) {
    let best = -1;
    for (let bone = 0; bone < weights.length; bone++) {
      if (!taken.has(bone) && (best < 0 || weights[bone] > weights[best])) best = bone;
    }
    if (best < 0 || weights[best] <= 0) break;
    taken.add(best);
    chosen.push(best);
  }
  return chosen;
}

/**
 * Automatic weights. `segments` are bone { head, tail } in world space and `meshMatrix` carries positions there. A vertex
 * farther than `maxDistance` from every bone still binds to its nearest ones (so it never collapses to the origin) and is
 * counted as unweighted. Returns skin indices and weights (four per vertex), unweighted vertices and each bone's weight total.
 */
export function computeSkinWeights({ positions, meshMatrix, segments, maxInfluences = MAX_INFLUENCES, maxDistance, softness }) {
  const vertexCount = positions.length / 3;
  const indices = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  const boneTotals = new Float64Array(segments.length);
  const falloff = new Float64Array(segments.length);
  const distances = new Float64Array(segments.length);
  const point = vec3.create();
  const unweighted = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    vec3.transformMat4(point, [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]], meshMatrix);
    let nearest = Infinity;
    segments.forEach((segment, bone) => {
      distances[bone] = Math.sqrt(squaredDistanceToSegment(point[0], point[1], point[2], segment.head, segment.tail));
      nearest = Math.min(nearest, distances[bone]);
    });
    if (nearest > maxDistance) unweighted.push(vertex);
    for (let bone = 0; bone < segments.length; bone++) falloff[bone] = ((nearest + softness) / (distances[bone] + softness)) ** FALLOFF_POWER;
    const chosen = strongestInfluences(falloff, maxInfluences);
    const total = chosen.reduce((sum, bone) => sum + falloff[bone], 0);
    chosen.forEach((bone, slot) => {
      indices[vertex * 4 + slot] = bone;
      weights[vertex * 4 + slot] = falloff[bone] / total;
      boneTotals[bone] += falloff[bone] / total;
    });
  }
  return { indices, weights, unweighted, boneTotals };
}

function skinOptions(skin, span) {
  return {
    maxInfluences: skin.maxInfluences ?? MAX_INFLUENCES,
    maxDistance: skin.maxDistance ?? span * DEFAULT_REACH_OF_SPAN,
    softness: span * SOFTNESS_OF_SPAN,
  };
}

function worldSegments(armature, armatureWorld) {
  const tails = boneTails(armature);
  return armature.bones.map((bone, index) => ({
    head: Array.from(vec3.transformMat4(vec3.create(), bone.head, armatureWorld)),
    tail: Array.from(vec3.transformMat4(vec3.create(), tails[index], armatureWorld)),
  }));
}

function armatureSpan(segments) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const { head, tail } of segments) {
    for (const point of [head, tail]) {
      point.forEach((component, axis) => {
        minimum[axis] = Math.min(minimum[axis], component);
        maximum[axis] = Math.max(maximum[axis], component);
      });
    }
  }
  return Math.max(...maximum.map((component, axis) => component - minimum[axis]), 1e-6);
}

function createSkin(armature, boneWorlds, meshWorld) {
  const count = armature.bones.length;
  const skin = createSkinPose(count);
  const inverseBindMatrices = new Float32Array(count * 16);
  boneWorlds.forEach((world, index) => inverseBindMatrices.set(mat4.invert(mat4.create(), world), index * 16));
  return Object.assign(skin, {
    joints: armature.bones.map(bone => ({ name: boneNodeId(armature, bone.name), parent: bone.parent === null ? -1 : armature.bones.findIndex(candidate => candidate.name === bone.parent) })),
    inverseBindMatrices, bindMatrix: Float32Array.from(meshWorld), jointWorldMatrices: new Float32Array(count * 16),
  });
}

/**
 * Bind every `skin` node of the rest `graph`. `cache` maps node ID to the last result, so an unchanged binding keeps the
 * same geometry and skin objects. Returns { bindings: Map(nodeId -> { geometry, skin, armature, boneIds, report }) }.
 */
export function bindSkins({ recipe, graph, geometryRecords, cache }) {
  const bindings = new Map();
  for (const node of recipe.nodes.filter(candidate => candidate.skin)) {
    const armature = recipe.armatures?.find(candidate => candidate.id === node.skin.armature);
    if (!armature) throw new RangeError(`Node ${node.id} skin names armature ${node.skin.armature}, which is not in armatures.`);
    const record = geometryRecords.get(node.geometry);
    const meshWorld = graph.getNode(node.id).worldMatrix;
    const boneIds = armature.bones.map(bone => boneNodeId(armature, bone.name));
    const boneWorlds = boneIds.map(id => graph.getNode(id).worldMatrix);
    const key = JSON.stringify([record.signature, armature, node.skin, Array.from(meshWorld), boneWorlds.map(world => Array.from(world))]);
    const cached = cache.get(node.id);
    if (cached?.key === key) {
      bindings.set(node.id, cached);
      continue;
    }
    const segments = worldSegments(armature, graph.getNode(armature.id).worldMatrix);
    const span = armatureSpan(segments);
    const weights = computeSkinWeights({ positions: record.geometry.positions, meshMatrix: meshWorld, segments, ...skinOptions(node.skin, span) });
    const geometry = Object.freeze({ ...record.geometry, skinIndices: weights.indices, skinWeights: weights.weights });
    const report = { node: node.id, armature: armature.id, vertices: record.geometry.positions.length / 3, unweightedVertices: weights.unweighted.length, boneWeight: weights.boneTotals };
    const binding = { key, geometry, skin: createSkin(armature, boneWorlds, meshWorld), armature, boneIds, report };
    cache.set(node.id, binding);
    bindings.set(node.id, binding);
  }
  return bindings;
}

/** Palettes for a pose graph. Writes into `scratch` skins; `publish` copies them to the part skins once the whole pose is valid. */
export function stageSkinPoses(skinned, graph) {
  for (const { binding, scratch, jointWorlds, meshNodeId } of skinned) {
    binding.boneIds.forEach((id, index) => jointWorlds.set(graph.getNode(id).worldMatrix, index * 16));
    updateSkinPose(scratch, jointWorlds, binding.skin.inverseBindMatrices, graph.getNode(meshNodeId).worldMatrix, binding.skin.bindMatrix);
  }
}

export function publishSkinPoses(skinned) {
  for (const { binding, scratch, jointWorlds } of skinned) {
    binding.skin.jointMatrices.set(scratch.jointMatrices);
    binding.skin.jointWorldMatrices.set(jointWorlds);
  }
}

export function createSkinStages(bindings) {
  return [...bindings].map(([meshNodeId, binding]) => ({
    meshNodeId, binding, scratch: createSkinPose(binding.boneIds.length), jointWorlds: new Float32Array(binding.boneIds.length * 16),
  }));
}

function chainProblem(armature, tails, middleName, endName, bendsBackward) {
  const byName = new Map(armature.bones.map((bone, index) => [bone.name, { bone, tail: tails[index] }]));
  const middle = byName.get(middleName);
  const end = byName.get(endName);
  const root = byName.get(middle.bone.parent);
  const rootToEnd = vec3.subtract(vec3.create(), end.bone.head, root.bone.head);
  const rootToMiddle = vec3.subtract(vec3.create(), middle.bone.head, root.bone.head);
  const length = vec3.length(rootToEnd);
  if (length < ZERO_LENGTH) return null;
  const alongLine = vec3.scale(vec3.create(), rootToEnd, vec3.dot(rootToMiddle, rootToEnd) / (length * length));
  const offset = vec3.subtract(vec3.create(), rootToMiddle, alongLine);
  if (vec3.length(offset) / length < STRAIGHT_CHAIN_RATIO) {
    return { bone: middleName, problem: 'straight-chain', detail: `${root.bone.name}, ${middleName} and ${endName} are collinear at rest, so a two-bone solve has no bend direction unless it gets a pole.` };
  }
  const forward = vec3.dot(offset, FORWARD);
  if (bendsBackward ? forward < 0 : forward > 0) {
    return { bone: middleName, problem: bendsBackward ? 'knee-bends-backward' : 'elbow-bends-forward', detail: `${middleName} sits ${bendsBackward ? 'behind' : 'in front of'} the line from ${root.bone.name} to ${endName} on a character facing +Z, so a poleless solve folds the joint the wrong way.` };
  }
  return null;
}

/** Problems with a bone layout alone: zero-length bones and limb chains whose rest bend is missing or the wrong way. */
export function armatureProblems(armature) {
  const tails = boneTails(armature);
  const problems = [];
  armature.bones.forEach((bone, index) => {
    if (vec3.distance(bone.head, tails[index]) < ZERO_LENGTH) problems.push({ bone: bone.name, problem: 'zero-length', detail: `${bone.name} has its tail at its head.` });
  });
  for (const bone of armature.bones) {
    const child = armature.bones.find(candidate => candidate.parent === bone.name);
    if (!child || bone.parent === null) continue;
    const isKnee = /LowerLeg$/.test(bone.name) && !/Front/.test(bone.name);
    const isElbow = /LowerArm$/.test(bone.name) || /FrontLowerLeg$/.test(bone.name);
    if (!isKnee && !isElbow) continue;
    const found = chainProblem(armature, tails, bone.name, child.name, isKnee);
    if (found) problems.push(found);
  }
  return problems;
}

/** Everything `scene_inspect` says about rigs: layout problems, and per skinned node unweighted vertices and unused bones. */
export function rigReport(recipe, bindings) {
  return recipe.armatures.map(armature => {
    const skinned = [...bindings.values()].filter(binding => binding.armature.id === armature.id);
    const weightTotals = armature.bones.map((_, index) => skinned.reduce((sum, binding) => sum + binding.report.boneWeight[index], 0));
    return {
      id: armature.id, bones: armature.bones.length,
      skinned: skinned.map(binding => ({ node: binding.report.node, vertices: binding.report.vertices, unweightedVertices: binding.report.unweightedVertices })),
      bonesWithNoVertices: skinned.length ? armature.bones.filter((_, index) => weightTotals[index] < 1e-3).map(bone => bone.name) : [],
      jointAxisProblems: armatureProblems(armature),
    };
  });
}

function bakedTracks(motionSampler, duration, frameRate) {
  const frameCount = Math.max(1, Math.ceil(duration * frameRate));
  const keyframesByTrack = new Map();
  for (let frame = 0; frame <= frameCount; frame++) {
    const time = Math.min(duration, frame / frameRate);
    for (const [id, patch] of motionSampler.sample(time).nodes) {
      for (const property of ['rotation', 'translation']) {
        if (!patch[property]) continue;
        const key = `${id}\u0000${property}`;
        if (!keyframesByTrack.has(key)) keyframesByTrack.set(key, { target: id, property, interpolation: 'LINEAR', keyframes: [] });
        keyframesByTrack.get(key).keyframes.push({ time, value: Array.from(patch[property]) });
      }
    }
  }
  return [...keyframesByTrack.values()];
}

/**
 * What `exportGlb` needs for an authored rig: bone nodes at rest (the exporter writes their hierarchy and inverse binds)
 * and, when the recipe has motion, one clip baked at `frameRate` from tracks and IK. Only bone nodes are baked.
 */
export function bakeRigExport(recipe, restGraph, motionSampler, { frameRate = 30 } = {}) {
  const nodes = recipe.nodes.filter(node => Object.hasOwn(node, 'armature')).map(node => {
    const isRoot = recipe.armatures.some(armature => armature.id === node.id);
    const world = isRoot ? restGraph.getNode(node.id).worldMatrix : null;
    return {
      id: node.id, name: node.id, meshIds: [],
      parent: isRoot ? null : node.parent,
      translation: world ? Array.from(mat4.getTranslation(vec3.create(), world)) : node.translation,
      rotation: world ? Array.from(mat4.getRotation([0, 0, 0, 1], world)) : node.rotation,
      scale: world ? Array.from(mat4.getScaling(vec3.create(), world)) : node.scale,
    };
  });
  const boneIds = new Set(nodes.map(node => node.id));
  const tracks = motionSampler ? bakedTracks(motionSampler, recipe.motion.duration, frameRate).filter(track => boneIds.has(track.target)) : [];
  const clip = tracks.length ? { ...createAnimationClip({ duration: recipe.motion.duration, loop: recipe.motion.loop, tracks }), name: 'motion' } : null;
  return { nodes, clips: clip ? [clip] : [] };
}

/** A rig for `retargetClip` and `createSkeletonPose`: joints in bone order, named by node ID, resting with identity rotation. */
export function createRigFromArmature(armature) {
  const indexByName = new Map(armature.bones.map((bone, index) => [bone.name, index]));
  const headByName = new Map(armature.bones.map(bone => [bone.name, bone.head]));
  return {
    joints: armature.bones.map(bone => ({
      name: boneNodeId(armature, bone.name), parent: bone.parent === null ? -1 : indexByName.get(bone.parent),
      translation: bone.head.map((component, axis) => component - (bone.parent === null ? 0 : headByName.get(bone.parent)[axis])),
      rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    })),
  };
}
