import assert from 'node:assert/strict';
import test from 'node:test';
import { quat } from 'gl-matrix';
import { createSkeletonPose } from '../src/skeleton-pose.js';
import { eulerFromQuaternion, quaternionFromEuler } from '../src/rotation-euler.js';

const LEG = { type: 'two-bone', root: 'hip', middle: 'knee', end: 'ankle' };

function createLegRig() {
  return {
    mapping: {},
    joints: [
      { name: 'hip', parent: -1, translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'knee', parent: 0, translation: [0, -0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'ankle', parent: 1, translation: [0, -0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    ],
  };
}

function solved(definition, time = 0) {
  const pose = createSkeletonPose({ rig: createLegRig(), ik: [{ ...LEG, ...definition }] });
  pose.apply(time);
  return pose;
}

function localKneeDegrees(pose) {
  return eulerFromQuaternion(pose.localRotation(1)).map(radians => radians * 180 / Math.PI);
}

test('euler conversion round trips in Blender XYZ order', () => {
  const angles = [0.4, -0.7, 1.1];
  const rotation = quaternionFromEuler(new Float64Array(4), ...angles);
  eulerFromQuaternion(rotation).forEach((angle, axis) => assert.ok(Math.abs(angle - angles[axis]) < 1e-9));
  const expected = quat.multiply(new Float64Array(4), quat.setAxisAngle(new Float64Array(4), [0, 0, 1], 1.1),
    quat.multiply(new Float64Array(4), quat.setAxisAngle(new Float64Array(4), [0, 1, 0], -0.7), quat.setAxisAngle(new Float64Array(4), [1, 0, 0], 0.4)));
  assert.ok(Math.abs(Math.abs(quat.dot(rotation, expected)) - 1) < 1e-12);
});

test('a joint limit clamps the solved pose and the change is reported', () => {
  const free = solved({ target: [0, 0.4, 0.45], pole: [0, 0.7, 2] });
  const freeKnee = localKneeDegrees(free)[0];
  assert.ok(Math.abs(freeKnee) > 60, `the unlimited knee bends ${freeKnee} degrees`);
  const limit = Math.sign(freeKnee) > 0 ? [0, 30] : [-30, 0];
  const pose = solved({ target: [0, 0.4, 0.45], pole: [0, 0.7, 2], limits: { middle: { x: limit } } });
  const [result] = pose.ikResults;
  assert.ok(Math.abs(localKneeDegrees(pose)[0]) <= 30 + 1e-6);
  assert.equal(result.limited.length, 1);
  assert.equal(result.limited[0].joint, 'knee');
  assert.equal(result.limited[0].axis, 'x');
  assert.ok(Math.abs(result.limited[0].requested) > Math.abs(result.limited[0].applied));
  assert.equal(result.reached, false, 'a clamped knee can not reach the far target');
  assert.deepEqual(free.ikResults[0].limited, []);
});

test('limits that the pose already respects change nothing', () => {
  const free = solved({ target: [0, 0.4, 0.45], pole: [0, 0.7, 2] });
  const limited = solved({ target: [0, 0.4, 0.45], pole: [0, 0.7, 2], limits: { middle: { x: [-170, 170] }, root: { z: [-45, 45] } } });
  assert.deepEqual(limited.ikResults[0].limited, []);
  assert.ok(Math.abs(quat.dot(free.localRotation(1), limited.localRotation(1))) > 1 - 1e-12);
});

test('limits are checked when the pose is built', () => {
  const build = limits => createSkeletonPose({ rig: createLegRig(), ik: [{ ...LEG, target: [0, 0.5, 0], limits }] });
  assert.throws(() => build({ ankle: { x: [0, 1] } }), /root or middle/);
  assert.throws(() => build({ middle: { w: [0, 1] } }), /x, y or z/);
  assert.throws(() => build({ middle: { x: [10, -10] } }), /min first/);
  assert.throws(() => build({ middle: { x: [0, 400] } }), /within -180 and 180/);
});

test('a wrong pole bends the knee backward and warns; the right pole stays quiet', () => {
  const backward = solved({ target: [0, 0.4, 0.2], pole: [0, 0.7, -2], bendToward: [0, 0, 1] });
  const [wrong] = backward.ikResults;
  assert.equal(wrong.reached, true, 'the foot still arrives, which is why the warning is needed');
  assert.deepEqual(wrong.warnings.map(warning => warning.code), ['wrong-bend']);
  assert.match(wrong.warnings[0].message, /knee/);
  const forward = solved({ target: [0, 0.4, 0.2], pole: [0, 0.7, 2], bendToward: [0, 0, 1] });
  assert.deepEqual(forward.ikResults[0].warnings, []);
});

test('a limb that rests bent warns when it is solved the other way, without bendToward', () => {
  const rig = createLegRig();
  rig.joints[1].rotation = Array.from(quaternionFromEuler(new Float64Array(4), 0.6, 0, 0));
  const run = pole => {
    const pose = createSkeletonPose({ rig, ik: [{ ...LEG, target: [0, 0.4, 0.2], pole }] });
    pose.apply(0);
    return pose.ikResults[0].warnings.map(warning => warning.code);
  };
  const restBend = createSkeletonPose({ rig });
  restBend.apply(0);
  const restKneeZ = restBend.jointWorld('knee').position[2];
  const naturalSide = Math.sign(restKneeZ) || 1;
  assert.deepEqual(run([0, 0.7, 2 * naturalSide]), []);
  assert.deepEqual(run([0, 0.7, -2 * naturalSide]), ['wrong-bend']);
});

test('a limb stretched to its reach warns about hyperextension', () => {
  const pose = solved({ target: [0, -2, 0.1], pole: [0, 0, 2] });
  const [result] = pose.ikResults;
  assert.equal(result.reached, false);
  assert.ok(result.warnings.some(warning => warning.code === 'hyperextended'));
});

test('seeking gives the same limited pose as playing to that time', () => {
  const definition = {
    target: { },
    pole: [0, 0.7, 2], limits: { middle: { x: [-30, 30] } },
  };
  const targetAt = time => [0, 0.45 - 0.1 * time, 0.4 * time];
  const make = () => createSkeletonPose({ rig: createLegRig(), ik: [{ ...LEG, ...definition, target: (time) => targetAt(time) }] });
  const played = make();
  [0, 0.25, 0.5, 0.75, 1].forEach(time => played.apply(time));
  const sought = make();
  sought.apply(1);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(Array.from(sought.localRotation(index)), Array.from(played.localRotation(index)));
  }
  assert.deepEqual(sought.ikResults[0].limited, played.ikResults[0].limited);
});
