import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder, sphere } from '../src/geometry.js';
import { meshFromGeometry, lintMesh } from '../src/mesh.js';
import { GEOMETRY_LINT_BUDGET } from '../src/mesh-lint-geometry.js';

function placedBox({ scale = [1, 1, 1], translation = [0, 0, 0] }) {
  const source = box(0, 1);
  const positions = Float32Array.from(source.positions, (value, index) => value * scale[index % 3] + translation[index % 3]);
  return { positions, indices: source.indices };
}

function joined(...geometries) {
  const positions = [];
  const indices = [];
  for (const geometry of geometries) {
    const base = positions.length / 3;
    positions.push(...geometry.positions);
    indices.push(...Array.from(geometry.indices, index => index + base));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function kinds(mesh) {
  return lintMesh(mesh, { geometry: true }).problems.map(problem => problem.kind);
}

test('a single cube and a cylinder raise no spatial warnings', () => {
  assert.deepEqual(kinds(meshFromGeometry(box(0, 1))), []);
  assert.deepEqual(kinds(meshFromGeometry(cylinder(24, 0, 1))), []);
});

test('two boxes that cross are reported as intersecting parts with the pair in the sample', () => {
  const mesh = meshFromGeometry(joined(placedBox({}), placedBox({ translation: [0.5, 0.5, 0.5] })));
  const report = lintMesh(mesh, { geometry: true });
  const crossing = report.problems.find(problem => problem.kind === 'intersecting-parts');
  assert.equal(crossing.count, 1);
  assert.equal(crossing.severity, 'warning');
  assert.match(crossing.fix, /union boolean/);
  assert.equal(report.ok, true);
});

test('a part that touches nothing floats, and a part resting on another does not', () => {
  const apart = meshFromGeometry(joined(placedBox({}), placedBox({ translation: [3, 0, 0] })));
  assert.equal(lintMesh(apart, { geometry: true }).problems.find(problem => problem.kind === 'floating-part').count, 2);
  const resting = meshFromGeometry(joined(placedBox({}), placedBox({ translation: [1, 0, 0] })));
  assert.equal(kinds(resting).includes('floating-part'), false);
});

test('a plate under half a percent of the mesh size is a thin wall, and a slab is not', () => {
  const plate = meshFromGeometry(placedBox({ scale: [1, 0.002, 1] }));
  const thin = lintMesh(plate, { geometry: true }).problems.find(problem => problem.kind === 'thin-wall');
  assert.ok(thin.count > 0);
  assert.match(thin.fix, /solidify/);
  assert.equal(kinds(meshFromGeometry(placedBox({ scale: [1, 0.2, 1] }))).includes('thin-wall'), false);
});

test('a mesh that is mirror-symmetric except for one moved vertex names the axis and the vertex', () => {
  const mesh = meshFromGeometry(sphere(16, 10));
  const symmetric = kinds(mesh);
  assert.equal(symmetric.includes('asymmetric'), false);
  const moved = { ...mesh, positions: Float32Array.from(mesh.positions) };
  const vertex = Array.from({ length: moved.vertexCount }, (value, index) => index).find(index => moved.positions[index * 3] > 0.3);
  moved.positions[vertex * 3] += 0.05;
  const problem = lintMesh(moved, { geometry: true }).problems.find(found => found.kind === 'asymmetric' && found.axis === 'x');
  assert.ok(problem.sample.includes(vertex));
  assert.match(problem.fix, /mirror/);
});

test('plain lintMesh stays free of spatial checks and a clean mesh skips none', () => {
  const mesh = meshFromGeometry(placedBox({ scale: [1, 0.002, 1] }));
  assert.deepEqual(lintMesh(mesh).problems.map(problem => problem.kind), []);
  assert.equal(lintMesh(mesh, { geometry: true }).skippedChecks, undefined);
  assert.ok(GEOMETRY_LINT_BUDGET.maxTotalTriangles >= GEOMETRY_LINT_BUDGET.maxTrianglesPerPart);
});
