import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec4 } from 'gl-matrix';
import { reverseProjectionDepth } from '../src/reversed-depth.js';

function depthAt(projection, eyeDistance) {
  const clip = vec4.transformMat4(vec4.create(), [0, 0, -eyeDistance, 1], projection);
  return clip[2] / clip[3];
}

test('a reversed perspective projection maps the near plane to 1 and the far plane to 0', () => {
  const standard = mat4.perspective(mat4.create(), Math.PI / 4, 1.5, 0.1, 600);
  const reversed = reverseProjectionDepth(mat4.create(), standard);
  assert.ok(Math.abs(depthAt(reversed, 0.1) - 1) < 1e-5);
  assert.ok(Math.abs(depthAt(reversed, 600)) < 1e-5);
  assert.ok(depthAt(reversed, 5) > depthAt(reversed, 50));
});

test('the reversed depth is one minus the standard depth mapped to 0..1, so shaders can undo it', () => {
  const standard = mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  const reversed = reverseProjectionDepth(mat4.create(), standard);
  for (const distance of [0.5, 3, 40, 99]) {
    const standardDepth = (depthAt(standard, distance) + 1) / 2;
    assert.ok(Math.abs(1 - depthAt(reversed, distance) - standardDepth) < 1e-5);
  }
});

test('an orthographic projection reverses too, and x, y and w are untouched', () => {
  const standard = mat4.ortho(mat4.create(), -2, 2, -1, 1, 0.1, 100);
  const reversed = reverseProjectionDepth(mat4.create(), standard);
  assert.ok(Math.abs(depthAt(reversed, 0.1) - 1) < 1e-5);
  assert.ok(Math.abs(depthAt(reversed, 100)) < 1e-5);
  for (const index of [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15]) assert.equal(reversed[index], standard[index]);
});
