import { applyClip } from './gltf-animation.js';
import { GLTF_LAYER_EXTENSIONS, layerTextureReferences, materialLayersFromGltf } from './gltf-layers.js';
import { attributeFloats } from './gltf-accessors.js';
import { decodeGltf, isLinePrimitive, textureSourceIndex } from './gltf-decode.js';
import { readPunctualLights } from './gltf-lights.js';
import { Matrix4 } from './gltf-nodes.js';
import { textureDescriptorInfo } from './renderer.js';
import { createSkinPose, updateSkinPose, validateSkinGeometry, validateSkinPose } from './skinning.js';
import { MAX_MORPH_TARGETS, createMorphPose, validateMorphGeometry, validateMorphPose, validateMorphTransform } from './morph.js';

export const GLTF_CAPABILITIES = Object.freeze({
  formats: ['glb', 'gltf'],
  supported: ['triangle meshes', 'world transforms', 'rigid node animations', 'four-influence skeletal skinning', 'joint node animations', 'relative POSITION/NORMAL morph targets', 'morph weight animations', 'PNG/JPEG/WebP base color textures', 'normal/occlusion/emissive/metallic-roughness textures', 'TEXCOORD_0', 'TEXCOORD_1 for occlusion, emissive and metallic-roughness textures', 'clearcoat, clearcoat roughness, clearcoat normal, anisotropy, sheen color and sheen roughness textures', 'linear RGB vertex colors, with the alpha of RGBA colors ignored and reported in warnings','metallic roughness factors', 'emissive factors', 'alpha mask and blend modes', 'double-sided materials', 'KHR_mesh_quantization', 'KHR_materials_emissive_strength', 'KHR_materials_clearcoat, transmission, volume, ior, specular, sheen, anisotropy and iridescence factors', 'KHR_texture_transform baked into UVs, with a normal map that differs by scale and offset applied in the shader', 'EXT_mesh_gpu_instancing expanded into parts', 'KHR_draco_mesh_compression with options.decoders.draco', 'EXT_meshopt_compression with options.decoders.meshopt', 'KHR_texture_basisu with options.decoders.ktx2', 'EXT_texture_webp, with the PNG or JPEG fallback source when the browser cannot decode WebP', 'KHR_materials_unlit as the unlit material tag, with a base color map only', 'KHR_lights_punctual point and spot lights (up to eight each) and the first directional light, returned in lights as environment options'],
  // The primitive's own material is drawn; the other variants are not selectable.
  ignoredExtensions: ['KHR_materials_variants', 'KHR_materials_dispersion', 'KHR_materials_diffuse_roughness', 'EXT_materials_bump', 'EXT_texture_avif'],
  optionalExtensions: 'Any other optional extension is ignored and named in warnings. One listed in extensionsRequired that 67js does not read is refused.',
  skippedPrimitives: ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP'],
  unsupported: ['more than four skin influences', 'singular weighted skin transforms', 'reflected skin transforms', 'TANGENT morph targets', 'morph targets without authored base normals', 'drawing vertex alpha (it is ignored with a warning)','different texture transforms on one material, except a normal map that differs by scale and offset', 'skinned or morphed GPU instancing', 'transmission, iridescence and specular textures (their factors are used)', 'texture transforms on TEXCOORD_1'],
});

const LAYER_SHADER_EXTENSIONS = Object.freeze(['KHR_materials_anisotropy', 'KHR_materials_iridescence']);

// The shader code for anisotropy and iridescence is not in the core bundle; a file that uses either brings it in.
async function loadLayerShadersFor(document) {
  const usesLayerShaders = (document.materials ?? []).some(material => LAYER_SHADER_EXTENSIONS.some(extension => material?.extensions?.[extension]) || layerTextureReferences(material).length > 0 || materialUvTransforms(material ?? {}).normalRelative);
  if (usesLayerShaders) await import('./material-layer-shaders.js');
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_VERTICES = 2_000_000;
const GLTF_ALPHA_MODES = { OPAQUE: 'opaque', MASK: 'mask', BLEND: 'blend' };
const DEFAULT_MAX_INSTANCES = 4096;
// KHR_xmp_json_ld and its earlier name KHR_xmp only carry metadata (authors, licences) and change nothing drawn: the
// Khronos sample assets list them, and a file must not be refused for them.
const METADATA_EXTENSIONS = ['KHR_xmp_json_ld', 'KHR_xmp'];
const ALLOWED_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_materials_emissive_strength', 'KHR_texture_transform', 'EXT_mesh_gpu_instancing', 'EXT_texture_webp', 'KHR_materials_unlit', 'KHR_lights_punctual', ...METADATA_EXTENSIONS, ...GLTF_LAYER_EXTENSIONS]);
const DECODER_BY_EXTENSION = { KHR_draco_mesh_compression: 'draco', EXT_meshopt_compression: 'meshopt', KHR_texture_basisu: 'ktx2' };
const IDENTITY_UV_TRANSFORM = Object.freeze({ offset: [0, 0], rotation: 0, scale: [1, 1] });
const IDENTITY_UV_TRANSFORM_KEY = JSON.stringify([IDENTITY_UV_TRANSFORM.offset, IDENTITY_UV_TRANSFORM.rotation, IDENTITY_UV_TRANSFORM.scale]);
const MATERIAL_TEXTURES = [
  ['map', 'baseColorTexture', 'srgb'],
  ['normalMap', 'normalTexture', 'linear'],
  ['metallicRoughnessMap', 'metallicRoughnessTexture', 'linear'],
  ['occlusionMap', 'occlusionTexture', 'linear'],
  ['emissiveMap', 'emissiveTexture', 'srgb'],
];

// Only these textures may read the second UV set, because the shader samples them with lightmapUV. The base color map is
// sampled in the depth pass and by box mapping, and the normal map builds its tangent frame from the first set.
const SECOND_UV_TEXTURES = ['metallicRoughnessTexture', 'occlusionTexture', 'emissiveTexture'];

function materialTexture(material, field) {
  return ['baseColorTexture', 'metallicRoughnessTexture'].includes(field) ? material.pbrMetallicRoughness?.[field] : material[field];
}

function uvChannelOf(reference) {
  return reference.texCoord ?? 0;
}

/** Every texture a material definition references, as [name, reference]: the five material maps, then the layer maps. */
function materialTextureReferences(material) {
  const references = [];
  for (const [, property] of MATERIAL_TEXTURES) {
    const reference = materialTexture(material, property);
    if (reference) references.push([property, reference]);
  }
  for (const [name, reference] of layerTextureReferences(material)) references.push([name, reference]);
  return references;
}

function usesSecondUvSet(material) {
  return materialTextureReferences(material ?? {}).some(([, reference]) => uvChannelOf(reference) === 1);
}

function limitsFor(options) {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxVertices: options.maxVertices ?? DEFAULT_MAX_VERTICES,
    maxParts: options.maxParts ?? 20_000,
    maxResources: options.maxResources ?? 64,
    maxTexturePixels: options.maxTexturePixels ?? 16_777_216,
    maxTextureImagePixels: options.maxTextureImagePixels ?? 16_777_216,
    maxJoints: options.maxJoints ?? 4096,
    maxInstances: options.maxInstances ?? DEFAULT_MAX_INSTANCES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return limits;
}

function documentFrom(data, maxBytes) {
  if (typeof data === 'string') {
    if (new TextEncoder().encode(data).byteLength > maxBytes) throw new Error('glTF exceeds maxBytes.');
    return JSON.parse(data);
  }
  if (!(data instanceof ArrayBuffer)) throw new TypeError('parseGltf expects an ArrayBuffer or glTF JSON string.');
  if (data.byteLength > maxBytes) throw new Error('glTF exceeds maxBytes.');
  if (data.byteLength < 4) throw new Error('glTF input is truncated.');
  const header = new DataView(data);
  if (header.getUint32(0, true) !== 0x46546c67) return JSON.parse(new TextDecoder().decode(data));
  if (data.byteLength < 20 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength) {
    throw new Error('Invalid GLB version or declared length.');
  }
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 !== 0 || 20 + jsonLength > data.byteLength) {
    throw new Error('Invalid GLB JSON chunk.');
  }
  let offset = 20 + jsonLength;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new Error('Truncated GLB chunk.');
    const length = header.getUint32(offset, true);
    if (length % 4 !== 0 || offset + 8 + length > data.byteLength) throw new Error('Invalid GLB chunk length.');
    offset += 8 + length;
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, jsonLength)));
}

function morphCount(mesh) {
  return mesh?.primitives?.[0]?.targets?.length ?? 0;
}

function validateDefaultWeights(weights, count) {
  if (weights === undefined) return;
  if (!count || !Array.isArray(weights) || weights.length !== count || weights.some(value => typeof value !== 'number' || !Number.isFinite(Math.fround(value)))) {
    throw new Error('Morph default weights require one finite Float32 value per target.');
  }
}

