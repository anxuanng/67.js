import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentMap, computeIrradianceCoefficients, evaluateIrradiance } from '../src/environment.js';
import { withGroundBounce } from '../src/ground-bounce.js';

const WIDTH = 8;
const HEIGHT = 4;

function uniformSky(value, extra = {}) {
  return createEnvironmentMap({ width: WIDTH, height: HEIGHT, data: new Float32Array(WIDTH * HEIGHT * 3).fill(value), ...extra });
}

function pixel(map, column, row) {
  const offset = (row * map.width + column) * map.channels;
  return Array.from(map.data.slice(offset, offset + 3));
}

test('the lower half becomes albedo times the sky and sun on the ground, and the upper half is kept', () => {
  const sky = uniformSky(0.5);
  const bounced = withGroundBounce(sky, { albedo: [0.4, 0.2, 0.1], keyColor: [Math.PI, Math.PI, Math.PI], lightDirection: [0, 2, 0] });
  const skyOnGround = evaluateIrradiance(computeIrradianceCoefficients(sky), [0, 1, 0]);
  assert.deepEqual(pixel(bounced, 3, 0), pixel(sky, 3, 0));
  assert.deepEqual(pixel(bounced, 3, 1), pixel(sky, 3, 1));
  const expected = [0.4, 0.2, 0.1].map((albedo, index) => albedo * (1 + skyOnGround[index]));
  pixel(bounced, 3, 3).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-5));
  assert.deepEqual(pixel(bounced, 0, 2), pixel(bounced, 7, 3));
});

test('a sun below the horizon, black albedo or no sun leaves only the sky term', () => {
  const sky = uniformSky(0.5);
  const skyOnGround = evaluateIrradiance(computeIrradianceCoefficients(sky), [0, 1, 0]);
  const night = withGroundBounce(sky, { albedo: [1, 1, 1], keyColor: [5, 5, 5], lightDirection: [0, -1, 0] });
  assert.ok(Math.abs(pixel(night, 0, 3)[0] - skyOnGround[0]) < 1e-5);
  const black = withGroundBounce(sky, { albedo: [0, 0, 0], keyColor: [5, 5, 5], lightDirection: [0, 1, 0] });
  assert.deepEqual(pixel(black, 0, 3), [0, 0, 0]);
});

test('the map keeps its intensity, rotation and size, and the input map is not changed', () => {
  const sky = uniformSky(0.5, { intensity: 2, rotation: 1, showBackground: true });
  const before = Array.from(sky.data);
  const bounced = withGroundBounce(sky, { albedo: [0.5, 0.5, 0.5], keyColor: [1, 1, 1], lightDirection: [0, 1, 0] });
  assert.equal(bounced.intensity, 2);
  assert.equal(bounced.rotation, 1);
  assert.equal(bounced.showBackground, true);
  assert.equal(bounced.width, WIDTH);
  assert.deepEqual(Array.from(sky.data), before);
});

test('the bounce lights a wall: a vertical normal gets more irradiance than the sky alone gave', () => {
  const sky = uniformSky(0.5);
  const sideways = [1, 0, 0];
  const plain = evaluateIrradiance(computeIrradianceCoefficients(sky), sideways);
  const bounced = withGroundBounce(sky, { albedo: [0.4, 0.4, 0.4], keyColor: [3, 3, 3], lightDirection: [0, 1, 0] });
  const lit = evaluateIrradiance(computeIrradianceCoefficients(bounced), sideways);
  assert.ok(lit[0] > plain[0] * 0.5);
});
