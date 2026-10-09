import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { setPriority, constants } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };

const finite = z.number().min(-3.4028234663852886e38).max(3.4028234663852886e38);
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const unit = z.number().min(0).max(1);
const identifier = z.string().min(1).max(128).regex(/\S/).describe('Stable resource or node ID, with at least one non-space character.');
const vector3 = z.tuple([finite, finite, finite]);
const color = z.tuple([unit, unit, unit]);
const quaternion = z.tuple([finite, finite, finite, finite]);
const point2 = z.tuple([finite, finite]);
const detail = (minimum, maximum) => z.number().int().min(minimum).max(maximum).optional();
const segments = detail(3, 2048);
const ring = z.array(point2).min(3).max(4096);
const nodeFields = {
  label: z.string().max(256).optional().describe('Human-readable label. Identity remains the node ID.'),
  parent: identifier.nullable().optional().describe('Parent node ID, or null for a root. Local transforms stay unchanged.'),
  translation: vector3.optional().describe('Local XYZ translation.'),
  rotation: quaternion.optional().describe('Nonzero local XYZW quaternion. The backend normalizes it.'),
  scale: z.tuple([positive, positive, positive]).optional().describe('Positive local XYZ scale.'),
};
const nodeRecord = z.strictObject({ id: identifier, geometry: identifier.optional(), material: identifier.optional(), ...nodeFields });
const materialFields = {
  color: color.optional().describe('Linear RGB base color, each component between zero and one.'),
  metallic: unit.optional(),
  roughness: unit.optional(),
  emission: nonnegative.optional().describe('Emission multiplier. Backend checks Float32 radiance products.'),
  emissiveColor: z.tuple([nonnegative, nonnegative, nonnegative]).optional().describe('Independent linear RGB emission color.'),
};
const cameraFields = {
  eye: vector3.optional().describe('Camera position in world coordinates.'),
  target: vector3.optional().describe('World point toward which the camera looks.'),
  up: vector3.optional().describe('Nonzero camera up direction, not collinear with the view direction.'),
  fov: finite.gt(0).lt(180).optional().describe('Vertical perspective field of view in degrees.'),
  near: positive.optional().describe('Near clipping distance. Must be less than far.'),
  far: positive.optional().describe('Far clipping distance. Must exceed near.'),
};
const bounded = (minimum, maximum) => z.number().min(minimum).max(maximum);
const boundedVector = (minimum, maximum) => z.tuple([bounded(minimum, maximum), bounded(minimum, maximum), bounded(minimum, maximum)]);
const volumeFog = z.strictObject({
  density: bounded(0, 10).optional(),
  minimum: boundedVector(-1e5, 1e5).optional(),
  maximum: boundedVector(-1e5, 1e5).optional(),
  color: color.optional(),
  ambient: boundedVector(0, 10).optional(),
  drift: boundedVector(-100, 100).optional(),
  steps: z.number().int().min(8).max(48).optional(),
  anisotropy: bounded(-0.9, 0.9).optional(),
  noiseAmount: unit.optional(),
  noiseScale: bounded(0.001, 100).optional(),
  maxDistance: bounded(0.01, 1e4).optional(),
});
const environment = z.strictObject({
  world: z.boolean().optional().describe('Draw the sky and apply surface fog.'),
  lightDirection: boundedVector(-1e6, 1e6).optional().describe('Nonzero direction toward the key light; shadows follow it.'),
  keyColor: boundedVector(0, 1000).optional(),
  keyIntensity: bounded(0, 100).optional(),
  fillIntensity: bounded(0, 100).optional(),
  ambientIntensity: bounded(0, 100).optional(),
  daylight: bounded(0, 100).optional(),
  pointLights: z.array(z.strictObject({
    position: boundedVector(-1e6, 1e6),
    color: color.optional(),
    intensity: bounded(0, 1e5).optional(),
    radius: bounded(0.001, 1e6).optional(),
    range: z.union([z.literal(0), bounded(0.001, 1e6)]).optional(),
  })).max(8).optional().describe('Replace the entire list; [] removes all point lights. No local shadows.'),
  skyTop: color.optional(),
  skyBottom: color.optional(),
  fogColor: color.optional(),
  fogDensity: bounded(0, 10).optional(),
  volumeFog: volumeFog.optional().describe('Bounded depth-clipped directional scattering; requires HDR support.'),
});
const effects = z.strictObject({
  exposure: bounded(0.01, 16).optional(),
  saturation: bounded(0, 2).optional(),
  contrast: bounded(0.1, 2).optional(),
  temperature: bounded(-1, 1).optional(),
  vignette: unit.optional(),
  grain: bounded(0, 0.1).optional(),
  bloom: z.strictObject({
    strength: bounded(0, 2).optional(),
    threshold: bounded(0, 10).optional(),
    radius: bounded(0.1, 4).optional(),
  }).optional(),
});
const shadow = z.strictObject({
  target: boundedVector(-1e6, 1e6).optional(),
  extent: bounded(0.01, 1e5).optional(),
  distance: bounded(0.01, 1e6).optional(),
  near: bounded(0.001, 1e6).optional(),
  far: bounded(0.001, 1e6).optional(),
}).describe('Directional shadow coverage. Backend checks Float32 view/projection consistency.');
const geometry = z.discriminatedUnion('type', [
  z.strictObject({ id: identifier, type: z.literal('box'), bevel: finite.optional(), subdivisions: detail(1, 128) }),
  z.strictObject({ id: identifier, type: z.literal('cylinder'), segments, bevel: finite.optional(), bevelSegments: detail(1, 128) }),
  z.strictObject({ id: identifier, type: z.literal('sphere'), segments, rings: detail(2, 2048) }),
  z.strictObject({ id: identifier, type: z.literal('torus'), tubeRadius: finite.optional(), segments, sides: detail(3, 128), arc: finite.optional(), start: finite.optional() }),
  z.strictObject({ id: identifier, type: z.literal('lathe'), profile: z.array(point2).min(2).max(4096), segments, startAngle: finite.optional(), sweep: finite.optional() }),
  z.strictObject({ id: identifier, type: z.literal('extrude'), contour: ring, holes: z.array(ring).max(128).optional(), depth: finite.optional(), steps: detail(1, 256), bevel: finite.optional(), bevelThickness: finite.optional(), bevelSegments: detail(1, 32) }),
  z.strictObject({ id: identifier, type: z.literal('tube'), path: z.array(vector3).min(2).max(4096), radius: finite.optional(), segments, radialSegments: detail(3, 128), closed: z.boolean().optional() }),
]);
const recipe = z.strictObject({
  format: z.literal('67js.scene'),
  schemaVersion: z.literal(1),
  geometries: z.array(geometry).max(256),
  materials: z.array(z.strictObject({ id: identifier, tag: z.enum(['surface', 'unlit']).optional(), ...materialFields })).max(256),
  nodes: z.array(nodeRecord).max(4096),
  camera: z.strictObject(cameraFields).optional(),
  environment: environment.optional(),
  effects: effects.optional(),
  shadow: shadow.optional(),
}).describe('Bounded scene recipe. Backend validates references, mesh resource pairs, hierarchy, geometry budgets and camera consistency.');
const assetRecipe = z.strictObject({
  format: z.literal('67js.asset'),
  schemaVersion: z.literal(1),
  assetId: z.string().regex(/^[a-f0-9]{64}$/).describe('SHA-256 asset ID from scene_asset_catalog.'),
  camera: z.strictObject(cameraFields).optional(),
  environment: environment.optional(),
  effects: effects.optional(),
  shadow: shadow.optional(),
  root: z.strictObject({
    translation: vector3.optional(), rotation: quaternion.optional(),
    scale: z.tuple([positive, positive, positive]).optional(),
  }).optional(),
  animation: z.strictObject({ clip: z.number().int().min(0), time: nonnegative }).nullable().optional().describe('Absolute clip/time sample. null selects the original decoded pose.'),
  materialOverrides: z.array(z.strictObject({ id: identifier, ...materialFields })).max(4096).optional(),
});
const operation = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('set-node'), id: identifier, geometry: identifier.optional(), material: identifier.optional(), ...nodeFields }),
  z.strictObject({ type: z.literal('set-material'), id: identifier, ...materialFields }),
  z.strictObject({ type: z.literal('set-camera'), ...cameraFields }),
  z.strictObject({ type: z.literal('set-environment'), environment }),
  z.strictObject({ type: z.literal('set-effects'), effects }),
  z.strictObject({ type: z.literal('set-shadow'), shadow }),
  z.strictObject({ type: z.literal('set-root'), translation: vector3.optional(), rotation: quaternion.optional(), scale: z.tuple([positive, positive, positive]).optional() }),
  z.strictObject({ type: z.literal('set-animation'), clip: z.number().int().min(0).nullable().optional(), time: nonnegative.optional() }),
  z.strictObject({ type: z.literal('add-node'), node: nodeRecord }),
  z.strictObject({ type: z.literal('remove-node'), id: identifier, recursive: z.boolean().optional().describe('Remove descendants too. Defaults to false; dangling children reject the batch.') }),
  z.strictObject({ type: z.literal('add-geometry'), geometry }),
  z.strictObject({ type: z.literal('remove-geometry'), id: identifier }),
  z.strictObject({ type: z.literal('add-material'), material: z.strictObject({ id: identifier, tag: z.enum(['surface', 'unlit']).optional(), ...materialFields }) }),
  z.strictObject({ type: z.literal('remove-material'), id: identifier }),
]);
const sessionFields = { sessionId: z.uuid().describe('Session UUID returned by scene_create.') };
const checkpointFields = { ...sessionFields, checkpointId: z.uuid().describe('Checkpoint UUID returned by scene_checkpoint for this session.') };
const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('Current revision returned by create, inspect, apply or restore. Stale edits fail atomically.');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function createAgentMcpServer(runtime, { version = packageMetadata.version } = {}) {
  const server = new McpServer({ name: '67js-scene', version }, {
    instructions: 'Start with scene_capabilities. Create a procedural recipe with scene_create, or select a configured GLB digest from scene_asset_catalog and use scene_create_asset. Inspect stable IDs and save a checkpoint before editing. Apply small batches with the current expectedRevision and check committed, revision and renderSucceeded. Procedural scenes support topology edits; imported assets preserve decoded meshes and support root, material, look and absolute clip sampling. A committed edit can have a separate renderError; do not retry it with an old revision. Use scene_look to judge the actual image. Restore experiments or release unused checkpoints. Export the final recipe and dispose the scene when finished. No arbitrary JavaScript, remote URLs, file paths or jobs are exposed.',
  });
  let closePromise;
  server.server.onclose = () => {
    closePromise ??= Promise.resolve().then(() => runtime.close());
    closePromise.then(
      () => console.error('67js preview resources closed.'),
      error => console.error(`67js runtime cleanup failed: ${error.message}`),
    );
  };
  function register(name, description, inputSchema, annotations, run) {
    server.registerTool(name, { description, inputSchema, annotations }, async argumentsValue => {
      try {
        return await run(argumentsValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: 'text', text: `${name} failed: ${message}` }] };
      }
    });
  }
  register('scene_capabilities', 'Read supported recipe features and runtime budgets before authoring. Does not launch a browser.', z.strictObject({}), readOnly, async () => jsonResult(await runtime.capabilities()));
  register('scene_create', 'Create the single active render scene from a JSON recipe. Dispose an existing scene first.', z.strictObject({ recipe }), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.create(argumentsValue)));
  register('scene_asset_catalog', 'List content-bound GLB IDs from the configured local asset directory. No arbitrary paths or downloads.', z.strictObject({}), readOnly, async () => jsonResult(await runtime.assetCatalog()));
  register('scene_create_asset', 'Create the active scene from a catalog GLB and editable asset recipe. Preserves supported maps, skins, morphs and clips. Dispose the existing scene first.', z.strictObject({ recipe: assetRecipe }), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.createAsset(argumentsValue)));
  register('scene_inspect', 'Read revision, counts and selected nodes. Bounds describe authored geometry rather than shader displacement.', z.strictObject({ ...sessionFields, ids: z.array(identifier).max(4096).optional().describe('Selected node IDs. Omit to inspect scene order.'), limit: z.number().int().min(1).max(4096).optional().describe('Maximum returned node records. Defaults to 64.'), includeBounds: z.boolean().optional().describe('Include world geometry bounds. Defaults to false.') }), readOnly, async argumentsValue => jsonResult(await runtime.inspect(argumentsValue)));
  register('scene_apply', 'Atomically edit transforms, look, camera or materials. Procedural scenes support membership commands. Imported assets support set-root and absolute set-animation sampling. Successful batches increment revision once.', z.strictObject({ ...sessionFields, expectedRevision, operations: z.array(operation).min(1).max(256).describe('Node/material/camera/root/animation commands use flat fields. Look patches and add commands contain nested records. Backend validates each scene mode before publication.') }), edit, async argumentsValue => jsonResult(await runtime.apply(argumentsValue)));
  register('scene_look', 'Render the active scene as a bounded PNG image for visual assessment.', z.strictObject({ ...sessionFields, width: z.number().int().min(64).max(1024).default(768).describe('PNG width in pixels.'), height: z.number().int().min(64).max(1024).default(512).describe('PNG height in pixels.') }), readOnly, async argumentsValue => {
    const { data, mimeType, metadata } = await runtime.look(argumentsValue);
    return { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(metadata) }], structuredContent: metadata };
  });
  register('scene_checkpoint', 'Save a private recipe snapshot. Up to eight checkpoints can be retained per session.', z.strictObject(sessionFields), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.checkpoint(argumentsValue)));
  register('scene_restore', 'Restore a checkpoint atomically using the current revision. The checkpoint remains available and revision increments.', z.strictObject({ ...checkpointFields, expectedRevision }), edit, async argumentsValue => jsonResult(await runtime.restore(argumentsValue)));
  register('scene_release_checkpoint', 'Release one checkpoint slot. Released or foreign checkpoints fail.', z.strictObject(checkpointFields), edit, async argumentsValue => jsonResult(await runtime.releaseCheckpoint(argumentsValue)));
  register('scene_export_recipe', 'Read a detached canonical JSON recipe for reproduction.', z.strictObject(sessionFields), readOnly, async argumentsValue => jsonResult(await runtime.exportRecipe(argumentsValue)));
  register('scene_dispose', 'Dispose the active scene and its checkpoints, releasing renderer resources.', z.strictObject(sessionFields), edit, async argumentsValue => jsonResult(await runtime.dispose(argumentsValue)));
  return server;
}

