import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

function recipe() {
  return { format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.2, 0.4, 0.6] }],
    nodes: [{ id: 'child', parent: 'root', geometry: 'box', material: 'finish', translation: [1, 2, 0] },
      { id: 'root', label: 'Same label', translation: [3, 0, 0] },
      { id: 'other', label: 'Same label', geometry: 'box', material: 'finish' }] };
}

test('shader arithmetic rejects cancelling product overflow and nonfinite emission atomically', () => {
  const input = recipe();
  const coordinate = Math.fround(1e20);
  const nextCoordinate = Math.fround(coordinate + 1e14);
  input.geometries = [{ id: 'box', type: 'extrude', depth: 1,
    contour: [[coordinate, coordinate], [nextCoordinate, coordinate], [nextCoordinate, nextCoordinate], [coordinate, nextCoordinate]] }];
  input.nodes = [
    { id: 'root' },
    { id: 'child', parent: 'root', geometry: 'box', material: 'finish', rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] },
  ];
  const session = createAgentScene(input);
  const before = session.exportRecipe();
  const matrix = Array.from(session.parts[0].matrix);
  assert.throws(() => session.apply([{ type: 'set-node', id: 'root', scale: [1e20, 1e-20, 1] }], { expectedRevision: 0 }), /world geometry bounds/);
  assert.throws(() => session.apply([{ type: 'set-material', id: 'finish', emission: 1e30, emissiveColor: [1e30, 0, 0] }], { expectedRevision: 0 }), /Emissive radiance/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.deepEqual(Array.from(session.parts[0].matrix), matrix);
  assert.equal(session.revision, 0);
  input.materials[0].tag = 'unlit';
  input.materials[0].emission = 70000;
  input.materials[0].emissiveColor = [1, 0, 0];
  assert.throws(() => createAgentScene(input), /half-float HDR/);
});

test('trailing sparse array holes reject recipes and command batches without commit', () => {
  const input = recipe();
  input.nodes.length++;
  assert.throws(() => createAgentScene(input), /trailing holes/);
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const operations = [{ type: 'set-node', id: 'root', translation: [2, 0, 0] }];
  operations.length++;
  assert.throws(() => session.apply(operations, { expectedRevision: 0 }), /trailing holes/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.revision, 0);
});

test('shared resources and retained renderer identities survive apply and restore', () => {
  const input = recipe();
  const session = createAgentScene(input);
  input.nodes[1].translation[0] = 100;
  const parts = session.parts;
  const identities = parts.map(part => [part, part.matrix, part.geometry, part.material]);
  assert.equal(parts[0].geometry, parts[1].geometry);
  assert.equal(parts[0].material, parts[1].material);
  assert.equal(parts[0].matrix[12], 4);
  assert.equal(session.capabilities, AGENT_SCENE_CAPABILITIES);
  const checkpoint = session.checkpoint();
  assert.equal(session.apply([{ type: 'set-node', id: 'root', translation: [7, 0, 0] },
    { type: 'set-material', id: 'finish', color: [1, 0, 0], emission: 2 }], { expectedRevision: 0 }), 1);
  assert.equal(parts[0].matrix[12], 8);
  assert.deepEqual(parts[1].material.color, [1, 0, 0]);
  session.restore(checkpoint, { expectedRevision: 1 });
  assert.equal(session.revision, 2);
  assert.equal(parts[0].matrix[12], 4);
  assert.deepEqual(parts[0].material.color, [0.2, 0.4, 0.6]);
  parts.forEach((part, index) => {
    [part, part.matrix, part.geometry, part.material].forEach((value, component) => assert.equal(value, identities[index][component]));
  });
  assert.equal(parts[0].material.color, parts[0].material.color);
  assert.equal(session.parts, parts);
  const inspection = session.inspect();
  assert.equal(inspection.counts.vertices, 24);
  assert.equal(inspection.geometryBytes, 720);
});

