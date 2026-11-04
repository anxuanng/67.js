// Opens a glTF material whose maps carry different KHR_texture_transform values. The first UV set holds one transform, so
// the maps that differ are resampled into that shared UV space once, at load time. parseGltf imports this module only for a
// file that has such a material, so it adds nothing to a scene that loads a clean file.

const IDENTITY_KEY = JSON.stringify([[0, 0], 0, [1, 1]]);
const REPEAT_WRAP = 10497;
const WHOLE_NUMBER_TOLERANCE = 1e-6;
// A resampled map may grow to this many times the pixels of its source: a 2 by 2 tiling at full density.
const MAX_GROWTH = 4;
// The decoded material field that holds each glTF material texture. Layer textures keep their glTF property name.
const SOURCE_FIELD = {
  baseColorTexture: 'map',
  metallicRoughnessTexture: 'metalnessMap',
  occlusionTexture: 'aoMap',
  emissiveTexture: 'emissiveMap',
};

const uvChannelOf = reference => reference.texCoord ?? 0;

// Compares transforms; the identity maps to the empty key, like the loader's own.
function uvTransformKey(transform) {
  const key = JSON.stringify([transform.offset, transform.rotation, transform.scale]);
  return key === IDENTITY_KEY ? '' : key;
}

function materialLabel(material, index) {
  return material?.name ? `"${material.name}" (material ${index})` : `material ${index}`;
}

/** The 2 by 2 matrix [a, b, c, d] of the UV transform, row-major: uv' = matrix * uv + offset. */
function linearPart({ rotation, scale }) {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return [cosine * scale[0], sine * scale[1], -sine * scale[0], cosine * scale[1]];
}

function multiply([a, b, c, d], [e, f, g, h]) {
  return [a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h];
}

function invert([a, b, c, d]) {
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return [d / determinant, -b / determinant, -c / determinant, a / determinant];
}

/**
 * Where a map reads its own texture for a UV already baked with `shared`: ownUv = linear * sharedUv + offset. The result
 * is null when `linear` is not made of whole numbers, because the baked image is one tile that repeats once per UV unit
 * and only whole-number steps land on the same texel again after each repeat.
 */
function sharedToOwn(shared, own) {
  const inverse = invert(linearPart(shared));
  if (!inverse) return null;
  const linear = multiply(linearPart(own), inverse);
  const rounded = linear.map(Math.round);
  if (linear.some((value, index) => Math.abs(value - rounded[index]) > WHOLE_NUMBER_TOLERANCE)) return null;
  const [a, b, c, d] = rounded;
  const offset = [own.offset[0] - (a * shared.offset[0] + b * shared.offset[1]), own.offset[1] - (c * shared.offset[0] + d * shared.offset[1])];
  return { linear: rounded, offset };
}

function textureWrapsByRepeat(document, reference) {
  const sampler = document.samplers?.[document.textures?.[reference.index]?.sampler] ?? {};
  return (sampler.wrapS ?? REPEAT_WRAP) === REPEAT_WRAP && (sampler.wrapT ?? REPEAT_WRAP) === REPEAT_WRAP;
}

/** The maps of one material that read the first UV set and can be resampled: [property, reference, transform]. */
function resamplableMaps(material, { materialTextureReferences, textureUvTransform }) {
  return materialTextureReferences(material)
    .filter(([property, reference]) => property !== 'normalTexture' && uvChannelOf(reference) === 0)
    .map(([property, reference]) => [property, reference, textureUvTransform(reference)]);
}

/** The transform to share, and the resample of every map that differs from it. The cheapest tiling wins; null if none works. */
function cheapestSharing(document, maps) {
  const candidates = new Map();
  for (const [, , transform] of maps) {
    const key = uvTransformKey(transform);
    candidates.set(key, { transform, count: (candidates.get(key)?.count ?? 0) + 1 });
  }
  const ranked = [...candidates.entries()].sort((first, second) => second[1].count - first[1].count);
  let best = null;
  for (const [sharedKey, { transform: shared }] of ranked) {
    const resamples = [];
    let growth = 0;
    for (const [property, reference, transform] of maps) {
      if (uvTransformKey(transform) === sharedKey) continue;
      const placement = textureWrapsByRepeat(document, reference) ? sharedToOwn(shared, transform) : null;
      if (!placement) {
        growth = Infinity;
        break;
      }
      growth += Math.abs(placement.linear[0] * placement.linear[3] - placement.linear[1] * placement.linear[2]);
      resamples.push({ property, ...placement });
    }
    if (growth < (best?.growth ?? Infinity)) best = { shared, resamples, growth };
  }
  return best;
}

function writeSharedTransform(reference, shared) {
  const { KHR_texture_transform: previous, ...otherExtensions } = reference.extensions ?? {};
  const extensions = uvTransformKey(shared) === '' ? otherExtensions : { ...otherExtensions, KHR_texture_transform: { ...previous, offset: shared.offset, rotation: shared.rotation, scale: shared.scale } };
  if (Object.keys(extensions).length) reference.extensions = extensions;
  else delete reference.extensions;
}

/**
 * For every material whose maps differ, rewrites the document so that all its maps share one KHR_texture_transform and
 * returns { apply(decoded, limits) }, which resamples the planned maps of the decoded materials and returns one warning per map.
 * Returns null when no material differs. Throws, naming the material, when the maps cannot be brought into one UV space.
 */
