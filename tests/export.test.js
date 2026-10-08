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
