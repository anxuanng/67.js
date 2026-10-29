import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, quat, vec3 } from 'gl-matrix';
import { createAnimationClip, sampleAnimationClip } from '../src/animation.js';
import { createSkinPose } from '../src/skinning.js';
import {
  HUMANOID_BONES, REQUIRED_HUMANOID_BONES, mapHumanoidBones, retargetClip, createRigFromSkin, createSkinClipPlayer, createCrowd,
} from '../src/retarget.js';

const MIXAMO_NAMES = {
  hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', head: 'mixamorig:Head',
  leftUpperArm: 'mixamorig:LeftArm', leftLowerArm: 'mixamorig:LeftForeArm', leftHand: 'mixamorig:LeftHand',
  leftUpperLeg: 'mixamorig:LeftUpLeg', leftLowerLeg: 'mixamorig:LeftLeg', leftFoot: 'mixamorig:LeftFoot',
  rightUpperArm: 'mixamorig:RightArm', rightLowerArm: 'mixamorig:RightForeArm', rightHand: 'mixamorig:RightHand',
  rightUpperLeg: 'mixamorig:RightUpLeg', rightLowerLeg: 'mixamorig:RightLeg', rightFoot: 'mixamorig:RightFoot',
};

const UNREAL_NAMES = {
  hips: 'pelvis', spine: 'spine_01', head: 'head',
  leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
  leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l',
  rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
  rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r',
};

function rotationAbout(axis, degrees) {
  return Array.from(quat.setAxisAngle(new Float64Array(4), axis, degrees * Math.PI / 180));
}

/** A minimal humanoid. `armTiltDegrees` tilts the arms down from a T-pose; `height` is the hips-to-foot distance. */
function createHumanoidRig(names, { height = 1, armTiltDegrees = 0 } = {}) {
  const joints = [];
  function addJoint(boneName, parent, translation, rotation = [0, 0, 0, 1]) {
    joints.push({ name: names[boneName], parent, translation, rotation, scale: [1, 1, 1] });
    return joints.length - 1;
  }
  const hips = addJoint('hips', -1, [0, height, 0]);
  const spine = addJoint('spine', hips, [0, height * 0.3, 0]);
  addJoint('head', spine, [0, height * 0.5, 0]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const upperArm = addJoint(`${side}UpperArm`, spine, [sign * 0.2, height * 0.2, 0], rotationAbout([0, 0, 1], -sign * armTiltDegrees));
    const lowerArm = addJoint(`${side}LowerArm`, upperArm, [sign * 0.3, 0, 0]);
    addJoint(`${side}Hand`, lowerArm, [sign * 0.25, 0, 0]);
    const upperLeg = addJoint(`${side}UpperLeg`, hips, [sign * 0.1, 0, 0]);
    const lowerLeg = addJoint(`${side}LowerLeg`, upperLeg, [0, -height / 2, 0]);
    addJoint(`${side}Foot`, lowerLeg, [0, -height / 2, 0]);
  }
  return { joints };
}

function worldTransforms(rig, localRotations = {}, localTranslations = {}) {
  const worlds = [];
  rig.joints.forEach((joint, index) => {
    const rotation = localRotations[joint.name] ?? joint.rotation;
    const translation = localTranslations[joint.name] ?? joint.translation;
    const local = mat4.fromRotationTranslation(mat4.create(), rotation, translation);
    worlds[index] = joint.parent >= 0 ? mat4.multiply(mat4.create(), worlds[joint.parent], local) : local;
  });
  return worlds;
}

function worldPosition(rig, jointName, localRotations, localTranslations) {
  const index = rig.joints.findIndex(joint => joint.name === jointName);
  return mat4.getTranslation(new Float64Array(3), worldTransforms(rig, localRotations, localTranslations)[index]);
}

function sampledPose(clip, time) {
  const rotations = {};
  const translations = {};
  for (const track of sampleAnimationClip(clip, time)) {
    (track.property === 'rotation' ? rotations : translations)[track.target] = track.value;
  }
  return { rotations, translations };
}

function direction(from, to) {
  return vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), to, from));
}

function assertVectorsClose(actual, expected, tolerance = 1e-6) {
  assert.ok(vec3.distance(actual, expected) < tolerance, `${Array.from(actual)} should be close to ${Array.from(expected)}`);
}

