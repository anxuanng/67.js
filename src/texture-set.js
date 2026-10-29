// Loads one scanned material (color, normal, roughness, height) as texture descriptors.
// The descriptors have the same shape as `material.map`, so they work for splat layers and plain maps alike.

export const TEXTURE_SET_CHANNELS = Object.freeze(['color', 'normal', 'roughness', 'height']);

const CHANNEL_COLOR_SPACES = Object.freeze({ color: 'srgb', normal: 'linear', roughness: 'linear', height: 'linear' });

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Texture request failed with status ${response.status}: ${url}`);
  return response.blob();
}

function decodeBlob(blob) {
  // Raw decoding: colour management would change the bytes the shader expects.
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

function joinUrl(baseUrl, fileName) {
  return `${baseUrl.replace(/\/+$/, '')}/${fileName}`;
}

function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) throw new TypeError('channels must be a non-empty array.');
  for (const channel of channels) {
    if (!TEXTURE_SET_CHANNELS.includes(channel)) throw new RangeError(`Unknown texture channel: ${channel}. Use ${TEXTURE_SET_CHANNELS.join(', ')}.`);
  }
}

/**
 * Fetch and decode `<baseUrl>/<channel>.<extension>` for each channel.
 * Without `channels`, every channel that exists is loaded and a missing file is skipped (some scans have no height map).
 * With an explicit `channels` list, a missing file throws.
 * `fetchBlob` and `decodeBlob` can be replaced, which is how Node tests run without a browser.
 */
export async function loadTextureSet(baseUrl, { channels, extension = 'webp', fetchBlob: fetchOne = fetchBlob, decodeBlob: decodeOne = decodeBlob, colorSpaces = {} } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl must be a non-empty string.');
  const required = channels !== undefined;
  const requested = channels ?? TEXTURE_SET_CHANNELS;
  validateChannels(requested);
  const loaded = await Promise.all(requested.map(async (channel) => {
    try {
      const blob = await fetchOne(joinUrl(baseUrl, `${channel}.${extension}`));
      const image = await decodeOne(blob);
      return [channel, { image, colorSpace: colorSpaces[channel] ?? CHANNEL_COLOR_SPACES[channel] }];
    } catch (error) {
      if (required) throw error;
      return null;
    }
  }));
  const set = Object.fromEntries(loaded.filter(Boolean));
  if (Object.keys(set).length === 0) throw new Error(`No texture channels found under ${baseUrl}.`);
  return set;
}

export const LEAF_TEXTURE_SPECIES = Object.freeze(['broadleaf', 'birch', 'bush', 'conifer']);

const CLAMP_TO_EDGE = 33071;

/**
 * Load scanned leaf cards for `createTree` and `scatterVegetation` (`leafTextures`).
 * Each species folder holds `color.webp` (RGBA, alpha is the leaf mask), `normal.webp` and `crown.webp`
 * (the far level-of-detail clump). Cards clamp at their edges so the twig at the bottom never bleeds to the top.
 * Returns `{ broadleaf: { color, normal, crown }, ... }`.
 */
export async function loadLeafTextures(baseUrl, { species = LEAF_TEXTURE_SPECIES, extension = 'webp', fetchBlob: fetchOne = fetchBlob, decodeBlob: decodeOne = decodeBlob } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl must be a non-empty string.');
  const channels = [['color', 'srgb'], ['normal', 'linear'], ['crown', 'srgb']];
  const entries = await Promise.all(species.map(async (name) => {
    const textures = await Promise.all(channels.map(async ([channel, colorSpace]) => {
      const blob = await fetchOne(joinUrl(baseUrl, `${name}/${channel}.${extension}`));
      const image = await decodeOne(blob);
      return [channel, { image, colorSpace, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }];
    }));
    return [name, Object.fromEntries(textures)];
  }));
  return Object.fromEntries(entries);
}
