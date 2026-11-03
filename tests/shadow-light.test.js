import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveShadowLight, shadowBiasPerSlope } from '../src/shadow-light.js';

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

test('the shadow bias is the same distance in metres for two depth ranges', () => {
  const mapSize = 2048;
  const studio = resolveShadowLight(false, [-3, 6, 4], { extent: 8, near: 0.1, far: 40 });
  const world = resolveShadowLight(false, [-3, 6, 4], { extent: 8, near: 1, far: 200 });
  const studioMetres = shadowBiasPerSlope(studio, mapSize) * (studio.far - studio.near);
  const worldMetres = shadowBiasPerSlope(world, mapSize) * (world.far - world.near);
  assert.ok(Math.abs(studioMetres - worldMetres) < 1e-12);
  // 3.5 texels of a 16 m wide map held in 2048 texels.
  assert.ok(Math.abs(studioMetres - (16 / 2048) * 3.5) < 1e-12);
  assert.ok(shadowBiasPerSlope(studio, mapSize) > shadowBiasPerSlope(world, mapSize));
});

test('the shadow bias in metres follows the texel size', () => {
  const mapSize = 2048;
  const narrow = resolveShadowLight(true, [-3, 6, 4], { extent: 4, near: 1, far: 100 });
  const wide = resolveShadowLight(true, [-3, 6, 4], { extent: 8, near: 1, far: 100 });
  const ratio = shadowBiasPerSlope(wide, mapSize) / shadowBiasPerSlope(narrow, mapSize);
  assert.ok(Math.abs(ratio - 2) < 1e-12);
});