const NAME_FAMILIES = {
  mixamo: {
    names: ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head',
      'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand', 'mixamorig:LeftHandIndex1',
      'mixamorig:LeftHandIndex4', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase',
      'mixamorig:LeftToe_End', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand', 'mixamorig:RightUpLeg',
      'mixamorig:RightLeg', 'mixamorig:RightFoot'],
    expected: { hips: 'mixamorig:Hips', chest: 'mixamorig:Spine1', upperChest: 'mixamorig:Spine2', leftShoulder: 'mixamorig:LeftShoulder',
      leftUpperArm: 'mixamorig:LeftArm', leftLowerArm: 'mixamorig:LeftForeArm', leftUpperLeg: 'mixamorig:LeftUpLeg',
      leftLowerLeg: 'mixamorig:LeftLeg', leftToes: 'mixamorig:LeftToeBase', leftIndexProximal: 'mixamorig:LeftHandIndex1',
      rightLowerLeg: 'mixamorig:RightLeg' },
    unmapped: ['mixamorig:LeftToe_End', 'mixamorig:LeftHandIndex4'],
  },
  'mixamo with numbered namespace': {
    names: ['mixamorig1:Hips', 'mixamorig1:Spine', 'mixamorig1:Head', 'mixamorig1:LeftArm', 'mixamorig1:RightArm'],
    expected: { hips: 'mixamorig1:Hips', spine: 'mixamorig1:Spine', leftUpperArm: 'mixamorig1:LeftArm', rightUpperArm: 'mixamorig1:RightArm' },
    unmapped: [],
  },
  vrm: {
    names: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'leftIndexProximal', 'rightLittleDistal'],
    expected: { upperChest: 'upperChest', leftShoulder: 'leftShoulder', leftToes: 'leftToes', leftIndexProximal: 'leftIndexProximal',
      rightLittleDistal: 'rightLittleDistal' },
    unmapped: [],
  },
  'vrm 0 bip names': {
    names: ['J_Bip_C_Hips', 'J_Bip_C_Spine', 'J_Bip_L_UpperArm', 'J_Bip_R_LowerLeg', 'J_Bip_L_Index1'],
    expected: { hips: 'J_Bip_C_Hips', spine: 'J_Bip_C_Spine', leftUpperArm: 'J_Bip_L_UpperArm', rightLowerLeg: 'J_Bip_R_LowerLeg',
      leftIndexProximal: 'J_Bip_L_Index1' },
    unmapped: [],
  },
  unreal: {
    names: ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'neck_01', 'head', 'clavicle_l', 'upperarm_l',
      'lowerarm_l', 'lowerarm_twist_01_l', 'hand_l', 'index_01_l', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'ik_foot_l', 'thigh_r'],
    expected: { hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', leftShoulder: 'clavicle_l',
      leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l', leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l',
      leftFoot: 'foot_l', leftToes: 'ball_l', leftIndexProximal: 'index_01_l', rightUpperLeg: 'thigh_r' },
    unmapped: ['root', 'spine_04', 'lowerarm_twist_01_l', 'ik_foot_l'],
  },
  rigify: {
    names: ['root', 'ORG-spine', 'DEF-spine', 'DEF-spine.001', 'DEF-spine.002', 'DEF-spine.003', 'DEF-spine.004', 'DEF-spine.006',
      'DEF-shoulder.L', 'DEF-upper_arm.L', 'DEF-upper_arm.L.001', 'DEF-forearm.L', 'DEF-hand.L', 'DEF-f_index.01.L', 'DEF-thigh.L',
      'DEF-thigh.L.001', 'DEF-shin.L', 'DEF-foot.L', 'DEF-toe.L', 'DEF-thigh.R'],
    expected: { hips: 'DEF-spine', spine: 'DEF-spine.001', chest: 'DEF-spine.002', upperChest: 'DEF-spine.003', neck: 'DEF-spine.004',
      head: 'DEF-spine.006', leftShoulder: 'DEF-shoulder.L', leftUpperArm: 'DEF-upper_arm.L', leftLowerArm: 'DEF-forearm.L',
      leftUpperLeg: 'DEF-thigh.L', leftLowerLeg: 'DEF-shin.L', leftToes: 'DEF-toe.L', leftIndexProximal: 'DEF-f_index.01.L',
      rightUpperLeg: 'DEF-thigh.R' },
    unmapped: ['root', 'ORG-spine', 'DEF-upper_arm.L.001', 'DEF-thigh.L.001'],
  },
  quaternius: {
    names: ['Hips', 'Abdomen', 'Torso', 'Neck', 'Head', 'Shoulder.L', 'UpperArm.L', 'LowerArm.L', 'Fist.L', 'UpperLeg.L',
      'LowerLeg.L', 'Foot.L', 'Toes.L', 'UpperArm.R', 'Fist.R'],
    expected: { hips: 'Hips', spine: 'Abdomen', chest: 'Torso', leftShoulder: 'Shoulder.L', leftUpperArm: 'UpperArm.L',
      leftLowerArm: 'LowerArm.L', leftHand: 'Fist.L', leftUpperLeg: 'UpperLeg.L', leftLowerLeg: 'LowerLeg.L', leftToes: 'Toes.L',
      rightUpperArm: 'UpperArm.R', rightHand: 'Fist.R' },
    unmapped: [],
  },
};

