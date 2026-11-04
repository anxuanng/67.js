import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { studioFloorHeight } from '../src/renderer.js';

function placed(geometry, scale, translation) {
  const matrix = mat4.fromTranslation(mat4.create(), translation);
  mat4.scale(matrix, matrix, [scale, scale, scale]);
  return { geometry, matrix };
}

test('the studio floor stays at 0.019 under a scene a metre or more tall, or a large scene that dips below y 0', () => {
  assert.equal(studioFloorHeight([placed(box(), 1, [0, 0.5, 0])]), 0.019);
  // 4 m tall, dipping 0.2 m below y 0: the floor hides 5% of it and stays.
  assert.equal(studioFloorHeight([placed(box(), 4, [0, 1.8, 0])]), 0.019);
  assert.equal(studioFloorHeight([]), 0.019);
});

test('the studio floor drops under small objects and scenes below y 0 instead of burying them (issue #468)', () => {
  // A pencil-sized box resting on y 0, 8 mm tall: the old floor at 19 mm covered all of it.
  const pencil = studioFloorHeight([placed(box(), 0.008, [0, 0.004, 0])]);
  assert.ok(Math.abs(pencil - 0.008 * 0.02) < 1e-9, `floor at ${pencil}`);
  // A hand from y -0.11 to 0.007 after node scales, like the Menagerie hand.
  const hand = studioFloorHeight([placed(box(), 0.117, [0, -0.0515, 0])]);
  assert.ok(hand < -0.105 && hand > -0.11, `floor at ${hand}`);
});
