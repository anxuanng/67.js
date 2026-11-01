import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, DataTexture, Float32BufferAttribute } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { parseGltf } from '../src/gltf.js';

const PNG_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWI6k2b8H4SZGKAAAAAA//8VS4tGAAAABklEQVQDAEBuBM3uhq5wAAAAAElFTkSuQmCC';
const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const TRIANGLE_UVS = new Float32Array([0, 0, 1, 0, 0, 1]);

function padToFour(length) {
  return Math.ceil(length / 4) * 4;
}

function bytesOf(typedArray) {
  return new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

function buildGlb(document, binary) {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = padToFour(json.length);
  const binaryLength = padToFour(binary.length);
  const glb = new Uint8Array(28 + jsonLength + binaryLength);
  const header = new DataView(glb.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, glb.length, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  glb.fill(32, 20, 20 + jsonLength);
  glb.set(json, 20);
  header.setUint32(20 + jsonLength, binaryLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  glb.set(binary, 28 + jsonLength);
  return glb.buffer;
}

/** Packs chunks into one buffer and returns the matching bufferViews. */
function packChunks(chunks) {
  const bufferViews = [];
  const parts = [];
  let offset = 0;
  for (const chunk of chunks) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: chunk.length });
    parts.push(chunk);
    offset += padToFour(chunk.length);
  }
  const binary = new Uint8Array(offset);
  let cursor = 0;
  for (const part of parts) {
    binary.set(part, cursor);
    cursor += padToFour(part.length);
  }
  return { binary, bufferViews };
}

function triangleDocument({ extraChunks = [], edit = () => {} } = {}) {
  const { binary, bufferViews } = packChunks([bytesOf(TRIANGLE_POSITIONS), bytesOf(TRIANGLE_UVS), ...extraChunks]);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Triangle', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: {} }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };
  edit(document);
  return buildGlb(document, binary);
}

function mockImageBitmap(context) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
}

function assertClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-6, `index ${index}: ${actual[index]} vs ${expected[index]}`);
  }
}

function addTexturedMaterial(document, transforms) {
  document.images = [{ uri: PNG_IMAGE }];
  document.textures = [{ source: 0 }];
  const withTransform = transform => ({ index: 0, ...(transform && { extensions: { KHR_texture_transform: transform } }) });
  document.materials[0].pbrMetallicRoughness.baseColorTexture = withTransform(transforms[0]);
  document.materials[0].normalTexture = withTransform(transforms[1]);
  document.extensionsUsed = ['KHR_texture_transform'];
}

test('KHR_texture_transform bakes one shared offset, rotation and scale into the UVs', async context => {
  mockImageBitmap(context);
  const shared = { offset: [0.5, 0], rotation: Math.PI / 2, scale: [1, 1] };
  const asset = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [shared, shared]) }));
  assertClose(asset.parts[0].geometry.uvs, [0.5, 0, 0.5, -1, 1.5, 0]);
  const scaled = { offset: [0.25, 0.5], scale: [2, 4] };
  const scaledAsset = await parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [scaled, scaled]) }));
  assertClose(scaledAsset.parts[0].geometry.uvs, [0.25, 0.5, 2.25, 0.5, 0.25, 4.5]);
});

test('KHR_texture_transform rejects different transforms and texCoord overrides on one material', async context => {
  mockImageBitmap(context);
  const moved = { offset: [0.5, 0] };
  await assert.rejects(parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [moved, undefined]) })), /same KHR_texture_transform/);
  await assert.rejects(parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [moved, { offset: [0, 0.5] }]) })), /same KHR_texture_transform/);
  await assert.rejects(parseGltf(triangleDocument({ edit: document => addTexturedMaterial(document, [{ texCoord: 1 }, { texCoord: 1 }]) })), /texCoord/);
});

function instancingDocument(translations, edit = () => {}) {
  return triangleDocument({
    extraChunks: [bytesOf(new Float32Array(translations))],
    edit: document => {
      document.accessors.push({ bufferView: 2, componentType: 5126, count: translations.length / 3, type: 'VEC3' });
      document.extensionsUsed = ['EXT_mesh_gpu_instancing'];
      document.nodes[0].translation = [0, 10, 0];
      document.nodes[0].extensions = { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } };
      edit(document);
    },
  });
}

test('EXT_mesh_gpu_instancing expands into parts that share one geometry', async () => {
  const asset = await parseGltf(instancingDocument([1, 0, 0, 2, 0, 0, 3, 0, 0]));
  assert.equal(asset.parts.length, 3);
  assert.equal(new Set(asset.parts.map(part => part.geometry)).size, 1);
  assert.equal(new Set(asset.parts.map(part => part.material)).size, 1);
  assert.deepEqual(asset.parts.map(part => Array.from(part.matrix.slice(12, 15))), [[1, 10, 0], [2, 10, 0], [3, 10, 0]]);
});

