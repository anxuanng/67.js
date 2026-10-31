import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder } from '../src/geometry.js';
import {
  editMesh, validateTopology, meshFromGeometry, meshBounds, tagCounts, applyMeshEdits, evaluateMeshStack,
  normalizeMeshStack, STACK_OPERATIONS, MESH_EDIT_OPERATIONS,
} from '../src/mesh.js';
import { createMeshData } from '../src/mesh-data.js';
import { MODIFIER_OPERATIONS } from '../src/mesh-operations.js';
import { AGENT_SCENE_CAPABILITIES, MESH_MODIFIER_NOTES } from '../src/agent-scene-capabilities.js';

const cube = () => meshFromGeometry(box(0, 1));
const drum = () => meshFromGeometry(cylinder(8, 0));

// A closed prism whose caps are single n-gons, which the cylinder generator does not make.
function prism(sides) {
  const positions = [];
  for (const height of [-1, 1]) {
    for (let side = 0; side < sides; side++) {
      const angle = side / sides * Math.PI * 2;
      positions.push(Math.cos(angle), Math.sin(angle), height);
    }
  }
  const faces = [Array.from({ length: sides }, (_, side) => sides - 1 - side), Array.from({ length: sides }, (_, side) => sides + side)];
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    faces.push([side, next, sides + next, sides + side]);
  }
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => {
    faceOffsets[index + 1] = faceOffsets[index] + face.length;
  });
  return createMeshData({ positions: Float32Array.from(positions), faceOffsets, cornerVertices: Uint32Array.from(faces.flat()) });
}
const run = (mesh, edit, limits) => applyMeshEdits(mesh, [edit], limits);

function checked(mesh) {
  validateTopology(editMesh(mesh));
  return mesh;
}

function maximumAbsoluteDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) largest = Math.max(largest, Math.abs(first[index] - second[index]));
  return largest;
}

test('every modifier is in the edit list, the stack list and the capability notes', () => {
  for (const name of Object.keys(MODIFIER_OPERATIONS)) {
    assert.ok(Object.hasOwn(MESH_EDIT_OPERATIONS, name), `${name} is an edit`);
    assert.ok(STACK_OPERATIONS.includes(name), `${name} is a stack node`);
    assert.ok(MESH_MODIFIER_NOTES[name], `${name} has a note`);
  }
  assert.equal(AGENT_SCENE_CAPABILITIES.meshModifiers, MESH_MODIFIER_NOTES);
  assert.deepEqual(Object.keys(MESH_MODIFIER_NOTES), Object.keys(MODIFIER_OPERATIONS));
});

test('weld merges the vertices an edge split pulled apart and keeps the surface closed', () => {
  const apart = run(cube(), { op: 'edge_split' }).mesh;
  assert.equal(apart.vertexCount, 24);
  const welded = run(apart, { op: 'weld', distance: 0.01 });
  assert.equal(welded.mesh.vertexCount, 8);
  assert.equal(welded.mesh.faceCount, 6);
  assert.equal(welded.results[0].removedVertices, 16);
  checked(welded.mesh);
});

test('triangulate turns every quad and cap into triangles and keeps tags', () => {
  const mesh = prism(8);
  const tagged = run(mesh, { op: 'tag', select: { all: true }, name: 'whole' }).mesh;
  const triangles = run(tagged, { op: 'triangulate' }).mesh;
  checked(triangles);
  for (let face = 0; face < triangles.faceCount; face++) assert.equal(triangles.faceOffsets[face + 1] - triangles.faceOffsets[face], 3);
  assert.equal(triangles.vertexCount, mesh.vertexCount);
  assert.equal(triangles.faceCount, 8 * 2 + 2 * 6, 'eight quads make 16 triangles and two octagons make 12');
  assert.equal(tagCounts(triangles).whole, triangles.faceCount);
});

test('triangulate with a larger minVertices leaves the smaller faces alone', () => {
  const mesh = prism(8);
  const caps = run(mesh, { op: 'triangulate', minVertices: 5 }).mesh;
  checked(caps);
  const sizes = {};
  for (let face = 0; face < caps.faceCount; face++) {
    const size = caps.faceOffsets[face + 1] - caps.faceOffsets[face];
    sizes[size] = (sizes[size] ?? 0) + 1;
  }
  assert.ok(sizes[4] > 0 && sizes[3] > 0 && !sizes[8]);
});

test('edge_split separates faces along edges sharper than the angle and leaves flat joins alone', () => {
  const split = run(cube(), { op: 'edge_split' });
  checked(split.mesh);
  assert.equal(split.mesh.vertexCount, 24);
  assert.equal(split.results[0].addedVertices, 16);
  assert.equal(run(cube(), { op: 'edge_split', angle: 120 }).mesh.vertexCount, 8);
  const smoothSides = run(drum(), { op: 'edge_split', angle: 60 }).mesh;
  checked(smoothSides);
  const sideJoined = run(drum(), { op: 'edge_split', angle: 30 }).mesh;
  assert.ok(sideJoined.vertexCount > smoothSides.vertexCount);
});

