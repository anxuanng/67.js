import { AnimationMixer, LoadingManager, LoopOnce, Matrix4 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { textureDescriptorInfo } from './renderer.js';
import { createSkinPose, updateSkinPose, validateSkinGeometry, validateSkinPose } from './skinning.js';
import { MAX_MORPH_TARGETS, createMorphPose, validateMorphGeometry, validateMorphPose, validateMorphTransform } from './morph.js';

export const GLTF_CAPABILITIES = Object.freeze({
  formats: ['glb', 'gltf'],
  supported: ['triangle meshes', 'world transforms', 'rigid node animations', 'four-influence skeletal skinning', 'joint node animations', 'relative POSITION/NORMAL morph targets', 'morph weight animations', 'PNG/JPEG base color textures', 'normal/occlusion/emissive/metallic-roughness textures', 'TEXCOORD_0', 'linear RGB vertex colors', 'metallic roughness factors', 'emissive factors', 'KHR_mesh_quantization', 'KHR_materials_emissive_strength'],
  unsupported: ['more than four skin influences', 'singular weighted skin transforms', 'reflected skin transforms', 'TANGENT morph targets', 'morph targets without authored base normals', 'vertex alpha below one', 'alpha blending or masking', 'double-sided materials', 'texture transforms', 'DRACO', 'KTX2', 'GPU instancing'],
});

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_VERTICES = 2_000_000;
const ALLOWED_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_materials_emissive_strength']);
const WRAPPING = { 1000: 10497, 1001: 33071, 1002: 33648 };
const FILTERING = { 1003: 9728, 1004: 9984, 1005: 9986, 1006: 9729, 1007: 9985, 1008: 9987 };
const MATERIAL_TEXTURES = [
  ['map', 'baseColorTexture', 'srgb'],
  ['normalMap', 'normalTexture', 'linear'],
  ['metallicRoughnessMap', 'metallicRoughnessTexture', 'linear'],
  ['occlusionMap', 'occlusionTexture', 'linear'],
  ['emissiveMap', 'emissiveTexture', 'srgb'],
];

function materialTexture(material, field) {
  return ['baseColorTexture', 'metallicRoughnessTexture'].includes(field) ? material.pbrMetallicRoughness?.[field] : material[field];
}

function limitsFor(options) {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxVertices: options.maxVertices ?? DEFAULT_MAX_VERTICES,
    maxParts: options.maxParts ?? 20_000,
    maxResources: options.maxResources ?? 64,
    maxTexturePixels: options.maxTexturePixels ?? 16_777_216,
    maxJoints: options.maxJoints ?? 4096,
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

function validateDocument(document, limits) {
  if (document.asset?.version !== '2.0') throw new Error('Only glTF 2.0 assets are supported.');
  const pending = [document];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const extension of Object.keys(value.extensions ?? {})) {
      if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Unsupported glTF extension: ${extension}.`);
    }
    pending.push(...Object.values(value).filter(child => child && typeof child === 'object'));
  }
  for (const extension of [...(document.extensionsUsed ?? []), ...(document.extensionsRequired ?? [])]) {
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`Unsupported glTF extension: ${extension}.`);
  }
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
      if ((primitive.mode ?? 4) !== 4) throw new Error('Only glTF TRIANGLES primitives are supported.');
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
    declaredParts += mesh?.primitives?.length ?? 0;
    if (declaredParts > limits.maxParts) throw new Error('glTF primitive instances exceed maxParts.');
    validateDefaultWeights(node.weights, morphCount(mesh));
    morphBytes += morphCount(mesh) * (mesh?.primitives?.length ?? 0) * 16;
    if (node.skin !== undefined) {
      if (!Number.isInteger(node.skin) || !document.skins?.[node.skin] || !document.meshes?.[node.mesh]) throw new Error('Invalid skinned mesh or skin index.');
      for (const primitive of document.meshes[node.mesh].primitives ?? []) {
        if (primitive.attributes?.JOINTS_0 === undefined || primitive.attributes?.WEIGHTS_0 === undefined) throw new Error('Skinned meshes require JOINTS_0 and WEIGHTS_0.');
        poseJointCount += document.skins[node.skin].joints.length;
        if (poseJointCount > limits.maxJoints) throw new Error('Instanced skin poses exceed maxJoints.');
      }
    }
    if (node.extensions && Object.keys(node.extensions).length) throw new Error('Node extensions are unsupported.');
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
    if ((material.alphaMode ?? 'OPAQUE') !== 'OPAQUE') throw new Error(`Unsupported alpha mode: ${material.alphaMode}.`);
    if (material.doubleSided) throw new Error('Double-sided materials are unsupported.');
    for (const [, field] of MATERIAL_TEXTURES) {
      const texture = materialTexture(material, field);
      if (!texture) continue;
      if ((texture.texCoord ?? 0) !== 0 || texture.extensions && Object.keys(texture.extensions).length) throw new Error(`${field} requires TEXCOORD_0 without texture transforms.`);
      if (!Number.isInteger(texture.index) || !document.textures?.[texture.index]) throw new Error(`Invalid ${field} texture index.`);
      if (field === 'normalTexture' && (!Number.isFinite(texture.scale ?? 1) || !Number.isFinite(Math.fround(texture.scale ?? 1)))) throw new Error('Normal texture scale must be a finite float.');
      if (field === 'occlusionTexture' && (!Number.isFinite(texture.strength ?? 1) || (texture.strength ?? 1) < 0 || (texture.strength ?? 1) > 1)) throw new Error('Occlusion texture strength must be within zero and one.');
    }
  }
  for (const texture of document.textures ?? []) {
    if (!Number.isInteger(texture.source) || !document.images?.[texture.source]) throw new Error('Invalid texture image index.');
    if (texture.sampler !== undefined && (!Number.isInteger(texture.sampler) || !document.samplers?.[texture.sampler])) throw new Error('Invalid texture sampler index.');
    const sampler = document.samplers?.[texture.sampler] ?? {};
    textureDescriptorInfo({ image: { width: 1, height: 1 }, ...sampler });
  }
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const material = document.materials?.[primitive.material];
      if (material && MATERIAL_TEXTURES.some(([, field]) => materialTexture(material, field)) && primitive.attributes?.TEXCOORD_0 === undefined) throw new Error('Material textures require TEXCOORD_0.');
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
  return vertices;
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

function validateImage(bytes, maxPixels) {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width;
  let height;
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
  if (!width || !height) throw new Error('Only valid PNG and JPEG texture images are supported.');
  if (width * height > maxPixels) throw new Error('Texture image exceeds maxTexturePixels before decoding.');
  return width * height;
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
  const resources = new Map();
  const resourceBytes = new Map();
  const objectUrls = [];
  const definitions = [...(document.buffers ?? []), ...(document.images ?? [])];
  const uris = new Set(definitions.map(resource => resource.uri).filter(uri => uri !== undefined));
  if (uris.size > limits.maxResources) throw new Error('glTF resources exceed maxResources.');
  let usedBytes = dataBytes;
  try {
    for (const uri of uris) {
      if (typeof uri !== 'string') throw new Error('Invalid glTF resource URI.');
      if (uri.startsWith('data:')) {
        resourceBytes.set(uri, dataUriBytes(uri));
        resources.set(uri, uri);
        continue;
      }
      if (!options.baseUrl && !/^(https?:|blob:)/.test(uri)) throw new Error('External glTF resources require baseUrl. Use GLB for a self-contained local file.');
      const resolved = new URL(uri, options.baseUrl || undefined).href;
      if (!/^(https?:|blob:)/.test(resolved)) throw new Error('Only HTTP, HTTPS, blob and embedded data resources are supported.');
      const resource = await boundedFetch(resolved, limits.maxBytes - usedBytes, options.signal);
      usedBytes += resource.bytes.byteLength;
      resourceBytes.set(uri, resource.bytes);
      const objectUrl = URL.createObjectURL(new Blob([resource.bytes], { type: resource.mimeType }));
      objectUrls.push(objectUrl);
      resources.set(resolved, objectUrl);
    }
    let texturePixels = 0;
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
      texturePixels += validateImage(bytes, limits.maxTexturePixels);
      if (texturePixels > limits.maxTexturePixels) throw new Error('Combined texture images exceed maxTexturePixels before decoding.');
    }
    return { resources, objectUrls };
  } catch (error) {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
}

function copyAttribute(attribute, size) {
  if (attribute.itemSize !== size) throw new Error(`Expected a ${size}-component mesh attribute.`);
  const result = new Float32Array(attribute.count * size);
  const getters = ['getX', 'getY', 'getZ', 'getW'];
  for (let vertex = 0; vertex < attribute.count; vertex++) {
    for (let component = 0; component < size; component++) {
      const value = attribute[getters[component]](vertex);
      if (!Number.isFinite(value)) throw new Error('Mesh attributes must contain finite values.');
      result[vertex * size + component] = value;
    }
  }
  return result;
}

function convertGeometry(source, mirrored, primitive) {
  const position = source.getAttribute('position');
  if (!source.getAttribute('normal')) source.computeVertexNormals();
  if (source.getAttribute('normal').count !== position.count) throw new Error('NORMAL and POSITION counts must match.');
  const geometry = { positions: copyAttribute(position, 3), normals: copyAttribute(source.getAttribute('normal'), 3) };
  for (let offset = 0; offset < geometry.normals.length; offset += 3) {
    const length = Math.hypot(...geometry.normals.subarray(offset, offset + 3));
    if (length < 1e-8) throw new Error('Degenerate geometry has no usable vertex normal.');
    for (let axis = 0; axis < 3; axis++) geometry.normals[offset + axis] /= length;
  }
  const sourceIndex = source.getIndex();
  geometry.indices = new Uint32Array(sourceIndex?.count ?? position.count);
  for (let index = 0; index < geometry.indices.length; index++) {
    const value = sourceIndex ? sourceIndex.getX(index) : index;
    if (!Number.isInteger(value) || value < 0 || value >= position.count) throw new Error('Mesh index is out of range.');
    geometry.indices[index] = value;
  }
  if (mirrored) {
    for (let index = 0; index < geometry.indices.length; index += 3) {
      const second = geometry.indices[index + 1];
      geometry.indices[index + 1] = geometry.indices[index + 2];
      geometry.indices[index + 2] = second;
    }
  }
  const uv = source.getAttribute('uv');
  if (uv && uv.count !== position.count) throw new Error('TEXCOORD_0 and POSITION counts must match.');
  if (uv) geometry.uvs = copyAttribute(uv, 2);
  const color = source.getAttribute('color');
  if (color) geometry.colors = convertVertexColors(color, position.count);
  const skinIndices = source.getAttribute('skinIndex');
  const skinWeights = source.getAttribute('skinWeight');
  if (skinIndices) geometry.skinIndices = new Uint16Array(copyAttribute(skinIndices, 4));
  if (skinWeights) geometry.skinWeights = copyAttribute(skinWeights, 4);
  if (primitive.targets?.length) {
    if (!source.morphTargetsRelative) throw new Error('Decoded morph targets must contain relative deltas.');
    geometry.morphTargets = primitive.targets.map((target, index) => {
      const channels = {};
      if (target.POSITION !== undefined) channels.positions = copyAttribute(source.morphAttributes.position[index], 3);
      if (target.NORMAL !== undefined) channels.normals = copyAttribute(source.morphAttributes.normal[index], 3);
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

function copyPrimitiveAssociations(original, decoded, associations) {
  const association = associations.get(original);
  if (original.isMesh && !association) throw new Error('Decoded mesh lost its original primitive association.');
  if (association) associations.set(decoded, association);
  if (original.children.length !== decoded.children.length) throw new Error('Decoded scene clone changed the node hierarchy.');
  for (let index = 0; index < original.children.length; index++) {
    copyPrimitiveAssociations(original.children[index], decoded.children[index], associations);
  }
}

function skinPreflightPlugin(parser, document, primitiveAssociations) {
  let originalRoots;
  return {
    name: '67SkinPreflight',
    async beforeRoot() {
      for (const mesh of document.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
          for (const target of primitive.targets ?? []) {
            for (const accessor of Object.values(target)) copyAttribute(await parser.getDependency('accessor', accessor), 3);
          }
        }
      }
      for (const animation of document.animations ?? []) {
        for (const channel of animation.channels ?? []) {
          if (channel.target.node === undefined) continue;
          const sampler = animation.samplers[channel.sampler];
          const input = copyAttribute(await parser.getDependency('accessor', sampler.input), 1);
          for (let index = 0; index < input.length; index++) {
            if (input[index] < 0 || index && input[index] <= input[index - 1]) throw new Error('Animation times must be nonnegative and strictly increasing.');
          }
          const size = channel.target.path === 'rotation' ? 4 : channel.target.path === 'weights' ? 1 : 3;
          const output = copyAttribute(await parser.getDependency('accessor', sampler.output), size);
          if (channel.target.path === 'rotation') {
            const cubic = sampler.interpolation === 'CUBICSPLINE';
            for (let offset = cubic ? 4 : 0; offset < output.length; offset += cubic ? 12 : 4) {
              const length = Math.hypot(output[offset], output[offset + 1], output[offset + 2], output[offset + 3]);
              if (Math.abs(length - 1) > 0.01) throw new Error('Animation rotation values require unit quaternions.');
            }
          }
        }
      }
      for (const node of document.nodes ?? []) {
        if (node.skin === undefined) continue;
        const pose = createSkinPose(document.skins[node.skin].joints.length);
        for (const primitive of document.meshes[node.mesh].primitives) {
          const [joints, weights] = await Promise.all([
            parser.getDependency('accessor', primitive.attributes.JOINTS_0),
            parser.getDependency('accessor', primitive.attributes.WEIGHTS_0),
          ]);
          validateSkinGeometry({ positions: { length: weights.count * 3 }, skinIndices: copyAttribute(joints, 4), skinWeights: copyAttribute(weights, 4) }, pose);
        }
      }
      // loadScene reduces parser.associations globally, so capture before any scene loads.
      const rootIndices = new Set();
      for (const scene of document.scenes ?? []) {
        for (const root of scene.nodes ?? []) rootIndices.add(root);
      }
      const roots = await Promise.all(Array.from(rootIndices, async index => [index, await parser.getDependency('node', index)]));
      originalRoots = new Map(roots);
      for (const [node, association] of parser.associations) {
        if (node.isMesh) primitiveAssociations.set(node, Object.freeze({ ...association }));
      }
    },
    afterRoot(result) {
      for (let index = 0; index < result.scenes.length; index++) {
        const roots = document.scenes[index].nodes ?? [];
        const scene = result.scenes[index];
        if (roots.length !== scene.children.length) throw new Error('Decoded scene root count changed.');
        for (let root = 0; root < roots.length; root++) {
          copyPrimitiveAssociations(originalRoots.get(roots[root]), scene.children[root], primitiveAssociations);
        }
      }
    },
  };
}

function convertVertexColors(attribute, vertexCount) {
  if (attribute.count !== vertexCount || ![3, 4].includes(attribute.itemSize)) {
    throw new Error('COLOR_0 requires matching RGB or RGBA vertex values.');
  }
  const values = copyAttribute(attribute, attribute.itemSize);
  const colors = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * attribute.itemSize;
    if (attribute.itemSize === 4 && values[offset + 3] !== 1) {
      throw new Error('Vertex alpha is unsupported. Every COLOR_0 alpha value must equal one.');
    }
    for (let component = 0; component < 3; component++) {
      const value = values[offset + component];
      if (value < 0 || value > 1) throw new Error('COLOR_0 RGB values must be within zero and one.');
      colors[vertex * 3 + component] = value;
    }
  }
  return colors;
}

function convertMaterial(source, limits, maps, definition = {}) {
  const material = {
    tag: 'gltf',
    color: source.color.toArray(),
    metallic: source.metalness,
    roughness: source.roughness,
    emission: source.emissiveIntensity ?? 1,
    emissiveColor: source.emissive.toArray(),
    normalScale: [definition.normalTexture?.scale ?? 1, definition.normalTexture?.scale ?? 1],
    occlusionStrength: source.aoMapIntensity,
  };
  if (!material.emissiveColor.some(value => value > 0)) material.emission = 0;
  if (!Number.isFinite(Math.fround(material.emission)) || material.emission < 0) throw new Error('Emissive intensity must be a finite nonnegative float.');
  for (const [field, , colorSpace] of MATERIAL_TEXTURES) {
    const texture = source[field === 'metallicRoughnessMap' ? 'metalnessMap' : field === 'occlusionMap' ? 'aoMap' : field];
    if (!texture) continue;
    if (!maps.has(texture)) maps.set(texture, new Map());
    const descriptors = maps.get(texture);
    if (!descriptors.has(colorSpace)) {
      const image = texture.image;
      if (!image || image.width * image.height > limits.maxTexturePixels) throw new Error(`${field} image is missing or exceeds maxTexturePixels.`);
      const descriptor = {
        image,
        uvChannel: 0,
        wrapS: WRAPPING[texture.wrapS],
        wrapT: WRAPPING[texture.wrapT],
        minFilter: FILTERING[texture.minFilter],
        magFilter: FILTERING[texture.magFilter],
        flipY: false,
        colorSpace,
      };
      textureDescriptorInfo(descriptor);
      descriptors.set(colorSpace, descriptor);
    }
    material[field] = descriptors.get(colorSpace);
  }
  return material;
}

function releaseParsed(gltf) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const images = new Set();
  const skeletons = new Set();
  for (const scene of gltf.scenes) {
    scene.traverse(node => {
      if (node.geometry) geometries.add(node.geometry);
      if (node.skeleton) skeletons.add(node.skeleton);
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
  }
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => {
    if (texture.image) images.add(texture.image);
    texture.dispose();
  });
  images.forEach(image => image.close?.());
  skeletons.forEach(skeleton => skeleton.dispose());
}

/** Parse a bounded glTF 2.0 asset into Renderer67 parts. Three.js only decodes the asset. */
export async function parseGltf(data, options = {}) {
  const limits = limitsFor(options);
  const document = documentFrom(data, limits.maxBytes);
  validateDocument(document, limits);
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
  const { resources, objectUrls } = await prepareResources(document, data, dataBytes, options, limits);
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (resources.has(url)) return resources.get(url);
    const normalized = new URL(url, options.baseUrl || undefined).href;
    if (resources.has(normalized)) return resources.get(normalized);
    if (url.startsWith('blob:')) return url;
    throw new Error(`Unregistered glTF resource: ${url}.`);
  });
  let gltf;
  const primitiveAssociations = new WeakMap();
  try {
    const loader = new GLTFLoader(manager);
    loader.register(parser => skinPreflightPlugin(parser, document, primitiveAssociations));
    gltf = await loader.parseAsync(data, options.baseUrl ?? '');
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    const bindings = [];
    const skinBindings = [];
    const morphBindings = [];
    const geometries = new Map();
    const morphMetadata = new Map();
    const materials = new Map();
    const maps = new Map();
    const nodes = [];
    const pendingTransform = new Matrix4();
    const pendingNodeMatrix = new Float32Array(16);
    let actualVertices = 0;
    gltf.scene.traverse(node => {
      nodes.push(node);
      if (!node.isMesh) return;
      const association = primitiveAssociations.get(node);
      const primitive = document.meshes?.[association?.meshes]?.primitives?.[association?.primitives];
      if (!primitive) throw new Error('Decoded mesh requires a valid original primitive association.');
      if (Array.isArray(node.material)) throw new Error('Multiple materials on one decoded primitive are unsupported.');
      const materialIndex = gltf.parser.associations.get(node.material)?.materials;
      for (const [field, sourceField] of MATERIAL_TEXTURES) {
        const decodedField = field === 'metallicRoughnessMap' ? 'metalnessMap' : field === 'occlusionMap' ? 'aoMap' : field;
        if (materialTexture(document.materials?.[materialIndex] ?? {}, sourceField) && !node.material[decodedField]) throw new Error(`${sourceField} failed to decode. Use a valid PNG or JPEG image.`);
      }
      const determinant = node.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Mesh world transform is singular or non-finite.');
      const mirrored = determinant < 0;
      const geometryMirrored = node.isSkinnedMesh ? false : mirrored;
      const geometryKey = `${node.geometry.uuid}:${geometryMirrored}`;
      if (!geometries.has(geometryKey)) {
        actualVertices += node.geometry.getAttribute('position').count * (1 + (primitive.targets?.length ?? 0));
        if (actualVertices > limits.maxVertices) throw new Error('Decoded geometry exceeds maxVertices.');
        geometries.set(geometryKey, convertGeometry(node.geometry, geometryMirrored, primitive));
      }
      if (!materials.has(node.material)) materials.set(node.material, convertMaterial(node.material, limits, maps, document.materials?.[materialIndex]));
      const geometry = geometries.get(geometryKey);
      const material = materials.get(node.material);
      if (MATERIAL_TEXTURES.some(([field]) => material[field]) && !geometry.uvs) throw new Error('Material textures require TEXCOORD_0.');
      const part = { name: node.name || `glTF mesh ${parts.length + 1}`, geometry, matrix: new Float32Array(node.matrixWorld.elements), material };
      const transformBinding = { node, part, mirrored, matrix: part.matrix, pendingMatrix: new Float32Array(16) };
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
    });
    validateNodeTransforms(nodes, pendingNodeMatrix, pendingTransform);
    if (!parts.length) throw new Error('glTF scene contains no supported triangle meshes.');
    const mixer = new AnimationMixer(gltf.scene);
    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      mixer.stopAllAction();
      mixer.uncacheRoot(gltf.scene);
      releaseParsed(gltf);
      objectUrls.forEach(url => URL.revokeObjectURL(url));
    }
    function applyAnimation(time, clipIndex = 0) {
      if (disposed) throw new Error('The glTF asset was disposed.');
      if (!Number.isFinite(time)) throw new TypeError('Animation time must be finite.');
      if (!Number.isInteger(clipIndex) || !gltf.animations[clipIndex]) throw new RangeError('Animation clip index is out of range.');
      const clip = gltf.animations[clipIndex];
      mixer.stopAllAction();
      const action = mixer.clipAction(clip);
      action.reset();
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      mixer.setTime(Math.max(0, Math.min(time, clip.duration)));
      gltf.scene.updateMatrixWorld(true);
      validateNodeTransforms(nodes, pendingNodeMatrix, pendingTransform);
      for (const { node, part, mirrored, matrix, pendingMatrix, skin } of bindings) {
        if (part.matrix !== matrix || matrix.length !== 16) throw new Error('Imported part matrix identity must remain unchanged.');
        if (part.skin !== skin) throw new Error('Imported skin pose identity must remain unchanged.');
        pendingMatrix.set(node.matrixWorld.elements);
        for (const value of pendingMatrix) if (!Number.isFinite(value)) throw new Error('Animation creates a non-finite Float32 world matrix.');
        const determinant = node.matrixWorld.determinant();
        const roundedDeterminant = pendingTransform.fromArray(pendingMatrix).determinant();
        if (!Number.isFinite(determinant) || !Number.isFinite(roundedDeterminant) || Math.abs(roundedDeterminant) < 1e-12 || (determinant < 0) !== mirrored || (roundedDeterminant < 0) !== mirrored) {
          throw new Error('Animation creates a singular transform or changes triangle winding.');
        }
      }
      for (const binding of skinBindings) prepareSkinBinding(binding, binding.geometry);
      for (const binding of morphBindings) {
        if (binding.part.morph !== binding.pose) throw new Error('Imported morph pose identity must remain unchanged.');
        prepareMorphBinding(binding);
        validateMorphTransform(binding.pendingPose, binding.metadata, binding.pendingMatrix, binding.pendingSkin);
      }
      for (const { matrix, pendingMatrix } of bindings) matrix.set(pendingMatrix);
      for (const binding of skinBindings) commitSkinBinding(binding);
      for (const binding of morphBindings) binding.weights.set(binding.pendingPose.weights);
      return parts;
    }
    return { parts, skins: skinBindings.map(binding => binding.skin), animations: gltf.animations, applyAnimation, dispose, capabilities: GLTF_CAPABILITIES };
  } catch (error) {
    if (gltf) releaseParsed(gltf);
    objectUrls.forEach(url => URL.revokeObjectURL(url));
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
