import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../src/model.js';
import { exportGlb } from '../src/export.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { box } from '../src/geometry.js';
import { createMorphPose } from '../src/morph.js';
import { mat4 } from 'gl-matrix';
import { Vector3 } from 'three';

test('exported GLB loads with an independent glTF loader and preserves every part', async () => {
  const parts = createModel();
  const binary = exportGlb(parts);
  const header = new DataView(binary);
  assert.equal(header.getUint32(0, true), 0x46546c67);
  assert.equal(header.getUint32(8, true), binary.byteLength);
  const gltf = await new GLTFLoader().parseAsync(binary, '');
  let meshCount = 0;
  gltf.scene.traverse((node) => { if (node.isMesh) meshCount++; });
  assert.equal(meshCount, parts.length);
  assert.ok(binary.byteLength < 1024 * 1024);
});

test('GLB export refuses to silently discard any material texture channel', () => {
  const part = createModel()[0];
  for (const channel of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    assert.throws(() => exportGlb([{ ...part, material: { ...part.material, [channel]: {} } }]),
      error => error instanceof RangeError && error.message.includes(channel));
  }
});

test('GLB export rejects skinning instead of silently saving the undeformed bind mesh', () => {
  const part = createModel()[0];
  assert.throws(() => exportGlb([{ ...part, skin: { jointMatrices: new Float32Array(16) } }]), /preserve skinning/);
  assert.throws(() => exportGlb([{ ...part, geometry: { ...part.geometry, skinIndices: new Uint16Array(4) } }]), /preserve skinning/);
});

test('GLB export rejects malformed morph pairs rather than discarding expressions', () => {
  const part = createModel()[0];
  assert.throws(() => exportGlb([{ ...part, morph: { weights: new Float32Array(1) } }]), /target array/);
  assert.throws(() => exportGlb([{ ...part, geometry: { ...part.geometry, morphTargets: [] } }]), /require a morph pose/);
});

test('GLB morph snapshots retain relative channels, shared meshes and independent signed node weights', async () => {
  const geometry = box();
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] = 0.25;
    positions[offset + 1] = 0.125;
    normals[offset + 2] = 0.1;
  }
  geometry.morphTargets = [{ positions }, { normals }];
  const first = createMorphPose(2);
  const second = createMorphPose(2);
  first.weights.set([1.5, -0.5]);
  second.weights.set([-0.25, 0.75]);
  const material = { color: [0.4, 0.5, 0.6], metallic: 0, roughness: 0.7, emission: 0 };
  const parts = [first, second].map((morph, index) => ({ name: `instance ${index}`, geometry, material, morph, matrix: mat4.create() }));
  const binary = exportGlb(parts);
  const view = new DataView(binary);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, view.getUint32(12, true))));
  assert.equal(document.meshes.length, 1);
  assert.deepEqual(document.nodes.map(node => node.weights), [[1.5, -0.5], [-0.25, 0.75]]);
  const targets = document.meshes[0].primitives[0].targets;
  assert.deepEqual(Object.keys(targets[0]), ['POSITION']);
  assert.deepEqual(Object.keys(targets[1]), ['NORMAL']);
  assert.deepEqual(document.accessors[targets[0].POSITION].min, [0.25, 0.125, 0]);
  const loaded = await new GLTFLoader().parseAsync(binary, '');
  const meshes = [];
  loaded.scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  assert.equal(meshes.length, 2);
  assert.equal(meshes[0].geometry, meshes[1].geometry);
  assert.deepEqual(meshes.map(mesh => mesh.morphTargetInfluences), [[1.5, -0.5], [-0.25, 0.75]]);
  for (let instance = 0; instance < meshes.length; instance++) {
    // GLTFLoader fills an omitted position channel with the base attribute.
    // Isolate the declared position target when using its CPU vertex helper.
    meshes[instance].morphTargetInfluences[1] = 0;
    const point = meshes[instance].getVertexPosition(0, new Vector3());
    assert.equal(point.x, geometry.positions[0] + parts[instance].morph.weights[0] * positions[0]);
    assert.equal(point.y, geometry.positions[1] + parts[instance].morph.weights[0] * positions[1]);
  }
  first.weights[0] = NaN;
  assert.throws(() => exportGlb(parts), /finite Float32/);
});
