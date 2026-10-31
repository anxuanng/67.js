import { mat4, quat, vec3 } from 'gl-matrix';

// A ragdoll gives every bone of a rig one capsule body, joined to its parent bone by a spherical joint, and hands the
// simulated world poses back as the local pose of each bone node. The bones are plain nodes (armature bones or the
// joints of an imported asset), so skinning, export and seeking need nothing new: the baked result is a table of local
// transforms read by time, never a solver replay.
//
// Bones never collide with each other (a shared collision layer that excludes itself), which keeps the capsules that
// meet at a joint from pushing apart. Joints have no swing limits, so a limb folds as far as the bodies allow.

export const MAX_RAGDOLL_BONES = 48;
const MIN_BONE_LENGTH = 1e-4;
// A joint between a light and a heavy body makes the solver blow up, so the lightest bone weighs a quarter of the longest.
const MIN_MASS_OF_LONGEST = 0.25;
const RADIUS_OF_LENGTH = 0.2;
const ANGULAR_DAMPING = 3;
// Linear blend skinning inverts a vertex where neighbouring joints turn past about 180 degrees from each other, and an
// engine that refuses such a pose cannot play the fall. The posed joint therefore stays within this angle of its rest pose.
const MAX_POSED_JOINT_ANGLE = (120 * Math.PI) / 180;
const DEFAULT_LAYER = 1;
const ALL_LAYERS_MASK = 0xffff;
const UNIFORM_SCALE_TOLERANCE = 1e-3;
const UP = [0, 1, 0];

function describeBone(bone) {
  const worldMatrix = mat4.clone(bone.worldMatrix);
  const rotation = quat.normalize(quat.create(), mat4.getRotation(quat.create(), worldMatrix));
  const head = mat4.getTranslation(vec3.create(), worldMatrix);
  const toLocal = vec3.transformQuat(vec3.create(), vec3.subtract(vec3.create(), bone.tail, head), quat.invert(quat.create(), rotation));
  const length = vec3.length(toLocal);
  if (!(length > MIN_BONE_LENGTH)) {
    throw new RangeError(`Ragdoll bone ${bone.id} has no length: its head and tail coincide.`);
  }
  const uniformScale = uniformScaleOf(worldMatrix, bone.id);
  const staticParent = bone.parentId === null ? frameOf(bone.parentWorldMatrix, bone.id) : null;
  return { ...bone, head, rotation, uniformScale, staticParent, tailInBone: toLocal, length };
}

// A uniform scale keeps a bone's local pose a rotation and a translation; a stretched rig would shear.
function uniformScaleOf(matrix, boneId) {
  const scale = mat4.getScaling(vec3.create(), matrix);
  if (Math.max(...scale) - Math.min(...scale) > UNIFORM_SCALE_TOLERANCE * Math.max(...scale)) {
    throw new RangeError(`Ragdoll bone ${boneId} sits under a stretched (non-uniform) scale ${JSON.stringify(Array.from(scale))}; a ragdoll needs uniform scale above its bones.`);
  }
  return scale[0];
}

function frameOf(matrix, boneId) {
  return {
    translation: mat4.getTranslation(vec3.create(), matrix),
    rotation: quat.normalize(quat.create(), mat4.getRotation(quat.create(), matrix)),
    scale: uniformScaleOf(matrix, boneId),
  };
}

function limitTurnFromRest(rotation, restLocalRotation) {
  quat.normalize(rotation, rotation);
  const turn = quat.multiply(quat.create(), quat.invert(quat.create(), restLocalRotation), rotation);
  if (turn[3] < 0) quat.scale(turn, turn, -1);
  const angle = 2 * Math.acos(Math.min(1, turn[3]));
  if (angle <= MAX_POSED_JOINT_ANGLE) return;
  const limitedTurn = quat.slerp(quat.create(), quat.create(), turn, MAX_POSED_JOINT_ANGLE / angle);
  quat.multiply(rotation, restLocalRotation, limitedTurn);
}

function boneCollider(bone, options, longestLength) {
  const radius = bone.length * RADIUS_OF_LENGTH;
  const layer = options.layer ?? DEFAULT_LAYER;
  const collider = {
    name: bone.id, body: bone.id, shape: 'capsule', radius,
    halfHeight: Math.max(bone.length / 2 - radius, radius * 0.01),
    translation: Array.from(vec3.scale(vec3.create(), bone.tailInBone, 0.5)),
    rotation: Array.from(quat.rotationTo(quat.create(), UP, vec3.normalize(vec3.create(), bone.tailInBone))),
    groups: 1 << layer,
    mask: options.collidesWith ?? (ALL_LAYERS_MASK & ~(1 << layer)),
    mass: (options.density ?? 1) * Math.max(bone.length, longestLength * MIN_MASS_OF_LONGEST),
  };
  if (options.friction !== undefined) collider.friction = options.friction;
  if (options.restitution !== undefined) collider.restitution = options.restitution;
  return collider;
}

function boneJoint(bone, parent, index) {
  const offset = vec3.subtract(vec3.create(), bone.head, parent.head);
  const anchorInParent = vec3.transformQuat(vec3.create(), offset, quat.invert(quat.create(), parent.rotation));
  return { name: `ragdoll-joint-${index}`, type: 'spherical', bodyA: parent.id, bodyB: bone.id, anchorA: Array.from(anchorInParent), anchorB: [0, 0, 0] };
}

