import { encodePng } from './export-png.js';

export const DEFAULT_MAX_TEXTURE_SIZE = 2048;
const ABSOLUTE_MAX_TEXTURE_SIZE = 16384;
const WRAP_DEFAULT = 10497;
const MIN_FILTER_DEFAULT = 9987;
const MAG_FILTER_DEFAULT = 9729;

function pixelsOf(image, channel) {
  const width = image?.naturalWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError(`GLB ${channel} needs an image with a whole width and height.`);
  }
  if (image.data) {
    if (image.data.length < width * height * 4) throw new RangeError(`GLB ${channel} image data must hold RGBA8 pixels for every texel.`);
    return { width, height, pixels: image.data };
  }
  // Browser images, bitmaps and canvases: read the pixels back through a canvas.
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : globalThis.document?.createElement('canvas');
  if (!canvas) throw new TypeError(`GLB ${channel} needs RGBA pixel data ({ width, height, data }) outside a browser.`);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return { width, height, pixels: context.getImageData(0, 0, width, height).data };
}

/** Writes each distinct image once as an embedded PNG and shares samplers and textures between channels. */
export function createTextureWriter(writer, maxTextureSize = DEFAULT_MAX_TEXTURE_SIZE) {
  if (!Number.isInteger(maxTextureSize) || maxTextureSize < 1 || maxTextureSize > ABSOLUTE_MAX_TEXTURE_SIZE) {
    throw new RangeError(`maxTextureSize must be a whole number from 1 to ${ABSOLUTE_MAX_TEXTURE_SIZE}.`);
  }
  const { document } = writer;
  document.images = [];
  document.samplers = [];
  document.textures = [];
  const imageIndices = new Map();
  const samplerIndices = new Map();
  const textureIndices = new Map();

  function imageIndex(descriptor, channel) {
    const flipRows = descriptor.flipY === true;
    const known = imageIndices.get(descriptor.image);
    if (known?.has(flipRows)) return known.get(flipRows);
    const { width, height, pixels } = pixelsOf(descriptor.image, channel);
    if (width > maxTextureSize || height > maxTextureSize) {
      throw new RangeError(`GLB ${channel} image is ${width}x${height}, above maxTextureSize ${maxTextureSize}. Resize the image, or pass exportGlb(parts, { maxTextureSize }) up to ${ABSOLUTE_MAX_TEXTURE_SIZE} if the file size is acceptable.`);
    }
    const bytes = encodePng(pixels, width, height, { flipRows });
    document.images.push({ bufferView: writer.addBufferView(bytes), mimeType: 'image/png' });
    const index = document.images.length - 1;
    imageIndices.set(descriptor.image, (known ?? new Map()).set(flipRows, index));
    return index;
  }

  function samplerIndex(descriptor) {
    const sampler = {
      magFilter: descriptor.magFilter ?? MAG_FILTER_DEFAULT,
      minFilter: descriptor.minFilter ?? MIN_FILTER_DEFAULT,
      wrapS: descriptor.wrapS ?? WRAP_DEFAULT,
      wrapT: descriptor.wrapT ?? WRAP_DEFAULT,
    };
    const key = JSON.stringify(sampler);
    if (!samplerIndices.has(key)) {
      samplerIndices.set(key, document.samplers.length);
      document.samplers.push(sampler);
    }
    return samplerIndices.get(key);
  }

  return {
    /** Index of the glTF texture for a renderer texture descriptor `{ image, wrapS, ... }`. */
    textureIndex(descriptor, channel) {
      if ((descriptor.uvChannel ?? 0) !== 0) throw new RangeError(`GLB ${channel} uses UV channel ${descriptor.uvChannel}; only channel 0 is supported.`);
      const source = imageIndex(descriptor, channel);
      const sampler = samplerIndex(descriptor);
      const key = `${source}:${sampler}`;
      if (!textureIndices.has(key)) {
        textureIndices.set(key, document.textures.length);
        document.textures.push({ sampler, source });
      }
      return textureIndices.get(key);
    },
  };
}
