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
    async inspectMeshes({ sessionId: requested, ...options }) {
      calls++;
      assert.equal(requested, sessionId);
      return { sessionId, ...scene.inspectMeshes(options) };
    },
    async apply({ expectedRevision, operations }) {
      calls++;
      scene.apply(operations, { expectedRevision });
      return status();
    },
    async look({ width, height, motionTime }) {
      calls++;
      if (motionTime !== undefined) {
        scene.sampleMotion(motionTime);
      }
      return { data: png, mimeType: 'image/png', metadata: { sessionId, revision: scene.revision,
        motionTime: scene.motionTime, width, height, backend: 'fake' } };
    },
    async review({ expectedRevision, width, height, shots }) {
      calls++;
      assert.equal(expectedRevision, scene.revision);
      return { data: png, mimeType: 'image/png', metadata: { sessionId,
        sourceRevision: scene.revision, width, height, shots, backend: 'fake' } };
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
    'mesh_inspect', 'scene_apply', 'scene_asset_catalog', 'scene_capabilities', 'scene_checkpoint', 'scene_create', 'scene_create_asset', 'scene_dispose',
    'scene_export_recipe', 'scene_inspect', 'scene_look', 'scene_review', 'scene_release_checkpoint', 'scene_restore',
    'scene_render_cancel', 'scene_render_release', 'scene_render_result', 'scene_render_status', 'scene_render_submit',
  ].sort());
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
  assert.equal(recipeSchema.properties.environment.additionalProperties, false);
  assert.equal(recipeSchema.properties.environment.properties.pointLights.maxItems, 8);
  assert.equal(recipeSchema.properties.effects.additionalProperties, false);
  assert.equal(recipeSchema.properties.shadow.additionalProperties, false);
  const look = tools.find(tool => tool.name === 'scene_look');
  assert.equal(look.annotations.readOnlyHint, true);
  assert.equal(look.inputSchema.properties.width.maximum, 1024);
  assert.ok(look.inputSchema.properties.motionTime);
});

test('review SDK exposes one image and rejects unknown or unbounded shot fields before dispatch', async context => {
  const { client, sessionId, calls } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: recipe() } });
  const { tools } = await client.listTools();
  const tool = tools.find(tool => tool.name === 'scene_review');
  assert.equal(tools.length, 19);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.properties.shots.maxItems, 4);
  assert.equal(tool.inputSchema.properties.shots.items.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.shots.items.properties.camera.additionalProperties, false);
  const input = { sessionId, expectedRevision: 0, shots: [{ label: 'Front', camera: { eye: [4, 2, 1] } }, {}] };
  const result = await client.callTool({ name: 'scene_review', arguments: input });
  assert.equal(result.content.filter(block => block.type === 'image').length, 1);
  assert.equal(result.structuredContent.sourceRevision, 0);
  assert.equal(result.structuredContent.width, 384);
  assert.ok(!JSON.stringify(result.structuredContent).includes(png));
  const before = calls();
  for (const invalid of [
    { ...input, width: 481 }, { ...input, shots: [] }, { ...input, shots: Array(5).fill({}) },
    { ...input, code: 'console.log(1)' }, { ...input, shots: [{ camera: { projection: 'orthographic' } }] },
    { ...input, shots: [{ animation: { clip: 0, time: 0, url: 'https://example.com' } }] },
    { ...input, shots: [{ label: 'x'.repeat(49) }] }, { ...input, shots: [{ motionTime: -1 }] },
    { ...input, shots: [{ rendererTime: 3601 }] }, { ...input, expectedRevision: -1 },
  ]) await rejected(client, 'scene_review', invalid);
  assert.equal(calls(), before);
});