for (const [family, { names, expected, unmapped }] of Object.entries(NAME_FAMILIES)) {
  test(`name mapping recognises the ${family} rig family`, () => {
    const result = mapHumanoidBones(names);
    for (const [bone, jointName] of Object.entries(expected)) assert.equal(result.mapping[bone], jointName, bone);
    assert.deepEqual(result.unmapped.sort(), [...unmapped].sort());
  });
}

test('name mapping reports missing required bones and accepts overrides', () => {
  const names = Object.values(UNREAL_NAMES).filter(name => name !== 'calf_l').concat('shinbone_left');
  const partial = mapHumanoidBones(names);
  assert.deepEqual(partial.missing, ['leftLowerLeg']);
  const fixed = mapHumanoidBones(names, { overrides: { leftLowerLeg: 'shinbone_left' } });
  assert.deepEqual(fixed.missing, []);
  assert.equal(fixed.mapping.leftLowerLeg, 'shinbone_left');
  assert.throws(() => mapHumanoidBones(names, { overrides: { leftLowerLeg: 'absent' } }), /not found/);
  assert.throws(() => mapHumanoidBones(names, { overrides: { tail: 'shinbone_left' } }), /Unknown humanoid bone/);
  assert.ok(REQUIRED_HUMANOID_BONES.every(bone => HUMANOID_BONES.includes(bone)));
  assert.equal(HUMANOID_BONES.length, new Set(HUMANOID_BONES).size);
});

function createRaisedArmClip(extraTracks = []) {
  const restUp = rotationAbout([0, 0, 1], 90);
  return createAnimationClip({
    duration: 1,
    tracks: [
      { target: MIXAMO_NAMES.leftUpperArm, property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: restUp }] },
      ...extraTracks,
    ],
  });
}

test('a source joint rotation moves the target bone by the same world-space rotation across T-pose and A-pose rests', () => {
  const source = createHumanoidRig(MIXAMO_NAMES);
  const target = createHumanoidRig(UNREAL_NAMES, { armTiltDegrees: 45 });
  const retargeted = retargetClip(source, target, createRaisedArmClip());
  const { rotations } = sampledPose(retargeted, 1);
  const elbow = UNREAL_NAMES.leftLowerArm;
  const restDirection = direction(worldPosition(target, UNREAL_NAMES.leftUpperArm), worldPosition(target, elbow));
  const animatedDirection = direction(worldPosition(target, UNREAL_NAMES.leftUpperArm, rotations), worldPosition(target, elbow, rotations));
  const expectedDirection = vec3.transformQuat(new Float64Array(3), restDirection, rotationAbout([0, 0, 1], 90));
  assertVectorsClose(restDirection, [Math.SQRT1_2, -Math.SQRT1_2, 0]);
  assertVectorsClose(animatedDirection, expectedDirection);
  const unmovedKnee = worldPosition(target, UNREAL_NAMES.leftLowerLeg, rotations);
  assertVectorsClose(unmovedKnee, worldPosition(target, UNREAL_NAMES.leftLowerLeg));
});