function validateAnimationChannels(document) {
  for (const animation of document.animations ?? []) {
    const targets = new Set();
    for (const channel of animation.channels ?? []) {
      const path = channel.target?.path;
      const nodeIndex = channel.target?.node;
      const node = document.nodes?.[nodeIndex];
      if (!['translation', 'rotation', 'scale', 'weights'].includes(path)) throw new Error('Only node translation, rotation, scale and weights animations are supported.');
      if (nodeIndex === undefined) continue;
      if (!Number.isInteger(nodeIndex) || !node) throw new Error('Animation channel requires a valid target node.');
      const targetKey = `${nodeIndex}:${path}`;
      if (targets.has(targetKey)) throw new Error('Animation channels must have distinct node and path targets.');
      targets.add(targetKey);
      const sampler = animation.samplers?.[channel.sampler];
      if (!Number.isInteger(channel.sampler) || !sampler) throw new Error('Invalid animation sampler index.');
      const interpolation = sampler.interpolation ?? 'LINEAR';
      if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) throw new Error('Unsupported animation interpolation.');
      const input = document.accessors?.[sampler.input];
      const output = document.accessors?.[sampler.output];
      if (!Number.isInteger(sampler.input) || !input || input.type !== 'SCALAR' || input.componentType !== 5126 || input.normalized
          || !Number.isSafeInteger(input.count) || input.count < (interpolation === 'CUBICSPLINE' ? 2 : 1)) throw new Error('Animation inputs require float SCALAR keyframe times.');
      const count = path === 'weights' ? morphCount(document.meshes?.[node.mesh]) : 1;
      if (!count) throw new Error('Weights animation requires a node with morph targets.');
      const shape = path === 'weights' ? 'SCALAR' : path === 'rotation' ? 'VEC4' : 'VEC3';
      const outputCount = input.count * count * (interpolation === 'CUBICSPLINE' ? 3 : 1);
      const integerOutput = ['rotation', 'weights'].includes(path) && [5120, 5121, 5122, 5123].includes(output?.componentType) && output.normalized;
      if (!Number.isInteger(sampler.output) || !output || output.type !== shape || output.count !== outputCount
          || !(output.componentType === 5126 && !output.normalized || integerOutput)) throw new Error('Animation output shape, count or component type does not match its target.');
    }
  }
}

function allowedExtensionsFor(decoders) {
  const allowed = new Set(ALLOWED_EXTENSIONS);
  for (const [extension, decoderName] of Object.entries(DECODER_BY_EXTENSION)) {
    if (decoders[decoderName]) allowed.add(extension);
  }
  return allowed;
}

function unsupportedExtensionError(extension) {
  const decoderName = DECODER_BY_EXTENSION[extension];
  const hint = decoderName ? ` Pass options.decoders.${decoderName} to enable it.` : '';
  return new Error(`Unsupported glTF extension: ${extension}.${hint}`);
}

/**
 * Returns the sorted names of optional extensions that 67js does not use and loads the file without them, as the glTF
 * specification allows. Rejects an extension listed in extensionsRequired that 67js does not read, and a compression
 * extension whose decoder is missing, because its meshes or textures would arrive empty.
 */
function scanExtensions(document, allowedExtensions) {
  const ignored = new Set();
  function checkOptional(extension) {
    if (allowedExtensions.has(extension)) return;
    if (DECODER_BY_EXTENSION[extension]) throw unsupportedExtensionError(extension);
    ignored.add(extension);
  }
  const pending = [document];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const extension of Object.keys(value.extensions ?? {})) checkOptional(extension);
    pending.push(...Object.values(value).filter(child => child && typeof child === 'object'));
  }
  for (const extension of document.extensionsUsed ?? []) checkOptional(extension);
  for (const extension of document.extensionsRequired ?? []) {
    if (!allowedExtensions.has(extension)) throw unsupportedExtensionError(extension);
  }
  return [...ignored].sort();
}

function textureUvTransform(texture) {
  const extension = texture.extensions?.KHR_texture_transform;
  if (!extension) return IDENTITY_UV_TRANSFORM;
  const offset = extension.offset ?? [0, 0];
  const scale = extension.scale ?? [1, 1];
  const rotation = extension.rotation ?? 0;
  const vectorsAreFinite = [offset, scale].every(vector => Array.isArray(vector) && vector.length === 2 && vector.every(Number.isFinite));
  if (!vectorsAreFinite || !Number.isFinite(rotation)) throw new Error('KHR_texture_transform requires finite offset, rotation and scale.');
  if ((extension.texCoord ?? uvChannelOf(texture)) !== uvChannelOf(texture)) throw new Error('KHR_texture_transform texCoord overrides are unsupported.');
  return { offset, rotation, scale };
}

function uvTransformKey(transform) {
  const key = JSON.stringify([transform.offset, transform.rotation, transform.scale]);
  return key === IDENTITY_UV_TRANSFORM_KEY ? '' : key;
}

/**
 * The scale and offset that turn UVs already baked with `shared` into the UVs of `own`: [scaleU, scaleV, offsetU, offsetV].
 * The normal map's tangent frame comes from the baked UVs, so the two must have the same rotation and a positive scale
 * ratio, equal on both axes unless there is no rotation.
 */
function relativeUvTransform(shared, own) {
  const ratios = own.scale.map((scale, axis) => scale / shared.scale[axis]);
  const sameRotation = own.rotation === shared.rotation;
  const keepsAxes = shared.rotation === 0 || ratios[0] === ratios[1];
  if (!sameRotation || !keepsAxes || !ratios.every(ratio => ratio > 0 && Number.isFinite(ratio))) {
    throw new Error('The normal texture transform may differ from the other maps only by an offset and a positive scale, with the same rotation.');
  }
  return [...ratios, own.offset[0] - ratios[0] * shared.offset[0], own.offset[1] - ratios[1] * shared.offset[1]];
}

/**
 * The maps on TEXCOORD_0 of a material share one UV set, so one transform is baked into it: the one every map but the
 * normal map has. A normal map with another transform keeps it as `normalRelative`, which the shader applies on top.
 */
function materialUvTransforms(material) {
  let shared = null;
  let normalTransform = null;
  for (const [name, texture] of materialTextureReferences(material)) {
    const transform = textureUvTransform(texture);
    if (uvChannelOf(texture) !== 0) {
      if (uvTransformKey(transform) !== '') throw new Error(`${name} reads TEXCOORD_1, where KHR_texture_transform is unsupported. Bake the transform into the UVs.`);
      continue;
    }
    if (name === 'normalTexture') {
      normalTransform = transform;
      continue;
    }
    if (shared && uvTransformKey(shared) !== uvTransformKey(transform)) {
      throw new Error('Maps of one material must share the same KHR_texture_transform, except the normal map. Different transforms per map are unsupported.');
    }
    shared = transform;
  }
  if (!normalTransform) return { shared: shared ?? IDENTITY_UV_TRANSFORM, normalRelative: null };
  if (!shared) return { shared: normalTransform, normalRelative: null };
  if (uvTransformKey(shared) === uvTransformKey(normalTransform)) return { shared, normalRelative: null };
  return { shared, normalRelative: relativeUvTransform(shared, normalTransform) };
}

function bakeUvTransform(uvs, transform) {
  const cosine = Math.cos(transform.rotation);
  const sine = Math.sin(transform.rotation);
  const [offsetU, offsetV] = transform.offset;
  const [scaleU, scaleV] = transform.scale;
  for (let index = 0; index < uvs.length; index += 2) {
    const u = uvs[index];
    const v = uvs[index + 1];
    uvs[index] = cosine * scaleU * u + sine * scaleV * v + offsetU;
    uvs[index + 1] = -sine * scaleU * u + cosine * scaleV * v + offsetV;
  }
}

function validateMaterialExtensions(material) {
  materialUvTransforms(material);
  materialLayersFromGltf(material);
}

/** Validates EXT_mesh_gpu_instancing on a node and returns how many instances it expands to. */
function nodeInstanceCount(document, node, limits) {
  const instancing = node.extensions?.EXT_mesh_gpu_instancing;
  if (!instancing) return 1;
  const attributes = instancing.attributes;
  if (node.mesh === undefined || node.skin !== undefined) throw new Error('EXT_mesh_gpu_instancing requires a static mesh node without a skin.');
  if (morphCount(document.meshes?.[node.mesh])) throw new Error('EXT_mesh_gpu_instancing with morph targets is unsupported.');
  const shapes = { TRANSLATION: 'VEC3', ROTATION: 'VEC4', SCALE: 'VEC3' };
  let count;
  for (const [name, accessorIndex] of Object.entries(attributes ?? {})) {
    if (!(name in shapes)) continue;
    const accessor = document.accessors?.[accessorIndex];
    if (!accessor || accessor.type !== shapes[name] || !Number.isSafeInteger(accessor.count)) throw new Error(`Instancing ${name} requires a ${shapes[name]} accessor.`);
    if (count !== undefined && accessor.count !== count) throw new Error('Instancing attributes must share one count.');
    count = accessor.count;
  }
  if (count === undefined || count < 1) throw new Error('EXT_mesh_gpu_instancing needs TRANSLATION, ROTATION or SCALE instances.');
  if (count > limits.maxInstances) throw new Error(`EXT_mesh_gpu_instancing node has ${count} instances, above maxInstances (${limits.maxInstances}).`);
  return count;
}