/**
 * Describe a ragdoll for the solver and read its result back as local node poses.
 * Each bone is `{ id, parentId, worldMatrix, parentWorldMatrix, tail }`: `parentId` names the bone above it (or null),
 * `worldMatrix` is its rest world matrix, `parentWorldMatrix` the rest world matrix of the node above it (used when
 * `parentId` is null) and `tail` where the bone ends in world space. A parent must come before its children.
 */
export function createRagdoll(bones, options = {}) {
  if (!Array.isArray(bones) || bones.length < 1 || bones.length > MAX_RAGDOLL_BONES) {
    throw new RangeError(`A ragdoll needs 1 to ${MAX_RAGDOLL_BONES} bones; this rig has ${Array.isArray(bones) ? bones.length : 0}.`);
  }
  const described = bones.map(describeBone);
  const byId = new Map(described.map(bone => [bone.id, bone]));
  const longestLength = Math.max(...described.map(bone => bone.length));
  const bodies = [];
  const colliders = [];
  const joints = [];
  for (const bone of described) {
    const parent = bone.parentId === null ? null : byId.get(bone.parentId);
    if (bone.parentId !== null && !parent) {
      throw new RangeError(`Ragdoll bone ${bone.id} names a parent that is not in the ragdoll: ${bone.parentId}.`);
    }
    bodies.push({ name: bone.id, type: 'dynamic', translation: Array.from(bone.head), rotation: Array.from(bone.rotation), angularDamping: ANGULAR_DAMPING });
    colliders.push(boneCollider(bone, options, longestLength));
    if (parent) joints.push(boneJoint(bone, parent, joints.length));
  }
  for (const bone of described) {
    const parentRotation = bone.parentId === null ? bone.staticParent.rotation : byId.get(bone.parentId).rotation;
    bone.restLocalRotation = quat.multiply(quat.create(), quat.invert(quat.create(), parentRotation), bone.rotation);
  }
  const offset = vec3.create();
  return Object.freeze({
    boneIds: described.map(bone => bone.id),
    definition: { bodies, colliders, joints },
    /** Write each bone's local translation and rotation, given the simulated world pose of its body. */
    writePatches(readPose, patches) {
      const sampledFrames = new Map();
      for (const bone of described) {
        const pose = readPose(bone.id);
        const parent = bone.parentId === null ? bone.staticParent : sampledFrames.get(bone.parentId);
        sampledFrames.set(bone.id, { translation: pose.translation, rotation: pose.rotation, scale: bone.uniformScale });
        const inverseParentRotation = quat.invert(quat.create(), parent.rotation);
        const patch = patches.get(bone.id);
        vec3.subtract(offset, pose.translation, parent.translation);
        vec3.transformQuat(patch.translation, offset, inverseParentRotation);
        vec3.scale(patch.translation, patch.translation, 1 / parent.scale);
        quat.multiply(patch.rotation, inverseParentRotation, pose.rotation);
        limitTurnFromRest(patch.rotation, bone.restLocalRotation);
      }
    },
    /** Where each end of a bone is in world space for a body pose. */
    ends(boneId, pose) {
      const tailInBone = byId.get(boneId).tailInBone;
      const tail = vec3.transformQuat(vec3.create(), tailInBone, pose.rotation);
      return { head: Array.from(pose.translation), tail: Array.from(vec3.add(tail, tail, pose.translation)) };
    },
  });
}

/** An empty patch table for a ragdoll's bones, to be filled by `writePatches`. */
export function ragdollPatches(ragdoll) {
  return new Map(ragdoll.boneIds.map(id => [id, { translation: new Float64Array(3), rotation: new Float64Array(4) }]));
}

const rounded = value => Number(value.toFixed(4));

/** Numbers an agent can read instead of a picture: how low the rig lies, how high it stays, and when it stops. */
export function ragdollReport(ragdoll, scene) {
  const finalPose = scene.sample(scene.duration);
  const previousPose = scene.sample(Math.max(0, scene.duration - scene.timestep));
  let lowest = Infinity;
  let highest = -Infinity;
  let fastest = 0;
  let restFrame = 0;
  for (const id of ragdoll.boneIds) {
    const offset = scene.bodyIndex(id) * 7;
    const pose = { translation: finalPose.subarray(offset, offset + 3), rotation: finalPose.subarray(offset + 3, offset + 7) };
    const { head, tail } = ragdoll.ends(id, pose);
    lowest = Math.min(lowest, head[1], tail[1]);
    highest = Math.max(highest, head[1], tail[1]);
    const step = Math.hypot(...[0, 1, 2].map(axis => finalPose[offset + axis] - previousPose[offset + axis]));
    fastest = Math.max(fastest, step / scene.timestep);
    const bodyRest = scene.restFrames[scene.bodyIndex(id)];
    restFrame = restFrame < 0 || bodyRest < 0 ? -1 : Math.max(restFrame, bodyRest);
  }
  return {
    bones: ragdoll.boneIds.length, lowestY: rounded(lowest), highestY: rounded(highest), fastestFinalSpeed: rounded(fastest),
    restsAtTime: restFrame < 0 ? null : Number((restFrame * scene.timestep).toFixed(3)),
  };
}
