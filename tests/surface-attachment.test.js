import assert from 'node:assert/strict';
import test from 'node:test';
import { mat3 } from 'gl-matrix';
import { Matrix4, Vector3 } from 'three';
import { createSurfaceAttachment } from '../src/surface-attachment.js';
import { createMorphPose } from '../src/morph.js';
import { createSkinPose } from '../src/skinning.js';
import { createMeshQueryIndex } from '../src/mesh-query.js';

const bind = { triangle: 0, barycentric: [0.2, 0.3, 0.5] };

function target() {
  return {
    geometry: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) },
    matrix: new Float32Array(new Matrix4().elements),
    material: { tag: 'standard' },
  };
}

function close(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let component = 0; component < actual.length; component++) assert.ok(Math.abs(actual[component] - expected[component]) <= tolerance, `component ${component}: ${actual[component]} versus ${expected[component]}`);
}

function rigid(matrix) {
  const first = new Vector3().fromArray(matrix, 0);
  const second = new Vector3().fromArray(matrix, 4);
  const third = new Vector3().fromArray(matrix, 8);
  assert.ok(Math.abs(first.length() - 1) < 1e-6);
  assert.ok(Math.abs(second.length() - 1) < 1e-6);
  assert.ok(Math.abs(third.length() - 1) < 1e-6);
  assert.ok(Math.abs(first.dot(second)) < 1e-6);
  assert.ok(Math.abs(first.dot(third)) < 1e-6);
  assert.ok(new Vector3().crossVectors(first, second).distanceTo(third) < 1e-6);
}

function deformable() {
  const part = target();
  part.geometry.morphTargets = [{ positions: new Float32Array([0, 0, 1, 0, 0, 2, 0, 0, 3]) }];
  part.morph = createMorphPose(1);
  part.skin = createSkinPose(2);
  part.geometry.skinIndices = new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]);
  part.geometry.skinWeights = new Float32Array([0.25, 0.25, 0, 0, 0.25, 0.25, 0, 0, 0.25, 0.25, 0, 0]);
  return part;
}

test('literal static binding is retained, rigid and compatible with original mesh-query hits', () => {
  const part = target();
  const attachment = createSurfaceAttachment(part, { ...bind, clearance: 0.125 });
  close(attachment.matrix.subarray(12, 15), [0.3, 0.5, 0.125]);
  rigid(attachment.matrix);
  assert.equal(attachment.update(), attachment.matrix);
  const index = createMeshQueryIndex(part.geometry);
  const hit = index.raycast(part.matrix, { origin: [0.25, 0.25, 1], direction: [0, 0, -1] });
  const fromHit = createSurfaceAttachment(part, { triangle: hit.triangle, barycentric: hit.barycentric });
  close(fromHit.matrix.subarray(12, 15), [0.25, 0.25, 0]);
  const twisted = createSurfaceAttachment(part, { ...bind, rotation: Math.PI / 2 });
  close(twisted.matrix.subarray(0, 3), [0, 1, 0]);
  close(twisted.matrix.subarray(4, 7), [-1, 0, 0]);
  index.dispose();
});

test('world affine transforms give rigid axes, geometric reflected winding, and constant world clearance', () => {
  for (const reflection of [1, -1]) {
    const part = target();
    const transform = new Matrix4().makeRotationX(0.4).multiply(new Matrix4().makeScale(reflection * 2, 3, 0.5));
    transform.elements[4] += 0.6;
    transform.setPosition(4, -2, 1);
    part.matrix.set(transform.elements);
    const attachment = createSurfaceAttachment(part, { ...bind, clearance: 0.2 });
    const vertices = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)].map(point => point.applyMatrix4(new Matrix4().fromArray(part.matrix)));
    const firstEdge = vertices[1].clone().sub(vertices[0]);
    const normal = new Vector3().crossVectors(firstEdge, vertices[2].clone().sub(vertices[0])).normalize();
    const center = vertices[0].clone().multiplyScalar(0.2).addScaledVector(vertices[1], 0.3).addScaledVector(vertices[2], 0.5);
    close(attachment.matrix.subarray(8, 11), normal.toArray());
    close(attachment.matrix.subarray(0, 3), firstEdge.normalize().toArray());
    close(attachment.matrix.subarray(12, 15), center.addScaledVector(normal, 0.2).toArray());
    rigid(attachment.matrix);
  }
});

test('relative morph runs before normalized four-influence skin and mesh world transformation', () => {
  const part = deformable();
  part.morph.weights[0] = 1;
  part.skin.jointMatrices.set(new Matrix4().makeScale(1, 1, 2).elements, 0);
  part.skin.jointMatrices.set(new Matrix4().makeTranslation(0, 0, 4).elements, 16);
  part.matrix[12] = 3;
  const attachment = createSurfaceAttachment(part, bind);
  // Normalized .25+.25 influences become .5+.5. Z = (2*z + z+4)/2.
  close(attachment.matrix.subarray(12, 15), [3.3, 0.5, 5.45]);
  const expectedNormal = new Vector3(-1.5, -3, 1).normalize();
  close(attachment.matrix.subarray(8, 11), expectedNormal.toArray());
  rigid(attachment.matrix);
});

