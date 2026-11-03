import { mat4, quat, vec3 } from 'gl-matrix';
import { bakeEasedKeyframes } from './animation.js';

// glTF has no easing, so an eased segment is written as this many linear pieces.
const EASING_BAKE_STEPS_PER_SEGMENT = 32;

const GLTF_PATHS = { translation: 'translation', rotation: 'rotation', scale: 'scale', weights: 'weights' };
const COMPONENTS_BY_PATH = { translation: 3, rotation: 4, scale: 3 };
const ACCESSOR_TYPE_BY_PATH = { translation: 'VEC3', rotation: 'VEC4', scale: 'VEC3', weights: 'SCALAR' };
const GLTF_STEP_INTERPOLATION = 2300;
const GLTF_LINEAR_INTERPOLATION = 2301;
const IDENTITY_ROTATION = [0, 0, 0, 1];

function transformFields(translation, rotation, scale) {
  const fields = {};
  if (translation.some(value => value !== 0)) fields.translation = Array.from(translation);
  if (rotation.some((value, index) => value !== IDENTITY_ROTATION[index])) fields.rotation = Array.from(rotation);
  if (scale.some(value => value !== 1)) fields.scale = Array.from(scale);
  return fields;
}

/** Split an affine matrix into glTF translation, rotation and scale fields. */
export function decomposeMatrix(matrix) {
  const translation = mat4.getTranslation(vec3.create(), matrix);
  const scale = mat4.getScaling(vec3.create(), matrix);
  const rotation = mat4.getRotation(quat.create(), matrix);
  return transformFields(translation, rotation, scale);
}

function composeFields(record) {
  return mat4.fromRotationTranslationScale(mat4.create(), record.rotation ?? IDENTITY_ROTATION, record.translation ?? [0, 0, 0], record.scale ?? [1, 1, 1]);
}

function worldMatrixOf(index, nodes, cache) {
  if (cache.has(index)) return cache.get(index);
  const node = nodes[index];
  const local = composeFields(node);
  const world = node.parent >= 0 ? mat4.multiply(mat4.create(), worldMatrixOf(node.parent, nodes, cache), local) : local;
  cache.set(index, world);
  return world;
}

/** Hierarchy records from `options.nodes` (the `nodes` of a parsed asset, or the same fields): name, id, parent id. */
function nodesFromRecords(records) {
  const indexById = new Map(records.map((record, index) => [record.id ?? record.name, index]));
  return records.map(record => {
    if (typeof record.name !== 'string' || !record.name) throw new TypeError('GLB nodes need a name.');
    const parent = record.parent === null || record.parent === undefined ? -1 : indexById.get(record.parent);
    if (parent === undefined) throw new RangeError(`GLB node ${record.name} names a parent that is not in the node list.`);
    return { name: record.name, parent, translation: record.translation, rotation: record.rotation, scale: record.scale, meshIds: record.meshIds ?? [] };
  });
}

function jointWorld(skin, joint) {
  return skin.jointWorldMatrices.subarray(joint * 16, joint * 16 + 16);
}

function requireSkinFields(skin, partName) {
  const jointCount = skin.joints?.length;
  if (!Array.isArray(skin.joints) || skin.inverseBindMatrices?.length !== jointCount * 16 || skin.jointWorldMatrices?.length !== jointCount * 16) {
    throw new TypeError(`GLB part ${partName} has a skin without joints, inverseBindMatrices and jointWorldMatrices. Use the skin that parseGltf returned, or give each joint a name and parent.`);
  }
}

/** Joint nodes derived from the skin's current joint world matrices, for skins built without a node list. */
function appendDerivedJoints(nodes, skin) {
  const indexByJoint = skin.joints.map(joint => {
    const existing = nodes.findIndex(node => node.name === joint.name);
    return existing >= 0 ? existing : -1;
  });
  skin.joints.forEach((joint, jointIndex) => {
    if (indexByJoint[jointIndex] >= 0) return;
    const parentJoint = joint.parent ?? -1;
    const world = jointWorld(skin, jointIndex);
    const parentWorld = parentJoint >= 0 ? jointWorld(skin, parentJoint) : null;
    const local = parentWorld ? mat4.multiply(mat4.create(), mat4.invert(mat4.create(), parentWorld), world) : world;
    const fields = decomposeMatrix(local);
    indexByJoint[jointIndex] = nodes.length;
    nodes.push({ name: joint.name, parent: -1, ...fields, meshIds: [], derivedParentJoint: parentJoint });
  });
  skin.joints.forEach((joint, jointIndex) => {
    const node = nodes[indexByJoint[jointIndex]];
    if (node.derivedParentJoint !== undefined) node.parent = node.derivedParentJoint >= 0 ? indexByJoint[node.derivedParentJoint] : -1;
  });
}

