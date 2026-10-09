import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function recipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
    nodes: [{ id: 'mesh', geometry: 'cube', material: 'blue' }],
  };
}

async function connect(context) {
  let scene;
  let closed = false;
  let calls = 0;
  const sessionId = randomUUID();
  const checkpoints = new Map();
  const status = () => ({ sessionId, revision: scene.revision, inspection: scene.inspect(), render: { backend: 'fake' } });
  const runtime = {
    async capabilities() { return AGENT_SCENE_CAPABILITIES; },
    async create({ recipe: input }) {
      calls++;
      scene = createAgentScene(input);
      return status();
    },
    async inspect({ sessionId: requested, ...options }) {
      calls++;
      assert.equal(requested, sessionId);
      return { sessionId, ...scene.inspect(options) };
    },
    async apply({ expectedRevision, operations }) {
      calls++;
      scene.apply(operations, { expectedRevision });
      return status();
    },
    async look({ width, height }) {
      calls++;
      return { data: png, mimeType: 'image/png', metadata: { sessionId, revision: scene.revision, width, height, backend: 'fake' } };
    },
    async checkpoint() {
      const checkpointId = randomUUID();
      checkpoints.set(checkpointId, scene.checkpoint());
      return { checkpointId, sessionId, revision: scene.revision };
    },
    async restore({ checkpointId, expectedRevision }) {
      scene.restore(checkpoints.get(checkpointId), { expectedRevision });
      return status();
    },
    async releaseCheckpoint({ checkpointId }) {
      scene.releaseCheckpoint(checkpoints.get(checkpointId));
      checkpoints.delete(checkpointId);
      return { released: true, sessionId, checkpointId };
    },
    async exportRecipe() { return { sessionId, revision: scene.revision, recipe: scene.exportRecipe() }; },
    async dispose() {
      scene = undefined;
      return { disposed: true, sessionId };
    },
    async close() { closed = true; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: '67js-boundary-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, server, sessionId, calls: () => calls, closed: () => closed };
}

async function rejected(client, name, argumentsValue) {
  let result;
  try {
    result = await client.callTool({ name, arguments: argumentsValue });
  } catch (error) {
    assert.match(error.message, /invalid|validation|schema|expected|unrecognized/i);
    return;
  }
  assert.equal(result.isError, true, `${name} must reject invalid arguments`);
}

test('SDK advertises the complete strict JSON contract and truthful annotations', async context => {
  const { client } = await connect(context);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'scene_apply', 'scene_capabilities', 'scene_checkpoint', 'scene_create', 'scene_dispose',
    'scene_export_recipe', 'scene_inspect', 'scene_look', 'scene_release_checkpoint', 'scene_restore',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.ok(tool.description.length > 20);
  }
  const apply = tools.find(tool => tool.name === 'scene_apply');
  assert.ok(apply.inputSchema.required.includes('expectedRevision'));
  assert.equal(apply.inputSchema.properties.operations.maxItems, 256);
  assert.equal(apply.annotations.idempotentHint, false);
  const create = tools.find(tool => tool.name === 'scene_create');
  const recipeSchema = create.inputSchema.properties.recipe;
  assert.equal(recipeSchema.additionalProperties, false);
  assert.equal(recipeSchema.properties.nodes.maxItems, 4096);
  assert.equal(recipeSchema.properties.materials.maxItems, 256);
  assert.equal(recipeSchema.properties.geometries.maxItems, 256);
  const variants = recipeSchema.properties.geometries.items.oneOf ?? recipeSchema.properties.geometries.items.anyOf;
  assert.deepEqual(variants.map(variant => variant.properties.type.const), ['box', 'cylinder', 'sphere', 'torus', 'lathe', 'extrude', 'tube']);
  assert.ok(variants.every(variant => variant.additionalProperties === false));
  const look = tools.find(tool => tool.name === 'scene_look');
  assert.equal(look.annotations.readOnlyHint, true);
  assert.equal(look.inputSchema.properties.width.maximum, 1024);
});

test('SDK rejects unknown fields, missing revisions, invalid vectors and oversized inputs before runtime dispatch', async context => {
  const boundary = await connect(context);
  const { client, sessionId } = boundary;
  await rejected(client, 'scene_capabilities', { javascript: 'process.exit()' });
  await rejected(client, 'scene_inspect', { sessionId: 'not-a-uuid' });
  await rejected(client, 'scene_look', { sessionId, width: 1025 });
  await rejected(client, 'scene_look', { sessionId, file: 'out.png' });
  await rejected(client, 'scene_restore', { sessionId, checkpointId: randomUUID() });
  await rejected(client, 'scene_apply', { sessionId, operations: [{ type: 'set-camera' }] });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [] });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: Array.from({ length: 257 }, () => ({ type: 'set-camera' })) });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-node', id: 'mesh', translation: [1, 2] }] });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), url: 'https://example.com/model' } });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), geometries: [{ id: 'box', type: 'box', parameters: {} }] } });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), geometries: [{ id: 'sphere', type: 'sphere', segments: 2049 }] } });
  await rejected(client, 'scene_create', { recipe: { ...recipe(), nodes: Array.from({ length: 4097 }, () => ({ id: 'node' })) } });
  assert.equal(boundary.calls(), 0);
});