test('a source with differently oriented bone axes produces the same world pose on the target', () => {
  const source = createHumanoidRig(MIXAMO_NAMES);
  const twistedSource = structuredClone(source);
  const upperArmJoint = twistedSource.joints.find(joint => joint.name === MIXAMO_NAMES.leftUpperArm);
  upperArmJoint.rotation = rotationAbout([1, 0, 0], 90);
  const lowerArmJoint = twistedSource.joints.find(joint => joint.name === MIXAMO_NAMES.leftLowerArm);
  lowerArmJoint.translation = [0, 0.3, 0];
  const target = createHumanoidRig(UNREAL_NAMES);
  const swing = rotationAbout([0, 0, 1], 60);
  const clip = createAnimationClip({
    duration: 1,
    tracks: [{ target: MIXAMO_NAMES.leftUpperArm, property: 'rotation', keyframes: [{ time: 0, value: upperArmJoint.rotation }, { time: 1, value: quat.multiply([], swing, upperArmJoint.rotation) }] }],
  });
  const { rotations } = sampledPose(retargetClip(twistedSource, target, clip), 1);
  const animatedDirection = direction(worldPosition(target, UNREAL_NAMES.leftUpperArm, rotations), worldPosition(target, UNREAL_NAMES.leftLowerArm, rotations));
  assertVectorsClose(animatedDirection, vec3.transformQuat(new Float64Array(3), [1, 0, 0], swing));
});

test('hips translation scales with the ratio of leg lengths and respects root motion and scale options', () => {
  const source = createHumanoidRig(MIXAMO_NAMES, { height: 1 });
  const target = createHumanoidRig(UNREAL_NAMES, { height: 2 });
  const hipsTrack = { target: MIXAMO_NAMES.hips, property: 'translation', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 1, value: [0.3, 1.1, 0.2] }] };
  const clip = createRaisedArmClip([hipsTrack]);
  const full = sampledPose(retargetClip(source, target, clip), 1).translations[UNREAL_NAMES.hips];
  assertVectorsClose(full, [0.6, 2.2, 0.4]);
  const inPlace = sampledPose(retargetClip(source, target, clip, { rootMotion: false }), 1).translations[UNREAL_NAMES.hips];
  assertVectorsClose(inPlace, [0, 2.2, 0]);
  const halved = sampledPose(retargetClip(source, target, clip, { scale: 0.5 }), 1).translations[UNREAL_NAMES.hips];
  assertVectorsClose(halved, [0.3, 2.1, 0.2]);
});

test('retargeting is deterministic and honours the bones option', () => {
  const source = createHumanoidRig(MIXAMO_NAMES);
  const target = createHumanoidRig(UNREAL_NAMES, { armTiltDegrees: 30 });
  const clip = createRaisedArmClip();
  assert.deepEqual(retargetClip(source, target, clip), retargetClip(source, target, clip));
  const onlyArm = retargetClip(source, target, clip, { bones: ['leftUpperArm'] });
  assert.deepEqual(onlyArm.tracks.map(track => track.target), [UNREAL_NAMES.leftUpperArm]);
  assert.throws(() => retargetClip(source, target, clip, { bones: ['leftToes'] }), /not mapped in both rigs/);
  assert.equal(retargetClip(source, target, clip, { frameRate: 10 }).tracks[0].keyframes.length, 11);
});

test('non-humanoid input is rejected with the missing bones listed', () => {
  const source = createHumanoidRig(MIXAMO_NAMES);
  const brokenTarget = createHumanoidRig(UNREAL_NAMES);
  brokenTarget.joints.find(joint => joint.name === 'calf_l').name = 'mystery_bone';
  assert.throws(() => retargetClip(source, brokenTarget, createRaisedArmClip()), error => {
    assert.match(error.message, /Target rig is not humanoid/);
    assert.match(error.message, /leftLowerLeg/);
    assert.deepEqual(error.missingBones, ['leftLowerLeg']);
    return true;
  });
  const repaired = retargetClip(source, brokenTarget, createRaisedArmClip(), { targetOverrides: { leftLowerLeg: 'mystery_bone' } });
  assert.ok(repaired.tracks.some(track => track.target === 'mystery_bone'));
});

