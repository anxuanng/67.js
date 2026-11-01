import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { bakeLightmaps, partAxisScale } from '../src/light-bake.js';

const cube = box(0, 1);

function placed(name, translation, scale) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0 } };
}

// How many times longer a texel is along u than along v on each triangle of a baked part, in metres.
function texelStretchPerTriangle(part) {
  const { positions, indices, uvs } = part.geometry;
  const scale = partAxisScale(part.matrix);
  const stretches = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const [first, second, third] = [0, 1, 2].map(corner => indices[triangle * 3 + corner]);
    const edgeOne = [0, 1, 2].map(axis => (positions[second * 3 + axis] - positions[first * 3 + axis]) * scale[axis]);
    const edgeTwo = [0, 1, 2].map(axis => (positions[third * 3 + axis] - positions[first * 3 + axis]) * scale[axis]);
    const uOne = uvs[second * 2] - uvs[first * 2];
    const vOne = uvs[second * 2 + 1] - uvs[first * 2 + 1];
    const uTwo = uvs[third * 2] - uvs[first * 2];
    const vTwo = uvs[third * 2 + 1] - uvs[first * 2 + 1];
    const determinant = uOne * vTwo - vOne * uTwo;
    if (Math.abs(determinant) < 1e-12) continue;
    const alongU = edgeOne.map((value, axis) => (value * vTwo - edgeTwo[axis] * vOne) / determinant);
    const alongV = edgeOne.map((value, axis) => (-value * uTwo + edgeTwo[axis] * uOne) / determinant);
    stretches.push(Math.hypot(...alongU) / Math.hypot(...alongV));
  }
  return stretches;
}

test('a long thin part that shares the unit box keeps square texels in the world', () => {
  // The parts share one geometry. Unwrapped once at unit size, every face of a 2 x 32 x 180 m wall got one square of the
  // lightmap, so its texels were 90 times longer than wide and the bake drew as streaks along the long axis.
  const parts = [
    placed('wall', [-4, 16, 0], [2, 32, 180]),
    placed('carpet', [0, 0.03, 0], [5, 0.06, 172]),
    placed('cube', [4, 1, 0], [2, 2, 2]),
  ];
  const lighting = { pointLights: [{ position: [0, 10, 0], color: [1, 1, 1], intensity: 400, radius: 0.1 }], keyColor: [0, 0, 0] };
  const { parts: baked } = bakeLightmaps(parts, lighting, { samples: 2, bounces: 1, texelsPerUnit: 1, maxResolution: 64 });
  assert.equal(parts[0].geometry, parts[1].geometry);
  for (const part of baked) {
    const stretches = texelStretchPerTriangle(part);
    assert.ok(stretches.length > 0, `${part.name} has triangles with area in the lightmap`);
    const worst = Math.max(...stretches.map(stretch => Math.max(stretch, 1 / stretch)));
    assert.ok(worst < 1.25, `${part.name} texels are ${worst.toFixed(2)} times longer one way than the other`);
    const { normals } = part.geometry;
    for (let vertex = 0; vertex < normals.length / 3; vertex++) {
      assert.ok(Math.abs(Math.hypot(normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]) - 1) < 1e-4);
    }
  }
});
