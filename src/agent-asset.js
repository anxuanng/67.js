import { mat4, mat3 } from 'gl-matrix';
import { createAgentScene } from './agent-scene.js';
import { environmentPatchWithSetup } from './agent-look.js';
import { assetDiagnostics } from './agent-diagnostics.js';
import { fitPerspectiveDistance } from './camera.js';
import { validateSkinGeometry, validateSkinPose } from './skinning.js';
import { validateMorphGeometry, validateMorphTransform } from './morph.js';
import * as agentMotion from './agent-motion.js';
import { clipLayerContextFromAsset } from './agent-clip-layers.js';
import { clipFromGltfAnimation, createAssetLayerEvaluator, morphClipFromGltfAnimation } from './skeleton-pose.js';
import { registerAgentSceneModule } from './agent-scene-modules.js';

registerAgentSceneModule('motion', agentMotion);

const MAX_RECIPE_BYTES = 1024 * 1024;
const MAX_CHECKPOINTS = 8;
const MAX_OPERATIONS = 256;
const MAX_INSPECTION_VERTICES = 2_000_000;
const ROOT_FIELDS = ['translation', 'rotation', 'scale'];
const MATERIAL_FIELDS = ['color', 'metallic', 'roughness', 'emission', 'emissiveColor'];
const LOOK_FIELDS = ['environment', 'effects', 'shadow'];
const LOOK_OPERATIONS = Object.freeze({
  'set-environment': 'environment',
  'set-effects': 'effects',
  'set-shadow': 'shadow',
});

export const AGENT_ASSET_CAPABILITIES = Object.freeze({
  format: '67js.asset', schemaVersion: 1, fixedTopology: true,
  operations: Object.freeze([
    'set-camera', 'set-environment', 'set-effects', 'set-shadow',
    'set-root', 'set-animation', 'set-material', 'set-asset-node', 'set-motion',
  ]),
  boundsKind: 'authored-base-world',
});

function knownKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw new TypeError(`Unknown ${label} field: ${key}. Allowed fields: ${fields.join(", ")}.`);
    }
  }
}

function copiedJson(input) {
  let bytes = 0;
  const ancestors = new Set();
  const encoder = new TextEncoder();
  function charge(count) {
    bytes += count;
    if (bytes > MAX_RECIPE_BYTES) {
      throw new RangeError('Asset recipe JSON exceeds 1 MiB. Reduce the input.');
    }
  }
  function copy(value, depth) {
    if (depth > 64) {
      throw new RangeError('Asset recipe JSON nesting exceeds 64 levels.');
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : String(value).length);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_RECIPE_BYTES) {
        throw new RangeError('Asset recipe JSON exceeds 1 MiB.');
      }
      charge(encoder.encode(JSON.stringify(value)).length);
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError('Asset recipe requires finite, acyclic JSON data.');
    }
    const array = Array.isArray(value);
    if (array && (value.length > MAX_RECIPE_BYTES || Object.getPrototypeOf(value) !== Array.prototype)) {
      throw new TypeError('Asset recipe arrays must be ordinary bounded JSON arrays.');
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Asset recipe objects must be plain JSON objects.');
    }
    ancestors.add(value);
    charge(2);
    const result = array ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') {
        continue;
      }
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('Invalid asset recipe JSON key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Asset recipe accessors and hidden fields are unsupported.');
      }
      if (array && key !== String(result.length)) {
        throw new TypeError('Asset recipe arrays must be dense without extra fields.');
      }
      charge(array ? 1 : encoder.encode(JSON.stringify(key)).length + 2);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) {
      throw new TypeError('Asset recipe arrays cannot contain trailing holes.');
    }
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > MAX_RECIPE_BYTES) {
    throw new RangeError('Asset recipe JSON exceeds 1 MiB.');
  }
  return result;
}

function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length ||
      !value.every(component => typeof component === 'number' && Number.isFinite(Math.fround(component)))) {
    throw new TypeError(`${label} requires ${length} finite Float32 numbers.`);
  }
  return [...value];
}

function rootFrom(input = {}) {
  knownKeys(input, ROOT_FIELDS, 'root');
  const root = {
    translation: vector(input.translation === undefined ? [0, 0, 0] : input.translation, 3, 'root translation'),
    rotation: vector(input.rotation === undefined ? [0, 0, 0, 1] : input.rotation, 4, 'root rotation'),
    scale: vector(input.scale === undefined ? [1, 1, 1] : input.scale, 3, 'root scale'),
  };
  const rotationLength = Math.hypot(...root.rotation);
  if (rotationLength === 0 || root.scale.some(component => Math.fround(component) <= 0)) {
    throw new RangeError('Root needs a nonzero quaternion and positive Float32 scales.');
  }
  root.rotation = root.rotation.map(component => component / rotationLength);
  return root;
}

