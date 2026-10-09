import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas2D, disk2D, roundedRect2D } from '../src/canvas2d.js';

test('flat vector primitives have positive XY winding and no fictitious thickness', () => {
  for (const geometry of [disk2D(), disk2D(96, 0.98), roundedRect2D()]) {
    for (let vertex = 0; vertex < geometry.positions.length; vertex += 3) {
      assert.equal(geometry.positions[vertex + 2], 0);
      assert.deepEqual(Array.from(geometry.normals.slice(vertex, vertex + 3)), [0, 0, 1]);
    }
    for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
      const [first, second, third] = Array.from(geometry.indices.slice(triangle, triangle + 3), value => value * 3);
      const positions = geometry.positions;
      const area = (positions[second] - positions[first]) * (positions[third + 1] - positions[first + 1]) - (positions[second + 1] - positions[first + 1]) * (positions[third] - positions[first]);
      assert.ok(area > 0, 'counterclockwise nondegenerate triangles');
    }
  }
});

test('2D poster is layered vector geometry with shared identities and deterministic reusable animation', () => {
  const scene = createCanvas2D();
  const geometries = new Set(scene.parts.map(part => part.geometry));
  assert.equal(geometries.size, 4);
  assert.ok(scene.parts.length > 100);
  assert.ok(scene.parts.every(part => part.material.tag === 'unlit'));
  const originalMatrices = scene.parts.map(part => part.matrix);
  scene.animate(2);
  const sample = scene.parts.map(part => Array.from(part.matrix));
  scene.animate(5);
  scene.animate(2);
  assert.deepEqual(scene.parts.map(part => Array.from(part.matrix)), sample);
  scene.parts.forEach((part, index) => assert.equal(part.matrix, originalMatrices[index]));
  scene.animate(0);
  const initial = scene.parts.map(part => Array.from(part.matrix));
  scene.animate(scene.duration);
  scene.parts.forEach((part, index) => part.matrix.forEach((value, axis) => assert.ok(Math.abs(value - initial[index][axis]) < 1e-6)));
  let triangles = 0;
  for (const part of scene.parts) {
    triangles += part.geometry.indices.length / 3;
    for (let vertex = 0; vertex < part.geometry.positions.length; vertex += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const positions = part.geometry.positions;
        const matrix = part.matrix;
        const value = matrix[axis] * positions[vertex] + matrix[axis + 4] * positions[vertex + 1] + matrix[axis + 8] * positions[vertex + 2] + matrix[axis + 12];
        assert.ok(value >= scene.bounds.minimum[axis] - 1e-6 && value <= scene.bounds.maximum[axis] + 1e-6);
      }
    }
  }
  console.log(JSON.stringify({ parts: scene.parts.length, geometries: geometries.size, triangles, bounds: scene.bounds }));
  assert.ok(triangles < 5000);
});
