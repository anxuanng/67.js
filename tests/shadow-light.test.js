import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveShadowLight } from '../src/shadow-light.js';

function directionBetween(light) {
  const offset = light.eye.map((value, axis) => value - light.target[axis]);
  const length = Math.hypot(...offset);
  return offset.map(value => value / length);
}

test('the default shadow eye sits along the sun direction', () => {
  for (const world of [false, true]) {
    for (const sun of [[-3, 6, 4], [0.85, 0.2, -0.25], [5, 5, 0]]) {
      const length = Math.hypot(...sun);
      const light = resolveShadowLight(world, sun);
      directionBetween(light).forEach((component, axis) => assert.ok(Math.abs(component - sun[axis] / length) < 1e-9));
    }
  }
});

test('an explicit shadow eye wins and a custom target moves the derived eye', () => {
  assert.deepEqual(resolveShadowLight(false, [0, 1, 0], { eye: [1, 2, 3] }).eye, [1, 2, 3]);
  const moved = resolveShadowLight(false, [0, 1, 0], { target: [4, 0, 0] });
  assert.equal(moved.eye[0], 4);
  assert.ok(moved.eye[1] > 1);
});

test('a missing or zero sun falls back to the default direction', () => {
  assert.deepEqual(resolveShadowLight(true, undefined).eye, resolveShadowLight(true, [-3, 6, 4]).eye);
  assert.deepEqual(resolveShadowLight(true, [0, 0, 0]).eye, resolveShadowLight(true, [-3, 6, 4]).eye);
});
