import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../src/model.js';
import { exportGlb } from '../src/export.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

test('GLB export rejects morph targets rather than discarding expressions', () => {
  const part = createModel()[0];
  assert.throws(() => exportGlb([{ ...part, morph: { weights: new Float32Array(1) } }]), /preserve morph targets/);
  assert.throws(() => exportGlb([{ ...part, geometry: { ...part.geometry, morphTargets: [] } }]), /preserve morph targets/);
});