test('homogeneous normalized Float32 weights follow the post-divide geometric triangle', () => {
  const part = target();
  part.skin = createSkinPose(3);
  part.geometry.skinIndices = new Uint16Array([0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0]);
  part.geometry.skinWeights = new Float32Array([0.1, 0.2, 0.3, 0, 0.1, 0.2, 0.3, 0, 0.1, 0.2, 0.3, 0]);
  part.skin.jointMatrices[28] = 3;
  part.skin.jointMatrices[44] = 6;
  part.matrix[12] = 2;
  const attachment = createSurfaceAttachment(part, bind);
  let total = 0;
  for (let influence = 0; influence < 4; influence++) total += part.geometry.skinWeights[influence];
  const first = Math.fround(part.geometry.skinWeights[0] / total);
  const second = Math.fround(part.geometry.skinWeights[1] / total);
  const third = Math.fround(part.geometry.skinWeights[2] / total);
  const sum = Math.fround(Math.fround(first + second) + third);
  const blendedTranslation = Math.fround(Math.fround(second * 3) + Math.fround(third * 6));
  const worldTranslation = Math.fround(blendedTranslation + Math.fround(2 * sum));
  close(attachment.matrix.subarray(12, 15), [worldTranslation / sum + 0.3, 0.5, 0], 2e-6);
});

test('different influences at each selected vertex change the geometric frame rather than a shared rigid skin pose', () => {
  const part = target();
  part.skin = createSkinPose(2);
  part.skin.jointMatrices[30] = 2;
  part.geometry.skinIndices = new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
  part.geometry.skinWeights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0]);
  const attachment = createSurfaceAttachment(part, bind);
  close(attachment.matrix.subarray(12, 15), [0.3, 0.5, 1.1]);
  close(attachment.matrix.subarray(8, 11), new Vector3(-2, -1, 1).normalize().toArray());
  rigid(attachment.matrix);
});

test('arbitrary pose order returns the same matrices and makes no per-update matrix allocation', context => {
  const part = deformable();
  const attachment = createSurfaceAttachment(part, bind);
  const retained = attachment.matrix;
  context.mock.method(mat3, 'create', () => { throw new Error('Per-frame normal matrix allocation'); });
  const sample = time => {
    part.morph.weights[0] = time * 0.25;
    part.skin.jointMatrices[28] = time;
    part.matrix[13] = time * 0.5;
    assert.equal(attachment.update(), retained);
    return new Float32Array(retained);
  };
  const forward = [0, 1, 2].map(sample);
  assert.deepEqual(sample(2), forward[2]);
  assert.deepEqual(sample(0), forward[0]);
  assert.deepEqual(sample(1), forward[1]);
});

test('static channel contents use immutable-upload snapshots while replacements require rebinding', () => {
  const part = deformable();
  part.morph.weights[0] = 0.5;
  const attachment = createSurfaceAttachment(part, bind);
  const expected = new Float32Array(attachment.matrix);
  part.geometry.positions.fill(100);
  part.geometry.indices.fill(0);
  part.geometry.morphTargets[0].positions.fill(10);
  part.geometry.skinIndices.fill(1);
  part.geometry.skinWeights.fill(0);
  assert.deepEqual(attachment.update(), expected);
  const original = part.geometry.positions;
  part.geometry.positions = new Float32Array(original);
  assert.throws(() => attachment.update(), /identities changed/);
  assert.deepEqual(attachment.matrix, expected);
  part.geometry.positions = original;
  assert.deepEqual(attachment.update(), expected);
  const originalWeights = part.morph.weights;
  part.morph.weights = new Float32Array(originalWeights);
  assert.throws(() => attachment.update(), /identities changed/);
  part.morph.weights = originalWeights;
  assert.deepEqual(attachment.update(), expected);
});

test('option snapshots and restored target identities recover without changing the retained output', () => {
  const part = deformable();
  const barycentric = [0.2, 0.3, 0.5];
  const attachment = createSurfaceAttachment(part, { triangle: 0, barycentric, clearance: 0.1 });
  const expected = new Float32Array(attachment.matrix);
  barycentric.fill(0);
  assert.deepEqual(attachment.update(), expected);
  for (const field of ['matrix', 'skin', 'morph']) {
    const original = part[field];
    part[field] = field === 'matrix' ? new Float32Array(original) : { ...original };
    assert.throws(() => attachment.update(), /identities changed/);
    assert.deepEqual(attachment.matrix, expected);
    part[field] = original;
    assert.deepEqual(attachment.update(), expected);
  }
  const palette = part.skin.jointMatrices;
  part.skin.jointMatrices = new Float32Array(palette);
  assert.throws(() => attachment.update(), /identities changed/);
  part.skin.jointMatrices = palette;
  assert.deepEqual(attachment.update(), expected);
  part.material.tag = 'water';
  assert.throws(() => attachment.update(), /procedural/);
  part.material.tag = 'standard';
  assert.deepEqual(attachment.update(), expected);
});

