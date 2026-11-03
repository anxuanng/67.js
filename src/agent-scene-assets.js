import { mat4 } from 'gl-matrix';
import { normalizeDrive } from './agent-drive-schema.js';

// Placing decoded glTF assets inside a procedural recipe scene. A node with an `asset` field is a group: the scene
// turns each mesh part of the asset into a generated child node, so terrain, lights, procedural meshes and any number of
// placed assets share one graph, one set of lights and one renderer. Every placement of the same asset uses the same
// geometry and the same material objects, so the renderer draws the copies as one instanced batch per material.
// A placement with a `clip` gets its own decoded copy (an "instance" above 0), because a pose is state of one decoded asset.

export const ASSET_PLACEMENT_LIMITS = Object.freeze({ maxPlacements: 512, maxAssets: 16, maxAnimatedPlacements: 16, maxOverrides: 32 });

const ASSET_ID = /^[a-f0-9]{64}$/;
const PLACEMENT_FIELDS = ['id', 'materials', 'clip', 'drive'];
const CLIP_FIELDS = ['index', 'start', 'speed', 'loop'];
const COLOR_FIELDS = ['color', 'emissiveColor'];
const UNIT_FIELDS = ['metallic', 'roughness', 'opacity'];
const OVERRIDE_FIELDS = ['name', 'tag', ...COLOR_FIELDS, ...UNIT_FIELDS, 'emission'];
// A tag an override may set: foliage and grass make an imported tree sway in the wind and shade like a grown one.
const OVERRIDE_TAGS = ['surface', 'foliage', 'grass'];

function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`Unknown ${label} field: ${key}. Allowed fields: ${allowed.join(', ')}.`);
    }
  }
}

function colorVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => !Number.isFinite(component) || component < 0)) {
    throw new RangeError(`${label} must be three finite non-negative linear RGB numbers.`);
  }
  return [...value];
}

function normalizeMaterialOverride(override) {
  knownKeys(override, OVERRIDE_FIELDS, 'asset material override');
  if (typeof override.name !== 'string' || !override.name || override.name.length > 256) {
    throw new TypeError('An asset material override needs the source material name. scene_inspect lists the names under assets.');
  }
  const result = { name: override.name };
  if (override.tag !== undefined) {
    if (!OVERRIDE_TAGS.includes(override.tag)) throw new RangeError(`asset material override tag must be one of ${OVERRIDE_TAGS.join(', ')}.`);
    result.tag = override.tag;
  }
  for (const field of COLOR_FIELDS) {
    if (override[field] !== undefined) result[field] = colorVector(override[field], field);
  }
  for (const field of UNIT_FIELDS) {
    if (override[field] !== undefined) {
      if (!Number.isFinite(override[field]) || override[field] < 0 || override[field] > 1) {
        throw new RangeError(`${field} must be a number from 0 to 1.`);
      }
      result[field] = override[field];
    }
  }
  if (override.emission !== undefined) {
    if (!Number.isFinite(override.emission) || override.emission < 0) {
      throw new RangeError('emission must be a finite non-negative number.');
    }
    result.emission = override.emission;
  }
  return result;
}

