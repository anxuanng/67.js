import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, setPriority } from 'node:os';
import { Matrix4, Vector3 } from 'three';
import { parseGltf } from '../src/gltf.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';
import { createTexturedRigFixture } from '../scripts/agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);

function snapshot(parts) {
  return parts.map(part => ({ matrix: [...part.matrix],
    palette: [...part.skin?.jointMatrices ?? []], world: [...part.skin?.jointWorldMatrices ?? []],
    weights: [...part.morph?.weights ?? []] }));
}

function skinnedPosition(part, vertex) {
  const position = new Vector3().fromArray(part.geometry.positions, vertex * 3);
  const output = new Vector3();
  let total = 0;
  for (let influence = 0; influence < 4; influence++) {
    total += part.geometry.skinWeights[vertex * 4 + influence];
  }
  for (let influence = 0; influence < 4; influence++) {
    const offset = vertex * 4 + influence;
    const matrix = new Matrix4().fromArray(part.skin.jointMatrices, part.geometry.skinIndices[offset] * 16);
    output.addScaledVector(position.clone().applyMatrix4(matrix), part.geometry.skinWeights[offset] / total);
  }
  return output.applyMatrix4(new Matrix4().fromArray(part.matrix));
}

test('source hierarchy metadata is detached and staged joint deformation leaves published resources unchanged', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  const metadata = asset.nodes;
  assert.deepEqual(metadata.map(node => node.id), ['node-0', 'node-1', 'node-2', 'node-3']);
  assert.equal(metadata.find(node => node.id === 'node-3').parent, 'node-2');
  assert.equal(metadata.find(node => node.id === 'node-3').joint, true);
  assert.deepEqual(metadata.find(node => node.id === 'node-1').meshIds, ['mesh-0']);
  metadata[0].translation[0] = 99;
  assert.equal(asset.nodes[0].translation[0], 1);
  const part = asset.parts[0];
  const before = snapshot(asset.parts);
  const originalVertex = skinnedPosition(part, 5);
  const palette = part.skin.jointMatrices;
  const transaction = asset.stagePose({ animation: null, nodeOverrides: [
    { id: 'node-3', rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
  ] });
  assert.deepEqual(snapshot(asset.parts), before);
  assert.notEqual(transaction.parts[0].matrix, part.matrix);
  assert.ok(skinnedPosition(transaction.parts[0], 5).distanceTo(originalVertex) > 0.5);
  assert.equal(transaction.parts[0].geometry, part.geometry);
  assert.equal(transaction.parts[0].material, part.material);
  transaction.commit();
  assert.equal(part.skin.jointMatrices, palette);
  assert.ok(skinnedPosition(part, 5).distanceTo(originalVertex) > 0.5);
  asset.stagePose({ animation: null }).commit();
  assert.deepEqual(snapshot(asset.parts), before);
  asset.dispose();
});

test('discard and failed poses restore private clip state for independent backward seeks', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  asset.applyAnimation(0.75);
  const expected = snapshot(asset.parts);
  const transaction = asset.stagePose({ animation: { clip: 0, time: 1.5 }, nodeOverrides: [
    { id: 'node-0', translation: [8, 2, 0] },
  ] });
  assert.throws(() => asset.stagePose({ animation: null }), /pending/);
  transaction.discard();
  assert.deepEqual(snapshot(asset.parts), expected);
  assert.throws(() => transaction.commit(), /settled/);
  assert.throws(() => asset.stagePose({ animation: null, nodeOverrides: [
    { id: 'node-3', rotation: [0, 0, 1, 0] },
  ] }), /singular/);
  assert.deepEqual(snapshot(asset.parts), expected);
  assert.throws(() => asset.stagePose({ animation: null, nodeOverrides: [
    { id: 'node-0', scale: [3e38, 3e38, 3e38] },
  ] }), /finite|singular/);
  assert.deepEqual(snapshot(asset.parts), expected);
  for (const time of [1.5, 0, 1.25, 0.75]) asset.applyAnimation(time);
  assert.deepEqual(snapshot(asset.parts), expected);
  asset.dispose();
});

test('strict pose boundaries reject malformed fields, identifiers, scale and quaternions without changing state', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  const expected = snapshot(asset.parts);
  for (const input of [
    { unknown: true }, { animation: { clip: 99, time: 0 } }, { animation: { clip: 0, time: -1 } },
    { nodeOverrides: [{ id: 'missing', translation: [0, 0, 0] }] },
    { nodeOverrides: [{ id: 'node-3', matrix: [] }] },
    { nodeOverrides: [{ id: 'node-3' }] },
    { nodeOverrides: [{ id: 'node-3', rotation: [0, 0, 0, 0] }] },
    { nodeOverrides: [{ id: 'node-3', scale: [1, 0, 1] }] },
    { nodeOverrides: [{ id: 'node-3', translation: [Infinity, 0, 0] }] },
    { nodeOverrides: [{ id: 'node-3', translation: [0, 0, 0] }, { id: 'node-3', scale: [1, 1, 1] }] },
    { nodeOverrides: Array(2) },
    { nodeOverrides: Array.from({ length: 257 }, () => ({ id: 'node-3', scale: [1, 1, 1] })) },
  ]) {
    assert.throws(() => asset.stagePose(input));
    assert.deepEqual(snapshot(asset.parts), expected);
  }
  let accessed = false;
  const input = {};
  Object.defineProperty(input, 'animation', { enumerable: true, get() { accessed = true; return null; } });
  assert.throws(() => asset.stagePose(input), /unsupported/);
  assert.equal(accessed, false);
  const pending = asset.stagePose({ animation: null });
  asset.dispose();
  assert.throws(() => pending.commit(), /disposed/);
  assert.throws(() => asset.stagePose({ animation: null }), /disposed/);
});