test('invalid mutable poses and triangle collapse fail atomically and permit later recovery', () => {
  const part = deformable();
  const attachment = createSurfaceAttachment(part, bind);
  const expected = new Float32Array(attachment.matrix);
  part.morph.weights[0] = NaN;
  assert.throws(() => attachment.update(), /finite/);
  assert.deepEqual(attachment.matrix, expected);
  part.morph.weights[0] = 0;
  part.skin.jointMatrices[0] = 0;
  assert.throws(() => attachment.update(), /nonsingular/);
  part.skin.jointMatrices[0] = 1;
  part.matrix[12] = 1e20;
  assert.throws(() => attachment.update(), /collapses/);
  part.matrix[12] = 0;
  assert.deepEqual(attachment.update(), expected);
  const collapsing = target();
  collapsing.geometry.morphTargets = [{ positions: new Float32Array([0, 0, 0, -1, 0, 0, 0, -1, 0]) }];
  collapsing.morph = createMorphPose(1);
  const collapseAttachment = createSurfaceAttachment(collapsing, bind);
  collapsing.morph.weights[0] = 1;
  assert.throws(() => collapseAttachment.update(), /collapses/);
  assert.ok(collapseAttachment.matrix.every(Number.isFinite));
  collapsing.morph.weights[0] = 0;
  assert.deepEqual(collapseAttachment.update(), expected);
});

test('updates validate only referenced palette entries and selected vertices', () => {
  const part = target();
  part.skin = createSkinPose(100);
  part.geometry.skinIndices = new Uint16Array(12);
  part.geometry.skinWeights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const attachment = createSurfaceAttachment(part, bind);
  part.skin.jointMatrices[99 * 16] = NaN;
  assert.equal(attachment.update(), attachment.matrix);
  part.skin.jointMatrices[0] = NaN;
  assert.throws(() => attachment.update(), /finite/);
});

test('binding rejects malformed coordinates, work budgets, unsupported tags and deformation contracts', () => {
  for (const options of [{ triangle: -1 }, { triangle: 1 }, { barycentric: [0, 0, 0] }, { barycentric: [-0.1, 0.5, 0.6] }, { barycentric: [NaN, 0, 1] }, { clearance: -1 }, { rotation: Infinity }, { maxVertices: 2 }, { maxTriangles: 0 }, { unknown: true }]) assert.throws(() => createSurfaceAttachment(target(), { ...bind, ...options }));
  const nearSum = createSurfaceAttachment(target(), { ...bind, barycentric: [0.2, 0.3, 0.5000005] });
  assert.ok(nearSum.matrix.every(Number.isFinite));
  for (const tag of ['water', 'foliage', 'grass', 'fire', 'smoke']) {
    const part = target();
    part.material.tag = tag;
    assert.throws(() => createSurfaceAttachment(part, bind), /procedural/);
  }
  const terrain = target();
  terrain.material.tag = 'terrain';
  assert.ok(createSurfaceAttachment(terrain, bind));
  const skinnedTerrain = deformable();
  skinnedTerrain.material.tag = 'terrain';
  assert.throws(() => createSurfaceAttachment(skinnedTerrain, bind), /procedural/);
  const assembly = target();
  assembly.assembly = {};
  assert.throws(() => createSurfaceAttachment(assembly, bind), /assembly/);
  const noPose = target();
  noPose.geometry.morphTargets = [{ positions: new Float32Array(9) }];
  assert.throws(() => createSurfaceAttachment(noPose, bind), /pose/);
  const singular = target();
  singular.matrix[0] = 0;
  assert.throws(() => createSurfaceAttachment(singular, bind), /nonsingular/);
});

test('world clearance must remain outward and nonzero after Float32 rounding', () => {
  const part = target();
  assert.throws(() => createSurfaceAttachment(part, { ...bind, clearance: 1e-50 }), /clearance collapses/);
  part.matrix[14] = 1e6;
  part.matrix[0] = 100;
  part.matrix[5] = 100;
  assert.throws(() => createSurfaceAttachment(part, { ...bind, clearance: 0.001 }), /clearance collapses/);
  const attachment = createSurfaceAttachment(part, { ...bind, clearance: 1 });
  assert.equal(attachment.matrix[14], 1e6 + 1);
});