function createSkinFromRig(rig) {
  const worlds = worldTransforms(rig);
  const inverseBindMatrices = new Float32Array(rig.joints.length * 16);
  worlds.forEach((world, index) => inverseBindMatrices.set(mat4.invert(mat4.create(), world), index * 16));
  const skin = createSkinPose(rig.joints.length);
  return Object.assign(skin, {
    joints: rig.joints.map(joint => ({ name: joint.name, parent: joint.parent })),
    inverseBindMatrices,
    bindMatrix: mat4.create(),
  });
}

test('a rig recovered from a skin and played with its rest clip keeps the identity palette', () => {
  const rig = createHumanoidRig(UNREAL_NAMES, { armTiltDegrees: 45 });
  const skin = createSkinFromRig(rig);
  const recovered = createRigFromSkin(skin);
  recovered.joints.forEach((joint, index) => {
    assertVectorsClose(joint.translation, rig.joints[index].translation, 1e-5);
    assert.ok(Math.abs(quat.dot(joint.rotation, rig.joints[index].rotation)) > 1 - 1e-6);
  });
  const restClip = createAnimationClip({ duration: 1, tracks: [{ target: 'upperarm_l', property: 'rotation', keyframes: [{ time: 0, value: rig.joints[3].rotation }] }] });
  const player = createSkinClipPlayer(skin, restClip);
  player.apply(0.5);
  const identity = mat4.create();
  for (let joint = 0; joint < rig.joints.length; joint++) {
    for (let component = 0; component < 16; component++) {
      assert.ok(Math.abs(skin.jointMatrices[joint * 16 + component] - identity[component]) < 1e-5);
    }
  }
  const raised = retargetClip(createHumanoidRig(MIXAMO_NAMES), rig, createRaisedArmClip());
  createSkinClipPlayer(skin, raised).apply(1);
  const armPalette = skin.jointMatrices.subarray(3 * 16, 4 * 16);
  assert.ok(Math.abs(armPalette[0] - 1) > 1e-3 || Math.abs(armPalette[1]) > 1e-3);
});

test('crowd placement and timing are deterministic per seed', () => {
  const clip = createRaisedArmClip();
  const first = createCrowd({ count: 12, clip, seed: 7, layout: 'scatter' });
  const second = createCrowd({ count: 12, clip, seed: 7, layout: 'scatter' });
  const other = createCrowd({ count: 12, clip, seed: 8, layout: 'scatter' });
  const describe = crowd => crowd.instances.map(({ position, timeOffset, playbackRate, yawRadians }) => ({ position, timeOffset, playbackRate, yawRadians }));
  assert.deepEqual(describe(first), describe(second));
  assert.notDeepEqual(describe(first), describe(other));
  assert.deepEqual(first.sample(0.25).map(entry => entry.time), second.sample(0.25).map(entry => entry.time));
  for (const { timeOffset, playbackRate } of first.instances) {
    assert.ok(timeOffset >= 0 && timeOffset < clip.duration);
    assert.ok(playbackRate >= 0.85 && playbackRate <= 1.15);
  }
});

test('crowd grid layout is centred and scatter layout keeps instances apart', () => {
  const clip = createRaisedArmClip();
  const grid = createCrowd({ count: 6, clip, columns: 3, spacing: 2 });
  assert.deepEqual(grid.instances.map(instance => instance.position), [[-2, 0, -1], [0, 0, -1], [2, 0, -1], [-2, 0, 1], [0, 0, 1], [2, 0, 1]]);
  const scatter = createCrowd({ count: 30, clip, layout: 'scatter', spacing: 2, randomYaw: true });
  const positions = scatter.instances.map(instance => instance.position);
  for (let first = 0; first < positions.length; first++) {
    for (let second = first + 1; second < positions.length; second++) {
      assert.ok(Math.hypot(positions[first][0] - positions[second][0], positions[first][2] - positions[second][2]) >= 1.5 - 1e-9);
    }
  }
  assert.ok(scatter.instances.some(instance => instance.yawRadians > 0));
  assert.throws(() => createCrowd({ count: 0, clip }), /positive integer/);
  assert.throws(() => createCrowd({ count: 2, clip, layout: 'ring' }), /Unknown crowd layout/);
});
