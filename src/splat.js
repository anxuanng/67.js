// Validation, GPU parameter packing and texel packing for the multi-layer splat ground material.
// The renderer owns the GL objects; everything here is plain data so it can be tested without a GPU.
import { estimateTextureBytes } from './budget.js';

export const SPLAT_MAXIMUM_LAYERS = 4;
export const SPLAT_LAYER_CHANNELS = Object.freeze(['color', 'normal', 'roughness', 'height']);
const MASK_CHANNELS = Object.freeze({ r: 0, g: 1, b: 2, a: 3 });
const DEFAULT_SCALE_METRES = 4;
const DEFAULT_SPLAT = Object.freeze({
  heightBlend: 0.22,
  heightInfluence: 1,
  triplanarStart: 38,
  triplanarEnd: 52,
  antiTiling: 1,
  cavity: 0.55,
  variation: 1,
  edgeNoise: 1,
});
const DEFAULT_RULE_SOFTNESS = Object.freeze({ slope: 4, height: 1.5 });

function imageSize(image) {
  const width = image?.naturalWidth ?? image?.width;
  const height = image?.naturalHeight ?? image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Splat texture image dimensions are invalid.');
  return Math.max(width, height);
}

function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
}

function requireRange(range, name, lowest, highest) {
  if (!Array.isArray(range) || range.length !== 2) throw new TypeError(`${name} must be a [minimum, maximum] pair.`);
  const [minimum, maximum] = range;
  requireFiniteNumber(minimum, `${name}[0]`);
  requireFiniteNumber(maximum, `${name}[1]`);
  if (minimum > maximum) throw new RangeError(`${name} minimum must not exceed its maximum.`);
  if (minimum < lowest || maximum > highest) throw new RangeError(`${name} must stay within ${lowest} and ${highest}.`);
}

function validateLayer(layer, index) {
  if (!layer || typeof layer !== 'object') throw new TypeError(`layers[${index}] must be an object.`);
  const present = SPLAT_LAYER_CHANNELS.filter(channel => layer[channel]);
  if (present.length === 0) throw new Error(`layers[${index}] needs at least one of ${SPLAT_LAYER_CHANNELS.join(', ')}.`);
  for (const channel of present) {
    imageSize(layer[channel].image);
    const colorSpace = layer[channel].colorSpace ?? (channel === 'color' ? 'srgb' : 'linear');
    const expected = channel === 'color' ? 'srgb' : 'linear';
    if (colorSpace !== expected) throw new Error(`layers[${index}].${channel} requires a ${expected} texture descriptor.`);
  }
  const scale = layer.scale ?? DEFAULT_SCALE_METRES;
  if (requireFiniteNumber(scale, `layers[${index}].scale`) <= 0) throw new RangeError(`layers[${index}].scale must be positive.`);
  if (layer.tint !== undefined && (!Array.isArray(layer.tint) || layer.tint.length !== 3 || !layer.tint.every(Number.isFinite))) throw new TypeError(`layers[${index}].tint must be three finite numbers.`);
  const normalStrength = layer.normalStrength ?? 1;
  if (requireFiniteNumber(normalStrength, `layers[${index}].normalStrength`) < 0) throw new RangeError(`layers[${index}].normalStrength must not be negative.`);
}

function validateRule(rule, index, splat) {
  if (rule === undefined || rule === null) return;
  if (typeof rule !== 'object') throw new TypeError(`splat.rules[${index}] must be an object.`);
  if (rule.slope !== undefined) requireRange(rule.slope, `splat.rules[${index}].slope`, 0, 90);
  if (rule.height !== undefined) requireRange(rule.height, `splat.rules[${index}].height`, -1e6, 1e6);
  for (const field of ['slopeSoftness', 'heightSoftness']) {
    if (rule[field] !== undefined && requireFiniteNumber(rule[field], `splat.rules[${index}].${field}`) < 0) throw new RangeError(`splat.rules[${index}].${field} must not be negative.`);
  }
  if (rule.mask !== undefined) {
    if (!Object.hasOwn(MASK_CHANNELS, rule.mask)) throw new RangeError(`splat.rules[${index}].mask must be r, g, b or a.`);
    if (rule.mask === 'a' && !splat.maskMap) throw new Error('Mask channel a needs splat.maskMap; vertex colours have only r, g and b.');
  }
}