test('SDK rejects unknown fields, missing revisions, invalid vectors and oversized inputs before runtime dispatch', async context => {
  const boundary = await connect(context);
  const { client, sessionId } = boundary;
  await rejected(client, 'scene_capabilities', { javascript: 'process.exit()' });
  await rejected(client, 'scene_render_submit', { sessionId, settings: { kind: 'video', width: 320, height: 320 } });
  await rejected(client, 'scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: 320, height: 320, output: '../video.mp4' } });
  await rejected(client, 'scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'video', width: 320, height: 320, fps: 31 } });
  await rejected(client, 'scene_render_result', { jobId: '../video.mp4' });
  await rejected(client, 'scene_inspect', { sessionId: 'not-a-uuid' });
  await rejected(client, 'scene_look', { sessionId, width: 1025 });
  await rejected(client, 'scene_look', { sessionId, motionTime: -1 });
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-motion' }] });
  await rejected(client, 'scene_asset_catalog', { path: 'C:/private/file.glb' });
  await rejected(client, 'scene_create_asset', { recipe: { format: '67js.asset', schemaVersion: 1, assetId: '../file.glb' } });
  await rejected(client, 'scene_create_asset', { recipe: { format: '67js.asset', schemaVersion: 1, assetId: 'a'.repeat(64), root: { javascript: 'run' } } });
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

test('mesh_inspect reports polygon counts, tags and lint for recipe geometries', async context => {
  const { client, sessionId } = await connect(context);
  await client.callTool({ name: 'scene_create', arguments: { recipe: {
    ...recipe(),
    geometries: [
      { id: 'cube', type: 'box', bevel: 0 },
      { id: 'cable', type: 'tube', path: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], radius: 0.05 },
    ],
  } } });
  const result = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId } });
  assert.equal(result.isError, undefined);
  const [cube, cable] = result.structuredContent.meshes;
  assert.equal(cube.geometry, 'cube');
  assert.equal(cube.ok, true);
  assert.deepEqual(cube.faces, { triangles: 0, quads: 6, ngons: 0 });
  assert.equal(cube.tags.top, 1);
  assert.deepEqual(cube.problems, []);
  assert.equal(cable.parts.closed, 0, 'an uncapped tube is open');
  assert.equal(cable.problems[0].kind, 'boundary-edge');
  assert.ok(JSON.stringify(result.structuredContent).length < 4096, 'default report stays compact');
  const one = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId, geometries: ['cube'] } });
  assert.equal(one.structuredContent.meshes.length, 1);
  const missing = await client.callTool({ name: 'mesh_inspect', arguments: { sessionId, geometries: ['nope'] } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Known IDs: cube, cable/);
  await rejected(client, 'mesh_inspect', { sessionId, geometries: [] });
  await rejected(client, 'mesh_inspect', { sessionId, geometries: Array.from({ length: 17 }, (_, index) => `g${index}`) });
  await rejected(client, 'mesh_inspect', { sessionId, path: '../file' });
});

test('real SDK round trip authors motion, seeks without revisions and rejects unknown track fields', async context => {
  const { client, sessionId } = await connect(context);
  const motion = { duration: 1, tracks: [{ kind: 'node', id: 'mesh', property: 'translation',
    keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] };
  await client.callTool({ name: 'scene_create', arguments: { recipe: { ...recipe(), motion } } });
  for (const motionTime of [1, 0.2, 0, null]) {
    const looked = await client.callTool({ name: 'scene_look', arguments: { sessionId, motionTime } });
    assert.equal(looked.isError, undefined);
    assert.equal(looked.structuredContent.revision, 0);
    assert.equal(looked.structuredContent.motionTime, motionTime);
  }
  const exported = await client.callTool({ name: 'scene_export_recipe', arguments: { sessionId } });
  assert.equal(exported.structuredContent.recipe.motion.tracks[0].property, 'translation');
  await rejected(client, 'scene_apply', { sessionId, expectedRevision: 0, operations: [{ type: 'set-motion',
    motion: { ...motion, tracks: [{ ...motion.tracks[0], javascript: 'run()' }] } }] });
  const cleared = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: 0,
    operations: [{ type: 'set-motion', motion: null }] } });
  assert.equal(cleared.structuredContent.revision, 1);
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
