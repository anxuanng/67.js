import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { applyProjection, cameraView, fitOrthographicHeight } from '../src/camera.js';

function project(point, frame, aspect = 1) {
  const projection = applyProjection(mat4.create(), frame, aspect);
  const view = mat4.lookAt(mat4.create(), frame.eye, frame.target, frame.up);
  return vec3.transformMat4(vec3.create(), point, mat4.multiply(mat4.create(), projection, view));
}

test('orthographic XY size is invariant with depth and perspective size is not', () => {
  const frame = cameraView('front', { target: [0, 0, 0], height: 4 });
  const close = project([1, 1, 2], frame);
  const distant = project([1, 1, -2], frame);
  assert.equal(close[0], distant[0]);
  assert.equal(close[1], distant[1]);
  assert.notEqual(close[2], distant[2]);
  frame.projection = 'perspective';
  assert.ok(project([1, 0, 2], frame)[0] > project([1, 0, -2], frame)[0]);
});

test('axis views keep the expected screen direction, including a usable top up vector', () => {
  const front = cameraView('front', { target: [0, 0, 0] });
  const right = cameraView('right', { target: [0, 0, 0] });
  const top = cameraView('top', { target: [0, 0, 0] });
  assert.ok(project([1, 0, 0], front)[0] > 0);
  assert.ok(project([0, 1, 0], front)[1] > 0);
  assert.ok(project([0, 0, -1], right)[0] > 0);
  assert.ok(project([1, 0, 0], top)[0] > 0);
  assert.ok(project([0, 0, -1], top)[1] > 0);
  assert.ok(Array.from(project([1, 0, 1], top)).every(Number.isFinite));
});

test('projection preserves existing shifts for callers without explicit camera projection', () => {
  const projection = mat4.perspective(mat4.create(), Math.PI / 4, 1.5, 0.1, 100);
  projection[8] = -0.25;
  const original = Array.from(projection);
  assert.equal(applyProjection(projection, {}, 1.5), projection);
  assert.deepEqual(Array.from(projection), original);
});

test('orthographic fit respects both horizontal and vertical extents', () => {
  const bounds = { minimum: [-2, -1, -0.5], maximum: [2, 1, 0.5] };
  const front = cameraView('front', { target: [0, 0, 0] });
  assert.equal(fitOrthographicHeight(bounds, front, 2, 1), 2);
  assert.equal(fitOrthographicHeight(bounds, front, 0.5, 1), 8);
  assert.equal(fitOrthographicHeight(bounds, cameraView('top', { target: [0, 0, 0] }), 2, 1), 2);
  assert.throws(() => applyProjection(mat4.create(), { projection: 'orthographic', orthographicHeight: 0 }, 1), /height/);
  assert.throws(() => applyProjection(mat4.create(), { fov: 190 }, 1), /field/);
  assert.throws(() => cameraView('diagonal'), /view/);
});
