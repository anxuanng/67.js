import { createImage } from './material-texture-kit.js';
import { TEXTURE_SEQUENCE_LIMITS } from './texture-sequence-limits.js';

// An image sequence as the colour map of a recipe material: `map: { sequence: { frames, fps, loop } }`. The frames are
// catalog image assets that the host decodes before createAgentScene. The scene picks a frame from its motion time, so a
// preview, a seek and a render job show the same frame for the same time.

const ASSET_ID = /^[a-f0-9]{64}$/;
const MAP_FIELDS = ['sequence'];
const SEQUENCE_FIELDS = ['frames', 'fps', 'loop'];

function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}. Allowed fields: ${allowed.join(', ')}.`);
  }
}

/** Validate a material `map` field. Returns the canonical form kept in the recipe. */
export function normalizeMapSequence(value) {
  knownKeys(value, MAP_FIELDS, 'material map');
  if (value.sequence === undefined) throw new TypeError('material map needs a sequence: { frames, fps }.');
  const sequence = value.sequence;
  knownKeys(sequence, SEQUENCE_FIELDS, 'map sequence');
  const { frames, fps, loop = true } = sequence;
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > TEXTURE_SEQUENCE_LIMITS.maxFrames) {
    throw new RangeError(`map sequence frames must list 2 to ${TEXTURE_SEQUENCE_LIMITS.maxFrames} catalog image asset IDs.`);
  }
  for (const frame of frames) {
    if (typeof frame !== 'string' || !ASSET_ID.test(frame.toLowerCase())) {
      throw new TypeError('Each map sequence frame must be the 64 hexadecimal characters of a catalog image asset id; scene_asset_catalog lists them.');
    }
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > TEXTURE_SEQUENCE_LIMITS.maxFps) {
    throw new RangeError(`map sequence fps must be above 0 and at most ${TEXTURE_SEQUENCE_LIMITS.maxFps}.`);
  }
  if (typeof loop !== 'boolean') throw new TypeError('map sequence loop must be boolean.');
  return { sequence: { frames: frames.map(frame => frame.toLowerCase()), fps, loop } };
}

/** The frame shown at a scene time: floor(time * fps), wrapped when the sequence loops and held on the last frame otherwise. */
export function sequenceFrameIndex(sequence, time) {
  const count = sequence.frames.length;
  // The small offset keeps a time such as 0.29 s at 100 fps on frame 29 despite binary rounding.
  const raw = Math.floor(Math.max(0, time ?? 0) * sequence.fps + 1e-9);
  return sequence.loop ? raw % count : Math.min(raw, count - 1);
}

/** The catalog image IDs a recipe, or a list of edit operations, uses as sequence frames. */
export function sequenceFrameIds(value) {
  const ids = new Set();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const frames = node.map?.sequence?.frames;
    if (Array.isArray(frames)) {
      for (const frame of frames) {
        if (typeof frame === 'string' && ASSET_ID.test(frame.toLowerCase())) ids.add(frame.toLowerCase());
      }
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...ids];
}

/**
 * The runtime of one material: a stable colour map descriptor holding the first frame, and the frame picked by `seek`.
 * `pool` maps catalog image IDs to decoded `{ width, height, data }` RGBA frames.
 */
export function createTextureSequence(materialId, mapField, pool) {
  const { frames, fps, loop } = mapField.sequence;
  const images = frames.map(id => {
    const frame = pool?.get(id);
    if (!frame) throw new Error(`Material ${materialId}: image ${id.slice(0, 12)} was not loaded. The host decodes catalog images before createAgentScene or apply.`);
    return frame;
  });
  const { width, height } = images[0];
  if (images.some(frame => frame.width !== width || frame.height !== height)) {
    throw new RangeError(`Material ${materialId}: every sequence frame must have the same size, ${width}x${height} here. Resize the images in the catalog.`);
  }
  const wrapped = images.map(frame => createImage(frame.data, frame.width, frame.height));
  const descriptor = { image: wrapped[0], colorSpace: 'srgb' };
  const definition = { frames, fps, loop };
  let index = 0;
  return {
    descriptor,
    seek(time) {
      index = sequenceFrameIndex(definition, time);
      return index;
    },
    get index() {
      return index;
    },
    get image() {
      return wrapped[index];
    },
    describe() {
      return { material: materialId, frames: frames.length, fps, loop, index, frame: frames[index], size: [width, height] };
    },
  };
}