function validateDocument(document, limits, allowedExtensions) {
  if (document.asset?.version !== '2.0') throw new Error('Only glTF 2.0 assets are supported.');
  const ignoredExtensions = scanExtensions(document, allowedExtensions);
  let declaredBytes = 0;
  for (const buffer of document.buffers ?? []) {
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0) throw new Error('Invalid glTF buffer length.');
    declaredBytes += buffer.byteLength;
  }
  if (declaredBytes > limits.maxBytes) throw new Error('glTF buffers exceed maxBytes.');
  let vertices = 0;
  let indices = 0;
  let morphBytes = 0;
  for (const mesh of document.meshes ?? []) {
    const targetCount = morphCount(mesh);
    if (targetCount > MAX_MORPH_TARGETS) throw new Error('Morph target count exceeds 64.');
    validateDefaultWeights(mesh.weights, targetCount);
    for (const primitive of mesh.primitives ?? []) {
      if (isLinePrimitive(primitive)) continue;
      if ((primitive.mode ?? 4) !== 4) throw new Error('Only glTF TRIANGLES primitives are supported. POINTS, LINES, LINE_LOOP and LINE_STRIP are skipped with a warning.');
      const position = document.accessors?.[primitive.attributes?.POSITION];
      if (!position || position.type !== 'VEC3' || !Number.isSafeInteger(position.count) || position.count < 3) {
        throw new Error('Each mesh primitive requires a valid POSITION accessor.');
      }
      if (primitive.targets !== undefined && (!Array.isArray(primitive.targets) || !primitive.targets.length || primitive.targets.length !== targetCount)) throw new Error('Morph target counts must match across all mesh primitives.');
      if ((primitive.targets?.length ?? 0) !== targetCount) throw new Error('Morph target counts must match across all mesh primitives.');
      if (targetCount && primitive.attributes?.NORMAL === undefined) throw new Error('Morph targets require authored base NORMAL. Per-target flat normal generation is unsupported.');
      for (const target of primitive.targets ?? []) {
        if (!target || typeof target !== 'object' || Array.isArray(target) || !Object.keys(target).length) throw new Error('Morph targets require POSITION or NORMAL channels.');
        for (const [semantic, accessorIndex] of Object.entries(target)) {
          if (!['POSITION', 'NORMAL'].includes(semantic)) throw new Error(`Unsupported morph target semantic: ${semantic}.`);
          const accessor = document.accessors?.[accessorIndex];
          if (primitive.attributes?.[semantic] === undefined) throw new Error('Morph target channels require corresponding base attributes.');
          if (!Number.isInteger(accessorIndex) || !accessor || accessor.type !== 'VEC3' || accessor.componentType !== 5126 || accessor.normalized || accessor.count !== position.count) throw new Error('Morph target channels require matching float VEC3 accessors.');
          if (semantic === 'POSITION' && (!Array.isArray(accessor.min) || !Array.isArray(accessor.max) || accessor.min.length !== 3 || accessor.max.length !== 3
              || accessor.min.some((value, axis) => typeof value !== 'number' || !Number.isFinite(Math.fround(value)) || typeof accessor.max[axis] !== 'number' || !Number.isFinite(Math.fround(accessor.max[axis])) || value > accessor.max[axis]))) throw new Error('Morph POSITION requires finite ordered min/max bounds.');
        }
      }
      vertices += position.count * (1 + targetCount);
      morphBytes += position.count * targetCount * 24;
      if (primitive.attributes?.NORMAL === undefined) morphBytes += position.count * 24;
      if (Object.keys(primitive.attributes ?? {}).some(name => /^(JOINTS|WEIGHTS)_/.test(name) && !['JOINTS_0', 'WEIGHTS_0'].includes(name))) throw new Error('Only four JOINTS_0/WEIGHTS_0 skin influences are supported.');
      const joints = document.accessors?.[primitive.attributes?.JOINTS_0];
      const weights = document.accessors?.[primitive.attributes?.WEIGHTS_0];
      if (joints || weights) {
        if (!joints || !weights || joints.type !== 'VEC4' || weights.type !== 'VEC4' || joints.count !== position.count || weights.count !== position.count) throw new Error('JOINTS_0 and WEIGHTS_0 must contain four values per POSITION.');
        if (![5121, 5123].includes(joints.componentType) || joints.normalized) throw new Error('JOINTS_0 requires unnormalized unsigned byte or short indices.');
        if (weights.componentType !== 5126 && (![5121, 5123].includes(weights.componentType) || !weights.normalized)) throw new Error('WEIGHTS_0 requires floats or normalized unsigned integers.');
      } else if (primitive.attributes?.JOINTS_0 !== undefined || primitive.attributes?.WEIGHTS_0 !== undefined) throw new Error('Invalid skin attribute accessor index.');
      const colorIndex = primitive.attributes?.COLOR_0;
      if (colorIndex !== undefined) {
        const color = document.accessors?.[colorIndex];
        if (!color || !['VEC3', 'VEC4'].includes(color.type) || color.count !== position.count) {
          throw new Error('COLOR_0 requires RGB or RGBA values matching the POSITION vertex count.');
        }
        if (color.componentType !== 5126 && (![5121, 5123].includes(color.componentType) || !color.normalized)) {
          throw new Error('COLOR_0 requires float or normalized unsigned integer components.');
        }
      }
      for (const [name, size] of [['NORMAL', 'VEC3'], ['TEXCOORD_0', 'VEC2']]) {
        const accessorIndex = primitive.attributes?.[name];
        const accessor = document.accessors?.[accessorIndex];
        if (accessorIndex !== undefined && (!accessor || accessor.type !== size || accessor.count !== position.count)) {
          throw new Error(`${name} must match the POSITION vertex count and component shape.`);
        }
      }
      const index = primitive.indices === undefined ? null : document.accessors?.[primitive.indices];
      if (primitive.indices !== undefined && (!index || index.type !== 'SCALAR' || !Number.isSafeInteger(index.count) || index.count < 3)) {
        throw new Error('Invalid mesh index accessor.');
      }
      const indexCount = index?.count ?? position.count;
      if (indexCount % 3 !== 0) throw new Error('Triangle index count must be divisible by three.');
      indices += indexCount;
    }
  }
  if (vertices > limits.maxVertices || indices > limits.maxVertices * 12) throw new Error('glTF geometry exceeds maxVertices or its index budget.');
  if ((document.nodes?.length ?? 0) > limits.maxParts) throw new Error('glTF nodes exceed maxParts.');
  let jointCount = 0;
  for (const skin of document.skins ?? []) {
    if (!Array.isArray(skin.joints) || !skin.joints.length || new Set(skin.joints).size !== skin.joints.length || skin.joints.some(joint => !Number.isInteger(joint) || !document.nodes?.[joint])) throw new Error('Skin joints require distinct valid node indices.');
    jointCount += skin.joints.length;
    if (jointCount > limits.maxJoints || skin.joints.length > 65536) throw new Error('Skin joints exceed maxJoints.');
    if (skin.skeleton !== undefined && (!Number.isInteger(skin.skeleton) || !document.nodes?.[skin.skeleton])) throw new Error('Invalid skin skeleton node.');
    if (skin.inverseBindMatrices !== undefined) {
      const accessor = document.accessors?.[skin.inverseBindMatrices];
      if (!accessor || accessor.type !== 'MAT4' || accessor.componentType !== 5126 || accessor.normalized || accessor.count !== skin.joints.length) throw new Error('Inverse bind matrices require one float MAT4 per joint.');
    }
  }
  let poseJointCount = 0;
  let declaredParts = 0;
  for (const node of document.nodes ?? []) {
    const mesh = document.meshes?.[node.mesh];
    if (node.mesh !== undefined && (!Number.isInteger(node.mesh) || !mesh)) throw new Error('Invalid mesh node index.');
    declaredParts += (mesh?.primitives?.length ?? 0) * nodeInstanceCount(document, node, limits);
    if (declaredParts > limits.maxParts) throw new Error('glTF primitive instances exceed maxParts.');
    validateDefaultWeights(node.weights, morphCount(mesh));
    morphBytes += morphCount(mesh) * (mesh?.primitives?.length ?? 0) * 16;
    if (node.skin !== undefined) {
      if (!Number.isInteger(node.skin) || !document.skins?.[node.skin] || !document.meshes?.[node.mesh]) throw new Error('Invalid skinned mesh or skin index.');
      for (const primitive of document.meshes[node.mesh].primitives ?? []) {
        if (isLinePrimitive(primitive)) continue;
        if (primitive.attributes?.JOINTS_0 === undefined || primitive.attributes?.WEIGHTS_0 === undefined) throw new Error('Skinned meshes require JOINTS_0 and WEIGHTS_0.');
        poseJointCount += document.skins[node.skin].joints.length;
        if (poseJointCount > limits.maxJoints) throw new Error('Instanced skin poses exceed maxJoints.');
      }
    }
  }
  validateHierarchy(document.nodes ?? []);
  validateAnimationChannels(document);
  for (const material of document.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    const factors = [pbr.baseColorFactor ?? [1, 1, 1, 1], material.emissiveFactor ?? [0, 0, 0]];
    for (let index = 0; index < factors.length; index++) {
      if (!Array.isArray(factors[index]) || factors[index].length !== (index === 0 ? 4 : 3) || !factors[index].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw new Error('Invalid glTF material color factor.');
      }
    }
    for (const factor of [pbr.metallicFactor ?? 1, pbr.roughnessFactor ?? 1]) {
      if (!Number.isFinite(factor) || factor < 0 || factor > 1) throw new Error('Invalid glTF metallic or roughness factor.');
    }
    if (!Object.hasOwn(GLTF_ALPHA_MODES, material.alphaMode ?? 'OPAQUE')) throw new Error(`Unsupported alpha mode: ${material.alphaMode}.`);
    const alphaCutoff = material.alphaCutoff ?? 0.5;
    if (!Number.isFinite(alphaCutoff) || alphaCutoff < 0 || alphaCutoff > 1) throw new Error('Invalid glTF alphaCutoff.');
    if (material.doubleSided !== undefined && typeof material.doubleSided !== 'boolean') throw new Error('glTF doubleSided must be a boolean.');
    for (const [field, texture] of materialTextureReferences(material)) {
      const allowedChannels = SECOND_UV_TEXTURES.includes(field) ? [0, 1] : [0];
      if (!allowedChannels.includes(uvChannelOf(texture)) || Object.keys(texture.extensions ?? {}).some(name => name !== 'KHR_texture_transform')) throw new Error(`${field} requires ${SECOND_UV_TEXTURES.includes(field) ? 'TEXCOORD_0 or TEXCOORD_1' : 'TEXCOORD_0'} and no texture extensions besides KHR_texture_transform.`);
      if (!Number.isInteger(texture.index) || !document.textures?.[texture.index]) throw new Error(`Invalid ${field} texture index.`);
      if (field === 'normalTexture' && (!Number.isFinite(texture.scale ?? 1) || !Number.isFinite(Math.fround(texture.scale ?? 1)))) throw new Error('Normal texture scale must be a finite float.');
      if (field === 'occlusionTexture' && (!Number.isFinite(texture.strength ?? 1) || (texture.strength ?? 1) < 0 || (texture.strength ?? 1) > 1)) throw new Error('Occlusion texture strength must be within zero and one.');
    }
    validateMaterialExtensions(material);
  }
  for (const texture of document.textures ?? []) {
    const source = textureSourceIndex(texture);
    if (!Number.isInteger(source) || !document.images?.[source]) throw new Error('Invalid texture image index.');
    if (texture.sampler !== undefined && (!Number.isInteger(texture.sampler) || !document.samplers?.[texture.sampler])) throw new Error('Invalid texture sampler index.');
    const sampler = document.samplers?.[texture.sampler] ?? {};
    textureDescriptorInfo({ image: { width: 1, height: 1 }, ...sampler });
  }
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (isLinePrimitive(primitive)) continue;
      const material = document.materials?.[primitive.material];
      for (const [, reference] of materialTextureReferences(material ?? {})) {
        const attribute = `TEXCOORD_${uvChannelOf(reference)}`;
        if (primitive.attributes?.[attribute] === undefined) throw new Error(`Material textures require ${attribute}.`);
      }
    }
  }
  let decodedBytes = morphBytes;
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  for (const accessor of document.accessors ?? []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > limits.maxVertices * 12) {
      throw new Error('glTF accessor exceeds its element budget.');
    }
    if (!components[accessor.type]) throw new Error('Unsupported glTF accessor shape.');
    decodedBytes += accessor.count * components[accessor.type] * 4;
  }
  if (decodedBytes > limits.maxBytes * 4) throw new Error('Decoded glTF accessors exceed four times maxBytes.');
  return { vertices, ignoredExtensions };
}