function viewRecipe(input, materials = []) {
  const recipe = { format: '67js.scene', schemaVersion: 1, geometries: [], materials, nodes: [] };
  for (const field of ['camera', ...LOOK_FIELDS]) {
    if (Object.hasOwn(input, field)) {
      recipe[field] = input[field];
    }
  }
  return createAgentScene(recipe, { maxMaterials: Math.max(256, materials.length) }).exportRecipe();
}

function geometryMaxima(geometry) {
  const maximum = [0, 0, 0];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      maximum[axis] = Math.max(maximum[axis], Math.abs(geometry.positions[offset + axis]));
    }
  }
  return maximum;
}

function localBounds(geometry) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], geometry.positions[offset + axis]);
      maximum[axis] = Math.max(maximum[axis], geometry.positions[offset + axis]);
    }
  }
  return { min: minimum, max: maximum };
}

function framingBounds(records, matrices) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < records.length; index++) {
    const bounds = records[index].geometry.bounds;
    const matrix = matrices[index];
    for (let corner = 0; corner < 8; corner++) {
      const point = bounds.min.map((component, axis) => corner & (1 << axis) ? bounds.max[axis] : component);
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * point[0] + matrix[axis + 4] * point[1] +
          matrix[axis + 8] * point[2] + matrix[axis + 12];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { min: minimum, max: maximum };
}

function validatePositionBounds(maxima, world, skin) {
  for (let row = 0; row < 4; row++) {
    let coordinateBound = 0;
    for (let column = 0; column < 4; column++) {
      let coefficient = Math.abs(world[column * 4 + row]);
      if (skin) {
        coefficient = 0;
        for (let axis = 0; axis < 4; axis++) {
          let paletteBound = 0;
          for (let offset = column * 4 + axis; offset < skin.jointMatrices.length; offset += 16) {
            paletteBound = Math.max(paletteBound, Math.abs(skin.jointMatrices[offset]));
          }
          coefficient += Math.abs(world[axis * 4 + row]) * paletteBound * (1 + 2 ** -21);
          if (!Number.isFinite(Math.fround(coefficient))) {
            throw new RangeError('Asset world/skin matrix products exceed Float32 range.');
          }
        }
      }
      coordinateBound += coefficient * (column === 3 ? 1 : maxima[column]);
      if (!Number.isFinite(Math.fround(coordinateBound))) {
        throw new RangeError('Asset world geometry bounds exceed Float32 range.');
      }
    }
  }
}

function baseBounds(records, matrices) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < records.length; index++) {
    const positions = records[index].source.geometry.positions;
    const matrix = matrices[index];
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] +
          matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { min: minimum, max: maximum };
}

function framedCamera(bounds) {
  const target = bounds.min.map((component, axis) => (component + bounds.max[axis]) / 2);
  const radius = Math.hypot(...bounds.max.map((component, axis) => (component - bounds.min[axis]) / 2));
  const near = Math.max(0.001, radius * 0.001);
  const far = Math.max(10, radius * 10);
  const probeDistance = Math.max(1, radius);
  const directionLength = Math.hypot(4, 3, 5);
  const direction = [4, 3, 5].map(component => component / directionLength);
  const camera = {
    target, eye: target.map((component, axis) => component + direction[axis] * probeDistance),
    up: [0, 1, 0], fov: 45, near, far,
  };
  const distance = fitPerspectiveDistance({ minimum: bounds.min, maximum: bounds.max }, camera, 1, 1.2);
  camera.eye = target.map((component, axis) => component + direction[axis] * distance);
  return camera;
}

