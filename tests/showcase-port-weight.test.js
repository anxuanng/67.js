import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SHOWCASE_SOURCE = new URL('../src/showcase.js', import.meta.url);
const MEGABYTE = 1024 * 1024;
const BYTE_BUDGET_BY_WORLD = { port: 16 * MEGABYTE, airport: 16 * MEGABYTE, datacenter: 16 * MEGABYTE };

function readGltfJson(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

for (const [world, budget] of Object.entries(BYTE_BUDGET_BY_WORLD)) {
  test(`the ${world} showcase GLB keeps its vertex data meshopt-compressed`, async () => {
    const buffer = await readFile(new URL(`../public/showcase/${world}/scene.glb`, import.meta.url));
    const document = readGltfJson(buffer);
    assert.ok(document.extensionsRequired.includes('EXT_meshopt_compression'));
    assert.ok(buffer.length < budget, `${world} scene.glb is ${buffer.length} bytes, budget ${budget}`);
  });
}

test('the showcase page supplies the meshopt decoder to the glTF loader', async () => {
  const source = await readFile(SHOWCASE_SOURCE, 'utf8');
  assert.match(source, /meshopt_decoder\.module\.js/);
  assert.match(source, /decoders/);
});