const LINE_MODE_NAMES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP'];

/** One warning per mesh that has point or line primitives, which 67js does not draw. */
function skippedPrimitiveWarnings(document) {
  const warnings = [];
  (document.meshes ?? []).forEach((mesh, meshIndex) => {
    const counts = new Map();
    for (const primitive of mesh.primitives ?? []) {
      if (!isLinePrimitive(primitive)) continue;
      const modeName = LINE_MODE_NAMES[primitive.mode];
      counts.set(modeName, (counts.get(modeName) ?? 0) + 1);
    }
    if (!counts.size) return;
    const summary = [...counts].map(([modeName, count]) => `${count} ${modeName}`).join(', ');
    const meshLabel = mesh.name ? `"${mesh.name}"` : meshIndex;
    warnings.push(`Skipped ${summary} primitive(s) in mesh ${meshLabel}: 67js draws triangles only.`);
  });
  return warnings;
}

function validateHierarchy(nodes) {
  const parents = new Set();
  for (const node of nodes) {
    for (const child of node.children ?? []) {
      if (!Number.isInteger(child) || !nodes[child] || parents.has(child)) throw new Error('Invalid glTF hierarchy child or multiple parents.');
      parents.add(child);
    }
  }
  const states = new Uint8Array(nodes.length);
  const roots = Array.from(nodes.keys()).filter(index => !parents.has(index));
  const remaining = Array.from(nodes.keys()).filter(index => parents.has(index));
  for (const root of [...roots, ...remaining]) {
    const pending = [{ index: root, exit: false, depth: 1 }];
    while (pending.length) {
      const current = pending.pop();
      if (current.exit) {
        states[current.index] = 2;
        continue;
      }
      if (states[current.index] === 1) throw new Error('Cyclic glTF node hierarchy.');
      if (states[current.index] === 2) continue;
      if (current.depth > 256) throw new Error('glTF hierarchy exceeds 256 levels.');
      states[current.index] = 1;
      pending.push({ ...current, exit: true });
      for (const child of nodes[current.index].children ?? []) pending.push({ index: child, exit: false, depth: current.depth + 1 });
    }
  }
}

function dataUriBytes(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0 || !uri.slice(0, comma).endsWith(';base64')) throw new Error('Embedded glTF resources must use base64 data URIs.');
  const binary = atob(uri.slice(comma + 1));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

const RIFF_TAG = 0x52494646;
const WEBP_TAG = 0x57454250;

/** Read the size from a WebP header: the extended (VP8X), lossy (VP8) or lossless (VP8L) layout. */
function webpImageSize(bytes, header) {
  if (bytes.length < 30 || header.getUint32(0) !== RIFF_TAG || header.getUint32(8) !== WEBP_TAG) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: header.getUint16(26, true) & 0x3fff, height: header.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = header.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function validateImage(bytes, maxImagePixels) {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width;
  let height;
  let scalable = true;
  if (bytes.length >= 24 && header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a && header.getUint32(12) === 0x49484452) {
    width = header.getUint32(16);
    height = header.getUint32(20);
  } else if (bytes.length >= 4 && header.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > bytes.length) break;
      const length = header.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = header.getUint16(offset + 3);
        width = header.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (!width) {
    const webpSize = webpImageSize(bytes, header);
    width = webpSize?.width;
    height = webpSize?.height;
  }
  const ktx2Identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!width && bytes.length >= 28 && ktx2Identifier.every((value, index) => bytes[index] === value)) {
    width = header.getUint32(20, true);
    height = header.getUint32(24, true);
    scalable = false;
  }
  if (!width || !height) throw new Error('Only valid PNG, JPEG, WebP and KTX2 texture images are supported.');
  if (width * height > maxImagePixels) throw new Error('Texture image exceeds maxTextureImagePixels before decoding.');
  return { width, height, scalable };
}

function binaryChunk(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 20) return null;
  const header = new DataView(data);
  if (header.getUint32(0, true) !== 0x46546c67) return null;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const length = header.getUint32(offset, true);
    if (header.getUint32(offset + 4, true) === 0x004e4942) return new Uint8Array(data, offset + 8, length);
    offset += 8 + length;
  }
  return null;
}

async function boundedFetch(url, maxBytes, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`glTF fetch failed (${response.status}): ${url}.`);
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw new Error('glTF resource exceeds maxBytes.');
  }
  if (!response.body?.getReader) throw new Error('Bounded glTF loading requires a streaming fetch response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('glTF resource exceeds maxBytes.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType: response.headers.get('content-type') ?? 'application/octet-stream' };
}

