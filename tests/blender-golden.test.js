import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createMeshData } from '../src/mesh.js';
import { loadMeshBooleans } from '../src/mesh-boolean.js';
import { applyMeshEdits } from '../src/mesh-recipe.js';

const FIXTURE_DIRECTORY = new URL('./fixtures/blender/', import.meta.url);
const readFixture = name => JSON.parse(readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8'));
const { inputs, cases } = readFixture('cases.json');
const golden = readFixture('golden.json');
const knownDifferences = readFixture('differences.json');

const POSITION_TOLERANCE = 1e-3;
const MEASURE_TOLERANCE = 1e-3;
const METRICS = ['vertexCount', 'edgeCount', 'faceCount', 'faceSizes', 'volume', 'area', 'positions'];

await loadMeshBooleans();

function meshFromInput({ vertices, faces }) {
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => {
    faceOffsets[index + 1] = faceOffsets[index] + face.length;
  });
  return createMeshData({
    positions: new Float32Array(vertices.flat()),
    faceOffsets,
    cornerVertices: new Uint32Array(faces.flat()),
  });
}

function runCase({ input, edit }) {
  const resolveCutter = record => meshFromInput(inputs[record.type]);
  return applyMeshEdits(meshFromInput(inputs[input]), [edit], { resolveCutter }).mesh;
}

function point(mesh, vertex) {
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

function subtract(first, second) {
  return first.map((value, axis) => value - second[axis]);
}

function cross([ax, ay, az], [bx, by, bz]) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function dot(first, second) {
  return first.reduce((sum, value, axis) => sum + value * second[axis], 0);
}

function measure(mesh) {
  let volume = 0;
  let area = 0;
  const faceSizes = {};
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    faceSizes[end - start] = (faceSizes[end - start] ?? 0) + 1;
    const first = point(mesh, mesh.cornerVertices[start]);
    // Summing signed triangles keeps both measures right on a concave face.
    const vectorArea = [0, 0, 0];
    for (let corner = start + 1; corner + 1 < end; corner++) {
      const second = point(mesh, mesh.cornerVertices[corner]);
      const third = point(mesh, mesh.cornerVertices[corner + 1]);
      volume += dot(first, cross(second, third)) / 6;
      cross(subtract(second, first), subtract(third, first)).forEach((value, axis) => {
        vectorArea[axis] += value / 2;
      });
    }
    area += Math.hypot(...vectorArea);
  }
  const positions = Array.from({ length: mesh.vertexCount }, (_, vertex) => point(mesh, vertex));
  return {
    vertexCount: mesh.vertexCount,
    edgeCount: mesh.edgeCount,
    faceCount: mesh.faceCount,
    faceSizes,
    volume: Math.abs(volume),
    area,
    positions,
  };
}

function farthestFromSet(points, others) {
  let farthest = 0;
  for (const candidate of points) {
    let nearest = Infinity;
    for (const other of others) nearest = Math.min(nearest, Math.hypot(...subtract(candidate, other)));
    farthest = Math.max(farthest, nearest);
  }
  return farthest;
}

function metricDifference(metric, actual, expected) {
  if (metric === 'positions') {
    const distance = Math.max(farthestFromSet(actual, expected), farthestFromSet(expected, actual));
    return distance > POSITION_TOLERANCE ? `farthest vertex is ${distance.toFixed(5)} away` : null;
  }
  if (metric === 'faceSizes') {
    const same = JSON.stringify(sortedEntries(actual)) === JSON.stringify(sortedEntries(expected));
    return same ? null : `${JSON.stringify(actual)} against ${JSON.stringify(expected)}`;
  }
  if (metric === 'volume' || metric === 'area') {
    const relative = Math.abs(actual - expected) / Math.max(expected, 1e-9);
    return relative > MEASURE_TOLERANCE ? `${actual.toFixed(5)} against ${expected.toFixed(5)}` : null;
  }
  return actual === expected ? null : `${actual} against ${expected}`;
}

function sortedEntries(sizes) {
  return Object.entries(sizes).sort(([first], [second]) => Number(first) - Number(second));
}

test('the golden file has a result for each case and records its Blender version', () => {
  assert.match(golden.blenderVersion, /^5\.2/);
  assert.deepEqual(Object.keys(golden.results).sort(), cases.map(({ id }) => id).sort());
});

test('every listed difference names a case and a metric', () => {
  const ids = new Set(cases.map(({ id }) => id));
  for (const [id, differences] of Object.entries(knownDifferences)) {
    assert.ok(ids.has(id), `Unknown case ${id}`);
    for (const [metric, reason] of Object.entries(differences)) {
      assert.ok(METRICS.includes(metric), `Unknown metric ${metric} on ${id}`);
      assert.ok(reason.length > 20, `${id} ${metric} needs a reason`);
    }
  }
});

for (const blenderCase of cases) {
  test(`${blenderCase.id} matches Blender, apart from its listed differences`, () => {
    const actual = measure(runCase(blenderCase));
    const expected = golden.results[blenderCase.id];
    const listed = knownDifferences[blenderCase.id] ?? {};
    const problems = [];
    for (const metric of METRICS) {
      const difference = metricDifference(metric, actual[metric], expected[metric]);
      if (listed[metric] && !difference) problems.push(`${metric} now matches Blender, so remove it from differences.json`);
      if (!listed[metric] && difference) problems.push(`${metric}: ${difference}`);
    }
    assert.deepEqual(problems, []);
  });
}

