import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PORT_GLB = new URL('../public/showcase/port/scene.glb', import.meta.url);
const SHOWCASE_SOURCE = new URL('../src/showcase.js', import.meta.url);
const PORT_BYTE_BUDGET = 16 * 1024 * 1024;

function readGltfJson(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

test('the port showcase GLB keeps its vertex data meshopt-compressed', async () => {
  const buffer = await readFile(PORT_GLB);
  const document = readGltfJson(buffer);
  assert.ok(document.extensionsRequired.includes('EXT_meshopt_compression'));
  assert.ok(buffer.length < PORT_BYTE_BUDGET, `port scene.glb is ${buffer.length} bytes, budget ${PORT_BYTE_BUDGET}`);
});

test('the showcase page supplies the meshopt decoder to the glTF loader', async () => {
  const source = await readFile(SHOWCASE_SOURCE, 'utf8');
  assert.match(source, /meshopt_decoder\.module\.js/);
  assert.match(source, /decoders/);
});