async function prepareResources(document, data, dataBytes, options, limits) {
  const resourceBytes = new Map();
  const definitions = [...(document.buffers ?? []), ...(document.images ?? [])];
  const uris = new Set(definitions.map(resource => resource.uri).filter(uri => uri !== undefined));
  if (uris.size > limits.maxResources) throw new Error('glTF resources exceed maxResources.');
  let usedBytes = dataBytes;
  for (const uri of uris) {
    if (typeof uri !== 'string') throw new Error('Invalid glTF resource URI.');
    if (uri.startsWith('data:')) {
      resourceBytes.set(uri, dataUriBytes(uri));
      continue;
    }
    if (!options.baseUrl && !/^(https?:|blob:)/.test(uri)) throw new Error('External glTF resources require baseUrl. Use GLB for a self-contained local file.');
    const resolved = new URL(uri, options.baseUrl || undefined).href;
    if (!/^(https?:|blob:)/.test(resolved)) throw new Error('Only HTTP, HTTPS, blob and embedded data resources are supported.');
    const resource = await boundedFetch(resolved, limits.maxBytes - usedBytes, options.signal);
    usedBytes += resource.bytes.byteLength;
    resourceBytes.set(uri, resource.bytes);
  }
  const imageSizes = [];
  for (const image of document.images ?? []) {
    let bytes = resourceBytes.get(image.uri);
    if (!bytes && image.bufferView !== undefined) {
      const view = document.bufferViews?.[image.bufferView];
      const buffer = view && document.buffers?.[view.buffer];
      const source = buffer?.uri ? resourceBytes.get(buffer.uri) : view?.buffer === 0 ? binaryChunk(data) : null;
      const offset = view?.byteOffset ?? 0;
      if (!source || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0 || offset < 0 || offset + view.byteLength > source.length) {
        throw new Error('Invalid embedded glTF image buffer view.');
      }
      bytes = source.subarray(offset, offset + view.byteLength);
    }
    if (!bytes) throw new Error('glTF image has no supported source.');
    imageSizes.push(validateImage(bytes, limits.maxTextureImagePixels));
  }
  return { resourceBytes, textureScaling: planTextureScaling(document.images ?? [], imageSizes, limits.maxTexturePixels) };
}

/**
 * Fit the combined texture pixels into the budget by halving the largest images together, so equal maps stay equal.
 * KTX2 images cannot be resized before transcoding; they count toward the budget and are never scaled.
 */
function planTextureScaling(imageDefinitions, imageSizes, maxTexturePixels) {
  const targets = imageSizes.map(({ width, height }) => ({ width, height }));
  const totalPixels = () => targets.reduce((sum, { width, height }) => sum + width * height, 0);
  while (totalPixels() > maxTexturePixels) {
    const scalable = targets.filter((target, index) => imageSizes[index].scalable && target.width * target.height > 1);
    if (!scalable.length) throw new Error('Texture images exceed maxTexturePixels and cannot be scaled down further.');
    const largestPixels = Math.max(...scalable.map(target => target.width * target.height));
    for (const target of scalable) {
      if (target.width * target.height !== largestPixels) continue;
      target.width = Math.max(1, target.width >> 1);
      target.height = Math.max(1, target.height >> 1);
    }
  }
  const scaledTextures = [];
  const targetByImageIndex = new Map();
  targets.forEach((target, index) => {
    const source = imageSizes[index];
    if (target.width === source.width && target.height === source.height) return;
    targetByImageIndex.set(index, target);
    scaledTextures.push({ name: imageDefinitions[index].name ?? `image ${index}`, from: [source.width, source.height], to: [target.width, target.height] });
  });
  return { targetByImageIndex, scaledTextures };
}

function copyAttribute(attribute, size) {
  if (attribute.itemSize !== size) throw new Error(`Expected a ${size}-component mesh attribute.`);
  const values = attributeFloats(attribute);
  if (!values.every(Number.isFinite)) throw new Error('Mesh attributes must contain finite values.');
  return values;
}

function computeVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [indices[corner] * 3, indices[corner + 1] * 3, indices[corner + 2] * 3];
    const edgeAB = [positions[second] - positions[first], positions[second + 1] - positions[first + 1], positions[second + 2] - positions[first + 2]];
    const edgeAC = [positions[third] - positions[first], positions[third + 1] - positions[first + 1], positions[third + 2] - positions[first + 2]];
    const cross = [edgeAB[1] * edgeAC[2] - edgeAB[2] * edgeAC[1], edgeAB[2] * edgeAC[0] - edgeAB[0] * edgeAC[2], edgeAB[0] * edgeAC[1] - edgeAB[1] * edgeAC[0]];
    for (const vertexOffset of [first, second, third]) {
      for (let axis = 0; axis < 3; axis++) normals[vertexOffset + axis] += cross[axis];
    }
  }
  return normals;
}

function convertGeometry(source, mirrored, primitive, secondUvSet, onIgnoredVertexAlpha) {
  const { position, normal, uv, uv1, color, skinIndex, skinWeight } = source.attributes;
  const positions = copyAttribute(position, 3);
  const indices = new Uint32Array(source.index?.count ?? position.count);
  for (let index = 0; index < indices.length; index++) {
    const value = source.index ? source.index.array[index] : index;
    if (!Number.isInteger(value) || value < 0 || value >= position.count) throw new Error('Mesh index is out of range.');
    indices[index] = value;
  }
  if (normal && normal.count !== position.count) throw new Error('NORMAL and POSITION counts must match.');
  const normals = normal ? copyAttribute(normal, 3) : computeVertexNormals(positions, indices);
  const geometry = { positions, normals, indices };
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(...normals.subarray(offset, offset + 3));
    if (length < 1e-8) throw new Error('Degenerate geometry has no usable vertex normal.');
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  if (mirrored) {
    for (let index = 0; index < indices.length; index += 3) {
      const second = indices[index + 1];
      indices[index + 1] = indices[index + 2];
      indices[index + 2] = second;
    }
  }
  if (uv && uv.count !== position.count) throw new Error('TEXCOORD_0 and POSITION counts must match.');
  if (uv) geometry.uvs = copyAttribute(uv, 2);
  // The renderer's second UV set is geometry.lightUvs, the one light maps use.
  if (secondUvSet) {
    if (!uv1 || uv1.count !== position.count) throw new Error('TEXCOORD_1 and POSITION counts must match.');
    geometry.lightUvs = copyAttribute(uv1, 2);
  }
  if (color) geometry.colors = convertVertexColors(color, position.count, onIgnoredVertexAlpha);
  if (skinIndex) geometry.skinIndices = new Uint16Array(copyAttribute(skinIndex, 4));
  if (skinWeight) geometry.skinWeights = copyAttribute(skinWeight, 4);
  if (primitive.targets?.length) {
    geometry.morphTargets = primitive.targets.map((target, index) => {
      const channels = {};
      if (target.POSITION !== undefined) channels.positions = copyAttribute(source.morphPositions[index], 3);
      if (target.NORMAL !== undefined) channels.normals = copyAttribute(source.morphNormals[index], 3);
      return channels;
    });
  }
  return geometry;
}

function makeSkinBinding(node) {
  const count = node.skeleton.bones.length;
  const pose = createSkinPose(count);
  const pendingPose = createSkinPose(count);
  const inverseBindMatrices = new Float32Array(count * 16);
  const jointWorldMatrices = new Float32Array(count * 16);
  const pendingWorld = new Float32Array(count * 16);
  const joints = node.skeleton.bones.map((bone, index) => {
    inverseBindMatrices.set(node.skeleton.boneInverses[index].elements, index * 16);
    return { name: bone.name, parent: node.skeleton.bones.indexOf(bone.parent) };
  });
  const skin = Object.assign(pose, { joints, inverseBindMatrices, jointWorldMatrices, bindMatrix: new Float32Array(node.bindMatrix.elements) });
  return { node, skin, pendingPose, pendingWorld, palette: skin.jointMatrices, jointWorld: skin.jointWorldMatrices };
}

function prepareSkinBinding(binding, geometry) {
  const { node, skin, pendingPose, pendingWorld } = binding;
  if (skin.jointMatrices !== binding.palette || skin.jointWorldMatrices !== binding.jointWorld || binding.palette.length !== pendingPose.jointMatrices.length || binding.jointWorld.length !== pendingWorld.length) throw new Error('Imported skin palette identities must remain unchanged.');
  for (let joint = 0; joint < node.skeleton.bones.length; joint++) pendingWorld.set(node.skeleton.bones[joint].matrixWorld.elements, joint * 16);
  updateSkinPose(pendingPose, pendingWorld, skin.inverseBindMatrices, node.matrixWorld.elements, skin.bindMatrix);
  validateSkinPose(pendingPose, geometry, node.matrixWorld.elements);
}

function commitSkinBinding(binding) {
  binding.skin.jointMatrices.set(binding.pendingPose.jointMatrices);
  binding.skin.jointWorldMatrices.set(binding.pendingWorld);
}

function makeMorphBinding(node, geometry, metadataCache) {
  const pose = createMorphPose(geometry.morphTargets.length);
  pose.weights.set(node.morphTargetInfluences);
  const pendingPose = createMorphPose(pose.weights.length);
  let metadata = metadataCache.get(geometry);
  if (metadata) validateMorphPose(pose, metadata);
  else {
    metadata = validateMorphGeometry(geometry, pose);
    metadataCache.set(geometry, metadata);
  }
  return { node, pose, weights: pose.weights, pendingPose, metadata };
}

function prepareMorphBinding(binding) {
  if (binding.pose.weights !== binding.weights || binding.weights.length !== binding.metadata.targetCount) throw new Error('Imported morph weight identity must remain unchanged.');
  const influences = binding.node.morphTargetInfluences;
  if (influences.length !== binding.weights.length) throw new Error('Decoded morph weight count changed.');
  binding.pendingPose.weights.set(influences);
  validateMorphPose(binding.pendingPose, binding.metadata);
}

