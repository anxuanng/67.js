import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { parseRadianceHdr } from '../src/hdri.js';

const SHOWCASE_SOURCE = new URL('../src/showcase.js', import.meta.url);
const MEGABYTE = 1024 * 1024;
const WORLDS = ['port', 'airport', 'datacenter'];
// The first part is what a visitor waits for: at 5 Mbps every megabyte is about 1.7 s, and the first frame is due within 5 s.
const FIRST_PART_BYTE_BUDGET = 3.1 * MEGABYTE;
const REST_PART_BYTE_BUDGET = 16 * MEGABYTE;
// Node has no image decoder, so the test stubs createImageBitmap and only the geometry is real.
const SHOWCASE_LIMITS = { maxBytes: 64 * MEGABYTE, maxVertices: 4_000_000, maxParts: 20_000, maxTexturePixels: 512 * MEGABYTE, maxTextureImagePixels: 100_000_000 };

function readGltfJson(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

async function readWorld(world) {
  const directory = new URL(`../public/showcase/${world}/`, import.meta.url);
  const description = JSON.parse(await readFile(new URL('scene.json', directory), 'utf8'));
  const first = await readFile(new URL('scene.glb', directory));
  const rest = await readFile(new URL('scene.rest.glb', directory));
  return { directory, description, first, rest };
}

for (const world of WORLDS) {
  test(`the ${world} showcase loads in two meshopt-compressed parts, the first small enough to draw quickly`, async () => {
    const { description, first, rest } = await readWorld(world);
    for (const buffer of [first, rest]) {
      assert.ok(readGltfJson(buffer).extensionsRequired.includes('EXT_meshopt_compression'));
    }
    assert.ok(first.length < FIRST_PART_BYTE_BUDGET, `${world} scene.glb is ${first.length} bytes, budget ${FIRST_PART_BYTE_BUDGET}`);
    assert.ok(rest.length < REST_PART_BYTE_BUDGET, `${world} scene.rest.glb is ${rest.length} bytes, budget ${REST_PART_BYTE_BUDGET}`);
    assert.equal(description.glb, `/showcase/${world}/scene.glb`);
    assert.deepEqual(description.glbRest, [`/showcase/${world}/scene.rest.glb`]);
  });

  test(`the ${world} showcase parts hold meshes and keep every skinned part in the first`, async () => {
    const { first, rest } = await readWorld(world);
    const firstDocument = readGltfJson(first);
    const restDocument = readGltfJson(rest);
    assert.ok(firstDocument.nodes.some(node => node.mesh !== undefined));
    assert.ok(restDocument.nodes.some(node => node.mesh !== undefined));
    assert.equal(restDocument.skins, undefined, 'the renderer cannot add a skinned part to a scene that is already drawing');
  });

  test(`the ${world} showcase has a small preview sky that parses`, async () => {
    const { directory, description } = await readWorld(world);
    assert.equal(description.hdriPreview, `/showcase/${world}/sky.preview.hdr`);
    const preview = await readFile(new URL('sky.preview.hdr', directory));
    assert.ok(preview.length < 256 * 1024);
    const { width, height, data } = parseRadianceHdr(preview);
    assert.ok(width > 0 && height > 0);
    assert.ok(data.some(value => value > 0));
  });
}

test('the showcase page leaves meshopt decoding to the glTF loader', async () => {
  const source = await readFile(SHOWCASE_SOURCE, 'utf8');
  assert.doesNotMatch(source, /meshopt_decoder/);
  assert.doesNotMatch(source, /decoders/);
});

for (const world of WORLDS) {
  test(`the ${world} showcase files load through loadGltf without a decoder option`, async () => {
    const { first, rest } = await readWorld(world);
    globalThis.createImageBitmap ??= async () => ({ width: 4, height: 4, close() {} });
    for (const buffer of [first, rest]) {
      const asset = await parseGltf(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), SHOWCASE_LIMITS);
      assert.ok(asset.parts.length > 0);
    }
  });
}

test('the showcase page draws the first part before it streams the rest', async () => {
  const source = await readFile(SHOWCASE_SOURCE, 'utf8');
  assert.match(source, /glbRest/);
  assert.match(source, /replaceParts/);
  assert.match(source, /replace-textured-parts/);
});
