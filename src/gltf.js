import { AnimationMixer, LoadingManager, LoopOnce } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const GLTF_CAPABILITIES = Object.freeze({
  formats: ['glb', 'gltf'],
  supported: ['triangle meshes', 'world transforms', 'rigid node animations', 'PNG/JPEG base color textures', 'TEXCOORD_0', 'linear RGB vertex colors', 'metallic roughness factors', 'emissive factors', 'KHR_mesh_quantization', 'KHR_materials_emissive_strength'],
  unsupported: ['skinning', 'morph targets', 'vertex alpha below one', 'alpha blending or masking', 'double-sided materials', 'normal/occlusion/emissive/metallic-roughness textures', 'texture transforms', 'DRACO', 'KTX2', 'GPU instancing'],
});

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_VERTICES = 2_000_000;
const ALLOWED_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_materials_emissive_strength']);
const WRAPPING = { 1000: 10497, 1001: 33071, 1002: 33648 };
const FILTERING = { 1003: 9728, 1004: 9984, 1005: 9986, 1006: 9729, 1007: 9985, 1008: 9987 };

function limitsFor(options) {
  const limits = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxVertices: options.maxVertices ?? DEFAULT_MAX_VERTICES,
    maxParts: options.maxParts ?? 20_000,
    maxResources: options.maxResources ?? 64,
    maxTexturePixels: options.maxTexturePixels ?? 16_777_216,
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
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) throw new Error('Only glTF TRIANGLES primitives are supported.');
      if (primitive.targets?.length) throw new Error('Morph targets are unsupported.');
      const position = document.accessors?.[primitive.attributes?.POSITION];
      if (!position || position.type !== 'VEC3' || !Number.isSafeInteger(position.count) || position.count < 3) {
        throw new Error('Each mesh primitive requires a valid POSITION accessor.');
      }
      vertices += position.count;
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
  for (const node of document.nodes ?? []) {
    if (node.skin !== undefined) throw new Error('Skinned meshes are unsupported.');
    if (node.extensions && Object.keys(node.extensions).length) throw new Error('Node extensions are unsupported.');
  }
  validateHierarchy(document.nodes ?? []);
  for (const animation of document.animations ?? []) {
    for (const channel of animation.channels ?? []) {
      if (!['translation', 'rotation', 'scale'].includes(channel.target?.path)) throw new Error('Only rigid node translation, rotation and scale animations are supported.');
    }
  }
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
    if (material.normalTexture || material.occlusionTexture || material.emissiveTexture || material.pbrMetallicRoughness?.metallicRoughnessTexture) {
      throw new Error('Only base color textures are supported. Other material texture channels are unsupported.');
    }
    const texture = material.pbrMetallicRoughness?.baseColorTexture;
    if (texture && ((texture.texCoord ?? 0) !== 0 || texture.extensions && Object.keys(texture.extensions).length)) {
      throw new Error('Base color textures require TEXCOORD_0 without texture transforms.');
    }
  }
  let decodedBytes = 0;
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

function convertGeometry(source, mirrored) {
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
  return geometry;
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

function convertMaterial(source, limits, maps) {
  const material = {
    tag: 'gltf',
    color: source.color.toArray(),
    metallic: source.metalness,
    roughness: source.roughness,
    emission: source.emissiveIntensity ?? 1,
    emissiveColor: source.emissive.toArray(),
  };
  if (!material.emissiveColor.some(value => value > 0)) material.emission = 0;
  if (!Number.isFinite(Math.fround(material.emission)) || material.emission < 0) throw new Error('Emissive intensity must be a finite nonnegative float.');
  if (source.map) {
    if (!maps.has(source.map)) {
      const image = source.map.image;
      if (!image || image.width * image.height > limits.maxTexturePixels) throw new Error('Base color image is missing or exceeds maxTexturePixels.');
      maps.set(source.map, {
        image,
        uvChannel: 0,
        wrapS: WRAPPING[source.map.wrapS],
        wrapT: WRAPPING[source.map.wrapT],
        minFilter: FILTERING[source.map.minFilter],
        magFilter: FILTERING[source.map.magFilter],
        flipY: false,
        colorSpace: 'srgb',
      });
    }
    material.map = maps.get(source.map);
  }
  return material;
}

function releaseParsed(gltf) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  for (const scene of gltf.scenes) {
    scene.traverse(node => {
      if (node.geometry) geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
  }
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => {
    texture.image?.close?.();
    texture.dispose();
  });
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
  try {
    gltf = await new GLTFLoader(manager).parseAsync(data, options.baseUrl ?? '');
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    const bindings = [];
    const geometries = new Map();
    const materials = new Map();
    const maps = new Map();
    let actualVertices = 0;
    gltf.scene.traverse(node => {
      if (!node.isMesh) return;
      if (node.isSkinnedMesh || node.morphTargetInfluences?.length) throw new Error('Skinning and morph targets are unsupported.');
      if (Array.isArray(node.material)) throw new Error('Multiple materials on one decoded primitive are unsupported.');
      const materialIndex = gltf.parser.associations.get(node.material)?.materials;
      if (document.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture && !node.material.map) {
        throw new Error('Base color texture failed to decode. Use a valid PNG or JPEG image.');
      }
      const determinant = node.matrixWorld.determinant();
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Mesh world transform is singular or non-finite.');
      const mirrored = determinant < 0;
      const geometryKey = `${node.geometry.uuid}:${mirrored}`;
      if (!geometries.has(geometryKey)) {
        actualVertices += node.geometry.getAttribute('position').count;
        if (actualVertices > limits.maxVertices) throw new Error('Decoded geometry exceeds maxVertices.');
        geometries.set(geometryKey, convertGeometry(node.geometry, mirrored));
      }
      if (!materials.has(node.material)) materials.set(node.material, convertMaterial(node.material, limits, maps));
      const geometry = geometries.get(geometryKey);
      const material = materials.get(node.material);
      if (material.map && !geometry.uvs) throw new Error('A base color texture requires TEXCOORD_0.');
      const part = { name: node.name || `glTF mesh ${parts.length + 1}`, geometry, matrix: new Float32Array(node.matrixWorld.elements), material };
      if (!Array.from(part.matrix).every(Number.isFinite)) throw new Error('Mesh world matrix must be finite.');
      parts.push(part);
      bindings.push({ node, part, mirrored });
      if (parts.length > limits.maxParts) throw new Error('Decoded parts exceed maxParts.');
    });
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
      for (const { node, mirrored } of bindings) {
        const determinant = node.matrixWorld.determinant();
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12 || (determinant < 0) !== mirrored) {
          throw new Error('Animation creates a singular transform or changes triangle winding.');
        }
      }
      for (const { node, part } of bindings) part.matrix.set(node.matrixWorld.elements);
      return parts;
    }
    return { parts, animations: gltf.animations, applyAnimation, dispose, capabilities: GLTF_CAPABILITIES };
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