function validateNodeTransforms(nodes, pending, transform) {
  for (const node of nodes) {
    pending.set(node.matrixWorld.elements);
    for (const value of pending) if (!Number.isFinite(value)) throw new Error('Animation creates a non-finite Float32 world matrix.');
    const determinant = transform.fromArray(pending).determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Animation creates a singular Float32 node transform.');
  }
}

function instanceMatricesOf(node, maximumInstances) {
  if (!node.isInstancedMesh) return [null];
  if (node.count > maximumInstances) throw new Error(`Decoded instance count ${node.count} exceeds maxInstances (${maximumInstances}).`);
  return Array.from({ length: node.count }, (unused, index) => {
    const matrix = new Matrix4();
    node.getMatrixAt(index, matrix);
    return matrix;
  });
}

function worldMatrixOf(node, instanceMatrix, target) {
  return instanceMatrix ? target.multiplyMatrices(node.matrixWorld, instanceMatrix) : target.copy(node.matrixWorld);
}

/** Keeps the RGB of COLOR_0. The alpha of an RGBA attribute is dropped, and onIgnoredVertexAlpha hears of it when it is below one. */
function convertVertexColors(attribute, vertexCount, onIgnoredVertexAlpha) {
  if (attribute.count !== vertexCount || ![3, 4].includes(attribute.itemSize)) {
    throw new Error('COLOR_0 requires matching RGB or RGBA vertex values.');
  }
  const values = copyAttribute(attribute, attribute.itemSize);
  const colors = new Float32Array(vertexCount * 3);
  let alphaBelowOne = false;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * attribute.itemSize;
    if (attribute.itemSize === 4 && values[offset + 3] < 1) alphaBelowOne = true;
    for (let component = 0; component < 3; component++) {
      const value = values[offset + component];
      if (value < 0 || value > 1) throw new Error('COLOR_0 RGB values must be within zero and one.');
      colors[vertex * 3 + component] = value;
    }
  }
  if (alphaBelowOne) onIgnoredVertexAlpha();
  return colors;
}

/** KTX2 textures arrive as RGBA8 pixel data, which the renderer uploads as an ImageData. */
function decodedTextureImage(texture, field) {
  if (texture.isCompressedTexture) throw new Error(`${field} decoded to a GPU-compressed KTX2 format. Configure the KTX2 loader to transcode to RGBA8 (see docs/gltf.md).`);
  const image = texture.image;
  if (!image?.data) return image;
  const { width, height, data } = image;
  if (!(data instanceof Uint8Array) || data.length < width * height * 4) throw new Error(`${field} KTX2 image must decode to RGBA8 pixels.`);
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
  return typeof ImageData === 'function' ? new ImageData(pixels, width, height) : { width, height, data: pixels };
}

function textureDescriptorFor(texture, field, { colorSpace, uvChannel, uvTransform = null }, limits, maps) {
  if (!maps.has(texture)) maps.set(texture, new Map());
  const descriptors = maps.get(texture);
  const key = `${colorSpace}:${uvChannel}:${uvTransform ?? ''}`;
  if (!descriptors.has(key)) {
    const image = decodedTextureImage(texture, field);
    if (!image || image.width * image.height > limits.maxTextureImagePixels) throw new Error(`${field} image is missing or exceeds maxTextureImagePixels.`);
    const descriptor = {
      image,
      uvChannel,
      wrapS: texture.wrapS,
      wrapT: texture.wrapT,
      minFilter: texture.minFilter,
      magFilter: texture.magFilter,
      flipY: false,
      colorSpace,
    };
    if (uvTransform) descriptor.uvTransform = uvTransform;
    textureDescriptorInfo(descriptor);
    descriptors.set(key, descriptor);
  }
  return descriptors.get(key);
}

function convertMaterial(source, limits, maps, definition = {}) {
  const unlit = Boolean(definition.extensions?.KHR_materials_unlit);
  const material = {
    tag: unlit ? 'unlit' : 'gltf',
    color: [...source.color],
    metallic: source.metalness,
    roughness: source.roughness,
    emission: source.emissiveIntensity ?? 1,
    emissiveColor: [...source.emissive],
    normalScale: [definition.normalTexture?.scale ?? 1, definition.normalTexture?.scale ?? 1],
    occlusionStrength: source.aoMapIntensity,
  };
  material.alphaMode = GLTF_ALPHA_MODES[definition.alphaMode ?? 'OPAQUE'];
  material.alphaCutoff = definition.alphaCutoff ?? 0.5;
  material.opacity = definition.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1;
  material.doubleSided = definition.doubleSided ?? false;
  if (!unlit) Object.assign(material, materialLayersFromGltf(definition));
  // An unlit surface shows its base color alone, and the renderer's unlit tag takes only a base map.
  if (unlit) material.emissiveColor = [0, 0, 0];
  if (!material.emissiveColor.some(value => value > 0)) material.emission = 0;
  if (!Number.isFinite(Math.fround(material.emission)) || material.emission < 0) throw new Error('Emissive intensity must be a finite nonnegative float.');
  for (const [field, property, colorSpace] of MATERIAL_TEXTURES) {
    if (unlit && field !== 'map') continue;
    const texture = source[field === 'metallicRoughnessMap' ? 'metalnessMap' : field === 'occlusionMap' ? 'aoMap' : field];
    if (!texture) continue;
    const uvChannel = uvChannelOf(materialTexture(definition, property));
    const uvTransform = field === 'normalMap' ? materialUvTransforms(definition).normalRelative : null;
    material[field] = textureDescriptorFor(texture, field, { colorSpace, uvChannel, uvTransform }, limits, maps);
  }
  for (const [name, reference, colorSpace] of unlit ? [] : layerTextureReferences(definition)) {
    const texture = source.layerTextures?.[name];
    if (!texture) continue;
    material.layerMaps ??= {};
    material.layerMaps[name] = textureDescriptorFor(texture, name, { colorSpace, uvChannel: uvChannelOf(reference) }, limits, maps);
  }
  return material;
}

