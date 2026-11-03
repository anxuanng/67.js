import { mat4, quat } from 'gl-matrix';
import { createSkeletonPose } from '../../src/skeleton-pose.js';

// Small skinned humanoids for the retargeting tests. Both are built here, so a test can change the proportions, the rest
// pose of the arms and the names without a second file: Mixamo-like names for one, Unreal-like names for the other.

export const MIXAMO_LIKE = {
  hips: 'Hips', spine: 'Spine', head: 'Head',
  leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot',
  rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot',
};

export const UNREAL_LIKE = {
  hips: 'pelvis', spine: 'spine_01', head: 'head',
  leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
  leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l',
  rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
  rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r',
};

export const FACE_TARGETS = ['eyeBlinkLeft', 'eyeBlinkRight', 'jawOpen', 'mouthSmile'];

/** The skeleton as { key, parent, translation, rotation } in order; parents come first. The first joint is the hips. */
export function humanoidJoints({ hipsHeight = 1, thigh = 0.5, shin = 0.5, armTiltDegrees = 0 } = {}) {
  const joints = [];
  const add = (key, parent, translation, rotation = [0, 0, 0, 1]) => joints.push({ key, parent, translation, rotation }) - 1;
  const hips = add('hips', -1, [0, hipsHeight, 0]);
  const spine = add('spine', hips, [0, 0.2, 0]);
  add('head', spine, [0, 0.5, 0]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const tilt = Array.from(quat.setAxisAngle(new Float64Array(4), [0, 0, 1], -sign * armTiltDegrees * Math.PI / 180));
    const upperArm = add(`${side}UpperArm`, spine, [sign * 0.2, 0.3, 0], tilt);
    const lowerArm = add(`${side}LowerArm`, upperArm, [sign * 0.3, 0, 0]);
    add(`${side}Hand`, lowerArm, [sign * 0.25, 0, 0]);
    const upperLeg = add(`${side}UpperLeg`, hips, [sign * 0.1, 0, 0]);
    const lowerLeg = add(`${side}LowerLeg`, upperLeg, [0, -thigh, 0]);
    add(`${side}Foot`, lowerLeg, [0, -shin, 0]);
  }
  return joints;
}

/**
 * A walk that plants each foot for half a cycle: the feet's world paths are fixed, the hips move at `speed`, and the
 * engine's own two-bone IK finds the leg rotations. Returns glTF tracks for the clip.
 */
export function walkTracks(joints, { speed = 1.2, duration = 1, kneeLift = 0.12, hipsDrop = 0.08, frameRate = 30 } = {}) {
  const rig = { joints: joints.map(joint => ({ name: joint.key, parent: joint.parent, translation: joint.translation, rotation: joint.rotation, scale: [1, 1, 1] })) };
  const chains = [['left', 0], ['right', 0.5]].map(([side, phase]) => ({ side, phase }));
  const hipsHeight = joints[0].translation[1];
  const footOffsets = Object.fromEntries(['left', 'right'].map(side => [side, joints.find(joint => joint.key === `${side}UpperLeg`).translation[0]]));
  const phase = (time, shift) => time / duration + shift;
  function footTarget(side, shift, time) {
    const whole = Math.floor(phase(time, shift));
    const fraction = phase(time, shift) - whole;
    const centerOfStance = (whole + 0.25 - shift) * duration;
    const planted = speed * centerOfStance;
    if (fraction < 0.5) return [footOffsets[side], 0, planted];
    const swing = (fraction - 0.5) / 0.5;
    const eased = swing * swing * (3 - 2 * swing);
    return [footOffsets[side], kneeLift * Math.sin(Math.PI * swing), planted + speed * duration * eased];
  }
  const ik = chains.map(({ side, phase: shift }) => ({
    type: 'two-bone', root: `${side}UpperLeg`, middle: `${side}LowerLeg`, end: `${side}Foot`, bendToward: [0, 0, 1],
    target: time => footTarget(side, shift, time),
  }));
  const pose = createSkeletonPose({ rig, ik });
  const keyed = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const indexOf = new Map(joints.map((joint, index) => [joint.key, index]));
  const tracks = new Map(keyed.map(key => [key, { times: [], values: [] }]));
  const frames = Math.round(duration * frameRate);
  for (let frame = 0; frame <= frames; frame++) {
    const time = frame / frameRate;
    pose.apply(time, (_rotations, translations) => translations[0].set([0, hipsHeight - hipsDrop, speed * time]));
    for (const key of keyed) {
      const track = tracks.get(key);
      track.times.push(time);
      track.values.push(...(key === 'hips' ? [0, hipsHeight - hipsDrop, speed * time] : pose.localRotation(indexOf.get(key))));
    }
  }
  return keyed.map(key => ({ joint: key, path: key === 'hips' ? 'translation' : 'rotation', ...tracks.get(key) }));
}

