import { bounded, denseArray, knownKeys } from './motion-validation.js';

// Clip layers for an imported asset's motion: play clips the file ships, blend them over each other, and limit each to
// some bones. Agent input is untrusted plain data, so everything here is named, bounded and checked against the asset.

export const MAX_CLIP_LAYERS = 8;
const MAX_MASK_JOINTS = 32;
const MAX_BONE_MAP_ENTRIES = 64;
const MAX_NAME_LENGTH = 128;
const MAX_LAYER_SPEED = 8;
const MAX_LAYER_OFFSET = 30;

/**
 * What the layers are checked against: `clips` (`{ duration, targets }` per clip, the node names its tracks move) and
 * `nodes` (`{ id, name }` per node). Built by the asset from its decoded file.
 */
export function clipLayerContextFromAsset(animations, nodes) {
  return {
    clips: animations.map(animation => ({
      duration: animation.duration,
      targets: new Set(animation.tracks.map(track => track.name.slice(0, track.name.lastIndexOf('.')))),
    })),
    nodes: nodes.map(({ id, name }) => ({ id, name })),
  };
}

function nodeNameResolver(context) {
  const nameById = new Map(context.nodes.map(node => [node.id, node.name]));
  const names = new Set(context.nodes.map(node => node.name));
  return function resolveNode(value, label) {
    if (typeof value !== 'string' || !value || value.length > MAX_NAME_LENGTH) {
      throw new TypeError(`${label} needs a node ID or name of 1 to ${MAX_NAME_LENGTH} characters.`);
    }
    if (nameById.has(value)) return nameById.get(value);
    if (names.has(value)) return value;
    throw new RangeError(`${label}: ${value.slice(0, 64)} is not a node of this asset. Find IDs and names with scene_inspect kind hierarchy.`);
  };
}

function normalizedMask(input, resolveNode, position) {
  const label = `Motion layer ${position} mask`;
  knownKeys(input, ['joints', 'descendants', 'exclude'], label);
  denseArray(input.joints, MAX_MASK_JOINTS, `${label} joints`);
  if (!input.joints.length) throw new RangeError(`${label} needs at least one joint.`);
  const mask = { joints: input.joints.map(joint => resolveNode(joint, `${label} joint`)) };
  if (input.descendants !== undefined) {
    if (typeof input.descendants !== 'boolean') throw new TypeError(`${label} descendants must be boolean.`);
    mask.descendants = input.descendants;
  }
  if (input.exclude !== undefined) {
    denseArray(input.exclude, MAX_MASK_JOINTS, `${label} exclude`);
    mask.exclude = input.exclude.map(joint => resolveNode(joint, `${label} exclude`));
  }
  return mask;
}

/** Retargeting by name: the clip's track target (a node name in the clip) mapped to the node of this asset it should move. */
function normalizedBoneMap(input, clip, resolveNode, position) {
  const label = `Motion layer ${position} bones`;
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(`${label} must be a plain object.`);
  const entries = Object.entries(input);
  if (!entries.length || entries.length > MAX_BONE_MAP_ENTRIES) throw new RangeError(`${label} needs 1 to ${MAX_BONE_MAP_ENTRIES} entries.`);
  const resolved = entries.map(([from, to]) => {
    if (!clip.targets.has(from)) throw new RangeError(`${label}: the clip has no track for ${from.slice(0, 64)}.`);
    return [from, resolveNode(to, `${label} ${from.slice(0, 64)}`)];
  });
  const destinations = resolved.map(([, destination]) => destination);
  if (new Set(destinations).size !== destinations.length) throw new RangeError(`${label} cannot send two clip nodes to the same node.`);
  return Object.fromEntries(resolved);
}

function normalizedLayer(input, position, context, resolveNode) {
  const label = `Motion layer ${position}`;
  knownKeys(input, ['clip', 'loop', 'weight', 'speed', 'offset', 'additive', 'reference', 'mask', 'bones', 'morph'], label);
  const clip = context.clips[input.clip];
  if (!Number.isInteger(input.clip) || !clip) throw new RangeError(`${label} clip must be the index of a clip in the asset (0 to ${context.clips.length - 1}).`);
  const layer = { clip: input.clip };
  for (const flag of ['loop', 'additive', 'morph']) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== 'boolean') throw new TypeError(`${label} ${flag} must be boolean.`);
    layer[flag] = input[flag];
  }
  if (input.weight !== undefined) layer.weight = bounded(input.weight, 0, 1, `${label} weight`);
  if (input.speed !== undefined) layer.speed = bounded(input.speed, 0.05, MAX_LAYER_SPEED, `${label} speed`);
  if (input.offset !== undefined) layer.offset = bounded(input.offset, -MAX_LAYER_OFFSET, MAX_LAYER_OFFSET, `${label} offset`);
  if (input.reference !== undefined) layer.reference = bounded(input.reference, 0, clip.duration, `${label} reference`);
  if (input.mask !== undefined) layer.mask = normalizedMask(input.mask, resolveNode, position);
  if (input.bones !== undefined) layer.bones = normalizedBoneMap(input.bones, clip, resolveNode, position);
  return layer;
}

/** Validate `motion.layers` against the asset. Returns plain data the asset turns into layer definitions. */
export function normalizeClipLayers(input, context) {
  if (!context) throw new RangeError('Motion layers play clips of an imported asset, so they need an asset recipe.');
  denseArray(input, MAX_CLIP_LAYERS, 'Motion layers');
  if (!input.length) throw new RangeError('Motion layers needs at least one layer. Leave it out to play none.');
  const resolveNode = nodeNameResolver(context);
  return input.map((layer, position) => normalizedLayer(layer, position, context, resolveNode));
}