/** Parse a bounded glTF 2.0 asset into Renderer67 parts. Draco, meshopt and KTX2 decoders come from options.decoders. */
export async function parseGltf(data, options = {}) {
  const limits = limitsFor(options);
  const document = documentFrom(data, limits.maxBytes);
  const decoders = options.decoders ?? {};
  const { ignoredExtensions } = validateDocument(document, limits, allowedExtensionsFor(decoders));
  await loadLayerShadersFor(document);
  const warnings = [...ignoredExtensions.map(extension => `${extension} is accepted but not rendered.`), ...skippedPrimitiveWarnings(document)];
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
  const { resourceBytes, textureScaling } = await prepareResources(document, data, dataBytes, options, limits);
  if (textureScaling.scaledTextures.length) {
    const names = textureScaling.scaledTextures.map(({ name, from, to }) => `${name} ${from.join('x')} to ${to.join('x')}`);
    warnings.push(`Scaled ${names.length} texture image(s) to fit maxTexturePixels: ${names.join(', ')}.`);
  }
  let gltf;
  try {
    gltf = await decodeGltf({ document, glbBinary: binaryChunk(data), resourceBytes, decoders, limits, imageTargets: textureScaling.targetByImageIndex });
    const parts = [];
    const bindings = [];
    const skinBindings = [];
    const morphBindings = [];
    const geometries = new Map();
    const morphMetadata = new Map();
    const materials = new Map();
    const maps = new Map();
    const nodes = [];
    const meshNamesWithIgnoredAlpha = new Set();
    const lightNodes = [];
    const pendingTransform = new Matrix4();
    const pendingNodeMatrix = new Float32Array(16);
    let actualVertices = 0;
    gltf.scene.traverse(node => {
      nodes.push(node);
      const sourceNodeIndex = node.association?.nodes;
      if (sourceNodeIndex !== undefined && document.nodes?.[sourceNodeIndex]?.extensions?.KHR_lights_punctual) {
        lightNodes.push({ nodeIndex: sourceNodeIndex, matrix: Array.from(node.matrixWorld.elements) });
      }
      if (!node.isMesh) return;
      const association = node.association;
      const primitive = document.meshes?.[association?.meshes]?.primitives?.[association?.primitives];
      if (!primitive) throw new Error('Decoded mesh requires a valid original primitive association.');
      if (Array.isArray(node.material)) throw new Error('Multiple materials on one decoded primitive are unsupported.');
      const materialIndex = node.material.materialIndex;
      const uvTransform = materialUvTransforms(document.materials?.[materialIndex] ?? {}).shared;
      const uvKey = uvTransformKey(uvTransform);
      const secondUvSet = usesSecondUvSet(document.materials?.[materialIndex]);
      if (!materials.has(node.material)) materials.set(node.material, convertMaterial(node.material, limits, maps, document.materials?.[materialIndex]));
      const material = materials.get(node.material);
      for (const instanceMatrix of instanceMatricesOf(node, limits.maxInstances)) {
        const determinant = worldMatrixOf(node, instanceMatrix, pendingTransform).determinant();
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Mesh world transform is singular or non-finite.');
        const mirrored = determinant < 0;
        const geometryMirrored = node.isSkinnedMesh ? false : mirrored;
        const geometryKey = `${node.geometry.uuid}:${geometryMirrored}:${uvKey}:${secondUvSet}`;
        if (!geometries.has(geometryKey)) {
          actualVertices += node.geometry.attributes.position.count * (1 + (primitive.targets?.length ?? 0));
          if (actualVertices > limits.maxVertices) throw new Error('Decoded geometry exceeds maxVertices.');
          const converted = convertGeometry(node.geometry, geometryMirrored, primitive, secondUvSet, () => meshNamesWithIgnoredAlpha.add(node.name));
          if (converted.uvs) bakeUvTransform(converted.uvs, uvTransform);
          geometries.set(geometryKey, converted);
        }
        const geometry = geometries.get(geometryKey);
        const firstSetMaps = [...MATERIAL_TEXTURES.map(([field]) => material[field]), ...Object.values(material.layerMaps ?? {})];
        if (firstSetMaps.some(map => map && map.uvChannel === 0) && !geometry.uvs) throw new Error('Material textures require TEXCOORD_0.');
        const part = { name: node.name || `glTF mesh ${parts.length + 1}`, geometry, matrix: new Float32Array(worldMatrixOf(node, instanceMatrix, pendingTransform).elements), material };
        const transformBinding = { node, instanceMatrix, part, mirrored, matrix: part.matrix, pendingMatrix: new Float32Array(16) };
        let pendingSkin;
        if (node.isSkinnedMesh) {
          const binding = makeSkinBinding(node);
          prepareSkinBinding(binding, geometry);
          commitSkinBinding(binding);
          part.skin = binding.skin;
          skinBindings.push({ ...binding, geometry });
          pendingSkin = binding.pendingPose;
        }
        validateSkinGeometry(geometry, part.skin);
        transformBinding.skin = part.skin;
        if (geometry.morphTargets) {
          const binding = makeMorphBinding(node, geometry, morphMetadata);
          part.morph = binding.pose;
          validateMorphTransform(binding.pose, binding.metadata, part.matrix, part.skin);
          morphBindings.push({ ...binding, part, pendingMatrix: transformBinding.pendingMatrix, pendingSkin });
        }
        if (!Array.from(part.matrix).every(Number.isFinite)) throw new Error('Mesh world matrix must be finite.');
        parts.push(part);
        bindings.push(transformBinding);
        if (parts.length > limits.maxParts) throw new Error('Decoded parts exceed maxParts.');
      }
    });
    validateNodeTransforms(nodes, pendingNodeMatrix, pendingTransform);
    if (!parts.length) throw new Error('glTF scene contains no supported triangle meshes.');
    const { lights, warnings: lightWarnings } = readPunctualLights(document, lightNodes);
    warnings.push(...lightWarnings);
    if (meshNamesWithIgnoredAlpha.size) {
      warnings.push(`Ignored the alpha of RGBA COLOR_0 vertex colors in ${[...meshNamesWithIgnoredAlpha].join(', ')}; only the RGB is used.`);
    }
    const sourceNodes = new Map();
    for (const node of nodes) {
      const index = node.association.nodes;
      if (index === undefined) continue;
      const id = `node-${index}`;
      if (sourceNodes.has(id)) {
        throw new Error('Decoded source node IDs must not alias.');
      }
      sourceNodes.set(id, node);
    }
    const sourceIds = new Map([...sourceNodes].map(([id, node]) => [node, id]));
    const jointNodes = new Set(skinBindings.flatMap(binding => binding.node.skeleton.bones));
    const meshIdsByNode = new Map([...sourceNodes.values()].map(node => [node, []]));
    for (let index = 0; index < bindings.length; index++) {
      let ancestor = bindings[index].node;
      while (ancestor && !sourceIds.has(ancestor)) ancestor = ancestor.parent;
      if (!ancestor) {
        throw new Error('Decoded mesh requires a stable source node association.');
      }
      meshIdsByNode.get(ancestor).push(`mesh-${index}`);
    }
    const nodeMetadata = [...sourceNodes].map(([id, node]) => {
      let parent = node.parent;
      while (parent && !sourceIds.has(parent)) parent = parent.parent;
      const original = document.nodes[Number(id.slice(5))];
      const composed = new Matrix4().compose(node.position, node.quaternion, node.scale);
      const authoredMatrix = original.matrix ?? node.matrix.elements;
      const editable = node.scale.toArray().every(value => value > 0 && Math.fround(value) > 0) &&
        composed.determinant() > 0 && authoredMatrix.every((value, index) =>
          Math.abs(value - composed.elements[index]) <= 1e-6 * Math.max(1, Math.abs(value)));
      const meshIds = meshIdsByNode.get(node);
      // `name` is the decoded node name, which clip tracks address; `label` is the name as authored in the file.
      return { id, label: String(original.name ?? id).slice(0, 256), name: node.name, parent: sourceIds.get(parent) ?? null,
        translation: node.position.toArray(), rotation: node.quaternion.toArray(), scale: node.scale.toArray(),
        editable, joint: jointNodes.has(node), meshIds };
    });
    const metadataById = new Map(nodeMetadata.map(metadata => [metadata.id, metadata]));
    const candidateParts = bindings.map(binding => ({ ...binding.part, matrix: binding.pendingMatrix }));
    for (const binding of skinBindings) {
      const index = bindings.findIndex(transform => transform.node === binding.node);
      candidateParts[index].skin = Object.assign(binding.pendingPose, {
        joints: binding.skin.joints, inverseBindMatrices: binding.skin.inverseBindMatrices,
        jointWorldMatrices: binding.pendingWorld, bindMatrix: binding.skin.bindMatrix,
      });
    }
    for (const binding of morphBindings) {
      candidateParts[bindings.findIndex(transform => transform.node === binding.node)].morph = binding.pendingPose;
    }
    let disposed = false;
    let pendingTransaction;
    let currentAnimation = null;

    function capturePrivatePose() {
      return nodes.map(node => ({ node, translation: node.position.toArray(), rotation: node.quaternion.toArray(),
        scale: node.scale.toArray(), matrix: [...node.matrix.elements], world: [...node.matrixWorld.elements],
        matrixAutoUpdate: node.matrixAutoUpdate, matrixWorldNeedsUpdate: node.matrixWorldNeedsUpdate,
        weights: node.morphTargetInfluences ? [...node.morphTargetInfluences] : null }));
    }

    function restorePrivatePose(snapshot) {
      for (const entry of snapshot) {
        entry.node.position.fromArray(entry.translation);
        entry.node.quaternion.fromArray(entry.rotation);
        entry.node.scale.fromArray(entry.scale);
        entry.node.matrix.fromArray(entry.matrix);
        entry.node.matrixWorld.fromArray(entry.world);
        entry.node.matrixAutoUpdate = entry.matrixAutoUpdate;
        entry.node.matrixWorldNeedsUpdate = entry.matrixWorldNeedsUpdate;
        if (entry.weights) {
          for (let index = 0; index < entry.weights.length; index++) {
            entry.node.morphTargetInfluences[index] = entry.weights[index];
          }
        }
      }
    }

    const basePose = capturePrivatePose();

    function playAnimation(animation) {
      restorePrivatePose(basePose);
      if (animation === null) {
        return;
      }
      applyClip(gltf.animations[animation.clip], animation.time);
    }

    function preparePose() {
      gltf.scene.updateMatrixWorld(true);
      validateNodeTransforms(nodes, pendingNodeMatrix, pendingTransform);
      const worldMatrix = new Matrix4();
      for (const { node, instanceMatrix, part, mirrored, matrix, pendingMatrix, skin } of bindings) {
        if (part.matrix !== matrix || matrix.length !== 16) {
          throw new Error('Imported part matrix identity must remain unchanged.');
        }
        if (part.skin !== skin) {
          throw new Error('Imported skin pose identity must remain unchanged.');
        }
        pendingMatrix.set(worldMatrixOf(node, instanceMatrix, worldMatrix).elements);
        for (const value of pendingMatrix) {
          if (!Number.isFinite(value)) {
            throw new Error('Animation creates a non-finite Float32 world matrix.');
          }
        }
        const determinant = worldMatrix.determinant();
        const roundedDeterminant = pendingTransform.fromArray(pendingMatrix).determinant();
        if (!Number.isFinite(determinant) || !Number.isFinite(roundedDeterminant) || Math.abs(roundedDeterminant) < 1e-12 || (determinant < 0) !== mirrored || (roundedDeterminant < 0) !== mirrored) {
          throw new Error('Animation creates a singular transform or changes triangle winding.');
        }
      }
      for (const binding of skinBindings) {
        prepareSkinBinding(binding, binding.geometry);
      }
      for (const binding of morphBindings) {
        if (binding.part.morph !== binding.pose) {
          throw new Error('Imported morph pose identity must remain unchanged.');
        }
        prepareMorphBinding(binding);
        validateMorphTransform(binding.pendingPose, binding.metadata, binding.pendingMatrix, binding.pendingSkin);
      }
    }

    function knownPoseFields(value, fields, label) {
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError(`${label} must be a plain object.`);
      }
      for (const field of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (typeof field !== 'string' || !fields.includes(field) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`Unknown or unsupported ${label} field: ${String(field)}.`);
        }
      }
    }

    function poseVector(value, length, label) {
      if (!Array.isArray(value) || value.length !== length || Reflect.ownKeys(value).length !== length + 1) {
        throw new TypeError(`${label} needs ${length} finite Float32 values.`);
      }
      const result = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isFinite(descriptor.value) || !Number.isFinite(Math.fround(descriptor.value))) {
          throw new TypeError(`${label} needs ${length} finite Float32 values.`);
        }
        result.push(descriptor.value);
      }
      return result;
    }

    function normalizePose(input) {
      knownPoseFields(input, ['animation', 'nodeOverrides', 'morphWeights'], 'pose');
      const animation = input.animation ?? null;
      if (animation !== null) {
        knownPoseFields(animation, ['clip', 'time'], 'pose animation');
        const clip = gltf.animations[animation.clip];
        if (!Number.isInteger(animation.clip) || !clip || !Number.isFinite(animation.time) || animation.time < 0 || animation.time > clip.duration) {
          throw new RangeError('Pose animation needs an existing clip and time within its duration.');
        }
      }
      const inputOverrides = input.nodeOverrides === undefined ? [] : input.nodeOverrides;
      const maximumOverrides = Math.min(4096, sourceNodes.size);
      if (!Array.isArray(inputOverrides) || inputOverrides.length > maximumOverrides ||
          Reflect.ownKeys(inputOverrides).length !== inputOverrides.length + 1) {
        throw new RangeError(`Pose overrides must be a dense array with at most ${maximumOverrides} entries.`);
      }
      const seen = new Set();
      const overrides = [];
      for (let index = 0; index < inputOverrides.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(inputOverrides, index);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('Pose overrides cannot contain holes or accessors.');
        }
        const override = descriptor.value;
        knownPoseFields(override, ['id', 'translation', 'rotation', 'scale'], 'node override');
        const metadata = metadataById.get(override.id);
        if (!metadata || seen.has(override.id)) {
          throw new RangeError('Pose node IDs must exist and be distinct.');
        }
        if (!metadata.editable) {
          throw new RangeError('Authored node poses require a positive TRS base without shear or reflection.');
        }
        seen.add(override.id);
        const result = { id: override.id };
        for (const field of ['translation', 'rotation', 'scale']) {
          if (Object.hasOwn(override, field)) {
            result[field] = poseVector(override[field], field === 'rotation' ? 4 : 3, field);
          }
        }
        if (Object.keys(result).length === 1) {
          throw new TypeError('A node override needs at least one transform field.');
        }
        if (result.rotation) {
          const length = Math.hypot(...result.rotation);
          if (!Number.isFinite(length) || length < 1e-8) {
            throw new RangeError('Pose rotation needs a nonzero quaternion.');
          }
          result.rotation = result.rotation.map(value => value / length);
        }
        if (result.scale?.some(value => Math.fround(value) <= 0)) {
          throw new RangeError('Pose scale must be positive at Float32 precision.');
        }
        overrides.push(result);
      }
      return { animation: animation === null ? null : { ...animation }, overrides, morphWeights: normalizeMorphWeights(input.morphWeights) };
    }

    /** Morph weights by part index: `[{ part, weights }]`, each part morphed and each weight finite and within 0 to 1. */
    function normalizeMorphWeights(input) {
      if (input === undefined) return [];
      if (!Array.isArray(input) || input.length > morphBindings.length || Reflect.ownKeys(input).length !== input.length + 1) {
        throw new RangeError(`Pose morphWeights must be a dense array with at most ${morphBindings.length} entries.`);
      }
      const seenParts = new Set();
      return input.map((entry, position) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, position);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Pose morphWeights cannot contain holes or accessors.');
        knownPoseFields(descriptor.value, ['part', 'weights'], 'morph weights');
        const binding = morphBindings.find(candidate => parts[descriptor.value.part] === candidate.part);
        if (!Number.isInteger(descriptor.value.part) || !binding || seenParts.has(descriptor.value.part)) {
          throw new RangeError('Pose morphWeights need distinct part indices of parts that have morph targets.');
        }
        seenParts.add(descriptor.value.part);
        const weights = poseVector(descriptor.value.weights, binding.weights.length, 'morph weights');
        if (weights.some(weight => weight < 0 || weight > 1)) throw new RangeError('Pose morph weights must be within 0 and 1.');
        return { binding, weights };
      });
    }

    function stagePose(input) {
      if (disposed) {
        throw new Error('The glTF asset was disposed.');
      }
      if (pendingTransaction) {
        throw new Error('A pose transaction is already pending. Commit or discard it first.');
      }
      const candidate = normalizePose(input);
      const previousPose = capturePrivatePose();
      const previousAnimation = currentAnimation;
      function rollback() {
        playAnimation(previousAnimation);
        restorePrivatePose(previousPose);
      }
      try {
        playAnimation(candidate.animation);
        for (const override of candidate.overrides) {
          const node = sourceNodes.get(override.id);
          if (override.translation) {
            node.position.fromArray(override.translation);
          }
          if (override.rotation) {
            node.quaternion.fromArray(override.rotation);
          }
          if (override.scale) {
            node.scale.fromArray(override.scale);
          }
          node.updateMatrix();
        }
        for (const { binding, weights } of candidate.morphWeights) {
          weights.forEach((weight, index) => {
            binding.node.morphTargetInfluences[index] = weight;
          });
        }
        preparePose();
      } catch (error) {
        rollback();
        throw error;
      }
      let settled = false;
      function requirePending() {
        if (disposed) {
          throw new Error('The glTF asset was disposed.');
        }
        if (settled) {
          throw new Error('The pose transaction is already settled.');
        }
      }
      const transaction = Object.freeze({
        parts: candidateParts,
        /** Local transform of every source node in this candidate pose, after the clip and overrides. */
        nodePoses() {
          requirePending();
          return [...sourceNodes].map(([id, node]) => ({ id, translation: node.position.toArray(), rotation: node.quaternion.toArray(), scale: node.scale.toArray() }));
        },
        commit() {
          requirePending();
          try {
            preparePose();
          } catch (error) {
            rollback();
            settled = true;
            pendingTransaction = null;
            throw error;
          }
          for (const { matrix, pendingMatrix } of bindings) {
            Float32Array.prototype.set.call(matrix, pendingMatrix);
          }
          for (const binding of skinBindings) {
            commitSkinBinding(binding);
          }
          for (const binding of morphBindings) {
            Float32Array.prototype.set.call(binding.weights, binding.pendingPose.weights);
          }
          currentAnimation = candidate.animation;
          settled = true;
          pendingTransaction = null;
          return parts;
        },
        discard() {
          requirePending();
          rollback();
          settled = true;
          pendingTransaction = null;
          return parts;
        },
      });
      pendingTransaction = transaction;
      return transaction;
    }

    function dispose() {
      if (disposed) {
        return;
      }
      pendingTransaction?.discard();
      disposed = true;
      gltf.release();
    }

    function applyAnimation(time, clipIndex = 0) {
      if (disposed) {
        throw new Error('The glTF asset was disposed.');
      }
      if (!Number.isFinite(time)) {
        throw new TypeError('Animation time must be finite.');
      }
      const clip = gltf.animations[clipIndex];
      if (!Number.isInteger(clipIndex) || !clip) {
        throw new RangeError('Animation clip index is out of range.');
      }
      return stagePose({ animation: { clip: clipIndex, time: Math.max(0, Math.min(time, clip.duration)) } }).commit();
    }
    return { parts, warnings, lights, scaledTextures: textureScaling.scaledTextures, skins: skinBindings.map(binding => binding.skin), animations: gltf.animations,
      get nodes() { return structuredClone(nodeMetadata); }, stagePose, applyAnimation, dispose, capabilities: GLTF_CAPABILITIES };
  } catch (error) {
    gltf?.release();
    throw error;
  }
}

/** Fetch a URL or read a local File/Blob, then parse it with the same limits. */
export async function loadGltf(source, options = {}) {
  const limits = limitsFor(options);
  if (typeof source === 'string' || source instanceof URL) {
    const url = new URL(String(source), globalThis.location?.href).href;
    if (!/^(https?:|blob:|data:)/.test(url)) throw new Error('Unsupported glTF source URL protocol.');
    const resource = await boundedFetch(url, limits.maxBytes, options.signal);
    const baseUrl = options.baseUrl ?? (/^https?:/.test(url) ? new URL('.', url).href : '');
    return parseGltf(resource.bytes.buffer, { ...options, baseUrl });
  }
  if (!source || typeof source.arrayBuffer !== 'function' || !Number.isSafeInteger(source.size)) {
    throw new TypeError('loadGltf expects a URL or a File/Blob.');
  }
  if (source.size > limits.maxBytes) throw new Error('Local glTF file exceeds maxBytes.');
  return parseGltf(await source.arrayBuffer(), options);
}
