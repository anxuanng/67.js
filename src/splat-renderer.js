import { SPLAT_UNITS } from './shader-registry.js';

// The renderer's splat ground code, kept apart from renderer.js so a scene without splat layers does not carry it.
// splat-shader.js registers these functions; each takes the renderer as its first argument.

function createTextureArray(renderer, internalFormat, size, layerCount, pixels) {
  const context = renderer.context;
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D_ARRAY, texture);
  const levels = Math.floor(Math.log2(size)) + 1;
  context.texStorage3D(context.TEXTURE_2D_ARRAY, levels, internalFormat, size, size, layerCount);
  context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
  context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
  context.texSubImage3D(context.TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, layerCount, context.RGBA, context.UNSIGNED_BYTE, pixels);
  context.generateMipmap(context.TEXTURE_2D_ARRAY);
  context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_WRAP_S, context.REPEAT);
  context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_WRAP_T, context.REPEAT);
  context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
  context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MAG_FILTER, context.LINEAR);
  renderer.applyAnisotropy(context.TEXTURE_2D_ARRAY);
  return texture;
}

export function initializeSplatPlaceholders(renderer) {
  const context = renderer.context;
  renderer.splatPlaceholder = context.createTexture();
  context.bindTexture(context.TEXTURE_2D_ARRAY, renderer.splatPlaceholder);
  context.texImage3D(context.TEXTURE_2D_ARRAY, 0, context.RGBA8, 1, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
  context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MIN_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.useProgram(renderer.program);
  for (const name of ['splatColor', 'splatNormal', 'splatPacked']) {
    context.uniform1i(renderer.uniforms[name], SPLAT_UNITS[name]);
    context.activeTexture(context.TEXTURE0 + SPLAT_UNITS[name]);
    context.bindTexture(context.TEXTURE_2D_ARRAY, renderer.splatPlaceholder);
  }
  context.uniform1i(renderer.uniforms.splatMask, SPLAT_UNITS.splatMask);
  context.activeTexture(context.TEXTURE0 + SPLAT_UNITS.splatMask);
  context.bindTexture(context.TEXTURE_2D, renderer.whiteTexture);
  context.uniform1f(renderer.uniforms.splatEnabled, 0);
}

export function createSplatResources(renderer, material, support) {
  if (renderer.splatResources.has(material.layers)) return renderer.splatResources.get(material.layers);
  const context = renderer.context;
  const size = support.resolveSize(material, context.getParameter(context.MAX_TEXTURE_SIZE));
  const layerCount = material.layers.length;
  const pixels = support.buildPixels(material.layers, size);
  const resources = {
    size,
    layerCount,
    color: createTextureArray(renderer, context.SRGB8_ALPHA8, size, layerCount, pixels.color),
    normal: createTextureArray(renderer, context.RGBA8, size, layerCount, pixels.normal),
    packed: createTextureArray(renderer, context.RGBA8, size, layerCount, pixels.packed),
    mask: material.splat?.maskMap ? renderer.createTexture(material.splat.maskMap) : renderer.whiteTexture,
    parameters: support.packParameters(material),
  };
  renderer.splatResources.set(material.layers, resources);
  return resources;
}

export function bindSplat(renderer, splat) {
  const context = renderer.context;
  const uniforms = renderer.uniforms;
  context.uniform1f(uniforms.splatEnabled, splat ? 1 : 0);
  if (!splat) return;
  const bindings = [
    [SPLAT_UNITS.splatColor, context.TEXTURE_2D_ARRAY, splat.color],
    [SPLAT_UNITS.splatNormal, context.TEXTURE_2D_ARRAY, splat.normal],
    [SPLAT_UNITS.splatPacked, context.TEXTURE_2D_ARRAY, splat.packed],
    [SPLAT_UNITS.splatMask, context.TEXTURE_2D, splat.mask],
  ];
  for (const [unit, target, texture] of bindings) {
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(target, texture);
  }
  const parameters = splat.parameters;
  context.uniform4fv(uniforms['splatLayer[0]'], parameters.layer);
  context.uniform4fv(uniforms['splatTint[0]'], parameters.tint);
  context.uniform4fv(uniforms['splatSlope[0]'], parameters.slope);
  context.uniform4fv(uniforms['splatHeightRange[0]'], parameters.height);
  context.uniform1fv(uniforms['splatMaskChannel[0]'], parameters.mask);
  context.uniform1fv(uniforms['splatMaskInvert[0]'], parameters.maskInvert);
  context.uniform4fv(uniforms.splatBlend, parameters.blend);
  context.uniform4fv(uniforms.splatOptions, parameters.options);
  context.uniform4fv(uniforms.splatMaskBounds, parameters.maskBounds);
  context.uniform4fv(uniforms.splatVariation, parameters.variation);
}

export function disposeSplatResources(renderer) {
  for (const resources of renderer.splatResources.values()) {
    for (const texture of [resources.color, resources.normal, resources.packed]) renderer.context.deleteTexture(texture);
  }
  renderer.splatResources.clear();
  if (renderer.splatPlaceholder) renderer.context.deleteTexture(renderer.splatPlaceholder);
}