test('EXT_mesh_gpu_instancing handles several primitives and a bounded instance count', async () => {
  const twoPrimitives = document => {
    document.meshes[0].primitives.push({ attributes: { POSITION: 0 } });
  };
  const asset = await parseGltf(instancingDocument([1, 0, 0, 2, 0, 0], twoPrimitives));
  assert.equal(asset.parts.length, 4);
  assert.equal(asset.nodes.length, 1);
  assert.equal(asset.nodes[0].meshIds.length, 4);
  await assert.rejects(parseGltf(instancingDocument([1, 0, 0, 2, 0, 0, 3, 0, 0]), { maxInstances: 2 }), /maxInstances/);
  await assert.rejects(parseGltf(instancingDocument([1, 0, 0, 2, 0, 0, 3, 0, 0]), { maxParts: 2 }), /maxParts/);
  await assert.rejects(parseGltf(instancingDocument([1, 0, 0], document => { document.nodes[0].extensions.EXT_mesh_gpu_instancing.attributes = {}; })), /needs TRANSLATION/);
});

const LAYER_MATERIAL_EXTENSIONS = {
  KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.1 },
  KHR_materials_transmission: { transmissionFactor: 0.6 },
  KHR_materials_ior: { ior: 1.4 },
  KHR_materials_specular: { specularFactor: 0.5, specularColorFactor: [1, 0.9, 0.8] },
  KHR_materials_sheen: { sheenColorFactor: [0.5, 0.4, 0.3], sheenRoughnessFactor: 0.3 },
  KHR_materials_volume: { thicknessFactor: 0.1, attenuationDistance: 2, attenuationColor: [0.8, 0.9, 1] },
};
const SURFACE_EFFECT_MATERIAL_EXTENSIONS = {
  KHR_materials_anisotropy: { anisotropyStrength: 0.6, anisotropyRotation: 1.2 },
  KHR_materials_iridescence: { iridescenceFactor: 0.8, iridescenceIor: 1.6, iridescenceThicknessMinimum: 150, iridescenceThicknessMaximum: 500 },
};

test('KHR_materials layer extensions import as material layers', async () => {
  const asset = await parseGltf(triangleDocument({
    edit: document => {
      document.extensionsUsed = Object.keys(LAYER_MATERIAL_EXTENSIONS);
      document.materials[0].extensions = structuredClone(LAYER_MATERIAL_EXTENSIONS);
    },
  }));
  const material = asset.parts[0].material;
  assert.equal(material.clearcoat, 1);
  assert.equal(material.clearcoatRoughness, 0.1);
  assert.equal(material.transmission, 0.6);
  assert.equal(material.ior, 1.4);
  assert.equal(material.specular, 0.5);
  assert.deepEqual(material.specularColor, [1, 0.9, 0.8]);
  assert.deepEqual(material.sheenColor, [0.5, 0.4, 0.3]);
  assert.equal(material.sheenRoughness, 0.3);
  assert.equal(material.thickness, 0.1);
  assert.equal(material.attenuationDistance, 2);
  assert.deepEqual(material.attenuationColor, [0.8, 0.9, 1]);
  assert.deepEqual(asset.warnings, []);
  const plain = await parseGltf(triangleDocument());
  assert.deepEqual(plain.warnings, []);
  assert.equal('transmission' in plain.parts[0].material, false);
});

test('anisotropy and iridescence import as material layers without a warning', async () => {
  const asset = await parseGltf(triangleDocument({
    edit: document => {
      document.extensionsUsed = Object.keys(SURFACE_EFFECT_MATERIAL_EXTENSIONS);
      document.materials[0].extensions = structuredClone(SURFACE_EFFECT_MATERIAL_EXTENSIONS);
    },
  }));
  const material = asset.parts[0].material;
  assert.equal(material.anisotropy, 0.6);
  assert.equal(material.anisotropyRotation, 1.2);
  assert.equal(material.iridescence, 0.8);
  assert.equal(material.iridescenceIor, 1.6);
  assert.equal(material.iridescenceThickness, 500, 'without a thickness texture the film is as thick as the maximum');
  assert.deepEqual(asset.warnings, []);
});

test('metadata extensions such as KHR_xmp_json_ld and the earlier KHR_xmp do not stop an import', async () => {
  const asset = await parseGltf(triangleDocument({
    edit: document => {
      document.extensionsUsed = ['KHR_xmp', 'KHR_xmp_json_ld'];
      document.extensions = { KHR_xmp_json_ld: { packets: [] } };
      document.asset.extensions = { KHR_xmp: { packet: 0 } };
    },
  }));
  assert.equal(asset.parts.length, 1);
  assert.deepEqual(asset.warnings, []);
});