/** Validate the `asset` field of a node. Returns the canonical form kept in the recipe. */
export function normalizeAssetPlacement(value) {
  knownKeys(value, PLACEMENT_FIELDS, 'asset placement');
  if (typeof value.id !== 'string' || !ASSET_ID.test(value.id.toLowerCase())) {
    throw new TypeError('asset id must be the 64 hexadecimal characters of a catalog asset id; asset_catalog lists them.');
  }
  const result = { id: value.id.toLowerCase() };
  if (value.materials !== undefined) {
    if (!Array.isArray(value.materials) || value.materials.length > ASSET_PLACEMENT_LIMITS.maxOverrides) {
      throw new RangeError(`asset materials must list at most ${ASSET_PLACEMENT_LIMITS.maxOverrides} overrides.`);
    }
    const overrides = value.materials.map(normalizeMaterialOverride);
    if (new Set(overrides.map(override => override.name)).size !== overrides.length) {
      throw new RangeError('asset material overrides must name distinct source materials.');
    }
    result.materials = overrides;
  }
  if (value.clip !== undefined) {
    knownKeys(value.clip, CLIP_FIELDS, 'asset clip');
    const { index, start = 0, speed = 1, loop = true } = value.clip;
    if (!Number.isInteger(index) || index < 0) throw new RangeError('asset clip index must be a non-negative integer.');
    if (!Number.isFinite(start) || start < 0 || start > 3600) throw new RangeError('asset clip start must be seconds from 0 to 3600.');
    if (!Number.isFinite(speed) || speed <= 0 || speed > 16) throw new RangeError('asset clip speed must be above 0 and at most 16.');
    if (typeof loop !== 'boolean') throw new TypeError('asset clip loop must be boolean.');
    result.clip = { index, start, speed, loop };
  }
  if (value.drive !== undefined) {
    if (value.clip !== undefined) throw new TypeError('An asset placement plays a clip or drives along a path, not both.');
    result.drive = normalizeDrive(value.drive);
    if (result.drive.lights?.tailLights) {
      throw new RangeError('Placed assets share their materials, so tail lights glow only in an asset recipe (motion.drive). Headlight and brake signals are still reported by scene_inspect.');
    }
  }
  return result;
}

function collectPlacements(value, found, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPlacements(item, found, depth + 1);
    return;
  }
  const placement = value.asset;
  if (placement && typeof placement === 'object' && typeof placement.id === 'string' && ASSET_ID.test(placement.id.toLowerCase())) {
    found.push(placement);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'asset') collectPlacements(child, found, depth + 1);
  }
}

/**
 * The catalog assets a recipe (or a list of edit operations) places: `{ id, copies }` where `copies` is how many decoded
 * copies the host should load. Copy 0 serves every unanimated placement; each placement with a clip takes its own copy.
 */
export function recipeAssetNeeds(value) {
  const placements = [];
  collectPlacements(value, placements);
  const needs = new Map();
  for (const placement of placements) {
    const id = placement.id.toLowerCase();
    const need = needs.get(id) ?? { id, copies: 1 };
    if (placement.clip || placement.drive) need.copies++;
    needs.set(id, need);
  }
  return [...needs.values()];
}

export function assetCopyKey(id, copy) {
  return `${id}:${copy}`;
}

function jsonMaterial(source) {
  const result = {};
  for (const [field, value] of Object.entries(source)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      result[field] = value;
    } else if (Array.isArray(value) && value.every(entry => typeof entry === 'number')) {
      result[field] = [...value];
    }
  }
  return result;
}

function overrideFields(override) {
  const fields = {};
  if (override?.tag !== undefined) fields.tag = override.tag;
  for (const field of [...COLOR_FIELDS, ...UNIT_FIELDS, 'emission']) {
    if (override?.[field] !== undefined) fields[field] = override[field];
  }
  return fields;
}