export function planMapResampling(document, loaderHelpers) {
  const plans = new Map();
  (document.materials ?? []).forEach((material, index) => {
    const maps = resamplableMaps(material ?? {}, loaderHelpers);
    if (new Set(maps.map(([, , transform]) => uvTransformKey(transform))).size < 2) return;
    const sharing = cheapestSharing(document, maps);
    if (!sharing) {
      const names = maps.map(([property]) => property).join(', ');
      throw new Error(`Maps of ${materialLabel(material, index)} have KHR_texture_transform values that cannot share one UV space (${names}). They must repeat, read TEXCOORD_0, and differ by whole-number tilings of one of them.`);
    }
    for (const [, reference, transform] of maps) {
      if (uvTransformKey(transform) !== uvTransformKey(sharing.shared)) writeSharedTransform(reference, sharing.shared);
    }
    plans.set(index, sharing.resamples);
  });
  if (!plans.size) return null;
  return { apply: (decoded, limits) => applyMapResampling(decoded, plans, document, limits) };
}

function pixelsOf(image, name) {
  if (image.data) return image.data;
  if (typeof OffscreenCanvas !== 'function' && typeof document === 'undefined') throw new Error(`${name} cannot be read back to resample it: this runtime has no canvas.`);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(image.width, image.height) : Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`${name} cannot be read back to resample it.`);
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height).data;
}

function wrapped(index, size) {
  return ((index % size) + size) % size;
}

function sampleBilinear(source, width, height, u, v, output, outputOffset) {
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const weightX = x - left;
  const weightY = y - top;
  for (let channel = 0; channel < 4; channel++) {
    const at = (column, row) => source[(wrapped(row, height) * width + wrapped(column, width)) * 4 + channel];
    const upper = at(left, top) * (1 - weightX) + at(left + 1, top) * weightX;
    const lower = at(left, top + 1) * (1 - weightX) + at(left + 1, top + 1) * weightX;
    output[outputOffset + channel] = Math.round(upper * (1 - weightY) + lower * weightY);
  }
}

/** Size of the resampled image: the source texel density kept, so tiling grows it, within the growth cap and the pixel limit. */
function resampledSize(image, { linear }, maxPixels) {
  const [a, b, c, d] = linear;
  let width = Math.max(1, Math.round(Math.hypot(a * image.width, c * image.height)));
  let height = Math.max(1, Math.round(Math.hypot(b * image.width, d * image.height)));
  const allowed = Math.min(MAX_GROWTH * image.width * image.height, maxPixels);
  const capped = width * height > allowed;
  if (capped) {
    const shrink = Math.sqrt(allowed / (width * height));
    width = Math.max(1, Math.floor(width * shrink));
    height = Math.max(1, Math.floor(height * shrink));
  }
  return { width, height, capped };
}

function resample(texture, placement, name, maxPixels) {
  if (texture.isCompressedTexture || !texture.image) throw new Error(`${name} is a compressed texture and cannot be resampled to a shared KHR_texture_transform.`);
  const { image } = texture;
  const source = pixelsOf(image, name);
  const { width, height, capped } = resampledSize(image, placement, maxPixels);
  const [a, b, c, d] = placement.linear;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const sharedV = (row + 0.5) / height;
    for (let column = 0; column < width; column++) {
      const sharedU = (column + 0.5) / width;
      sampleBilinear(source, image.width, image.height, a * sharedU + b * sharedV + placement.offset[0], c * sharedU + d * sharedV + placement.offset[1], data, (row * width + column) * 4);
    }
  }
  return { texture: { ...texture, image: { width, height, data } }, from: [image.width, image.height], to: [width, height], capped };
}

/** Replaces each planned map of the decoded materials with its resampled copy, and returns one warning per map. */
function applyMapResampling(decoded, plans, document, limits) {
  const warnings = [];
  const copies = new Map();
  const handled = new Set();
  decoded.scene.traverse(node => {
    const material = node.isMesh ? node.material : null;
    if (!material || handled.has(material) || !plans.has(material.materialIndex)) return;
    handled.add(material);
    const label = materialLabel(document.materials[material.materialIndex], material.materialIndex);
    for (const placement of plans.get(material.materialIndex)) {
      const holder = SOURCE_FIELD[placement.property] ? material : material.layerTextures;
      const field = SOURCE_FIELD[placement.property] ?? placement.property;
      const texture = holder?.[field];
      if (!texture) continue;
      const key = `${placement.linear}|${placement.offset}`;
      if (!copies.has(texture)) copies.set(texture, new Map());
      const name = `${placement.property} of ${label}`;
      if (!copies.get(texture).has(key)) {
        const result = resample(texture, placement, name, limits.maxTextureImagePixels);
        copies.get(texture).set(key, result.texture);
        warnings.push(`Resampled ${name} from ${result.from.join('x')} to ${result.to.join('x')} to share the UV transform of the other maps${result.capped ? ' (capped at 4 times the source pixels or maxTextureImagePixels)' : ''}.`);
      }
      holder[field] = copies.get(texture).get(key);
    }
  });
  return warnings;
}