test('required material extensions, bad layer values and missing decoders are rejected', async () => {
  const required = triangleDocument({ edit: document => { document.extensionsRequired = ['KHR_materials_unlit']; } });
  await assert.rejects(parseGltf(required), /Unsupported glTF extension: KHR_materials_unlit/);
  const badIridescence = triangleDocument({ edit: document => { document.materials[0].extensions = { KHR_materials_iridescence: { iridescenceFactor: 2 } }; } });
  await assert.rejects(parseGltf(badIridescence), /iridescence must be between 0 and 1/);
  const badTransmission = triangleDocument({ edit: document => { document.materials[0].extensions = { KHR_materials_transmission: { transmissionFactor: 2 } }; } });
  await assert.rejects(parseGltf(badTransmission), /transmission must be between 0 and 1.*Use a number inside that range/);
  const badIor = triangleDocument({ edit: document => { document.materials[0].extensions = { KHR_materials_ior: { ior: 0.5 } }; } });
  await assert.rejects(parseGltf(badIor), /ior must be between 1 and 2.5/);
  for (const [extension, decoder] of [['KHR_draco_mesh_compression', 'draco'], ['EXT_meshopt_compression', 'meshopt'], ['KHR_texture_basisu', 'ktx2']]) {
    const data = triangleDocument({ edit: document => { document.extensionsRequired = [extension]; } });
    await assert.rejects(parseGltf(data), new RegExp(`options\\.decoders\\.${decoder}`));
  }
});

/** Encodes bytes with the meshopt ATTRIBUTES codec using literal 8-bit delta groups only. */
function encodeMeshoptLiteral(bytes, count, stride) {
  assert.ok(count <= 16, 'the test encoder handles one group of sixteen elements');
  const header = 0xa0;
  const tailSize = Math.max(32, stride);
  const encoded = [header];
  for (let lane = 0; lane < stride; lane++) {
    encoded.push(0b11);
    let previous = 0;
    for (let element = 0; element < 16; element++) {
      const value = element < count ? bytes[element * stride + lane] : previous;
      const delta = (value - previous) << 24 >> 24;
      encoded.push(((delta << 1) ^ (delta >> 7)) & 0xff);
      previous = value;
    }
  }
  encoded.push(...new Array(tailSize).fill(0));
  return Uint8Array.from(encoded);
}

test('EXT_meshopt_compression decodes a real encoded vertex buffer', async () => {
  const compressed = encodeMeshoptLiteral(bytesOf(TRIANGLE_POSITIONS), 3, 12);
  const { binary, bufferViews } = packChunks([compressed, bytesOf(TRIANGLE_UVS)]);
  const document = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    bufferViews: [
      {
        buffer: 1, byteLength: 36, byteStride: 12,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: compressed.length, byteStride: 12, mode: 'ATTRIBUTES', count: 3 } },
      },
      { ...bufferViews[1] },
    ],
    buffers: [{ byteLength: binary.length }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
  };
  const asset = await parseGltf(buildGlb(document, binary), { decoders: { meshopt: MeshoptDecoder } });
  assert.deepEqual(Array.from(asset.parts[0].geometry.positions), Array.from(TRIANGLE_POSITIONS));
});

test('KHR_draco_mesh_compression decodes through the supplied Draco loader', async () => {
  const decodedGeometry = new BufferGeometry();
  decodedGeometry.setAttribute('position', new Float32BufferAttribute(TRIANGLE_POSITIONS, 3));
  const requested = [];
  const dracoLoader = {
    preload() {},
    decodeDracoFile(buffer, onLoad, attributeIds) {
      requested.push(attributeIds);
      onLoad(decodedGeometry);
    },
  };
  const data = triangleDocument({
    extraChunks: [new Uint8Array(8)],
    edit: document => {
      document.accessors[0].bufferView = undefined;
      document.meshes[0].primitives[0] = { attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 2, attributes: { POSITION: 0 } } } };
      document.extensionsUsed = ['KHR_draco_mesh_compression'];
      document.extensionsRequired = ['KHR_draco_mesh_compression'];
    },
  });
  const asset = await parseGltf(data, { decoders: { draco: dracoLoader } });
  assert.deepEqual(requested, [{ position: 0 }]);
  assert.deepEqual(Array.from(asset.parts[0].geometry.positions), Array.from(TRIANGLE_POSITIONS));
});

test('KHR_texture_basisu textures arrive as RGBA8 pixels from the supplied KTX2 loader', async context => {
  mockImageBitmap(context);
  const ktx2Header = new Uint8Array(80);
  ktx2Header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(ktx2Header.buffer).setUint32(20, 2, true);
  new DataView(ktx2Header.buffer).setUint32(24, 2, true);
  const pixels = Uint8Array.from({ length: 16 }, (unused, index) => index * 10);
  const ktx2Loader = {
    load(url, onLoad) {
      onLoad(new DataTexture(pixels, 2, 2));
    },
  };
  const data = triangleDocument({
    extraChunks: [ktx2Header],
    edit: document => {
      document.images = [{ bufferView: 2, mimeType: 'image/ktx2' }];
      document.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
      document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
      document.extensionsUsed = ['KHR_texture_basisu'];
      document.extensionsRequired = ['KHR_texture_basisu'];
    },
  });
  const asset = await parseGltf(data, { decoders: { ktx2: ktx2Loader }, maxTexturePixels: 4 });
  const { image } = asset.parts[0].material.map;
  assert.equal(image.width, 2);
  assert.equal(image.height, 2);
  assert.deepEqual(Array.from(image.data), Array.from(pixels));
  await assert.rejects(parseGltf(data, { decoders: { ktx2: ktx2Loader }, maxTexturePixels: 3 }), /maxTexturePixels/);
});
