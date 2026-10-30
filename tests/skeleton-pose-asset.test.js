import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { quat, vec3 } from 'gl-matrix';
import { parseGltf } from '../src/gltf.js';
import { validateSkinGeometry, createSkinPose } from '../src/skinning.js';
import { clipFromGltfAnimation, createAssetPose } from '../src/skeleton-pose.js';

// A real character: CC0 RobotExpressive by Tomás Laulhé, with modifications by Don McCurdy. Most of it is rigid parts
// attached to bones, with four skinned hand meshes, under an armature scaled by 100 and rotated by -90 degrees.
const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

function loadRobot() {
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

function clipNamed(asset, name) {
  return clipFromGltfAnimation(asset.animations.find(animation => animation.name === name), { loop: true });
}

function partMatrix(asset, name) {
  return Array.from(asset.parts.find(part => part.name === name).matrix);
}

function matrixDistance(first, second) {
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])));
}

test('a real exported file loads even though some weights are one unit of rounding above 1', async () => {
  const asset = await loadRobot();
  assert.equal(asset.parts.length, 19);
  assert.equal(asset.skins.length, 4);
  const geometry = { positions: { length: 3 }, skinIndices: new Uint16Array([0, 0, 0, 0]), skinWeights: new Float32Array([1.0000001192092896, 0, 0, 0]) };
  assert.doesNotThrow(() => validateSkinGeometry(geometry, createSkinPose(1)));
  geometry.skinWeights = new Float32Array([1.01, 0, 0, 0]);
  assert.throws(() => validateSkinGeometry(geometry, createSkinPose(1)), /within zero and one/);
});

test('a GLB clip through createAssetPose matches the decoder playing it, on rigid parts and skins', async () => {
  const reference = await loadRobot();
  const posed = await loadRobot();
  const clipIndex = reference.animations.findIndex(animation => animation.name === 'Walking');
  const pose = createAssetPose(posed, { layers: [{ clip: clipNamed(posed, 'Walking') }] });
  for (const time of [0, 0.3, 0.71]) {
    reference.applyAnimation(time, clipIndex);
    pose.apply(time);
    reference.parts.forEach((part, index) => {
      const distance = matrixDistance(Array.from(part.matrix), Array.from(posed.parts[index].matrix));
      assert.ok(distance < 5e-4, `${part.name} at ${time}: ${distance}`);
    });
    reference.skins.forEach((skin, index) => {
      const distance = matrixDistance(Array.from(skin.jointMatrices), Array.from(posed.skins[index].jointMatrices));
      assert.ok(distance < 1e-4, `skin ${index} at ${time}: ${distance}`);
    });
  }
});

test('rigid parts follow the pose, and seeking back gives the same matrices', async () => {
  const asset = await loadRobot();
  const pose = createAssetPose(asset, { layers: [{ clip: clipNamed(asset, 'Walking') }] });
  pose.apply(0.1);
  const early = partMatrix(asset, 'LegL');
  pose.apply(0.5);
  assert.ok(matrixDistance(early, partMatrix(asset, 'LegL')) > 1e-3, 'the leg moved');
  pose.apply(0.1);
  assert.deepEqual(partMatrix(asset, 'LegL'), early);
});

test('a mask limits a clip to one arm of a walking character', async () => {
  const plainAsset = await loadRobot();
  const plain = createAssetPose(plainAsset, { layers: [{ clip: clipNamed(plainAsset, 'Walking') }] });
  plain.apply(0.4);
  const maskedAsset = await loadRobot();
  const masked = createAssetPose(maskedAsset, { layers: [{ clip: clipNamed(maskedAsset, 'Walking') }, { clip: clipNamed(maskedAsset, 'Wave'), mask: { joints: ['ShoulderR'] } }] });
  masked.apply(0.4);
  assert.ok(matrixDistance(partMatrix(plainAsset, 'ArmR'), partMatrix(maskedAsset, 'ArmR')) > 1e-3, 'the masked arm changed');
  for (const name of ['ArmL', 'LegL', 'LegR', 'Head_2']) {
    assert.ok(matrixDistance(partMatrix(plainAsset, name), partMatrix(maskedAsset, name)) < 1e-5, `${name} stayed on the walk`);
  }
});

test('arm IK reaches a world point through the armature scale and rotation', async () => {
  const asset = await loadRobot();
  const target = [-1.3, 2.1, 0.8];
  const pose = createAssetPose(asset, {
    layers: [{ clip: clipNamed(asset, 'Idle') }],
    ik: [{ type: 'two-bone', root: 'UpperArmR', middle: 'LowerArmR', end: 'Palm2R', target, keepEndRotation: false }],
  });
  pose.apply(0);
  assert.equal(pose.ikResults[0].reached, true);
  assert.ok(vec3.distance(pose.jointWorld('Palm2R').position, target) < 1e-3);
});

test('worldForward aims by the way the character faces, whatever the bone axes are', async () => {
  const asset = await loadRobot();
  const rest = createAssetPose(asset);
  rest.apply(0);
  const restRotation = rest.jointWorld('Head').rotation;
  const localForward = vec3.transformQuat(new Float64Array(3), [0, 0, 1], quat.invert(new Float64Array(4), restRotation));
  const target = [2, 3, 4];
  const pose = createAssetPose(asset, { ik: [{ type: 'aim', joint: 'Head', worldForward: [0, 0, 1], target }] });
  pose.apply(0);
  const { position, rotation } = pose.jointWorld('Head');
  const facing = vec3.transformQuat(new Float64Array(3), localForward, rotation);
  const toTarget = vec3.subtract(new Float64Array(3), target, position);
  assert.ok(vec3.angle(facing, toTarget) < 1e-3);
  assert.equal(pose.ikResults[0].reached, true);
  assert.throws(() => createAssetPose(asset, { ik: [{ type: 'aim', joint: 'Head', forward: [0, 0, 1], worldForward: [0, 0, 1], target }] }), /forward or worldForward, not both/);
});

test('a foot that is not a child of the lower leg gets a clear error', async () => {
  const asset = await loadRobot();
  assert.throws(() => createAssetPose(asset, {
    ik: [{ type: 'two-bone', root: 'UpperLegL', middle: 'LowerLegL', end: 'FootL', target: [0, 0, 0] }],
  }), /end must descend from middle/);
});

test('clip conversion keeps node tracks and skips morph weights', async () => {
  const asset = await loadRobot();
  const source = asset.animations.find(animation => animation.name === 'Wave');
  const clip = clipFromGltfAnimation(source);
  assert.ok(clip.tracks.every(track => ['rotation', 'translation', 'scale'].includes(track.property)));
  assert.ok(clip.tracks.some(track => track.target === 'ShoulderR' && track.property === 'rotation'));
  assert.ok(clip.tracks.length < source.tracks.length);
  assert.throws(() => clipFromGltfAnimation({}), /needs an animation/);
  assert.throws(() => createAssetPose({}), /needs an asset/);
});
