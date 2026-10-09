import { readFile } from 'node:fs/promises';
import { skinnedStripAsset } from '../tests/fixtures/skinned-strip.js';

/** Embedded PNG on an animated skin, exercising the actual decoder and shader path. */
export async function createTexturedRigFixture() {
  const document = JSON.parse(await readFile(new URL('../tests/fixtures/textured-triangle.gltf', import.meta.url), 'utf8'));
  const image = Buffer.from(document.images[0].uri.split(',')[1], 'base64');
  return Buffer.from(skinnedStripAsset((asset, append) => {
    append(new Uint8Array(image), 'SCALAR');
    asset.images = [{ bufferView: asset.bufferViews.length - 1, mimeType: 'image/png' }];
    asset.textures = [{ source: 0 }];
    asset.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }));
}