test('transactions reject conflicts and invalid late commands without publishing any changes', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const matrix = Array.from(session.parts[0].matrix);
  const invalidCommands = [
    { type: 'set-node', id: 'root', parent: 'child' },
    { type: 'set-node', id: 'child', parent: 'missing' },
    { type: 'set-node', id: 'child', scale: [0, 1, 1] },
    { type: 'set-node', id: 'child', rotation: [0, 0, 0, 0] },
    { type: 'set-material', id: 'finish', roughness: 2 },
    { type: 'set-camera', eye: [0, 0, 0], target: [0, 0, 0] },
    { type: 'set-camera', near: 10, far: 1 },
    { type: 'set-node', id: 'child', surprise: true },
    { type: 'set-node', id: 'child', translation: null },
  ];
  for (const command of invalidCommands) {
    assert.throws(() => session.apply([{ type: 'set-node', id: 'root', translation: [9, 0, 0] }, command], { expectedRevision: 0 }));
    assert.deepEqual(session.exportRecipe(), before);
    assert.deepEqual(Array.from(session.parts[0].matrix), matrix);
    assert.equal(session.revision, 0);
  }
  assert.throws(() => session.apply([{ type: 'set-camera', fov: 60 }]));
  assert.throws(() => session.apply([{ type: 'set-camera', fov: 60 }], { expectedRevision: 1 }));
  session.apply([{ type: 'set-camera', fov: 60 }], { expectedRevision: 0 });
  assert.equal(session.camera.fov, 60);
});

test('hierarchy and actual vertex bounds agree with an independent double precision transform', () => {
  const input = recipe();
  const rotation = [0, 0, Math.sin(Math.PI / 8) * 2, Math.cos(Math.PI / 8) * 2];
  input.nodes[1].rotation = rotation;
  input.nodes[1].scale = [2, 3, 4];
  input.nodes[0].scale = [0.5, 1.5, 0.75];
  const session = createAgentScene(input);
  const root = new Matrix4().compose(new Vector3(3, 0, 0), new Quaternion(...rotation).normalize(), new Vector3(2, 3, 4));
  const child = new Matrix4().compose(new Vector3(1, 2, 0), new Quaternion(), new Vector3(0.5, 1.5, 0.75));
  const world = root.multiply(child);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
    const point = new Vector3(x, y, z).applyMatrix4(world).toArray();
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], point[axis]);
      maximum[axis] = Math.max(maximum[axis], point[axis]);
    }
  }
  const actual = session.inspect({ ids: ['child'], includeBounds: true }).nodes[0].bounds;
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(actual.min[axis] - minimum[axis]) < 1e-5);
    assert.ok(Math.abs(actual.max[axis] - maximum[axis]) < 1e-5);
  }
  session.parts[0].matrix.fill(NaN);
  assert.deepEqual(session.inspect({ ids: ['child'], includeBounds: true }).nodes[0].bounds, actual);
  const exported = session.exportRecipe();
  exported.nodes[0].translation[0] = 999;
  const camera = session.camera;
  camera.eye[0] = 999;
  session.apply([{ type: 'set-node', id: 'child', label: 'Renamed' }], { expectedRevision: 0 });
  assert.ok(session.parts[0].matrix.every(Number.isFinite));
  assert.equal(session.inspect({ ids: ['child'] }).nodes[0].label, 'Renamed');
  assert.equal(session.parts[0].name, 'child');
});

test('depth and world overflow checks reject an entire candidate and allow recovery', () => {
  const session = createAgentScene(recipe(), { maxDepth: 2 });
  assert.throws(() => session.apply([{ type: 'set-node', id: 'other', parent: 'child' }], { expectedRevision: 0 }), /maxDepth/);
  assert.throws(() => session.apply([{ type: 'set-node', id: 'root', scale: [1e30, 1e30, 1e30] },
    { type: 'set-node', id: 'child', scale: [1e30, 1e30, 1e30] }], { expectedRevision: 0 }), /finite Float32/);
  assert.equal(session.revision, 0);
  session.apply([{ type: 'set-node', id: 'other', parent: 'root' }], { expectedRevision: 0 });
  assert.equal(session.inspect({ ids: ['other'] }).nodes[0].parent, 'root');
});