/** Own authoring state around one exclusively owned, decoded parseGltf asset. */
export function createAgentAssetScene(asset, inputRecipe) {
  if (!asset || !Array.isArray(asset.parts) || !asset.parts.length || !Array.isArray(asset.animations) ||
      typeof asset.stagePose !== 'function' || !Array.isArray(asset.nodes)) {
    throw new TypeError('createAgentAssetScene requires a decoded parseGltf asset.');
  }
  if (asset.parts.length > 4096 || asset.animations.length > 256 ||
      new Set(asset.parts.map(part => part.material)).size > 4096) {
    throw new RangeError('Asset budgets allow 4096 parts, 4096 materials, and 256 animation clips.');
  }
  const sourceParts = [...asset.parts];
  const materials = new Map();
  const geometries = new Map();
  const morphMetadata = new Map();
  const records = sourceParts.map((source, index) => {
    if (!materials.has(source.material)) {
      const id = `material-${materials.size}`;
      const baseline = {};
      for (const field of MATERIAL_FIELDS) {
        const value = source.material[field];
        if (value !== undefined) {
          baseline[field] = Array.isArray(value) ? [...value] : value;
        }
      }
      materials.set(source.material, { id, baseline });
    }
    if (!geometries.has(source.geometry)) {
      const metadata = validateMorphGeometry(source.geometry, source.morph);
      if (metadata) {
        morphMetadata.set(source.geometry, metadata);
      }
      geometries.set(source.geometry, {
        id: `geometry-${geometries.size}`, maxima: geometryMaxima(source.geometry), bounds: localBounds(source.geometry),
      });
    }
    validateSkinGeometry(source.geometry, source.skin);
    return {
      id: `mesh-${index}`, label: String(source.name ?? `Mesh ${index}`).slice(0, 256), source,
      geometry: geometries.get(source.geometry), material: materials.get(source.material),
      sourceMatrix: source.matrix, jointMatrices: source.skin?.jointMatrices,
      jointWorldMatrices: source.skin?.jointWorldMatrices, morphWeights: source.morph?.weights,
    };
  });
  const materialRecords = new Map([...materials.values()].map(record => [record.id, record]));
  const sourceNodes = new Map(asset.nodes.map(node => [node.id, structuredClone(node)]));
  const clipLayerContext = clipLayerContextFromAsset(asset.animations, [...sourceNodes.values()]);
  const initialRecipe = copiedJson(inputRecipe);
  const assetId = initialRecipe?.assetId;
  if (typeof assetId !== 'string' || !/^[a-f0-9]{64}$/i.test(assetId)) {
    throw new TypeError('assetId must contain 64 SHA256 hexadecimal characters.');
  }
  const canonicalAssetId = assetId.toLowerCase();
  const cameraOmitted = !Object.hasOwn(initialRecipe, 'camera');
  let recipe;
  let materialSnapshots = new Map();
  let matrices = [];
  let revision = 0;
  let sampler = null;
  let layerEvaluator = null;
  let motionTime = null;
  let sampledCamera;
  const checkpoints = new Map();
  const materialOutputs = new Map([...materials].map(([source, record]) => {
    const output = {};
    for (const [field, value] of Object.entries(source)) {
      if (!MATERIAL_FIELDS.includes(field)) {
        output[field] = Array.isArray(value) ? Object.freeze([...value]) : value;
      }
    }
    for (const field of MATERIAL_FIELDS) {
      Object.defineProperty(output, field, {
        enumerable: true,
        get() {
          return materialSnapshots.get(record.id)[field];
        },
      });
    }
    return [record.id, Object.freeze(output)];
  }));
  const parts = Object.freeze(records.map(record => {
    const part = {
      name: record.id, geometry: record.source.geometry,
      matrix: new Float32Array(record.source.matrix), material: materialOutputs.get(record.material.id),
    };
    if (record.source.skin) {
      part.skin = record.source.skin;
    }
    if (record.source.morph) {
      part.morph = record.source.morph;
    }
    if (record.source.castShadow !== undefined) {
      part.castShadow = record.source.castShadow;
    }
    return Object.freeze(part);
  }));
  const capabilities = Object.freeze({
    ...AGENT_ASSET_CAPABILITIES,
    animations: asset.animations.length,
    skinning: parts.some(part => Boolean(part.skin)),
    morphTargets: parts.some(part => Boolean(part.morph)),
    textures: [...materialOutputs.values()].some(material => Boolean(material.map || material.normalMap ||
      material.metallicRoughnessMap || material.occlusionMap || material.emissiveMap)),
  });

  function normalize(input) {
    const candidate = copiedJson(input);
    knownKeys(candidate, ['format', 'schemaVersion', 'assetId', 'camera', ...LOOK_FIELDS, 'root', 'animation', 'materialOverrides', 'nodeOverrides', 'motion'], 'asset recipe');
    if (candidate.format !== '67js.asset' || candidate.schemaVersion !== 1 ||
        typeof candidate.assetId !== 'string' || candidate.assetId.toLowerCase() !== canonicalAssetId) {
      throw new RangeError('Expected the bound 67js.asset schemaVersion 1 assetId.');
    }
    const overrides = candidate.materialOverrides === undefined ? [] : candidate.materialOverrides;
    if (!Array.isArray(overrides) || overrides.length > materialRecords.size) {
      throw new RangeError('materialOverrides must be an array within the decoded material count.');
    }
    const seen = new Set();
    const definitions = overrides.map(override => {
      knownKeys(override, ['id', ...MATERIAL_FIELDS], 'material override');
      const original = materialRecords.get(override.id);
      if (!original || seen.has(override.id)) {
        throw new RangeError('Material override IDs must exist and be distinct.');
      }
      seen.add(override.id);
      return { id: override.id, ...original.baseline, ...override };
    });
    const view = viewRecipe(candidate, definitions);
    const normalizedOverrides = view.materials.map(material => {
      const result = { id: material.id };
      for (const field of MATERIAL_FIELDS) {
        if (material[field] !== undefined) {
          result[field] = material[field];
        }
      }
      return result;
    });
    const animation = candidate.animation === undefined ? null : candidate.animation;
    if (animation !== null) {
      knownKeys(animation, ['clip', 'time'], 'animation');
      const clip = asset.animations[animation.clip];
      if (!Number.isInteger(animation.clip) || !clip || !Number.isFinite(animation.time) ||
          animation.time < 0 || animation.time > clip.duration) {
        throw new RangeError('Animation needs an existing clip and time within its duration.');
      }
    }
    const nodeOverrides = candidate.nodeOverrides === undefined ? [] : candidate.nodeOverrides;
    if (!Array.isArray(nodeOverrides) || nodeOverrides.length > sourceNodes.size) {
      throw new RangeError('nodeOverrides must fit the decoded source-node count.');
    }
    const seenNodes = new Set();
    const normalizedNodes = nodeOverrides.map(override => {
      knownKeys(override, ['id', ...ROOT_FIELDS], 'node override');
      const node = sourceNodes.get(override.id);
      if (!node || seenNodes.has(override.id) || !node.editable) {
        throw new RangeError('Node override IDs must exist, be editable and be distinct.');
      }
      seenNodes.add(override.id);
      const fields = Object.keys(override).filter(field => field !== 'id');
      if (!fields.length) {
        throw new RangeError('Node overrides need at least one local transform component.');
      }
      const transform = rootFrom(Object.fromEntries(fields.map(field => [field, override[field]])));
      return { id: override.id, ...Object.fromEntries(fields.map(field => [field, transform[field]])) };
    });
    const result = copiedJson({
      format: '67js.asset', schemaVersion: 1, assetId: canonicalAssetId,
      camera: view.camera, environment: view.environment, effects: view.effects, shadow: view.shadow,
      root: rootFrom(candidate.root), animation, materialOverrides: normalizedOverrides, nodeOverrides: normalizedNodes,
    });
    if (candidate.motion?.ik?.length && Math.max(...result.root.scale) - Math.min(...result.root.scale) > 1e-3 * Math.max(...result.root.scale)) {
      throw new RangeError('Motion ik needs a uniform asset root scale.');
    }
    result.motion = agentMotion.normalizeAgentMotion(candidate.motion, motionRecipe(result));
    return copiedJson(result);
  }

  function motionRecipe(candidate) {
    const baselines = new Map([...materialRecords].map(([id, record]) => [id, { id, ...record.baseline }]));
    for (const override of candidate.materialOverrides) {
      baselines.set(override.id, { ...baselines.get(override.id), ...override });
    }
    const root = candidate.root;
    return {
      nodes: [...sourceNodes.values()].filter(node => node.editable),
      materials: [...baselines.values()], camera: candidate.camera,
      ikHierarchy: [...sourceNodes.values()], clipLayerContext,
      ikRootMatrix: Array.from(mat4.fromRotationTranslationScale(mat4.create(), root.rotation, root.translation, [root.scale[0], root.scale[0], root.scale[0]])),
    };
  }

  /** Stage clip and overrides without publishing them, and read the local pose IK must start from. */
  function stagedNodePoses(animation, overrides) {
    const probe = asset.stagePose({ animation, nodeOverrides: overrides });
    try {
      return probe.nodePoses();
    } finally {
      probe.discard();
    }
  }

  /** Layers of the motion as definitions for the pose code: decoded clips, renamed by `bones`, with their morph tracks. */
  function layerDefinitions(layers) {
    return layers.map(layer => {
      const animation = asset.animations[layer.clip];
      const loop = layer.loop !== false;
      return {
        clip: clipFromGltfAnimation(animation, { loop, rename: layer.bones }),
        ...(layer.morph === false ? {} : { morphs: morphClipFromGltfAnimation(animation, { loop }) }),
        weight: layer.weight, speed: layer.speed, offset: layer.offset, additive: layer.additive, reference: layer.reference, mask: layer.mask,
      };
    });
  }

  /** Evaluates the motion's clip layers at a time, or null when it has none. Stateless, so a seek equals playing. */
  function compileLayers(motion) {
    return motion?.layers?.length ? createAssetLayerEvaluator(asset, layerDefinitions(motion.layers)) : null;
  }

  /** Where tracks, layers and the recipe's own overrides meet: the recipe's overrides, then layers, then tracks on top. */
  function poseOverrides(baseOverrides, layerEvaluator, sampled, time) {
    const layered = layerEvaluator?.evaluate(time);
    const withLayers = new Map(baseOverrides.map(override => [override.id, override]));
    for (const override of layered?.nodeOverrides ?? []) {
      withLayers.set(override.id, { ...withLayers.get(override.id), ...override });
    }
    return { nodeOverrides: trackOverrides([...withLayers.values()], sampled), morphWeights: layered?.morphWeights ?? [] };
  }

  function trackOverrides(baseOverrides, sampled) {
    const nodeOverrides = new Map(baseOverrides.map(override => [override.id, override]));
    for (const [id, patch] of sampled?.nodes ?? []) {
      const copiedPatch = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, Array.from(value)]));
      nodeOverrides.set(id, { ...nodeOverrides.get(id), id, ...copiedPatch });
    }
    return nodeOverrides;
  }

  function publish(input, autoFrame = false, increment = true, transientTime = undefined, transientAnimation = undefined) {
    let candidate = transientTime === undefined ? normalize(input) : recipe;
    if (transientAnimation !== undefined) {
      candidate = { ...candidate, animation: transientAnimation };
    }
    let stagedSampler = transientTime === undefined ? agentMotion.compileAgentMotion(candidate.motion, motionRecipe(candidate)) : sampler;
    const stagedLayers = transientTime === undefined ? compileLayers(candidate.motion) : layerEvaluator;
    const targetTime = transientTime === undefined ? (candidate.motion ? 0 : null) : transientTime;
    if (targetTime !== null && !stagedSampler) {
      throw new RangeError('The asset has no authored motion to sample.');
    }
    let sampled = targetTime === null ? null : stagedSampler.sample(targetTime);
    if (asset.parts.length !== records.length) {
      throw new RangeError('Decoded part membership must remain fixed.');
    }
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const source = record.source;
      if (asset.parts[index] !== source || source.geometry !== parts[index].geometry ||
          source.skin !== parts[index].skin || source.morph !== parts[index].morph ||
          source.matrix !== record.sourceMatrix || source.skin?.jointMatrices !== record.jointMatrices ||
          source.skin?.jointWorldMatrices !== record.jointWorldMatrices || source.morph?.weights !== record.morphWeights ||
          parts[index].matrix.length !== 16 || parts[index].matrix.byteLength !== 64) {
        throw new RangeError('Decoded resources and retained adapter matrices must not change identity or detach.');
      }
    }
    const { nodeOverrides, morphWeights } = poseOverrides(candidate.nodeOverrides, targetTime === null ? null : stagedLayers, sampled, targetTime);
    if (targetTime !== null && stagedSampler?.ikUsesStagedPose) {
      const nodePoses = stagedNodePoses(candidate.animation, [...nodeOverrides.values()]);
      for (const override of stagedSampler.solveStagedPose(targetTime, nodePoses)) {
        nodeOverrides.set(override.id, { ...nodeOverrides.get(override.id), ...override });
      }
    }
    let transaction;
    try {
      transaction = asset.stagePose({ animation: candidate.animation, nodeOverrides: [...nodeOverrides.values()], morphWeights });
      const rootMatrix = mat4.fromRotationTranslationScale(mat4.create(), candidate.root.rotation, candidate.root.translation, candidate.root.scale);
      const normal = mat3.create();
      const stagedMatrices = records.map((record, index) => {
        const posed = transaction.parts[index];
        const world = mat4.multiply(mat4.create(), rootMatrix, posed.matrix);
        const determinant = mat4.determinant(world);
        if (!world.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0 ||
            !mat3.normalFromMat4(normal, world) || !normal.every(Number.isFinite)) {
          throw new RangeError('Asset root/world matrices must remain finite and nonsingular at Float32 precision.');
        }
        if (posed.skin) {
          validateSkinPose(posed.skin, record.source.geometry, world);
        }
        if (posed.morph) {
          validateMorphTransform(posed.morph, morphMetadata.get(record.source.geometry), world, posed.skin);
        } else {
          validatePositionBounds(record.geometry.maxima, world, posed.skin);
        }
        return world;
      });
      if (autoFrame) {
        candidate.camera = framedCamera(framingBounds(records, stagedMatrices));
        candidate = normalize(candidate);
        stagedSampler = agentMotion.compileAgentMotion(candidate.motion, motionRecipe(candidate));
        sampled = targetTime === null ? null : stagedSampler.sample(targetTime);
      }
      const stagedMaterials = new Map([...materialRecords].map(([id, record]) => [id, { ...record.baseline }]));
      for (const override of candidate.materialOverrides) {
        stagedMaterials.set(override.id, { ...stagedMaterials.get(override.id), ...override });
      }
      for (const [id, patch] of sampled?.materials ?? []) {
        const copiedPatch = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, typeof value === 'number' ? value : Array.from(value)]));
        stagedMaterials.set(id, { ...stagedMaterials.get(id), ...copiedPatch });
      }
      for (const snapshot of stagedMaterials.values()) {
        for (const field of ['color', 'emissiveColor']) {
          if (snapshot[field]) {
            Object.freeze(snapshot[field]);
          }
        }
        Object.freeze(snapshot);
      }
      const stagedCamera = sampled?.camera ? {
        ...candidate.camera,
        ...Object.fromEntries(Object.entries(sampled.camera).filter(([field]) => field !== 'projection').map(([field, value]) => [field, ArrayBuffer.isView(value) ? Array.from(value) : value])),
      } : candidate.camera;
      // Validate camera geometry through the same canonical view contract.
      viewRecipe({ camera: stagedCamera });
      const preparedTransaction = transaction;
      transaction = null;
      preparedTransaction.commit();
      for (let index = 0; index < parts.length; index++) {
        Float32Array.prototype.set.call(parts[index].matrix, stagedMatrices[index]);
      }
      if (transientTime === undefined) {
        recipe = candidate;
        sampler = stagedSampler;
        layerEvaluator = stagedLayers;
      }
      materialSnapshots = stagedMaterials;
      sampledCamera = stagedCamera;
      motionTime = targetTime;
      if (transientTime === undefined) {
        matrices = stagedMatrices;
      }
      if (increment) {
        revision++;
      }
      return revision;
    } catch (error) {
      transaction?.discard();
      throw error;
    }
  }

  /** scene_inspect's motionIk: how each solver fares across the clip, from a sampler that leaves the published pose alone. */
  function diagnosticsReport() {
    const diagnostics = assetDiagnostics({
      assetId: canonicalAssetId,
      warnings: asset.warnings,
      skinnedParts: records.filter(record => record.source.skin).length,
      jointCount: [...sourceNodes.values()].filter(node => node.joint).length,
      clipCount: asset.animations.length,
    });
    return diagnostics.length ? { diagnostics } : {};
  }

  function motionIkReport() {
    if (!recipe.motion?.ik?.length) return {};
    const sweeper = agentMotion.compileAgentMotion(recipe.motion, motionRecipe(recipe));
    return {
      motionIk: sweeper.sweepIk(time => stagedNodePoses(recipe.animation, [...poseOverrides(recipe.nodeOverrides, layerEvaluator, sweeper.sample(time), time).nodeOverrides.values()])),
    };
  }

  function expected(options) {
    knownKeys(options, ['expectedRevision'], 'transaction options');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== revision) {
      throw new RangeError('expectedRevision must match the current revision.');
    }
  }

  publish(initialRecipe, cameraOmitted, false);
  return Object.freeze({
    parts, capabilities,
    get revision() {
      return revision;
    },
    get topologyRevision() {
      return 0;
    },
    get camera() {
      return structuredClone(sampledCamera);
    },
    get motionTime() {
      return motionTime;
    },
    get environment() {
      return structuredClone(recipe.environment);
    },
    get effects() {
      return structuredClone(recipe.effects);
    },
    get shadow() {
      return structuredClone(recipe.shadow);
    },
    exportRecipe() {
      return structuredClone(recipe);
    },
    sampleMotion(time) {
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw new RangeError('Motion sample time must be null or within zero and 3600.');
      }
      publish(recipe, false, false, time);
      return motionTime;
    },
    sampleFrame(input) {
      const frame = copiedJson(input);
      knownKeys(frame, ['animation', 'motionTime'], 'asset frame');
      const time = frame.motionTime === undefined ? motionTime : frame.motionTime;
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw new RangeError('Motion sample time must be null or within zero and 3600.');
      }
      publish(recipe, false, false, time, frame.animation);
      return motionTime;
    },
    apply(inputOperations, options = {}) {
      expected(options);
      if (!Array.isArray(inputOperations) || !inputOperations.length || inputOperations.length > MAX_OPERATIONS) {
        throw new RangeError('Asset operations must contain 1 to 256 commands.');
      }
      const operations = copiedJson(inputOperations);
      const candidate = structuredClone(recipe);
      for (const operation of operations) {
        const lookField = Object.hasOwn(LOOK_OPERATIONS, operation.type) ? LOOK_OPERATIONS[operation.type] : null;
        if (lookField) {
          knownKeys(operation, ['type', lookField], 'operation');
          const patch = operation[lookField];
          knownKeys(patch, Object.keys(candidate[lookField]), lookField);
          const nested = lookField === 'environment' ? 'volumeFog' : lookField === 'effects' ? 'bloom' : null;
          const merged = { ...candidate[lookField], ...(lookField === 'environment' ? environmentPatchWithSetup(patch) : patch) };
          if (nested && Object.hasOwn(patch, nested)) {
            knownKeys(patch[nested], Object.keys(candidate[lookField][nested]), nested);
            merged[nested] = { ...candidate[lookField][nested], ...patch[nested] };
          }
          candidate[lookField] = merged;
        } else if (operation.type === 'set-camera') {
          knownKeys(operation, ['type', ...Object.keys(candidate.camera)], 'operation');
          for (const field of Object.keys(candidate.camera)) {
            if (Object.hasOwn(operation, field)) {
              candidate.camera[field] = operation[field];
            }
          }
        } else if (operation.type === 'set-root') {
          knownKeys(operation, ['type', ...ROOT_FIELDS], 'operation');
          for (const field of ROOT_FIELDS) {
            if (Object.hasOwn(operation, field)) {
              candidate.root[field] = operation[field];
            }
          }
        } else if (operation.type === 'set-motion') {
          knownKeys(operation, ['type', 'motion'], 'operation');
          if (!Object.hasOwn(operation, 'motion')) {
            throw new TypeError('set-motion requires a motion record or explicit null.');
          }
          candidate.motion = operation.motion;
        } else if (operation.type === 'set-asset-node') {
          knownKeys(operation, ['type', 'id', ...ROOT_FIELDS], 'operation');
          if (!sourceNodes.has(operation.id)) {
            throw new RangeError(`Unknown source-node ID: ${operation.id}.`);
          }
          const fields = ROOT_FIELDS.filter(field => Object.hasOwn(operation, field));
          if (!fields.length) {
            throw new TypeError('set-asset-node needs a local transform component.');
          }
          let override = candidate.nodeOverrides.find(value => value.id === operation.id);
          if (!override) {
            override = { id: operation.id };
            candidate.nodeOverrides.push(override);
          }
          for (const field of fields) {
            override[field] = operation[field];
          }
        } else if (operation.type === 'set-animation') {
          knownKeys(operation, ['type', 'clip', 'time'], 'operation');
          if (operation.clip === null) {
            if (Object.hasOwn(operation, 'time')) {
              throw new TypeError('Returning to the initial pose requires clip:null with time omitted.');
            }
            candidate.animation = null;
          } else {
            const clip = operation.clip === undefined ? candidate.animation?.clip : operation.clip;
            const sameClip = candidate.animation !== null && clip === candidate.animation.clip;
            const time = operation.time === undefined ? (sameClip ? candidate.animation.time : 0) : operation.time;
            candidate.animation = { clip, time };
          }
        } else if (operation.type === 'set-material') {
          knownKeys(operation, ['type', 'id', ...MATERIAL_FIELDS], 'operation');
          if (!materialRecords.has(operation.id)) {
            throw new RangeError(`Unknown material ID: ${operation.id}.`);
          }
          let override = candidate.materialOverrides.find(value => value.id === operation.id);
          if (!override) {
            override = { id: operation.id };
            candidate.materialOverrides.push(override);
          }
          for (const field of MATERIAL_FIELDS) {
            if (Object.hasOwn(operation, field)) {
              override[field] = operation[field];
            }
          }
        } else {
          throw new TypeError('Unsupported asset operation. Geometry and topology editing are unavailable.');
        }
      }
      return publish(candidate);
    },
    inspect(inputOptions = {}) {
      const options = copiedJson(inputOptions);
      knownKeys(options, ['ids', 'limit', 'includeBounds', 'kind', 'offset'], 'inspection');
      const limit = options.limit === undefined ? 64 : options.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 256 ||
          (options.includeBounds !== undefined && typeof options.includeBounds !== 'boolean')) {
        throw new RangeError('Inspection needs limit from 1 to 256 and boolean includeBounds.');
      }
      const offset = options.offset === undefined ? 0 : options.offset;
      if (!Number.isInteger(offset) || offset < 0 || offset > 4096 ||
          (options.kind !== undefined && !['meshes', 'hierarchy'].includes(options.kind))) {
        throw new RangeError('Inspection kind must be meshes or hierarchy with an offset from zero to 4096.');
      }
      if (options.kind === 'hierarchy') {
        if (options.includeBounds) {
          throw new TypeError('Hierarchy inspection has no deformed silhouette bounds. Drop includeBounds, or inspect without kind to get mesh bounds.');
        }
        if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > sourceNodes.size)) {
          throw new RangeError('Hierarchy IDs must fit the source-node count.');
        }
        const selected = options.ids === undefined ? [...sourceNodes.values()] : options.ids.map(id => {
          if (!sourceNodes.has(id)) {
            throw new RangeError(`Unknown source-node ID: ${id}.`);
          }
          return sourceNodes.get(id);
        });
        const nodes = structuredClone(selected.slice(offset, offset + limit));
        return { revision, topologyRevision: 0, assetId: canonicalAssetId, kind: 'hierarchy', ...motionIkReport(), ...diagnosticsReport(),
          counts: { nodes: sourceNodes.size, joints: [...sourceNodes.values()].filter(node => node.joint).length },
          nodes, offset, truncated: offset + nodes.length < selected.length,
          motion: recipe.motion ? { duration: recipe.motion.duration, loop: recipe.motion.loop, tracks: recipe.motion.tracks.length, time: motionTime } : null };
      }
      if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > records.length)) {
        throw new RangeError('Inspection IDs must be an array within the decoded part count.');
      }
      const selected = options.ids === undefined ? records : options.ids.map(id => {
        const record = records.find(value => value.id === id);
        if (!record) {
          throw new RangeError(`Unknown mesh ID: ${id}. Imported mesh IDs look like mesh-0, mesh-1; call scene_inspect without ids to list them, or with kind hierarchy for source nodes.`);
        }
        return record;
      });
      const visible = selected.slice(offset, offset + limit);
      if (options.includeBounds && visible.reduce((total, record) => total + record.source.geometry.positions.length / 3, 0) > MAX_INSPECTION_VERTICES) {
        throw new RangeError('Bounds inspection exceeds two million authored base vertices. Select fewer meshes.');
      }
      const nodes = visible.map(record => {
        const index = Number(record.id.slice(5));
        const node = {
          id: record.id, label: record.label, geometry: record.geometry.id, material: record.material.id,
          vertices: record.source.geometry.positions.length / 3,
          triangles: record.source.geometry.indices.length / 3,
          skinned: Boolean(record.source.skin), morphTargets: record.source.geometry.morphTargets?.length ?? 0,
        };
        if (options.includeBounds) {
          node.bounds = baseBounds([record], [matrices[index]]);
          node.boundsKind = AGENT_ASSET_CAPABILITIES.boundsKind;
        }
        return node;
      });
      let geometryBytes = 0;
      let vertices = 0;
      for (const geometry of geometries.keys()) {
        vertices += geometry.positions.length / 3;
        for (const value of Object.values(geometry)) {
          if (ArrayBuffer.isView(value)) {
            geometryBytes += value.byteLength;
          }
        }
        for (const target of geometry.morphTargets ?? []) {
          geometryBytes += (target.positions?.byteLength ?? 0) + (target.normals?.byteLength ?? 0);
        }
      }
      return {
        revision, topologyRevision: 0, assetId: canonicalAssetId, ...diagnosticsReport(),
        counts: { nodes: parts.length, parts: parts.length, geometries: geometries.size, materials: materials.size, vertices },
        geometryBytes, animation: structuredClone(recipe.animation),
        motion: recipe.motion ? { duration: recipe.motion.duration, loop: recipe.motion.loop, tracks: recipe.motion.tracks.length, layers: recipe.motion.layers?.length ?? 0, time: motionTime } : null,
        animations: asset.animations.map((clip, index) => ({ id: index, label: String(clip.name ?? `Clip ${index}`).slice(0, 256), duration: clip.duration })),
        nodes, offset, truncated: selected.length > offset + nodes.length,
      };
    },
    checkpoint() {
      if (checkpoints.size >= MAX_CHECKPOINTS) {
        throw new RangeError('Asset checkpoint budget exhausted. Release a checkpoint.');
      }
      const handle = Object.freeze({});
      checkpoints.set(handle, structuredClone(recipe));
      return handle;
    },
    restore(handle, options = {}) {
      expected(options);
      if (!checkpoints.has(handle)) {
        throw new RangeError('Unknown or released asset checkpoint. Save one with scene_checkpoint, or use a checkpointId that scene_checkpoint returned and you have not released.');
      }
      return publish(checkpoints.get(handle));
    },
    releaseCheckpoint(handle) {
      if (!checkpoints.delete(handle)) {
        throw new RangeError('Unknown or released asset checkpoint. Save one with scene_checkpoint, or use a checkpointId that scene_checkpoint returned and you have not released.');
      }
    },
  });
}