/**
 * A GLB of the humanoid: one skinned triangle over all joints, a small rigid mesh on each foot (named sole_left and
 * sole_right, so a test reads foot positions from their parts), and optionally a face mesh with named morph targets.
 * `clips` is [{ name, duration, tracks: [{ joint, path, times, values }], morphTracks: [{ times, values }] }].
 */
export function humanoidGlb({ names, joints = humanoidJoints(), clips = [], face = false }) {
  const nodes = [{ name: 'Character', children: [] }];
  const worlds = [];
  joints.forEach((joint, index) => {
    const node = { name: names[joint.key], translation: joint.translation, rotation: joint.rotation };
    nodes.push(node);
    if (joint.parent < 0) nodes[0].children.push(index + 1);
    else (nodes[joint.parent + 1].children ??= []).push(index + 1);
    const local = mat4.fromRotationTranslation(mat4.create(), joint.rotation, joint.translation);
    worlds.push(joint.parent < 0 ? local : mat4.multiply(mat4.create(), worlds[joint.parent], local));
  });
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes, meshes: [], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.7, 0.7, 0.8, 1] } }],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], skins: [], animations: [],
  };
  const chunks = [];
  let offset = 0;
  function append(data, type, extra = {}) {
    const components = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    chunks.push(data);
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    offset += Math.ceil(data.byteLength / 4) * 4;
    document.buffers[0].byteLength = offset;
    document.accessors.push({ bufferView: chunks.length - 1, componentType: data instanceof Uint16Array ? 5123 : 5126, count: data.length / components, type, ...extra });
    return document.accessors.length - 1;
  }
  const triangle = (size, targets) => {
    const attributes = {
      POSITION: append(new Float32Array([-size, 0, 0, size, 0, 0, 0, size, 0]), 'VEC3', { min: [-size, 0, 0], max: [size, size, 0] }),
      NORMAL: append(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3'),
    };
    return { attributes, indices: append(new Uint16Array([0, 1, 2]), 'SCALAR'), material: 0, ...(targets ? { targets } : {}) };
  };
  const addMeshNode = (name, mesh, parentIndex, extra = {}) => {
    document.meshes.push({ name, ...mesh });
    nodes.push({ name, mesh: document.meshes.length - 1, ...extra });
    (nodes[parentIndex].children ??= []).push(nodes.length - 1);
    return nodes.length - 1;
  };
  const body = triangle(0.1);
  body.attributes.JOINTS_0 = append(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'VEC4');
  body.attributes.WEIGHTS_0 = append(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4');
  document.skins.push({
    joints: joints.map((_, index) => index + 1), skeleton: 1,
    inverseBindMatrices: append(new Float32Array(worlds.flatMap(world => Array.from(mat4.invert(mat4.create(), world)))), 'MAT4'),
  });
  addMeshNode('Body', { primitives: [body] }, 0, { skin: 0 });
  joints.forEach((joint, index) => {
    if (joint.key.endsWith('Foot')) addMeshNode(`sole_${joint.key.replace('Foot', '')}`, { primitives: [triangle(0.05)] }, index + 1);
  });
  if (face) {
    const headIndex = joints.findIndex(joint => joint.key === 'head') + 1;
    const targets = FACE_TARGETS.map(() => ({ POSITION: append(new Float32Array([0, 0.01, 0, 0, 0.01, 0, 0, 0.01, 0]), 'VEC3', { min: [0, 0.01, 0], max: [0, 0.01, 0] }) }));
    addMeshNode('Face', { primitives: [triangle(0.08, targets)], extras: { targetNames: FACE_TARGETS } }, headIndex);
    nodes[nodes.length - 1].weights = FACE_TARGETS.map(() => 0);
    document.meshes[document.meshes.length - 1].weights = FACE_TARGETS.map(() => 0);
  }
  const nodeIndexOf = new Map(joints.map((joint, index) => [joint.key, index + 1]));
  for (const clip of clips) {
    const animation = { name: clip.name, samplers: [], channels: [] };
    for (const track of clip.tracks) {
      animation.samplers.push({ input: append(new Float32Array(track.times), 'SCALAR', { min: [track.times[0]], max: [track.times.at(-1)] }), output: append(new Float32Array(track.values), track.path === 'rotation' ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' });
      animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: nodeIndexOf.get(track.joint), path: track.path } });
    }
    document.animations.push(animation);
  }
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + offset);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, offset, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  chunks.forEach((chunk, index) => bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), 28 + jsonLength + document.bufferViews[index].byteOffset));
  return result;
}