test('checkpoints are private, bounded, session-specific and releaseable', () => {
  const session = createAgentScene(recipe(), { maxCheckpoints: 1 });
  const checkpoint = session.checkpoint();
  assert.ok(Object.isFrozen(checkpoint));
  assert.throws(() => session.checkpoint(), /budget/);
  const foreign = createAgentScene(recipe()).checkpoint();
  assert.throws(() => session.restore(foreign, { expectedRevision: 0 }), /Unknown/);
  assert.throws(() => session.releaseCheckpoint(foreign), /Unknown/);
  session.apply([{ type: 'set-node', id: 'root', translation: [8, 0, 0] }], { expectedRevision: 0 });
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 0 }), /expectedRevision/);
  session.restore(checkpoint, { expectedRevision: 1 });
  session.releaseCheckpoint(checkpoint);
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 2 }), /released/);
  assert.throws(() => session.releaseCheckpoint(checkpoint), /released/);
  assert.ok(session.checkpoint());
});

test('camera supports explicit top views and rejects degenerate or collapsed projection ranges', () => {
  const session = createAgentScene(recipe());
  for (const camera of [{ eye: [0, 3, 0], target: [0, 0, 0] }, { up: [0, 0, 0] },
    { near: 1e-100 }, { near: 1, far: 1 + 1e-10 }, { fov: 1e-40 }]) {
    assert.throws(() => session.apply([{ type: 'set-camera', ...camera }], { expectedRevision: 0 }));
    assert.equal(session.revision, 0);
  }
  session.apply([{ type: 'set-camera', eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -2] }], { expectedRevision: 0 });
  assert.deepEqual(session.camera.up, [0, 0, -1]);
});

test('finite matrices still reject world geometry overflow using cached local bounds', () => {
  const input = recipe();
  input.geometries = [{ id: 'box', type: 'lathe', profile: [[1e30, -1], [1e30, 1]], segments: 8 }];
  const session = createAgentScene(input);
  const before = session.exportRecipe();
  assert.throws(() => session.apply([{ type: 'set-node', id: 'child', scale: [1e30, 1, 1] }], { expectedRevision: 0 }), /world geometry/);
  assert.deepEqual(session.exportRecipe(), before);
  assert.equal(session.revision, 0);
});

test('recipe boundary rejects malformed JSON, unknown keys and oversized geometry before generation', () => {
  assert.throws(() => createAgentScene({ ...recipe(), eval: 'code' }), /Unknown/);
  assert.throws(() => createAgentScene(recipe(), { maxNodes: 4097 }), /4096/);
  assert.throws(() => createAgentScene(recipe(), { maxRecipeBytes: 100 }), /maxRecipeBytes/);
  assert.throws(() => createAgentScene(recipe(), { maxGeometryBytes: 100 }), /preflight/);
  const huge = recipe();
  huge.geometries = [{ id: 'box', type: 'sphere', segments: 2048, rings: 2048 }];
  assert.throws(() => createAgentScene(huge), /preflight/);
  const cyclic = recipe();
  cyclic.camera = cyclic;
  assert.throws(() => createAgentScene(cyclic), /acyclic/);
  const accessor = recipe();
  Object.defineProperty(accessor, 'camera', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    },
  });
  assert.throws(() => createAgentScene(accessor), /accessors/);
  const bad = recipe();
  bad.nodes[0].rotation = [0, 0, NaN, 1];
  assert.throws(() => createAgentScene(bad), /JSON/);
});