test('real SDK calls preserve atomic revisions, checkpoints, recipe snapshots and PNG content', async context => {
  const boundary = await connect(context);
  const { client, sessionId } = boundary;
  const call = (name, argumentsValue = {}) => client.callTool({ name, arguments: argumentsValue });
  const capabilities = await call('scene_capabilities');
  assert.equal(capabilities.structuredContent.format, '67js.scene');
  const created = await call('scene_create', { recipe: recipe() });
  assert.equal(created.structuredContent.sessionId, sessionId);
  const revision = created.structuredContent.revision;
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const edited = await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-node', id: 'mesh', translation: [1, 2, 3] }] });
  assert.equal(edited.structuredContent.revision, revision + 1);
  const stale = await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-node', id: 'mesh', translation: [9, 9, 9] }] });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /expectedRevision/);
  const inspected = await call('scene_inspect', { sessionId, includeBounds: true });
  assert.equal(inspected.structuredContent.revision, revision + 1);
  assert.ok(inspected.structuredContent.nodes[0].bounds);
  const image = await call('scene_look', { sessionId });
  assert.deepEqual(image.content[0], { type: 'image', data: png, mimeType: 'image/png' });
  assert.equal(Buffer.from(image.content[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(JSON.parse(image.content[1].text), image.structuredContent);
  assert.equal(image.structuredContent.width, 768);
  assert.equal(image.structuredContent.height, 512);
  assert.equal(Object.hasOwn(image.structuredContent, 'data'), false);
  const restored = await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: revision + 1 });
  assert.equal(restored.structuredContent.revision, revision + 2);
  const exported = await call('scene_export_recipe', { sessionId });
  assert.deepEqual(exported.structuredContent.recipe.nodes[0].translation, [0, 0, 0]);
  assert.deepEqual(JSON.parse(exported.content[0].text), exported.structuredContent);
  assert.equal((await call('scene_release_checkpoint', { sessionId, checkpointId: checkpoint.checkpointId })).structuredContent.released, true);
  const released = await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: revision + 2 });
  assert.equal(released.isError, true);
  assert.match(released.content[0].text, /released checkpoint/);
  assert.equal((await call('scene_dispose', { sessionId })).structuredContent.disposed, true);
  await boundary.server.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(boundary.closed(), true);
});

test('SDK stdio EOF closes the runtime without launching a scene', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createAgentMcpServer({ async close() { resolveClosed(); } });
  await server.connect(new StdioServerTransport(input, output));
  input.end();
  await closed;
  assert.equal(output.readableLength, 0);
  await server.close();
  input.destroy();
  output.destroy();
});

test('SDK dynamic batches create resources, reject dangling edits, and restore scene membership', async context => {
  const { client, sessionId } = await connect(context);
  const call = (name, argumentsValue) => client.callTool({ name, arguments: argumentsValue });
  await call('scene_create', { recipe: { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] } });
  const initial = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const added = await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    { type: 'add-geometry', geometry: { id: 'cube', type: 'box' } },
    { type: 'add-material', material: { id: 'paint', color: [0.2, 0.6, 0.8] } },
    { type: 'add-node', node: { id: 'group' } },
    { type: 'add-node', node: { id: 'mesh', parent: 'group', geometry: 'cube', material: 'paint' } },
  ] });
  assert.equal(added.isError, undefined);
  assert.equal(added.structuredContent.inspection.counts.parts, 1);
  const invalid = await call('scene_apply', { sessionId, expectedRevision: 1, operations: [{ type: 'remove-geometry', id: 'cube' }] });
  assert.equal(invalid.isError, true);
  const inspected = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(inspected.revision, 1);
  assert.equal(inspected.counts.geometries, 1);
  const restored = await call('scene_restore', { sessionId, checkpointId: initial.checkpointId, expectedRevision: 1 });
  assert.equal(restored.structuredContent.inspection.counts.parts, 0);
  assert.equal(restored.structuredContent.inspection.counts.geometries, 0);
});
