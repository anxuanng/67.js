import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleScientistHead } from '../src/film-character.js';

function frontPoint(horizontalPosition, height) {
  const vertical = (Math.acos(height) - 0.008) / (Math.PI - 0.016);
  let minimum = 0;
  let maximum = 0.5;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (minimum + maximum) / 2;
    if (sampleScientistHead(middle, vertical)[0] > horizontalPosition) minimum = middle;
    else maximum = middle;
  }
  return sampleScientistHead((minimum + maximum) / 2, vertical);
}

test('head grid and mesher derivative probes are finite, continuous and nondegenerate', () => {
  const epsilon = 0.0001;
  for (let row = 0; row <= 96; row++) {
    for (let column = 0; column <= 128; column++) {
      const horizontal = column / 128;
      const vertical = row / 96;
      const point = sampleScientistHead(horizontal, vertical);
      assert.ok(point.every(Number.isFinite));
      assert.ok(Math.hypot(...point) < 1.5);
      const right = sampleScientistHead(horizontal + epsilon, vertical);
      const left = sampleScientistHead(horizontal - epsilon, vertical);
      const below = sampleScientistHead(horizontal, vertical + epsilon);
      const above = sampleScientistHead(horizontal, vertical - epsilon);
      const tangent = right.map((value, axis) => value - left[axis]);
      const bitangent = below.map((value, axis) => value - above[axis]);
      const normal = [
        tangent[1] * bitangent[2] - tangent[2] * bitangent[1],
        tangent[2] * bitangent[0] - tangent[0] * bitangent[2],
        tangent[0] * bitangent[1] - tangent[1] * bitangent[0],
      ];
      assert.ok(normal.every(Number.isFinite));
      assert.ok(Math.hypot(...normal) > 1e-10);
      assert.ok(Math.hypot(...right.map((value, axis) => value - left[axis])) < 0.004);
    }
  }
});

test('wrapped seam and bilateral facial geometry agree', () => {
  for (let row = 0; row <= 96; row++) {
    const vertical = row / 96;
    const start = sampleScientistHead(0, vertical);
    const end = sampleScientistHead(1, vertical);
    assert.ok(Math.hypot(...start.map((value, axis) => value - end[axis])) < 1e-12);
    for (let column = 0; column <= 32; column++) {
      const horizontal = column / 64;
      const first = sampleScientistHead(horizontal, vertical);
      const mirrored = sampleScientistHead(0.5 - horizontal, vertical);
      assert.ok(Math.abs(first[0] + mirrored[0]) < 1e-12);
      assert.ok(Math.abs(first[2] - mirrored[2]) < 1e-12);
    }
  }
});

test('nose projects beyond sockets and mouth, while jaw narrows below the cheekbones', () => {
  const nose = frontPoint(0, -0.14);
  const socket = frontPoint(0.42, 0.153);
  const brow = frontPoint(0.42, 0.30);
  const mouth = frontPoint(0, -0.33);
  const cheek = frontPoint(0.53, -0.095);
  assert.ok(nose[2] > mouth[2] + 0.2);
  assert.ok(brow[2] > socket[2] + 0.05);
  assert.ok(cheek[2] > socket[2]);
  assert.ok(socket[2] > 0.65 && socket[2] < 0.9);
  assert.ok(mouth[2] > 0.9 && mouth[2] < 1.05);
  const cheekVertical = (Math.acos(-0.13) - 0.008) / (Math.PI - 0.016);
  const jawVertical = (Math.acos(-0.62) - 0.008) / (Math.PI - 0.016);
  assert.ok(sampleScientistHead(0, jawVertical)[0] < sampleScientistHead(0, cheekVertical)[0] * 0.75);
});
