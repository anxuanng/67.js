import { bounded, denseArray, knownKeys } from './motion-validation.js';
import { retargetReport } from './agent-retarget.js';

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
    hierarchy: nodes,
    external: new Map(),
  };
}

/** What a layer needs of another catalog asset: its clips' durations, its clips and its nodes. Add it to `context.external` by asset ID. */
export function retargetSourceFromAsset(decoded) {
  return {
    clips: decoded.animations.map(animation => ({ duration: animation.duration })),
    animations: decoded.animations,
    nodes: decoded.nodes.map(node => structuredClone(node)),
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

/** `from`: a clip of another catalog asset. It must be loaded for this session, and both skeletons must map to the humanoid bones. */
function normalizedSource(input, context, label) {
  knownKeys(input, ['asset', 'clip'], `${label} from`);
  const source = typeof input.asset === 'string' ? context.external.get(input.asset.toLowerCase()) : undefined;
  if (!source) throw new RangeError(`${label} from.asset is not a catalog asset available to this session. Use an asset ID from scene_asset_catalog other than this scene's own.`);
  const clip = source.clips[input.clip];
  if (!Number.isInteger(input.clip) || !clip) throw new RangeError(`${label} from.clip must be the index of a clip in that asset (0 to ${source.clips.length - 1}).`);
  retargetReport(source.nodes, context.hierarchy, label);
  return { from: { asset: input.asset.toLowerCase(), clip: input.clip }, clip };
}

function normalizedLayer(input, position, context, resolveNode) {
  const label = `Motion layer ${position}`;
  knownKeys(input, ['clip', 'from', 'scale', 'rootMotion', 'loop', 'weight', 'speed', 'offset', 'additive', 'reference', 'mask', 'bones', 'morph'], label);
  const layer = {};
  let clip;
  if (input.from !== undefined) {
    if (input.clip !== undefined || input.bones !== undefined || input.morph !== undefined) throw new TypeError(`${label} takes from or clip, and from has no bones or morph.`);
    const sourced = normalizedSource(input.from, context, label);
    clip = sourced.clip;
    layer.from = sourced.from;
    if (input.scale !== undefined) layer.scale = bounded(input.scale, 0.1, 10, `${label} scale`);
    if (input.rootMotion !== undefined) {
      if (typeof input.rootMotion !== 'boolean') throw new TypeError(`${label} rootMotion must be boolean.`);
      layer.rootMotion = input.rootMotion;
    }
  } else {
    clip = context.clips[input.clip];
    if (!Number.isInteger(input.clip) || !clip) throw new RangeError(`${label} clip must be the index of a clip in the asset (0 to ${context.clips.length - 1}).`);
    layer.clip = input.clip;
    if (input.scale !== undefined || input.rootMotion !== undefined) throw new TypeError(`${label} scale and rootMotion only apply to a layer with from.`);
  }
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
