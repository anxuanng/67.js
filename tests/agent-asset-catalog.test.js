import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), '67js-catalog-'));
  context.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from(exportGlb([{ name: 'Cube', geometry: box(0), matrix: mat4.create(), material: { color: [0.2, 0.5, 0.7], roughness: 0.5, metallic: 0 } }]));
  await writeFile(join(directory, 'cube.glb'), bytes);
  return { directory, bytes };
}

function withDocument(bytes, edit) {
  const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  edit(document);
  const json = Buffer.from(JSON.stringify(document));
  const length = Math.ceil(json.length / 4) * 4;
  const binary = bytes.subarray(20 + bytes.readUInt32LE(12));
  const result = Buffer.alloc(20 + length + binary.length, 32);
  bytes.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(length, 12);
  json.copy(result, 20);
  binary.copy(result, 20 + length);
  return result;
}

test('catalog IDs bind self-contained GLB content and metadata stays detached without paths', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'duplicate.glb'), bytes);
  await writeFile(join(directory, 'ignored.txt'), 'not an asset');
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets.length, 1);
  assert.match(listing.assets[0].assetId, /^[a-f0-9]{64}$/);
  assert.equal(listing.assets[0].meshes, 1);
  assert.doesNotMatch(JSON.stringify(listing), /67js-catalog-/);
  const id = listing.assets[0].assetId;
  listing.assets[0].name = 'changed';
  assert.equal(catalog.list().assets[0].name, 'cube.glb');
  assert.deepEqual(await catalog.read(id), bytes);
  await assert.rejects(catalog.read('../cube.glb'), /Unknown asset/);
});

test('changed bytes cannot silently reuse a catalog digest', async context => {
  const { directory, bytes } = await fixture(context);
  const catalog = await createAgentAssetCatalog(directory);
  const id = catalog.list().assets[0].assetId;
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  await writeFile(join(directory, 'cube.glb'), changed);
  await assert.rejects(catalog.read(id), /bytes changed/);
});

test('catalog rejects external resources and malformed or over-budget GLBs before browser loading', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => { document.buffers[0].uri = 'https://example.invalid/private'; }));
  await assert.rejects(createAgentAssetCatalog(directory), /embed all/);
  await writeFile(join(directory, 'cube.glb'), Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(createAgentAssetCatalog(directory), /16 MiB/);
  await writeFile(join(directory, 'cube.glb'), Buffer.alloc(28));
  await assert.rejects(createAgentAssetCatalog(directory), /complete glTF/);
});

test('declared clip metadata stays bounded even when a GLB contains many animation declarations', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => {
    document.animations = Array.from({ length: 100000 }, () => ({ name: 'x'.repeat(100) }));
  }));
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets[0].animationCount, 100000);
  assert.equal(listing.assets[0].animations.length, 16);
  assert.equal(listing.assets[0].animationsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) < 4096);
  await assert.rejects(catalog.read(listing.assets[0].assetId), /256-clip/);
});

test('catalog rejects linked assets and requires an explicitly absolute directory', async context => {
  const { directory } = await fixture(context);
  await assert.rejects(createAgentAssetCatalog('relative-assets'), /absolute/);
  await symlink(join(directory, 'cube.glb'), join(directory, 'linked.glb'), 'file');
  await assert.rejects(createAgentAssetCatalog(directory), /without links/);
});