export async function runMcpCli({ argumentsValue = process.argv.slice(2),
  previewUrl = new URL('../build/mcp/preview.js', import.meta.url), version = packageMetadata.version } = {}) {
  const options = { backend: 'gpu', memory: 192 };
  for (let index = 0; index < argumentsValue.length; index += 2) {
    const name = argumentsValue[index];
    const value = argumentsValue[index + 1];
    if (!['--backend', '--browser', '--memory', '--assets'].includes(name) || value === undefined) {
      throw new Error('Use --backend cpu|gpu, --browser <local executable path>, --memory <32..256 MiB>, and --assets <absolute GLB directory>.');
    }
    options[name.slice(2)] = name === '--memory' ? Number(value) : value;
  }
  if (!['cpu', 'gpu'].includes(options.backend) || !Number.isInteger(options.memory) || options.memory < 32 || options.memory > 256) {
    throw new Error('Backend must be cpu or gpu, and memory must be an integer from 32 to 256 MiB.');
  }
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const { createAgentRuntime } = await import('./agent-runtime.mjs');
  const handle = serveStdio(() => createAgentMcpServer(createAgentRuntime({ ...options, previewUrl }), { version }), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 2 * 1024 * 1024 }),
    onerror: error => console.error(`67js MCP error: ${error.message}`),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => handle.close().catch(error => console.error(`67js shutdown failed: ${error.message}`)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMcpCli().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