test('command and resource budgets, bounded inspection and missing IDs report failures', () => {
  assert.throws(() => createAgentScene(recipe(), { maxNodes: 2 }), /resource limit/);
  const extra = recipe();
  extra.geometries.push({ id: 'sphere', type: 'sphere', segments: 8, rings: 4 });
  assert.throws(() => createAgentScene(extra, { maxGeometries: 1 }), /resource limit/);
  const duplicate = recipe();
  duplicate.nodes[2].id = 'root';
  assert.throws(() => createAgentScene(duplicate), /Duplicate/);
  const session = createAgentScene(recipe(), { maxOperations: 1 });
  assert.throws(() => session.apply([{ type: 'set-camera', fov: 60 }, { type: 'set-camera', fov: 70 }], { expectedRevision: 0 }), /maxOperations/);
  assert.throws(() => session.apply([], { expectedRevision: 0 }), /commands/);
  const inspection = session.inspect({ limit: 1 });
  assert.equal(inspection.nodes.length, 1);
  assert.equal(inspection.truncated, true);
  assert.equal(inspection.counts.nodes, 3);
  assert.throws(() => session.inspect({ ids: ['missing'] }), /not found/);
  assert.throws(() => session.inspect({ includeBounds: 'yes' }), /boolean/);
  assert.equal(session.revision, 0);
});

test('detached privileged adapter matrices cannot partially publish a transaction', () => {
  const session = createAgentScene(recipe());
  const before = session.exportRecipe();
  const checkpoint = session.checkpoint();
  structuredClone(session.parts[1].matrix.buffer, { transfer: [session.parts[1].matrix.buffer] });
  assert.throws(() => session.apply([{ type: 'set-node', id: 'root', translation: [10, 0, 0] },
    { type: 'set-material', id: 'finish', color: [1, 0, 0] }], { expectedRevision: 0 }), /detached/);
  assert.equal(session.revision, 0);
  assert.deepEqual(session.exportRecipe(), before);
  assert.deepEqual(session.parts[0].material.color, [0.2, 0.4, 0.6]);
  assert.equal(session.parts[0].matrix[12], 4);
  assert.throws(() => session.restore(checkpoint, { expectedRevision: 0 }), /detached/);
  assert.equal(session.revision, 0);
});

test('all seven generators remain within conservative aggregate vertex and byte estimates', () => {
  const input = { format: '67js.scene', schemaVersion: 1, materials: [{ id: 'material' }], nodes: [], geometries: [
    { id: 'box', type: 'box', subdivisions: 2 },
    { id: 'cylinder', type: 'cylinder', segments: 8, bevelSegments: 2 },
    { id: 'sphere', type: 'sphere', segments: 8, rings: 4 },
    { id: 'torus', type: 'torus', segments: 8, sides: 4, arc: Math.PI },
    { id: 'lathe', type: 'lathe', profile: [[0.5, -1], [1, 0], [0.5, 1]], segments: 8 },
    { id: 'extrude', type: 'extrude', contour: [[0, 0], [1, 0], [1, 1], [0, 1]], depth: 0.5 },
    { id: 'tube', type: 'tube', path: [[0, 0, 0], [0, 1, 0], [1, 2, 0]], segments: 8, radialSegments: 4 },
  ] };
  input.nodes = input.geometries.map(geometry => ({ id: geometry.id, geometry: geometry.id, material: 'material' }));
  const session = createAgentScene(input);
  const inspection = session.inspect({ includeBounds: true });
  assert.equal(inspection.counts.geometries, 7);
  assert.ok(inspection.geometryBytes <= inspection.estimatedGeometryBytes);
  assert.ok(inspection.nodes.every(node => node.bounds.min.every(Number.isFinite)));
  assert.deepEqual(createAgentScene(session.exportRecipe()).inspect(), session.inspect());
  assert.throws(() => session.apply([{ type: 'set-node', id: 'box', geometry: 'sphere' }], { expectedRevision: 0 }), /Unknown/);
  assert.throws(() => session.apply([{ type: 'set-material', id: 'material', tag: 'unlit' }], { expectedRevision: 0 }), /Unknown/);
});
