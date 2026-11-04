// Lets renderer.replaceParts add and remove textured parts. Importing this module registers the texture bookkeeping
// that replaceParts runs around its batch swap (the pattern of texture-update.js), so a scene that never streams
// textured parts does not carry it.
//
// A texture is deleted, and its bytes leave the texture ledger, once no kept or new batch binds it. A texture that
// another part still binds stays. Skinned and morphed parts are still not reconciled by replaceParts.
import { textureDescriptorInfo } from './renderer.js';
import { texturedReplaceSupport } from './shader-registry.js';

// Every texture descriptor a batch binds, including layer and splat-mask maps, so a texture they share is never freed.
export function batchTextureDescriptors(batch) {
  const state = batch.mapState;
  return [...state.slice(0, 5), state[14], ...Object.values(state[18] ?? {}), state[17]?.maskMap].filter(Boolean);
}

function deleteTextures(renderer, descriptors) {
  let bytes = 0;
  for (const descriptor of new Set(descriptors)) {
    renderer.context.deleteTexture(renderer.textures.get(descriptor));
    renderer.textures.delete(descriptor);
    bytes += textureDescriptorInfo(descriptor).bytes;
  }
  return bytes;
}

texturedReplaceSupport.begin = renderer => {
  const previousTextures = new Map(renderer.textures);
  // The shared white texture has a null key and the renderer owns it; only descriptors uploaded during the replace are new.
  const uploadedDuringReplace = () => [...renderer.textures.keys()].filter(descriptor => descriptor && !previousTextures.has(descriptor));
  // Called without batches, it rolls the replace back; with the batches before and after, it settles the ledger.
  return (previousBatches, nextBatches) => {
    if (!nextBatches) {
      deleteTextures(renderer, uploadedDuringReplace());
      return;
    }
    const bound = new Set(nextBatches.flatMap(batchTextureDescriptors));
    const unbound = previousBatches.flatMap(batchTextureDescriptors).filter(descriptor => !bound.has(descriptor) && renderer.textures.has(descriptor));
    const addedBytes = uploadedDuringReplace().reduce((total, descriptor) => total + textureDescriptorInfo(descriptor).bytes, 0);
    renderer.textureBytes += addedBytes - deleteTextures(renderer, unbound);
  };
};
