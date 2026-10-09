import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { Triangle, Vector3 } from 'three';
import { sphere } from '../src/geometry.js';
import { createMeshQueryIndex } from '../src/mesh-query.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const segments = Number(process.argv[2] ?? 32);
const rings = Number(process.argv[3] ?? 20);
const geometry = sphere(segments, rings);
const queries = Array.from({ length: 96 }, (_, index) => {
  const elevation = (index / 95 - 0.5) * Math.PI * 0.8;
  const longitude = index * 2.399963229728653;
  const radius = 0.5 + (index % 4) * 0.6;
  return Array.from(new Float32Array([
    Math.cos(longitude) * Math.cos(elevation) * radius,
    Math.sin(elevation) * radius,
    Math.sin(longitude) * Math.cos(elevation) * radius,
  ]));
});
const triangles = [];
for (let offset = 0; offset < geometry.indices.length; offset += 3) {
  triangles.push(new Triangle(...Array.from(geometry.indices.subarray(offset, offset + 3), index =>
    new Vector3().fromArray(geometry.positions, index * 3))));
}
const referenceStarted = performance.now();
const reference = queries.map(point => {
  const origin = new Vector3(...point);
  const candidate = new Vector3();
  const closest = new Vector3();
  let distanceSquared = Infinity;
  for (const triangle of triangles) {
    triangle.closestPointToPoint(origin, candidate);
    const distance = candidate.distanceToSquared(origin);
    if (distance < distanceSquared) {
      distanceSquared = distance;
      closest.copy(candidate);
    }
  }
  return { point: closest.toArray(), distance: Math.sqrt(distanceSquared) };
});
const referenceMilliseconds = performance.now() - referenceStarted;
const buildStarted = performance.now();
const index = createMeshQueryIndex(geometry);
const buildMilliseconds = performance.now() - buildStarted;
const queryStarted = performance.now();
const accelerated = queries.map(point => index.nearest(point, { maxTriangleTests: 10000 }));
const queryMilliseconds = performance.now() - queryStarted;
let maximumPointError = 0;
let maximumDistanceError = 0;
for (let offset = 0; offset < reference.length; offset++) {
  const expected = reference[offset];
  const actual = accelerated[offset].hit;
  assert.ok(actual);
  maximumPointError = Math.max(maximumPointError, Math.hypot(...actual.point.map((value, axis) => value - expected.point[axis])));
  maximumDistanceError = Math.max(maximumDistanceError, Math.abs(actual.distance - expected.distance));
}
const triangleTests = accelerated.reduce((total, result) => total + result.triangleTests, 0);
const exhaustiveTriangleTests = queries.length * triangles.length;
const report = {
  fixture: `96 deterministic local-space nearest queries against sphere(${segments},${rings})`,
  vertexCount: index.info.vertexCount, triangleCount: index.info.triangleCount,
  queryCount: queries.length, buildMilliseconds, queryMilliseconds, referenceMilliseconds,
  triangleTests, exhaustiveTriangleTests, maximumPointError, maximumDistanceError,
  estimatedIndexBytes: index.info.estimatedBytes,
};
index.dispose();
assert.ok(maximumPointError < 1e-6);
assert.ok(maximumDistanceError < 1e-6);
assert.ok(triangleTests < exhaustiveTriangleTests);
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/mesh-query-nearest-benchmark-${segments}x${rings}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