function validateMaskMap(splat) {
  if (!splat.maskMap) return;
  imageSize(splat.maskMap.image);
  if ((splat.maskMap.colorSpace ?? 'srgb') !== 'linear') throw new Error('splat.maskMap requires a linear texture descriptor.');
  if (!Array.isArray(splat.maskBounds) || splat.maskBounds.length !== 4 || !splat.maskBounds.every(Number.isFinite)) throw new TypeError('splat.maskBounds must be [minimumX, minimumZ, maximumX, maximumZ].');
  if (splat.maskBounds[2] <= splat.maskBounds[0] || splat.maskBounds[3] <= splat.maskBounds[1]) throw new RangeError('splat.maskBounds must have a positive extent.');
}

/** Throws a descriptive error unless the material's layers and splat rules can be drawn. */
export function validateSplatMaterial(material) {
  if (!material.layers && !material.splat) return;
  const layers = material.layers;
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > SPLAT_MAXIMUM_LAYERS) throw new RangeError(`material.layers must hold 1 to ${SPLAT_MAXIMUM_LAYERS} layers.`);
  layers.forEach(validateLayer);
  const splat = material.splat ?? {};
  if (splat.rules !== undefined && (!Array.isArray(splat.rules) || splat.rules.length > layers.length)) throw new RangeError('splat.rules needs one entry per layer at most.');
  splat.rules?.forEach((rule, index) => validateRule(rule, index, splat));
  validateMaskMap(splat);
  for (const field of ['heightBlend', 'heightInfluence', 'antiTiling', 'cavity', 'variation', 'edgeNoise']) {
    if (splat[field] !== undefined && requireFiniteNumber(splat[field], `splat.${field}`) < 0) throw new RangeError(`splat.${field} must not be negative.`);
  }
  if (splat.antiTiling > 1 || splat.cavity > 1) throw new RangeError('splat.antiTiling and splat.cavity must be at most 1.');
  if (splat.variation > 2 || splat.edgeNoise > 2) throw new RangeError('splat.variation and splat.edgeNoise must be at most 2.');
  for (const field of ['triplanarStart', 'triplanarEnd']) {
    if (splat[field] !== undefined) requireRange([splat[field], splat[field]], `splat.${field}`, 0, 90);
  }
  if ((splat.triplanarStart ?? DEFAULT_SPLAT.triplanarStart) > (splat.triplanarEnd ?? DEFAULT_SPLAT.triplanarEnd)) throw new RangeError('splat.triplanarStart must not exceed splat.triplanarEnd.');
  if (splat.textureSize !== undefined && (!Number.isInteger(splat.textureSize) || splat.textureSize < 4)) throw new RangeError('splat.textureSize must be an integer of at least 4.');
  if (material.map || material.normalMap || material.metallicRoughnessMap || material.occlusionMap) throw new Error('Splat materials replace base, normal, roughness and occlusion maps; remove them.');
}

/** Identity values that decide whether two materials can share one draw call. */
export function splatBatchState(material) {
  return [material.layers ?? null, material.splat ?? null];
}

/** Bytes of the three texture arrays (color, normal, roughness+height) with mipmaps, plus the weight texture. */
export function splatTextureBytes(size, layerCount, maskSize = 0) {
  const arrays = 3 * layerCount * estimateTextureBytes(size, size);
  return arrays + (maskSize ? estimateTextureBytes(maskSize, maskSize) : 0);
}

/** Common layer resolution: the largest source, capped by the GPU limit and by `splat.textureSize`. */
export function resolveSplatSize(material, maximumTextureSize) {
  let size = 1;
  for (const layer of material.layers) {
    for (const channel of SPLAT_LAYER_CHANNELS) {
      if (layer[channel]) size = Math.max(size, imageSize(layer[channel].image));
    }
  }
  return Math.min(size, maximumTextureSize, material.splat?.textureSize ?? Infinity);
}

