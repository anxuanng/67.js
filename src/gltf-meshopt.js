import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Decodes EXT_meshopt_compression buffer views with the meshoptimizer WebAssembly decoder (MIT, the build that ships with three.js).
// Only a file that has such a view loads this module, so the decoder costs every other file nothing.
const MODES = new Set(['ATTRIBUTES', 'TRIANGLES', 'INDICES']);
const FILTERS = new Set(['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL']);

function decodeView(view, bufferBytes, decoder) {
  const extension = view.extensions.EXT_meshopt_compression;
  const filter = extension.filter ?? 'NONE';
  const source = bufferBytes(extension.buffer);
  const offset = extension.byteOffset ?? 0;
  if (!source || offset + extension.byteLength > source.length) throw new Error('Meshopt buffer view exceeds its buffer.');
  const decodedLength = extension.count * extension.byteStride;
  if (!Number.isSafeInteger(decodedLength) || decodedLength !== view.byteLength) {
    throw new Error('EXT_meshopt_compression count and byteStride do not match the buffer view length.');
  }
  if (!MODES.has(extension.mode) || !FILTERS.has(filter)) throw new Error('EXT_meshopt_compression has an unknown mode or filter.');
  const decoded = new Uint8Array(decodedLength);
  try {
    decoder.decodeGltfBuffer(decoded, extension.count, extension.byteStride, source.subarray(offset, offset + extension.byteLength), extension.mode, filter);
  } catch (error) {
    throw new Error(`EXT_meshopt_compression could not decode a buffer view (${extension.mode}, ${filter}): ${error.message}`);
  }
  return decoded;
}

/** Returns a Map from buffer view index to its decoded bytes. The fallback buffer is never read. */
export async function decodeMeshoptViews(bufferViews, bufferBytes, suppliedDecoder) {
  const decoder = suppliedDecoder ?? MeshoptDecoder;
  await decoder.ready;
  const decodedViews = new Map();
  bufferViews.forEach((view, index) => {
    if (view.extensions?.EXT_meshopt_compression) decodedViews.set(index, decodeView(view, bufferBytes, decoder));
  });
  return decodedViews;
}
