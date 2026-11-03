// Through MCP on the CPU backend: a recipe with terrain, two different catalog GLBs and ten copies of one of them,
// one of which plays a clip. Checks the draw batches, the inspected assets and that a seek reproduces its frame.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTexturedRigFixture } from './agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts/scene-assets-proof', { recursive: true });
await writeFile('artifacts/scene-assets-proof/wall-e.glb', await readFile('public/wall-e.glb'));
await writeFile('artifacts/scene-assets-proof/textured-rig.glb', await createTexturedRigFixture());
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', resolve('artifacts/scene-assets-proof')],
  stderr: 'pipe', cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: '67js-scene-assets-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});
async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function look(sessionId, label, motionTime) {
  const result = await call('scene_look', { sessionId, width: 768, height: 512, ...(motionTime === undefined ? {} : { motionTime }) });
  const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
  await writeFile(`artifacts/scene-assets-${label}.png`, bytes);
  return bytes;
}
try {
  await client.connect(transport, { timeout: 180000 });
  assert.equal((await client.listTools()).tools.length, 22);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const robot = catalog.assets.find(asset => asset.name === 'wall-e.glb').assetId;
  const rig = catalog.assets.find(asset => asset.name === 'textured-rig.glb').assetId;
  const copies = Array.from({ length: 10 }, (_, index) => ({
    id: `rig-${index}`, translation: [index * 1.5 - 7, 0, 2],
    asset: index === 4 ? { id: rig, clip: { index: 0, start: 0.25 } } : { id: rig },
  }));
  const created = (await call('scene_create', { recipe: {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'hills', type: 'terrain', size: 30, resolution: 48, amplitude: 0.4 }],
    materials: [{ id: 'grass', color: [0.25, 0.45, 0.2], roughness: 0.9 }],
    nodes: [
      { id: 'ground', geometry: 'hills', material: 'grass', translation: [0, -0.5, 0] },
      { id: 'robot', translation: [0, 0, -3], asset: { id: robot } },
      ...copies,
    ],
    camera: { eye: [0, 6, 14], target: [0, 1, 0], fov: 45 },
  } })).structuredContent;
  const sessionId = created.sessionId;
  const batches = created.render.drawBatches;
  const inspection = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(inspection.assets.length, 11);
  assert.equal(inspection.assets.filter(placement => placement.assetId === rig).length, 10);
  assert.ok(inspection.assets.every(placement => placement.bounds.max[1] > placement.bounds.min[1]));
  const first = await look(sessionId, 'start', 0);
  const later = await look(sessionId, 'later', 1.1);
  assert.notDeepEqual(first, later, 'the placed clip changes the frame');
  assert.deepEqual(await look(sessionId, 'later-again', 1.1), later, 'a seek reproduces its frame');
  assert.deepEqual(await look(sessionId, 'start-again', 0), first);
  const exported = (await call('scene_export_recipe', { sessionId })).structuredContent;
  assert.equal(exported.recipe.nodes.length, 12);
  await call('scene_dispose', { sessionId });
  const report = { backend: 'cpu', placements: 11, drawBatches: batches, seekExact: true };
  await writeFile('artifacts/scene-assets-cpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}