function materialOutput(source, fields) {
  const output = { ...source };
  for (const [field, value] of Object.entries(fields)) {
    output[field] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  if (fields.emission !== undefined && fields.emission > 0 && !output.emissiveColor?.some(component => component > 0)) {
    output.emissiveColor = Object.freeze([1, 1, 1]);
  }
  return Object.freeze(output);
}

/**
 * Generate the geometries, materials and child nodes of every placement into a normalized recipe, in place.
 * `assets` maps assetCopyKey(id, copy) to a decoded parseGltf asset; `createAssetDrive` is the loaded drive module's builder. Returns what the scene keeps outside the recipe JSON.
 */
export function expandAssetPlacements(recipe, assets, limits, outputCache = new Map(), createAssetDrive = null) {
  const placed = recipe.nodes.filter(node => node.asset);
  const runtime = { placements: [], geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map(), animators: [] };
  if (!placed.length) return runtime;
  if (!assets) {
    throw new Error('This recipe places catalog assets, which a host loads and decodes first. Pass them as the assets option of createAgentScene; MCP does this for scene_create.');
  }
  const distinct = new Set(placed.map(node => node.asset.id));
  const animated = placed.filter(node => node.asset.clip || node.asset.drive);
  if (placed.length > ASSET_PLACEMENT_LIMITS.maxPlacements || distinct.size > ASSET_PLACEMENT_LIMITS.maxAssets ||
      animated.length > ASSET_PLACEMENT_LIMITS.maxAnimatedPlacements) {
    throw new RangeError(`A scene places at most ${ASSET_PLACEMENT_LIMITS.maxPlacements} assets, ${ASSET_PLACEMENT_LIMITS.maxAssets} different ones, ${ASSET_PLACEMENT_LIMITS.maxAnimatedPlacements} of them playing a clip; this recipe places ${placed.length}, ${distinct.size} and ${animated.length}.`);
  }
  const copyCounter = new Map();
  const geometryIds = new Set();
  const materialIds = new Map();
  const generatedNodes = [];
  for (const node of placed) {
    const { id: assetId, materials: overrides = [], clip, drive } = node.asset;
    let copy = 0;
    if (clip || drive) {
      copy = (copyCounter.get(assetId) ?? 0) + 1;
      copyCounter.set(assetId, copy);
    }
    const asset = assets.get(assetCopyKey(assetId, copy));
    if (!asset) {
      throw new Error(`Asset ${assetId.slice(0, 12)} copy ${copy} is not loaded. The host loads it before createAgentScene or apply.`);
    }
    if (clip && !asset.animations[clip.index]) {
      throw new RangeError(`Node ${node.id}: asset ${assetId.slice(0, 12)} has ${asset.animations.length} clips, so clip index ${clip.index} does not exist. scene_inspect lists them under assets.`);
    }
    const materialNames = new Set(asset.parts.map(part => part.material.name).filter(Boolean));
    for (const override of overrides) {
      if (!materialNames.has(override.name)) {
        throw new RangeError(`Node ${node.id}: asset has no material named ${JSON.stringify(override.name)}. Names: ${[...materialNames].slice(0, 16).map(name => JSON.stringify(name)).join(', ') || 'none, the asset materials are unnamed'}.`);
      }
    }
    const overrideByName = new Map(overrides.map(override => [override.name, override]));
    const materialIndexes = new Map();
    const partNodeIds = [];
    asset.parts.forEach((part, index) => {
      const geometryId = `asset:${assetId.slice(0, 12)}:${copy}:${index}`;
      if (!geometryIds.has(geometryId)) {
        geometryIds.add(geometryId);
        recipe.geometries.push({ id: geometryId, type: 'asset', assetId, copy, part: index });
        runtime.geometryParts.set(geometryId, part.geometry);
      }
      if (!materialIndexes.has(part.material)) materialIndexes.set(part.material, materialIndexes.size);
      const fields = overrideFields(overrideByName.get(part.material.name));
      const materialKey = `asset:${assetId.slice(0, 12)}:${copy}:${materialIndexes.get(part.material)}:${JSON.stringify(fields)}`;
      if (!materialIds.has(materialKey)) {
        materialIds.set(materialKey, materialKey);
        recipe.materials.push({ id: materialKey, ...jsonMaterial(part.material), ...fields, assetSource: true });
        // The same output object across stages keeps the renderer's batches and the parts' identity stable.
        if (outputCache.get(materialKey)?.source !== part.material) {
          outputCache.set(materialKey, { source: part.material, output: materialOutput(part.material, fields) });
        }
        runtime.materialOutputs.set(materialKey, outputCache.get(materialKey).output);
      }
      const partNodeId = `${node.id}/${index}`;
      partNodeIds.push(partNodeId);
      generatedNodes.push({
        id: partNodeId, parent: node.id, label: String(part.name ?? partNodeId).slice(0, 256),
        translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        geometry: geometryId, material: materialKey, assetPart: { placement: node.id, index, matrix: Array.from(part.matrix) },
      });
      runtime.partExtras.set(partNodeId, {
        ...(part.skin ? { skin: part.skin } : {}), ...(part.morph ? { morph: part.morph } : {}),
        ...(part.castShadow !== undefined ? { castShadow: part.castShadow } : {}),
      });
    });
    const record = { node: node.id, assetId, copy, asset, partNodeIds, clip: clip ?? null, drive: drive ? createDrive(node.id, createAssetDrive, asset, drive) : null, drivePose: null };
    runtime.placements.push(record);
    if (clip || drive) runtime.animators.push(record);
  }
  if (recipe.nodes.length + generatedNodes.length > limits.maxNodes) {
    throw new RangeError(`Placed assets expand to ${generatedNodes.length} part nodes, which with the ${recipe.nodes.length} authored nodes exceeds maxNodes ${limits.maxNodes}. Place fewer copies or simpler assets.`);
  }
  recipe.nodes.push(...generatedNodes);
  return runtime;
}

function createDrive(nodeId, createAssetDrive, asset, drive) {
  if (!createAssetDrive) throw new Error('This recipe drives a placed asset, which needs the drive code: await loadAgentSceneModules(recipe) before createAgentScene or apply.');
  try {
    return createAssetDrive(asset, drive);
  } catch (error) {
    error.message = `Node ${nodeId} drive: ${error.message}`;
    throw error;
  }
}

/** The time inside a clip for a scene time: held at the first frame before `start`, then looped or held at the end. */
export function clipTimeAt(clip, duration, time) {
  const elapsed = Math.max(0, ((time ?? 0) - clip.start) * clip.speed);
  if (duration <= 0) return 0;
  return clip.loop ? elapsed % duration : Math.min(elapsed, duration);
}

/**
 * Pose every animated placement at a scene time. Returns the world matrix of each part node and a commit/discard pair;
 * the pose is staged first so a failure leaves every asset where it was.
 */
export function stageAssetClips(runtime, graph, time) {
  const transactions = [];
  const matrices = new Map();
  try {
    for (const record of runtime.animators) {
      let transaction;
      if (record.drive) {
        const driven = record.drive.sample(time ?? 0);
        record.drivePose = driven.pose;
        transaction = record.asset.stagePose({ nodeOverrides: driven.nodeOverrides });
      } else {
        const duration = record.asset.animations[record.clip.index].duration;
        transaction = record.asset.stagePose({ animation: { clip: record.clip.index, time: clipTimeAt(record.clip, duration, time) }, nodeOverrides: [] });
      }
      transactions.push(transaction);
      const placement = graph.getNode(record.node).worldMatrix;
      record.partNodeIds.forEach((id, index) => {
        matrices.set(id, mat4.multiply(new Float32Array(16), placement, transaction.parts[index].matrix));
      });
    }
  } catch (error) {
    for (const transaction of transactions) transaction.discard();
    throw error;
  }
  return {
    matrices,
    commit() {
      for (const transaction of transactions) transaction.commit();
    },
  };
}

/** What scene_inspect reports for each placement: the asset id, its world bounds, its clips and material names. */
export function describeAssetPlacements(runtime, graph, geometryBounds) {
  return runtime.placements.map(record => {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (const id of record.partNodeIds) {
      const node = graph.getNode(id);
      const bounds = geometryBounds(node.geometry);
      for (let corner = 0; corner < 8; corner++) {
        const point = [0, 1, 2].map(axis => (corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis]));
        for (let axis = 0; axis < 3; axis++) {
          const value = node.worldMatrix[axis] * point[0] + node.worldMatrix[4 + axis] * point[1] + node.worldMatrix[8 + axis] * point[2] + node.worldMatrix[12 + axis];
          minimum[axis] = Math.min(minimum[axis], value);
          maximum[axis] = Math.max(maximum[axis], value);
        }
      }
    }
    return {
      node: record.node, assetId: record.assetId, parts: record.partNodeIds.length,
      bounds: { min: minimum, max: maximum },
      clips: record.asset.animations.map((animation, index) => ({ index, name: animation.name ?? `clip ${index}`, duration: animation.duration })),
      materials: [...new Set(record.asset.parts.map(part => part.material.name).filter(Boolean))],
      ...(record.clip ? { playing: record.clip } : {}),
      ...(record.drive ? { drive: record.drive.describe(record.drivePose ?? undefined) } : {}),
    };
  });
}
