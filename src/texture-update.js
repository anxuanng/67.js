// Pushes new pixels into a texture that createTexture() already uploaded (live canvas, video, simulation).
// Importing this module gives the renderer its updateTexture code (the pattern of splat-shader.js).
// The validation and region math need no GL context, so tests can reach them directly.
import { textureDescriptorInfo } from './renderer.js';
import { textureUpdateSupport } from './shader-registry.js';

// Bytes in a region are RGBA, top row first, exactly as the descriptor image would supply them.
export function validateTextureRegion(region, width, height) {
  const { x, y, width: regionWidth, height: regionHeight, data } = region ?? {};
  for (const [name, value] of Object.entries({ x, y, width: regionWidth, height: regionHeight })) {
    if (!Number.isInteger(value)) throw new TypeError(`updateTexture region.${name} must be an integer.`);
  }
  if (x < 0 || y < 0 || regionWidth <= 0 || regionHeight <= 0 || x + regionWidth > width || y + regionHeight > height) {
    throw new RangeError(`updateTexture region ${regionWidth}x${regionHeight} at ${x},${y} does not fit the ${width}x${height} texture.`);
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw new TypeError('updateTexture region.data must be a Uint8Array or Uint8ClampedArray of RGBA bytes.');
  const expected = regionWidth * regionHeight * 4;
  if (data.length !== expected) throw new RangeError(`updateTexture region.data has ${data.length} bytes, expected ${expected} (${regionWidth}x${regionHeight} RGBA).`);
}

// With flipY the first upload stores image row 0 at the top texture row, and WebGL flips a sub-rectangle inside itself,
// so the rectangle moves to the mirrored rows and the region stays in image coordinates.
export function textureRegionOffset(region, textureHeight, flipY) {
  return { x: region.x, y: flipY ? textureHeight - region.y - region.height : region.y };
}

export function updateRendererTexture(renderer, descriptor, update) {
  const context = renderer.context;
  if (!descriptor || !renderer.textures.has(descriptor)) throw new Error('updateTexture needs a descriptor this renderer already uploaded with a part or createTexture(descriptor).');
  if (descriptor.image.compressed) throw new Error('Compressed textures cannot be updated because their mip levels come from the file. Use an RGBA image.');
  const info = textureDescriptorInfo(descriptor, context.getParameter(context.MAX_TEXTURE_SIZE));
  const { image, region } = update;
  if (image && region) throw new Error('updateTexture takes image or region, not both.');
  if (image && ((image.naturalWidth ?? image.width) !== info.width || (image.naturalHeight ?? image.height) !== info.height)) {
    throw new RangeError(`updateTexture image must be ${info.width}x${info.height} like the uploaded texture. Create a new renderer to change the size.`);
  }
  if (region) validateTextureRegion(region, info.width, info.height);
  const flipY = descriptor.flipY ?? false;
  const previousFlip = context.getParameter(context.UNPACK_FLIP_Y_WEBGL);
  const previousPremultiply = context.getParameter(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  const previousColorSpace = context.getParameter(context.UNPACK_COLORSPACE_CONVERSION_WEBGL);
  const previousBinding = context.getParameter(context.TEXTURE_BINDING_2D);
  try {
    context.bindTexture(context.TEXTURE_2D, renderer.textures.get(descriptor));
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, flipY);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
    if (region) {
      const offset = textureRegionOffset(region, info.height, flipY);
      context.texSubImage2D(context.TEXTURE_2D, 0, offset.x, offset.y, region.width, region.height, context.RGBA, context.UNSIGNED_BYTE, region.data);
    } else {
      context.texSubImage2D(context.TEXTURE_2D, 0, 0, 0, context.RGBA, context.UNSIGNED_BYTE, image ?? descriptor.image);
    }
    if (info.mipmaps) context.generateMipmap(context.TEXTURE_2D);
  } finally {
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, previousFlip);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, previousPremultiply);
    context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
    context.bindTexture(context.TEXTURE_2D, previousBinding);
  }
}

textureUpdateSupport.update = updateRendererTexture;