/**
 * The hierarchy of joint and group nodes: the records of `options.nodes` when given, otherwise one node per skin joint.
 * Each entry holds name, parent index, local TRS fields and the `mesh-N` ids it carries.
 */
export function buildHierarchy(parts, nodeRecords) {
  const nodes = nodeRecords ? nodesFromRecords(nodeRecords) : [];
  for (const part of parts) {
    if (!part.skin) continue;
    requireSkinFields(part.skin, part.name);
    const missing = part.skin.joints.find(joint => !nodes.some(node => node.name === joint.name));
    if (missing && nodeRecords) {
      throw new RangeError(`GLB skin joint ${missing.name} of part ${part.name} is not in options.nodes. Pass the nodes of the same parsed asset.`);
    }
    if (!nodeRecords) appendDerivedJoints(nodes, part.skin);
  }
  return nodes;
}

/** Where each part hangs: the hierarchy node whose meshIds lists it, with its matrix made relative to that node. */
export function hostOfPart(partIndex, hierarchy, worldCache) {
  const host = hierarchy.findIndex(node => node.meshIds.includes(`mesh-${partIndex}`));
  if (host < 0) return null;
  return { index: host, world: worldMatrixOf(host, hierarchy, worldCache) };
}

export function relativeMatrix(partMatrix, hostWorld) {
  return mat4.multiply(mat4.create(), mat4.invert(mat4.create(), hostWorld), partMatrix);
}

export function hierarchyNodeFields(node) {
  return transformFields(node.translation ?? [0, 0, 0], node.rotation ?? IDENTITY_ROTATION, node.scale ?? [1, 1, 1]);
}

/** glTF skin for a part: inverse bind matrices fold in the bind matrix, so joint world * matrix * vertex is the pose. */
export function writeSkin(writer, skin, nodeIndexByName, cache) {
  if (cache.has(skin)) return cache.get(skin);
  const count = skin.joints.length;
  const matrices = new Float32Array(count * 16);
  const bind = skin.bindMatrix ?? mat4.create();
  for (let joint = 0; joint < count; joint++) {
    const inverseBind = skin.inverseBindMatrices.subarray(joint * 16, joint * 16 + 16);
    matrices.set(mat4.multiply(mat4.create(), inverseBind, bind), joint * 16);
  }
  writer.document.skins ??= [];
  writer.document.skins.push({
    joints: skin.joints.map(joint => nodeIndexByName.get(joint.name)),
    inverseBindMatrices: writer.addAccessor(matrices, 'MAT4', undefined, { bounds: false }),
  });
  cache.set(skin, writer.document.skins.length - 1);
  return writer.document.skins.length - 1;
}

/** Skin weights as glTF wants them: four joints per vertex, summing to one. */
export function normalizedWeights(weights) {
  const result = new Float32Array(weights.length);
  for (let vertex = 0; vertex < weights.length; vertex += 4) {
    const total = weights[vertex] + weights[vertex + 1] + weights[vertex + 2] + weights[vertex + 3];
    for (let influence = 0; influence < 4; influence++) result[vertex + influence] = weights[vertex + influence] / total;
  }
  return result;
}

// A weights keyframe holds one value per morph target, so its width comes from the keyframes.
function componentCount(track) {
  if (track.property !== 'weights') return COMPONENTS_BY_PATH[track.property];
  const count = track.keyframes[0].value.length;
  const consistent = track.keyframes.every(keyframe => keyframe.value.length === count && Array.from(keyframe.value).every(Number.isFinite));
  if (!count || !consistent) {
    throw new RangeError(`GLB weights track on ${track.target} needs the same nonzero count of finite weights in every keyframe.`);
  }
  return count;
}

