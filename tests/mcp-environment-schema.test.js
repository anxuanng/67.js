import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { hasPatternTextures } from '../scripts/agent-preview-textures.js';

async function sourceText(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

async function backendEnvironmentFields() {
  const source = await sourceText('src/agent-look.js');
  const list = source.match(/const ENVIRONMENT_FIELDS = \[([^\]]+)\]/);
  assert.ok(list, 'ENVIRONMENT_FIELDS moved out of src/agent-look.js');
  return [...list[1].matchAll(/'(\w+)'/g)].map(match => match[1]);
}

async function documentedEnvironmentFields() {
  const text = (await sourceText('docs/agent-look.md')).replaceAll('\r\n', '\n');
  const section = text.slice(text.indexOf('\n## Environment\n'));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('| --- |')));
  return [...table.matchAll(/^\| `(\w+)` \|/gm)].map(match => match[1]);
}

function findSetEnvironmentSchema(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.properties?.type?.const === 'set-environment' && node.properties.environment) return node.properties.environment;
  for (const value of Object.values(node)) {
    const found = findSetEnvironmentSchema(value);
    if (found) return found;
  }
  return null;
}

async function mcpEnvironmentFields() {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: '67js-environment-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  const schema = findSetEnvironmentSchema(tools.find(tool => tool.name === 'scene_apply').inputSchema);
  assert.ok(schema, 'scene_apply no longer lists a set-environment operation');
  return Object.keys(schema.properties);
}

test('the MCP environment schema lists exactly the fields the backend allows', async () => {
  const backend = (await backendEnvironmentFields()).sort();
  assert.deepEqual((await mcpEnvironmentFields()).sort(), backend);
});

test('every documented environment field is in the MCP schema', async () => {
  const schema = await mcpEnvironmentFields();
  const documented = await documentedEnvironmentFields();
  assert.ok(documented.length > 10);
  assert.deepEqual(documented.filter(field => !schema.includes(field)), []);
  for (const field of ['viewTransform', 'resolveCoplanar', 'ground']) assert.ok(schema.includes(field), field);
});

function coplanarRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', scale: [1, 0.5, 0.2] },
    ],
  };
}

test('set-environment accepts ground, viewTransform and resolveCoplanar', () => {
  const scene = createAgentScene(coplanarRecipe());
  scene.apply([{ type: 'set-environment', environment: { ground: false, viewTransform: 'agx', resolveCoplanar: 'offset' } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.ground, false);
  assert.equal(scene.environment.viewTransform, 'agx');
  assert.equal(scene.environment.resolveCoplanar, 'offset');
});

test('a coplanar depth layer regroups parts, and the preview sees every texture map so it rebuilds the renderer', () => {
  const scene = createAgentScene(coplanarRecipe());
  const before = scene.topologyRevision;
  scene.apply([{ type: 'set-environment', environment: { resolveCoplanar: 'offset' } }], { expectedRevision: scene.revision });
  assert.ok(scene.topologyRevision > before, 'the edit changes topology, which replaceParts refuses for textured parts');
  for (const field of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    assert.equal(hasPatternTextures([{ material: { [field]: {} } }]), true, field);
  }
  assert.equal(hasPatternTextures(scene.parts), false);
});