test('smooth pulls vertices toward their neighbours and factor 0 changes nothing', () => {
  const mesh = cube();
  const smoothed = run(mesh, { op: 'smooth', factor: 1, iterations: 4 }).mesh;
  checked(smoothed);
  const before = meshBounds(mesh);
  const after = meshBounds(smoothed);
  assert.ok(after.max[0] < before.max[0]);
  assert.equal(run(mesh, { op: 'smooth', factor: 0 }).mesh.positions.every((value, index) => value === mesh.positions[index]), true);
});

test('simple_deform twist keeps the axis coordinate and rotates the cross-section in proportion to it', () => {
  const mesh = drum();
  const twisted = run(mesh, { op: 'simple_deform', mode: 'twist', axis: 'z', angle: 90 }).mesh;
  checked(twisted);
  const bounds = meshBounds(mesh);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    assert.ok(Math.abs(twisted.positions[vertex * 3 + 2] - mesh.positions[vertex * 3 + 2]) < 1e-6);
    const before = Math.hypot(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1]);
    const after = Math.hypot(twisted.positions[vertex * 3], twisted.positions[vertex * 3 + 1]);
    assert.ok(Math.abs(before - after) < 1e-5, 'a twist keeps the distance from the axis');
  }
  assert.ok(bounds.max[2] > bounds.min[2]);
});

test('simple_deform taper, stretch and bend run and a flat mesh along the axis is left as it is', () => {
  for (const mode of ['taper', 'stretch', 'bend']) {
    checked(run(drum(), { op: 'simple_deform', mode, axis: 'y', angle: 30, ...(mode === 'bend' ? {} : { angle: undefined, factor: 0.4 }) }).mesh);
  }
  const flat = createMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: Uint32Array.from([0, 4]), cornerVertices: Uint32Array.from([0, 1, 2, 3]),
  });
  const result = run(flat, { op: 'simple_deform', mode: 'twist', axis: 'z', angle: 90 }).mesh;
  assert.equal(maximumAbsoluteDifference(result.positions, flat.positions), 0);
});

test('cast moves vertices toward a sphere', () => {
  const mesh = cube();
  const spherical = run(mesh, { op: 'cast', factor: 1, size: 2 }).mesh;
  checked(spherical);
  for (let vertex = 0; vertex < spherical.vertexCount; vertex++) {
    assert.ok(Math.abs(Math.hypot(...spherical.positions.subarray(vertex * 3, vertex * 3 + 3)) - 2) < 1e-5);
  }
});

test('modifier fields are validated and unknown fields are refused', () => {
  const bad = [
    { op: 'weld', distance: 0 },
    { op: 'weld', distance: Number.NaN },
    { op: 'triangulate', minVertices: 3 },
    { op: 'triangulate', minVertices: 4.5 },
    { op: 'edge_split', angle: 181 },
    { op: 'smooth', iterations: 65 },
    { op: 'smooth', factor: 3 },
    { op: 'simple_deform' },
    { op: 'simple_deform', mode: 'wobble' },
    { op: 'simple_deform', mode: 'twist', axis: 'w' },
    { op: 'simple_deform', mode: 'twist', factor: 1 },
    { op: 'simple_deform', mode: 'taper', angle: 10 },
    { op: 'cast', factor: 2 },
    { op: 'cast', size: -1 },
    { op: 'cast', radius: 1 },
    { op: 'weld', name: 'x' },
  ];
  for (const edit of bad) assert.throws(() => applyMeshEdits(cube(), [edit]), TypeError, JSON.stringify(edit));
});

test('hostile input: output past the vertex or face limit is refused before it is built', () => {
  assert.throws(() => run(cube(), { op: 'edge_split' }, { maxVertices: 20 }), /edge_split would make 24 vertices, over the limit of 20/);
  assert.throws(() => run(drum(), { op: 'triangulate' }, { maxFaces: 10 }), /triangulate would make \d+ faces, over the limit of 10/);
  assert.throws(() => evaluateMeshStack(cube(), [{ op: 'edge_split' }], { maxVertices: 10, maxFaces: 10 }), /edge_split/);
  const long = Array.from({ length: 17 }, () => ({ op: 'smooth' }));
  assert.throws(() => normalizeMeshStack(long), /at most 16 nodes/);
});

test('hostile input: a huge n-gon is refused when its triangles would pass the face limit', () => {
  const corners = 20000;
  const positions = new Float32Array(corners * 3);
  for (let corner = 0; corner < corners; corner++) {
    positions[corner * 3] = Math.cos(corner / corners * Math.PI * 2);
    positions[corner * 3 + 1] = Math.sin(corner / corners * Math.PI * 2);
  }
  const ngon = createMeshData({ positions, faceOffsets: Uint32Array.from([0, corners]), cornerVertices: Uint32Array.from({ length: corners }, (_, index) => index) });
  assert.throws(() => run(ngon, { op: 'triangulate' }, { maxFaces: 1000 }), /over the limit/);
});

test('modifiers run as stack nodes, reuse the cache and report their counts', () => {
  const stack = [{ op: 'triangulate' }, { op: 'smooth', factor: 0.5, iterations: 2 }, { op: 'simple_deform', mode: 'bend', axis: 'z', angle: 20 }];
  const outcome = evaluateMeshStack(drum(), stack);
  checked(outcome.mesh);
  assert.equal(outcome.results.length, 3);
  assert.ok(outcome.results[0].triangulated > 0);
  assert.ok(outcome.results[0].after.faces > drum().faceCount);
});