function trackOutput(track) {
  const zero = new Array(componentCount(track)).fill(0);
  const rows = [];
  for (const keyframe of track.keyframes) {
    const value = Array.isArray(keyframe.value) ? keyframe.value : Array.from(keyframe.value);
    if (track.interpolation === 'CUBICSPLINE') rows.push(Array.from(keyframe.inTangent), value, Array.from(keyframe.outTangent));
    // SMOOTH eases each segment with smoothstep, which is a cubic Hermite segment with zero tangents.
    else if (track.interpolation === 'SMOOTH') rows.push(zero, value, zero);
    else rows.push(value);
  }
  return Float32Array.from(rows.flat());
}

const GLTF_INTERPOLATION = { LINEAR: 'LINEAR', STEP: 'STEP', SMOOTH: 'CUBICSPLINE', CUBICSPLINE: 'CUBICSPLINE' };

function writeTrack(writer, animation, sourceTrack, nodeIndex) {
  const bakedKeyframes = bakeEasedKeyframes(sourceTrack, EASING_BAKE_STEPS_PER_SEGMENT);
  const track = bakedKeyframes === sourceTrack.keyframes ? sourceTrack : { ...sourceTrack, keyframes: bakedKeyframes, interpolation: 'LINEAR' };
  const path = GLTF_PATHS[track.property];
  if (!path) {
    throw new RangeError(`GLB export cannot write ${track.property} tracks (target ${track.target}). Only translation, rotation, scale and weights tracks are exported; remove the others from the clip.`);
  }
  const times = Float32Array.from(track.keyframes, keyframe => keyframe.time);
  animation.samplers.push({
    input: writer.addAccessor(times, 'SCALAR', undefined, { bounds: true }),
    output: writer.addAccessor(trackOutput(track), ACCESSOR_TYPE_BY_PATH[track.property], undefined, { bounds: false }),
    interpolation: GLTF_INTERPOLATION[track.interpolation ?? 'LINEAR'],
  });
  animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: nodeIndex, path } });
}

/** Clips in createAnimationClip form; track targets are node names. */
export function writeAnimations(writer, clips, nodeIndexByName, prepareNodeForAnimation) {
  writer.document.animations = [];
  clips.forEach((clip, clipIndex) => {
    if (!Array.isArray(clip?.tracks) || !clip.tracks.length) throw new TypeError(`GLB clip ${clipIndex} needs tracks. Build it with createAnimationClip or clipFromGltfAnimation.`);
    const animation = { name: clip.name ?? `clip ${clipIndex}`, samplers: [], channels: [] };
    for (const track of clip.tracks) {
      const nodeIndex = nodeIndexByName.get(track.target);
      if (nodeIndex === undefined) {
        throw new RangeError(`GLB clip ${animation.name} targets ${track.target}, which is no exported node. Pass options.nodes from the parsed asset, or name a part or joint.`);
      }
      prepareNodeForAnimation(nodeIndex);
      writeTrack(writer, animation, track, nodeIndex);
    }
    writer.document.animations.push(animation);
  });
}

/**
 * Morph weight tracks of an imported animation (`asset.animations[n]`) in clip form. clipFromGltfAnimation skips them,
 * because the mixer samples only fixed-size properties. Cubic weight keys fail instead of silently changing shape.
 */
export function weightTracksFromGltfAnimation(animation) {
  const tracks = [];
  for (const track of animation.tracks) {
    const separator = track.name.lastIndexOf('.');
    if (track.name.slice(separator + 1) !== 'morphTargetInfluences') continue;
    const target = track.name.slice(0, separator);
    const interpolation = track.getInterpolation?.();
    if (interpolation !== GLTF_LINEAR_INTERPOLATION && interpolation !== GLTF_STEP_INTERPOLATION) {
      throw new RangeError(`GLB export cannot write cubic morph weights on ${target}. Re-key them as linear or step.`);
    }
    const width = track.values.length / track.times.length;
    tracks.push({
      target,
      property: 'weights',
      interpolation: interpolation === GLTF_STEP_INTERPOLATION ? 'STEP' : 'LINEAR',
      keyframes: Array.from(track.times, (time, index) => ({ time, value: Array.from(track.values.subarray(index * width, (index + 1) * width)) })),
    });
  }
  return tracks;
}
