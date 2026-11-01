import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, vec3 } from 'gl-matrix';
import { createFragmentShader } from '../src/shaders.js';
import { CascadedShadows, cascadeSplitDistances, createCascadedShadows, writeCascadeMatrix } from '../src/cascaded-shadows.js';

const TOWARD_LIGHT = vec3.normalize(vec3.create(), [-0.7, 0.8, 0.35]);
const RESOLUTION = 2048;
const CASTER_REACH = 200;

function projectedPoint(matrix, point) {
  return vec3.transformMat4(vec3.create(), point, matrix);
}

test('split distances grow, end at the far plane and sit between a uniform and a logarithmic split', () => {
  const splits = cascadeSplitDistances(4, 0.1, 100, 0.7);
  assert.equal(splits.length, 4);
  assert.equal(splits[3], 100);
  for (let index = 1; index < splits.length; index++) assert.ok(splits[index] > splits[index - 1]);
  const uniformFirst = 0.1 + (100 - 0.1) / 4;
  assert.ok(splits[0] < uniformFirst, 'the first slice is shorter than a uniform one');
  assert.ok(splits[0] > 0.1);
});

test('one cascade covers the whole range', () => {
  assert.deepEqual(cascadeSplitDistances(1, 0.5, 80), [80]);
});

test('a cascade matrix maps its own sphere inside the depth map', () => {
  const sphere = { center: [3, 1, -20], radius: 12 };
  const matrix = mat4.create();
  const { texel, range } = writeCascadeMatrix(matrix, sphere, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  assert.ok(Math.abs(texel - 24 / RESOLUTION) < 1e-12);
  assert.ok(range > CASTER_REACH);
  const centre = projectedPoint(matrix, sphere.center);
  assert.ok(Math.abs(centre[0]) < 2 / RESOLUTION * 1.01 && Math.abs(centre[1]) < 2 / RESOLUTION * 1.01, 'the centre stays within a texel of the middle');
  const towardCamera = projectedPoint(matrix, vec3.scaleAndAdd(vec3.create(), sphere.center, TOWARD_LIGHT, 150));
  assert.ok(towardCamera[2] > -1 && towardCamera[2] < 1, 'a caster far toward the light is inside the depth range');
});

test('moving the slice by less than a texel leaves the matrix unchanged, so edges do not crawl', () => {
  const first = mat4.create();
  const second = mat4.create();
  const sphere = { center: [3, 1, -20], radius: 12 };
  writeCascadeMatrix(first, sphere, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  const texel = 24 / RESOLUTION;
  const nudged = { center: [3 + texel * 0.01, 1, -20], radius: 12 };
  writeCascadeMatrix(second, nudged, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  assert.deepEqual([...second], [...first]);
  const far = { center: [3 + texel * 5, 1, -20], radius: 12 };
  writeCascadeMatrix(second, far, TOWARD_LIGHT, RESOLUTION, CASTER_REACH);
  assert.notDeepEqual([...second], [...first]);
});

test('a vertical light still gets a valid view', () => {
  const matrix = mat4.create();
  writeCascadeMatrix(matrix, { center: [0, 0, 0], radius: 5 }, [0, 1, 0], RESOLUTION, CASTER_REACH);
  assert.ok([...matrix].every(Number.isFinite));
});

test('options are checked', () => {
  assert.throws(() => createCascadedShadows({ count: 0 }), /cascade count/);
  assert.throws(() => createCascadedShadows({ count: 5 }), /cascade count/);
  assert.throws(() => createCascadedShadows({ count: 2.5 }), /cascade count/);
  assert.throws(() => createCascadedShadows({ resolution: 100 }), /cascade resolution/);
  assert.throws(() => createCascadedShadows({ maximumDistance: -1 }), /maximumDistance/);
  assert.throws(() => createCascadedShadows({ splitLambda: 2 }), /splitLambda/);
  assert.ok(createCascadedShadows({ count: 4 }) instanceof CascadedShadows);
});

test('the cascade shader replaces the classic sun map and a plain shader has no trace of it', () => {
  const cascaded = createFragmentShader(['cascadedShadows']);
  assert.match(cascaded, /#define shadowVisibility\(normal\) cascadeVisibility\(normal\)/);
  const plain = createFragmentShader([]);
  assert.doesNotMatch(plain, /cascadeVisibility|cascadeShadowMap/);
  assert.doesNotMatch(plain, /#define shadowVisibility/);
});
