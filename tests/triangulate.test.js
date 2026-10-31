import assert from 'node:assert/strict';
import test from 'node:test';
import { signedArea, triangulate } from '../src/triangulate.js';

function starRing(count, center, innerRadius, outerRadius, seed) {
  let state = seed;
  const random = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return Array.from({ length: count }, (_, index) => {
    const angle = index / count * Math.PI * 2;
    const radius = innerRadius + (outerRadius - innerRadius) * random();
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}

function trianglesArea(points, triangles) {
  return triangles.reduce((sum, [a, b, c]) => {
    const area = signedArea([points[a], points[b], points[c]]);
    assert.ok(area > 0, 'triangles must be counter-clockwise');
    return sum + area;
  }, 0);
}

test('ear clipping covers star contours with several holes exactly once', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const contour = starRing(5 + seed % 30, [0, 0], 8, 10, seed);
    const holes = [[-4, 0], [4, 0], [0, 4], [0, -4]].slice(0, seed % 5).map((center, index) =>
      starRing(3 + (seed + index) % 9, center, 0.8, 1.6, seed * 7 + index).reverse());
    const triangles = triangulate(contour, holes);
    const points = [...contour, ...holes.flat()];
    const expected = Math.abs(signedArea(contour)) - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
    assert.ok(Math.abs(trianglesArea(points, triangles) - expected) < 1e-9, `seed ${seed}`);
  }
});

test('ear clipping accepts clockwise contours and counter-clockwise holes', () => {
  const contour = [[0, 0], [0, 4], [4, 4], [4, 0]];
  const hole = [[1, 1], [3, 1], [3, 3], [1, 3]];
  const points = [...contour, ...hole];
  assert.equal(trianglesArea(points, triangulate(contour, [hole])), 12);
});
