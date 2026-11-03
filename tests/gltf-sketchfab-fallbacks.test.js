import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';

const PNG_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWI6k2b8H4SZGKAAAAAA//8VS4tGAAAABklEQVQDAEBuBM3uhq5wAAAAAElFTkSuQmCC';
const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const TRIANGLE_UVS = new Float32Array([0, 0, 1, 0, 0, 1]);

function dataUri(...arrays) {
  const bytes = Buffer.concat(arrays.map(array => Buffer.from(array.buffer)));
  return `data:application/octet-stream;base64,${bytes.toString('base64')}`;
}

/** Stands in for the browser image decoder, which Node does not have. */
async function withImageDecoder(run) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  try {
    return await run();
  } finally {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  }
}

/** One triangle with one material and one texture, with or without TEXCOORD_0. */
function triangleDocument(material, { withUvs, extensionsRequired } = {}) {
  const attributes = { POSITION: 0 };
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }];
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 36 }];
  if (withUvs) {
    attributes.TEXCOORD_0 = 1;
    accessors.push({ bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' });
    bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: 24 });
  }
  const byteLength = withUvs ? 60 : 36;
  return JSON.stringify({
    asset: { version: '2.0' },
    ...(extensionsRequired ? { extensionsUsed: extensionsRequired, extensionsRequired } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, material: 0 }] }],
    materials: [material],
    accessors,
    bufferViews,
    buffers: [{ byteLength, uri: withUvs ? dataUri(TRIANGLE_POSITIONS, TRIANGLE_UVS) : dataUri(TRIANGLE_POSITIONS) }],
    textures: [{ source: 0 }],
    images: [{ uri: PNG_IMAGE }],
  });
}

test('a required KHR_materials_pbrSpecularGlossiness material loads as metallic-roughness', async () => {
  const extension = { diffuseFactor: [0.5, 0.25, 0.125, 1], glossinessFactor: 0.25, diffuseTexture: { index: 0 }, specularFactor: [1, 1, 1] };
  const document = triangleDocument({ name: 'old paint', extensions: { KHR_materials_pbrSpecularGlossiness: extension } }, { withUvs: true, extensionsRequired: ['KHR_materials_pbrSpecularGlossiness'] });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  const material = parts[0].material;
  assert.deepEqual(material.color.map(value => Number(value.toFixed(3))), [0.5, 0.25, 0.125]);
  assert.equal(material.metallic, 0);
  assert.equal(material.roughness, 0.75);
  assert.ok(material.map, 'the diffuse texture becomes the base color map');
  assert.ok(warnings.some(warning => /KHR_materials_pbrSpecularGlossiness converted to metallic-roughness.*old paint/.test(warning)));
});

test('a KHR_materials_unlit material with a base color map loads with the unlit tag and no lit maps', async () => {
  const document = triangleDocument({
    pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0, 1], baseColorTexture: { index: 0 } },
    normalTexture: { index: 0 },
    extensions: { KHR_materials_unlit: {} },
  }, { withUvs: true, extensionsRequired: ['KHR_materials_unlit'] });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  const material = parts[0].material;
  assert.equal(material.tag, 'unlit');
  assert.deepEqual(material.color, [1, 0.5, 0]);
  assert.equal(material.emission, 0);
  assert.ok(material.map);
  assert.equal(material.normalMap, undefined);
  assert.deepEqual(warnings, []);
});

test('a normal map on a primitive without TEXCOORD_0 is dropped with a warning', async () => {
  const document = triangleDocument({ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] }, normalTexture: { index: 0 } }, { withUvs: false });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  const material = parts[0].material;
  assert.equal(material.normalMap, undefined);
  assert.deepEqual(material.color.map(value => Number(value.toFixed(3))), [0.2, 0.4, 0.6]);
  assert.ok(warnings.some(warning => /Dropped normalTexture from primitives without TEXCOORD_0/.test(warning)));
});

test('an unlit material with a base color map and no UVs loads without the map', async () => {
  const document = triangleDocument({ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: { KHR_materials_unlit: {} } }, { withUvs: false });
  const { parts, warnings } = await withImageDecoder(() => parseGltf(document));
  assert.equal(parts[0].material.tag, 'unlit');
  assert.equal(parts[0].material.map, undefined);
  assert.ok(warnings.some(warning => /Dropped baseColorTexture/.test(warning)));
});