function writeRule(rule, index, parameters, layer) {
  const slope = rule?.slope;
  const height = rule?.height;
  const maskIndex = rule?.mask === undefined ? -1 : MASK_CHANNELS[rule.mask];
  parameters.slope.set([slope?.[0] ?? 0, slope?.[1] ?? 90, rule?.slopeSoftness ?? DEFAULT_RULE_SOFTNESS.slope, slope ? 1 : 0], index * 4);
  parameters.height.set([height?.[0] ?? -1e6, height?.[1] ?? 1e6, rule?.heightSoftness ?? DEFAULT_RULE_SOFTNESS.height, height ? 1 : 0], index * 4);
  parameters.mask[index] = maskIndex;
  parameters.maskInvert[index] = rule?.invertMask ? 1 : 0;
  const hasRules = Boolean(slope || height || maskIndex >= 0);
  parameters.layer.set([layer.scale ?? DEFAULT_SCALE_METRES, layer.normalStrength ?? 1, layer.triplanar ? 1 : 0, hasRules ? 1 : 0], index * 4);
  parameters.tint.set([...(layer.tint ?? [1, 1, 1]), 0], index * 4);
}

/** Flat uniform data for the shader. Layers without rules take whatever the other layers leave. */
export function packSplatParameters(material) {
  const splat = { ...DEFAULT_SPLAT, ...material.splat };
  const layerCount = material.layers.length;
  const parameters = {
    layer: new Float32Array(16),
    tint: new Float32Array(16),
    slope: new Float32Array(16),
    height: new Float32Array(16),
    mask: new Float32Array(4).fill(-1),
    maskInvert: new Float32Array(4),
    blend: new Float32Array([splat.heightBlend, splat.heightInfluence, splat.triplanarStart, splat.triplanarEnd]),
    options: new Float32Array([splat.antiTiling, splat.maskMap ? 1 : 0, layerCount, splat.cavity]),
    maskBounds: new Float32Array(splat.maskBounds ?? [0, 0, 1, 1]),
    variation: new Float32Array([splat.variation, splat.edgeNoise, 0, 0]),
  };
  material.layers.forEach((layer, index) => writeRule(material.splat?.rules?.[index], index, parameters, layer));
  return parameters;
}

/** Nearest-neighbour resample for decoded images that already carry RGBA bytes (Node, tests). */
function resampleBytes(image, size) {
  const output = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    const sourceRow = Math.min(image.height - 1, Math.floor(row * image.height / size));
    for (let column = 0; column < size; column++) {
      const sourceColumn = Math.min(image.width - 1, Math.floor(column * image.width / size));
      const source = (sourceRow * image.width + sourceColumn) * 4;
      output.set(image.data.subarray(source, source + 4), (row * size + column) * 4);
    }
  }
  return output;
}

function createScratchCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/** RGBA bytes of `image` resized to size by size. Browser images go through a 2D canvas. */
export function readImagePixels(image, size) {
  if (image.data && image.width && image.height) return resampleBytes(image, size);
  const canvas = createScratchCanvas(size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, size, size);
  return new Uint8Array(context.getImageData(0, 0, size, size).data.buffer);
}

const NEUTRAL_TEXEL = Object.freeze({ color: [128, 128, 128, 255], normal: [128, 128, 255, 255], roughnessHeight: [255, 128, 0, 255] });

function fillLayer(target, layerIndex, size, texel) {
  const layerBytes = size * size * 4;
  const start = layerIndex * layerBytes;
  for (let offset = 0; offset < layerBytes; offset += 4) target.set(texel, start + offset);
}

/** Texel data for the three texture arrays: color, normal and roughness (red) with height (green). */
export function buildSplatPixels(layers, size, readPixels = readImagePixels) {
  const layerBytes = size * size * 4;
  const color = new Uint8Array(layerBytes * layers.length);
  const normal = new Uint8Array(layerBytes * layers.length);
  const packed = new Uint8Array(layerBytes * layers.length);
  layers.forEach((layer, layerIndex) => {
    const start = layerIndex * layerBytes;
    if (layer.color) color.set(readPixels(layer.color.image, size), start); else fillLayer(color, layerIndex, size, NEUTRAL_TEXEL.color);
    if (layer.normal) normal.set(readPixels(layer.normal.image, size), start); else fillLayer(normal, layerIndex, size, NEUTRAL_TEXEL.normal);
    fillLayer(packed, layerIndex, size, NEUTRAL_TEXEL.roughnessHeight);
    const roughness = layer.roughness ? readPixels(layer.roughness.image, size) : null;
    const height = layer.height ? readPixels(layer.height.image, size) : null;
    for (let offset = 0; offset < layerBytes; offset += 4) {
      if (roughness) packed[start + offset] = roughness[offset];
      if (height) packed[start + offset + 1] = height[offset];
    }
  });
  return { color, normal, packed };
}
