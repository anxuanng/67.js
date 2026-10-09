import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Matrix4, Vector3 } from 'three';
import { createCameraPath, fovFromFocalLength } from '../src/camera-path.js';

function close(actual, expected, tolerance = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${value} differs from ${expected[index]}`));
}

test('lens conversion agrees with a Three camera with a 24mm sensor height', () => {
  const reference = new PerspectiveCamera(45, 35 / 24);
  for (const focalLength of [18, 35, 50, 85]) {
    reference.setFocalLength(focalLength);
    assert.ok(Math.abs(fovFromFocalLength(focalLength) - reference.fov) < 1e-12);
  }
  assert.throws(() => fovFromFocalLength(0), /positive/);
});

test('camera follows a Hermite arc and is independent of seek order and input mutation', () => {
  const keyframes = [
    { time: 0, value: [0, 1, 4], inTangent: [0, 0, 0], outTangent: [2, 0, 0] },
    { time: 2, value: [2, 1, 4], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
  ];
  const path = createCameraPath({ duration: 2, eye: { interpolation: 'CUBICSPLINE', keyframes } });
  const midpoint = path.sample(1);
  close(midpoint.eye, [1.5, 1, 4]);
  keyframes[0].value[0] = 100;
  path.sample(2);
  assert.deepEqual(path.sample(1), midpoint);
  assert.notEqual(path.sample(1).eye, midpoint.eye);
  close(path.sample(-10).eye, [0, 1, 4]);
  close(path.sample(20).eye, [2, 1, 4]);
});

test('tracking transforms a local target offset and roll changes the up vector', () => {
  const matrix = new Matrix4().makeRotationY(Math.PI / 2).setPosition(2, 0, 0);
  const path = createCameraPath({ duration: 1, eye: [2, 0, 5], target: [1, 0, 0], roll: Math.PI / 2 });
  const frame = path.sample(0, undefined, { targetMatrix: matrix.elements });
  close(frame.target, new Vector3(1, 0, 0).applyMatrix4(matrix).toArray());
  close(frame.up, [1, 0, 0]);
});

test('retained outputs preserve identity and rejected samples leave the frame untouched', () => {
  const path = createCameraPath({ duration: 1, eye: [0, 0, 4] });
  const output = { eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3) };
  assert.equal(path.sample(0.5, output), output);
  const before = structuredClone(output);
  const eye = output.eye;
  assert.throws(() => path.sample(NaN, output), /finite/);
  assert.deepEqual(output, before);
  assert.equal(output.eye, eye);
  const collapse = new Matrix4().makeTranslation(0, 0, 4).elements;
  assert.throws(() => path.sample(0, output, { targetMatrix: collapse }), /distinct/);
  assert.deepEqual(output, before);
});

test('Float32 precision collapse is rejected before publishing outputs', () => {
  const path = createCameraPath({ duration: 1, eye: [1e10, 0, 0], target: [1e10 + 1, 0, 0] });
  const output = { eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3) };
  assert.throws(() => path.sample(0, output), /distinct/);
  close(output.eye, [0, 0, 0]);
});

test('overlapping views and readonly output components reject before any writes', () => {
  const path = createCameraPath({ duration: 1, eye: [0, 0, 4] });
  const buffer = new ArrayBuffer(48);
  const output = { eye: new Float32Array(buffer, 0, 3), target: new Float32Array(buffer, 8, 3), up: [0, 0, 0] };
  assert.throws(() => path.sample(0, output), /overlap/);
  const readonly = { eye: [9, 9, 9], target: [8, 8, 8], up: [7, 7, 7] };
  Object.defineProperty(readonly.target, '1', { writable: false });
  assert.throws(() => path.sample(0, readonly), /writable/);
  assert.deepEqual(readonly.eye, [9, 9, 9]);
  const sealed = Object.seal({ eye: [9, 9, 9], target: [8, 8, 8], up: [7, 7, 7] });
  assert.throws(() => path.sample(0, sealed), /writable/);
  assert.deepEqual(sealed.eye, [9, 9, 9]);
  const prototype = {};
  Object.defineProperty(prototype, 'fov', { value: 45, writable: false });
  const inherited = Object.assign(Object.create(prototype), { eye: [9, 9, 9], target: [8, 8, 8], up: [7, 7, 7] });
  assert.throws(() => path.sample(0, inherited), /writable/);
  assert.deepEqual(inherited.eye, [9, 9, 9]);
});

test('looping and cubic lens overshoot obey camera domain constraints', () => {
  const loop = createCameraPath({ duration: 2, loop: true, eye: {
    keyframes: [{ time: 0, value: [0, 0, 4] }, { time: 2, value: [2, 0, 4] }],
  } });
  assert.deepEqual(loop.sample(-0.5), loop.sample(1.5));
  const path = createCameraPath({ duration: 2, eye: [0, 0, 4], fov: {
    interpolation: 'CUBICSPLINE', keyframes: [
      { time: 0, value: 45, inTangent: 0, outTangent: 600 },
      { time: 2, value: 45, inTangent: -600, outTangent: 0 },
    ],
  } });
  const output = path.sample(0);
  const before = structuredClone(output);
  assert.throws(() => path.sample(1, output), /field of view/);
  assert.deepEqual(output, before);
  assert.throws(() => createCameraPath({ duration: 1, eye: [0, 4, 0] }), /parallel/);
  assert.throws(() => createCameraPath({ duration: 1, eye: [0, 0, 4], far: 0.05 }), /clipping/);
});