test('shared scene clones and grouped primitives keep source node IDs distinct from traversal mesh IDs', async () => {
  const asset = await parseGltf(skinnedStripAsset(document => {
    delete document.nodes[1].skin;
    delete document.meshes[0].primitives[0].attributes.JOINTS_0;
    delete document.meshes[0].primitives[0].attributes.WEIGHTS_0;
    document.scenes = [{ nodes: [0] }, { nodes: [0] }];
    document.scene = 1;
    document.meshes[0].primitives.push(structuredClone(document.meshes[0].primitives[0]));
  }));
  assert.equal(asset.parts.length, 2);
  assert.deepEqual(asset.nodes.find(node => node.id === 'node-1').meshIds, ['mesh-0', 'mesh-1']);
  assert.equal(new Set(asset.nodes.map(node => node.id)).size, asset.nodes.length);
  asset.stagePose({ nodeOverrides: [{ id: 'node-1', translation: [2, 0, 0] }] }).commit();
  assert.equal(asset.parts[0].matrix[12], 3);
  assert.equal(asset.parts[1].matrix[12], 3);
  asset.dispose();
});

test('selected cloned scenes bind authored joint edits to their actual skin skeleton', async () => {
  for (const scene of [0, 1]) {
    const asset = await parseGltf(skinnedStripAsset(document => {
      document.scenes = [{ nodes: [0] }, { nodes: [0] }];
      document.scene = scene;
    }));
    assert.equal(asset.nodes.find(node => node.id === 'node-3').joint, true);
    const original = skinnedPosition(asset.parts[0], 5);
    asset.stagePose({ nodeOverrides: [{ id: 'node-3', rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }] }).commit();
    assert.ok(skinnedPosition(asset.parts[0], 5).distanceTo(original) > 0.5);
    asset.dispose();
  }
});

test('reflected and sheared source nodes remain uneditable while decoded base poses remain usable', async () => {
  for (const matrix of [
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ]) {
    const asset = await parseGltf(skinnedStripAsset(document => {
      delete document.nodes[1].skin;
      delete document.meshes[0].primitives[0].attributes.JOINTS_0;
      delete document.meshes[0].primitives[0].attributes.WEIGHTS_0;
      document.nodes[1].matrix = matrix;
    }));
    assert.equal(asset.nodes.find(node => node.id === 'node-1').editable, false);
    const expected = snapshot(asset.parts);
    assert.throws(() => asset.stagePose({ nodeOverrides: [{ id: 'node-1', translation: [1, 0, 0] }] }), /TRS/);
    asset.stagePose({ animation: null }).commit();
    assert.deepEqual(snapshot(asset.parts), expected);
    asset.dispose();
  }
});

test('skin and morph candidates retain palettes and weights through authored poses', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    const positions = append(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0.25, 0]), 'VEC3');
    Object.assign(document.accessors[positions], { min: [0, 0, 0], max: [0, 0.25, 0] });
    document.meshes[0].primitives[0].targets = [{ POSITION: positions }];
    document.nodes[1].weights = [0.5];
  }));
  const part = asset.parts[0];
  const weights = part.morph.weights;
  const palette = part.skin.jointMatrices;
  const transaction = asset.stagePose({ animation: { clip: 0, time: 0.5 }, nodeOverrides: [{ id: 'node-3', translation: [0.25, 1, 0] }] });
  const candidate = transaction.parts[0];
  transaction.commit();
  const next = asset.stagePose({ animation: null });
  assert.equal(next.parts[0].skin.jointMatrices, candidate.skin.jointMatrices);
  assert.equal(next.parts[0].morph.weights, candidate.morph.weights);
  next.commit();
  assert.equal(part.morph.weights, weights);
  assert.equal(part.skin.jointMatrices, palette);
  assert.deepEqual([...weights], [0.5]);
  asset.dispose();
});

test('textured rig parsing preserves texture descriptors across staged poses', async context => {
  const previousSelf = globalThis.self;
  const previousBitmap = globalThis.createImageBitmap;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  context.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
    if (previousBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = previousBitmap;
  });
  const bytes = await createTexturedRigFixture();
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const map = asset.parts[0].material.map;
  assert.ok(map);
  const transaction = asset.stagePose({ nodeOverrides: [{ id: 'node-3', translation: [0.1, 1, 0] }] });
  assert.equal(transaction.parts[0].material.map, map);
  transaction.commit();
  assert.equal(asset.parts[0].material.map, map);
  asset.dispose();
});
