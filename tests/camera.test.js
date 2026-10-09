import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { applyProjection, cameraView, fitOrthographicHeight, fitPerspectiveDistance } from '../src/camera.js';
import { PerspectiveCamera, Vector3 } from 'three';

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

test('perspective fit contains off-center boxes under tilted and rolled Three.js cameras', () => {
  const bounds = { minimum: [-0.7, -0.2, -0.9], maximum: [1.3, 1.8, 0.5] };
  for (const aspect of [9 / 16, 1, 16 / 9, 3]) {
    for (const up of [[0, 1, 0], [0.4, 1, 0.3]]) {
      const view = { eye: [3, 2, 5], target: [0.2, 0.3, 0], up, fov: 38, near: 0.1, far: 100 };
      const distance = fitPerspectiveDistance(bounds, view, aspect, 1.15);
      const camera = new PerspectiveCamera(view.fov, aspect, view.near, view.far);
      camera.up.fromArray(up);
      const direction = new Vector3().fromArray(view.eye).sub(new Vector3().fromArray(view.target)).normalize();
      camera.position.fromArray(view.target).addScaledVector(direction, distance);
      camera.lookAt(...view.target);
      camera.updateMatrixWorld();
      let tightest = 0;
      for (let corner = 0; corner < 8; corner++) {
        const coordinates = [0, 1, 2].map(axis => corner & (1 << axis) ? bounds.maximum[axis] : bounds.minimum[axis]);
        const projected = new Vector3(...coordinates).project(camera);
        tightest = Math.max(tightest, Math.abs(projected.x), Math.abs(projected.y));
        assert.ok(Math.abs(projected.x) <= 1 / 1.15 + 1e-10);
        assert.ok(Math.abs(projected.y) <= 1 / 1.15 + 1e-10);
        assert.ok(projected.z >= -1 && projected.z <= 1);
      }
      assert.ok(Math.abs(tightest - 1 / 1.15) < 1e-10, 'fit retains the requested margin without unnecessary zoom-out');
    }
  }
});

test('perspective fit rejects invalid bounds, lenses and impossible clipping without mutating inputs', () => {
  const bounds = { minimum: [-1, -1, -1], maximum: [1, 1, 1] };
  const view = { eye: [0, 0, 5], target: [0, 0, 0], fov: 40, near: 0.1, far: 100 };
  const snapshot = structuredClone({ bounds, view });
  for (const aspect of [0, -1, NaN, Infinity]) assert.throws(() => fitPerspectiveDistance(bounds, view, aspect));
  assert.throws(() => fitPerspectiveDistance(bounds, { ...view, far: 1 }, 0.5), /clipping/);
  assert.throws(() => fitPerspectiveDistance(bounds, { ...view, target: view.eye }, 1), /differ/);
  assert.throws(() => fitPerspectiveDistance(bounds, { ...view, up: [0, 0, 1] }, 1), /parallel/);
  assert.throws(() => fitPerspectiveDistance(bounds, { ...view, fov: 180 }, 1), /lens/);
  assert.throws(() => fitPerspectiveDistance(bounds, { ...view, projection: 'orthographic' }, 1), /perspective/);
  assert.throws(() => fitPerspectiveDistance({ minimum: [0, 0, 0], maximum: [-1, 1, 1] }, view, 1), /bounds/);
  assert.throws(() => fitPerspectiveDistance(bounds, view, 1e-320), /range|clipping/);
  assert.deepEqual({ bounds, view }, snapshot);
});

test('perspective fit shares renderer clipping defaults and rejects unrepresentable camera positions', () => {
  const bounds = { minimum: [-1, -1, -150], maximum: [1, 1, -140] };
  const view = { eye: [0, 0, 1], target: [0, 0, 0], fov: 45 };
  assert.throws(() => fitPerspectiveDistance(bounds, view, 1), /clipping/);
  assert.equal(fitPerspectiveDistance(bounds, { ...view, far: 600 }, 1), 0.1);
  const distantBounds = { minimum: [1e20, -1, -1], maximum: [1e20, 1, 1] };
  const distantView = { eye: [0, 0, 0], target: [1e20, 0, 0], fov: 45, far: 600 };
  assert.throws(() => fitPerspectiveDistance(distantBounds, distantView, 1), /Float32/);
});
