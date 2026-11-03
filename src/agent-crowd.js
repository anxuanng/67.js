import { createCrowd } from './retarget.js';
import { bakeCrowdPalette, createCrowdParts, createCrowdRig } from './crowd-skinning.js';
import { jsonMaterial, materialOutput, registerCrowdModule } from './agent-scene-assets.js';

// Recipe crowd field: an asset placement with a `crowd` field turns one catalog character and one of its clips into
// `count` walking instances that share a few instanced batches (src/crowd-skinning.js). The result travels the
// placed-asset channel of agent-scene.js: generated geometries (type "asset"), materials (assetSource) and part nodes
// (assetPart), so exports and edits already skip them. The pose of every instance is a pure function of the scene
// time, the seed and the recipe camera, so a seek equals playing.

export const CROWD_LIMITS = Object.freeze({ maxInstances: 1000, maxCachedCrowds: 4 });
const CROWD_FIELDS = ['clip', 'count', 'seed', 'layout', 'spacing', 'columns', 'size', 'rateJitter', 'randomYaw', 'speed', 'frameRate', 'morphs', 'lods', 'farDistance', 'farRate'];

function numberWithin(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`crowd ${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

/** Validate the `crowd` field of an asset placement. Returns the canonical form kept in the recipe. */
export function normalizeCrowd(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('crowd must be an object.');
  for (const key of Object.keys(value)) {
    if (!CROWD_FIELDS.includes(key)) throw new TypeError(`Unknown crowd field: ${key}. Allowed fields: ${CROWD_FIELDS.join(', ')}.`);
  }
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > CROWD_LIMITS.maxInstances) {
    throw new RangeError(`crowd count must be an integer from 1 to ${CROWD_LIMITS.maxInstances}.`);
  }
  const layout = value.layout ?? 'grid';
  if (layout !== 'grid' && layout !== 'scatter') throw new RangeError('crowd layout must be grid or scatter.');
  const clip = value.clip ?? 0;
  if (!Number.isInteger(clip) || clip < 0) throw new RangeError('crowd clip must be a non-negative clip index.');
  const result = {
    clip,
    count: value.count,
    seed: numberWithin(value.seed ?? 1, -2147483648, 2147483647, 'seed'),
    layout,
    spacing: numberWithin(value.spacing ?? 1.5, 0.05, 1000, 'spacing'),
    rateJitter: numberWithin(value.rateJitter ?? 0.15, 0, 0.9, 'rateJitter'),
    speed: numberWithin(value.speed ?? 1, 0.05, 16, 'speed'),
    frameRate: numberWithin(value.frameRate ?? 30, 4, 60, 'frameRate'),
  };
  if (value.columns !== undefined) result.columns = Math.round(numberWithin(value.columns, 1, CROWD_LIMITS.maxInstances, 'columns'));
  if (value.size !== undefined) result.size = numberWithin(value.size, 0.1, 100_000, 'size');
  for (const flag of ['randomYaw', 'morphs', 'lods']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new TypeError(`crowd ${flag} must be boolean.`);
  }
  result.randomYaw = value.randomYaw ?? false;
  result.morphs = value.morphs ?? false;
  result.lods = value.lods ?? true;
  if ((value.farDistance === undefined) !== (value.farRate === undefined)) throw new TypeError('crowd farDistance and farRate go together.');
  if (value.farDistance !== undefined) {
    result.farDistance = numberWithin(value.farDistance, 0.1, 100_000, 'farDistance');
    result.farRate = numberWithin(value.farRate, 1, 60, 'farRate');
  }
  return result;
}

function buildCrowd(asset, assetId, settings) {
  const source = asset.animations[settings.clip];
  const rig = createCrowdRig(asset.parts, { morphs: settings.morphs });
  const poseAt = seconds => asset.stagePose({ animation: { clip: settings.clip, time: seconds }, nodeOverrides: [] }).commit();
  const palette = bakeCrowdPalette(rig, poseAt, { duration: source.duration, frameRate: settings.frameRate });
  const crowd = createCrowd({
    count: settings.count, clip: { duration: source.duration, tracks: [] }, seed: settings.seed, layout: settings.layout,
    spacing: settings.spacing, columns: settings.columns, size: settings.size, rateJitter: settings.rateJitter, randomYaw: settings.randomYaw,
  });
  const farPose = settings.farDistance ? { distance: settings.farDistance, rate: settings.farRate } : null;
  const set = createCrowdParts({ rig, palette, instances: crowd.instances, lods: settings.lods, farPose, name: assetId.slice(0, 12) });
  const materialOutputs = rig.parts.map(rigPart => materialOutput(rigPart.material, {}));
  return { asset, rig, palette, crowd, set, materialOutputs, clipName: source.name ?? `clip ${settings.clip}`, duration: source.duration };
}

/**
 * Generate the geometries, materials and part nodes of one crowd placement into a normalized recipe, in place.
 * `cache` (the scene's asset output map) keeps the baked palette and the instance list across edits, so a camera or
 * unrelated edit does not bake again and the parts of the last stage stay reusable. `asset` is the decoded copy
 * reserved for this placement, which the bake poses. Returns the nodes to add and the placement record.
 */
export function expandCrowd(recipe, node, asset, copy, cache, runtime, limits) {
  const { id: assetId, crowd: settings } = node.asset;
  if (!asset.animations[settings.clip]) {
    throw new RangeError(`Node ${node.id}: asset ${assetId.slice(0, 12)} has ${asset.animations.length} clips, so crowd clip ${settings.clip} does not exist.`);
  }
  const key = `crowd:${node.id}:${assetId}:${copy}:${JSON.stringify(settings)}`;
  if (cache.get(key)?.asset !== asset) {
    const stale = [...cache.keys()].filter(candidate => candidate.startsWith('crowd:'));
    if (stale.length >= CROWD_LIMITS.maxCachedCrowds) cache.delete(stale[0]);
    try {
      cache.set(key, buildCrowd(asset, assetId, settings));
    } catch (error) {
      error.message = `Node ${node.id} crowd: ${error.message}`;
      throw error;
    }
  }
  const built = cache.get(key);
  const rigPartCount = built.rig.parts.length;
  if (recipe.nodes.length + settings.count * rigPartCount > limits.maxNodes) {
    throw new RangeError(`Node ${node.id}: a crowd of ${settings.count} makes ${settings.count * rigPartCount} part nodes (${rigPartCount} per instance), which with the ${recipe.nodes.length} authored nodes exceeds maxNodes ${limits.maxNodes}. Lower count or raise maxNodes.`);
  }
  const prefix = `crowd:${assetId.slice(0, 12)}:${copy}`;
  const materialIds = built.rig.parts.map((rigPart, index) => {
    const id = `${prefix}:${index}`;
    runtime.materialOutputs.set(id, built.materialOutputs[index]);
    recipe.materials.push({ id, ...jsonMaterial(rigPart.material), assetSource: true });
    runtime.geometryParts.set(id, rigPart.geometry);
    recipe.geometries.push({ id, type: 'asset', assetId, copy, part: index });
    return id;
  });
  const nodes = [];
  const partNodeIds = [];
  built.set.parts.forEach((part, index) => {
    const instance = Math.floor(index / rigPartCount);
    const rigIndex = index % rigPartCount;
    const id = `${node.id}/${instance}/${rigIndex}`;
    partNodeIds.push(id);
    nodes.push({
      id, parent: node.id, label: `${built.clipName} ${instance}`,
      translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      geometry: `${prefix}:${rigIndex}`, material: materialIds[rigIndex],
      assetPart: { placement: node.id, index: instance, matrix: Array.from(part.matrix) },
    });
    runtime.partExtras.set(id, { crowd: part.crowd, assembly: part.assembly, ...(part.lods ? { lods: part.lods } : {}), ...(part.morph ? { morph: part.morph } : {}) });
  });
  const eye = recipe.camera?.eye ?? null;
  const record = {
    node: node.id, assetId, copy, asset, partNodeIds, clip: null, drive: null, drivePose: null,
    crowd: {
      /** The pose at a scene time, applied on commit: only frame offsets change, so nothing here can fail. */
      stage(time) {
        const seconds = time * settings.speed;
        return {
          commit: () => built.set.setTimes(index => built.crowd.clipTime(index, seconds), eye),
          discard() {},
        };
      },
      describe() {
        return {
          node: node.id, assetId, kind: 'crowd', instances: settings.count, parts: partNodeIds.length,
          batches: rigPartCount, clip: { index: settings.clip, name: built.clipName, duration: built.duration },
          frames: built.palette.frameCount, paletteBytes: built.palette.data.byteLength, boundsRadius: built.palette.bounds.radius,
          lods: settings.lods, morphs: built.rig.parts.filter(part => part.morph).length,
          ...(settings.farDistance ? { farPose: { distance: settings.farDistance, rate: settings.farRate } } : {}),
        };
      },
    },
  };
  return { nodes, record };
}

registerCrowdModule({ normalizeCrowd, expandCrowd });
