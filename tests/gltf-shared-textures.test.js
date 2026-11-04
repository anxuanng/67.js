import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { createSharedTextures, parseGltf } from '../src/gltf.js';
import { box } from '../src/geometry.js';

// Node has no image decoder: decode the exporter's PNGs (unfiltered rows) so parseGltf sees real pixels.
globalThis.self = globalThis;
let decodedImageCount = 0;
globalThis.createImageBitmap = async blob => {
  decodedImageCount += 1;
  const bytes = Buffer.from(await blob.arrayBuffer());
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : 3;
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < channels; channel++) {
        data[(row * width + column) * 4 + channel] = raw[row * (width * channels + 1) + 1 + column * channels + channel];
      }
    }
  }
  return { width, height, data, close() {} };
};

const IMAGE_SIZE = 4;

function mapDescriptor(seed) {
  const data = new Uint8ClampedArray(IMAGE_SIZE * IMAGE_SIZE * 4);
  for (let texel = 0; texel < IMAGE_SIZE * IMAGE_SIZE; texel++) {
    data.set([(texel * 16 + seed) % 256, (texel * 7 + seed * 3) % 256, (seed * 29) % 256, 255], texel * 4);
  }
  return { image: { width: IMAGE_SIZE, height: IMAGE_SIZE, data }, wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729, colorSpace: 'srgb', uvChannel: 0 };
}

function texturedBox(seed) {
  const geometry = box();
  geometry.uvs = new Float32Array((geometry.positions.length / 3) * 2).map((unused, index) => (index % 5) / 5);
  return { name: 'Box', geometry, matrix: mat4.create(), material: { color: [1, 1, 1], metallic: 0, roughness: 0.5, map: mapDescriptor(seed) } };
}

// Tags every texture of a GLB with the key the world splitter writes into extras.sharedTexture.
function tagSharedTexture(glb, key) {
  const buffer = Buffer.from(glb);
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  json.textures.forEach(texture => { texture.extras = { sharedTexture: key }; });
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binaryChunk = buffer.subarray(20 + jsonLength);
  const header = Buffer.from(buffer.subarray(0, 20));
  header.writeUInt32LE(12 + 8 + jsonPadded.length + binaryChunk.length, 8);
  header.writeUInt32LE(jsonPadded.length, 12);
  const rebuilt = Buffer.concat([header, jsonPadded, binaryChunk]);
  return rebuilt.buffer.slice(rebuilt.byteOffset, rebuilt.byteOffset + rebuilt.length);
}

test('a texture with the same shared key in two files is decoded once and both files bind one descriptor', async () => {
  const sharedTextures = createSharedTextures();
  const firstFile = tagSharedTexture(exportGlb([texturedBox(1)]), 'ground');
  // The later file carries a different stand-in image under the same key; it must never be decoded.
  const laterFile = tagSharedTexture(exportGlb([texturedBox(2)]), 'ground');
  decodedImageCount = 0;
  const first = await parseGltf(firstFile, { sharedTextures });
  const later = await parseGltf(laterFile, { sharedTextures });
  assert.equal(decodedImageCount, 1);
  assert.equal(later.parts[0].material.map, first.parts[0].material.map);
  assert.deepEqual(Array.from(later.parts[0].material.map.image.data), Array.from(mapDescriptor(1).image.data));
});

test('without shared state, or with different keys, each file decodes its own texture', async () => {
  const firstFile = tagSharedTexture(exportGlb([texturedBox(1)]), 'ground');
  const laterFile = tagSharedTexture(exportGlb([texturedBox(2)]), 'roof');
  decodedImageCount = 0;
  const sharedTextures = createSharedTextures();
  const first = await parseGltf(firstFile, { sharedTextures });
  const later = await parseGltf(laterFile, { sharedTextures });
  assert.equal(decodedImageCount, 2);
  assert.notEqual(later.parts[0].material.map, first.parts[0].material.map);
  const alone = await parseGltf(laterFile);
  assert.equal(decodedImageCount, 3);
  assert.deepEqual(Array.from(alone.parts[0].material.map.image.data), Array.from(mapDescriptor(2).image.data));
});
