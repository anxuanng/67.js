import { validateMorphGeometry, validateMorphPose } from './morph.js';

const EMISSIVE_STRENGTH = 'KHR_materials_emissive_strength';
const COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3 };

function validateFloatChannel(values, length, label, bounded = false) {
  if (!(values instanceof Float32Array) || values.length !== length) {
    throw new TypeError(`${label} requires a Float32Array matching the vertex count.`);
  }
  for (const value of values) {
    if (!Number.isFinite(value) || (bounded && (value < 0 || value > 1))) {
      throw new RangeError(`${label} requires finite values${bounded ? ' within [0,1]' : ''}.`);
    }
  }
}

const GLTF_ALPHA_MODES = { mask: 'MASK', blend: 'BLEND' };

function writeAlphaFields(gltfMaterial, material) {
  const alphaMode = material.alphaMode ?? 'opaque';
  if (alphaMode !== 'opaque') {
    if (!Object.hasOwn(GLTF_ALPHA_MODES, alphaMode)) throw new Error("alphaMode must be 'opaque', 'mask' or 'blend'.");
    gltfMaterial.alphaMode = GLTF_ALPHA_MODES[alphaMode];
    validateFactor(material.opacity ?? 1, 'opacity');
    gltfMaterial.pbrMetallicRoughness.baseColorFactor[3] = material.opacity ?? 1;
  }
  if (alphaMode === 'mask') {
    validateFactor(material.alphaCutoff ?? 0.5, 'alphaCutoff');
    gltfMaterial.alphaCutoff = material.alphaCutoff ?? 0.5;
  }
  if (material.doubleSided === true) gltfMaterial.doubleSided = true;
}

function validateFactor(value, label, maximum = 1) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < 0 || value > maximum) {
    throw new RangeError(`${label} requires a finite nonnegative Float32 value${maximum === 1 ? ' within [0,1]' : ''}.`);
  }
}

function validateColor(values, label) {
  if (!values || values.length !== 3) throw new TypeError(`${label} requires three linear RGB components.`);
  for (const value of values) validateFactor(value, label);
}

function validateGeometry(geometry) {
  const count = geometry?.positions?.length;
  if (!Number.isSafeInteger(count) || count < 3 || count % 3 !== 0) {
    throw new TypeError('GLB positions require a nonempty array of XYZ vertices.');
  }
  validateFloatChannel(geometry.positions, count, 'GLB positions');
  validateFloatChannel(geometry.normals, count, 'GLB normals');
  for (let offset = 0; offset < count; offset += 3) {
    const length = Math.hypot(geometry.normals[offset], geometry.normals[offset + 1], geometry.normals[offset + 2]);
    if (Math.abs(length - 1) > 0.001) throw new RangeError('GLB normals require unit vectors.');
  }
  if (geometry.colors !== undefined) validateFloatChannel(geometry.colors, count, 'GLB colors', true);
  if (geometry.uvs !== undefined) validateFloatChannel(geometry.uvs, count / 3 * 2, 'GLB UVs');
  if (!(geometry.indices instanceof Uint32Array) || geometry.indices.length === 0 || geometry.indices.length % 3 !== 0) {
    throw new TypeError('GLB indices require a nonempty Uint32Array of triangles.');
  }
  for (const index of geometry.indices) {
    if (index >= count / 3) throw new RangeError('GLB index exceeds the vertex count.');
  }
}

function validatePart(part) {
  if (!part.matrix || part.matrix.length !== 16 || Array.from(part.matrix).some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
    throw new RangeError('GLB matrix requires 16 finite components.');
  }
  if (part.matrix[3] !== 0 || part.matrix[7] !== 0 || part.matrix[11] !== 0 || part.matrix[15] !== 1) {
    throw new RangeError('GLB matrix requires an affine transform.');
  }
  validateTransformColumns(part.matrix);
  const material = part.material;
  if (!material || typeof material !== 'object') throw new TypeError('GLB parts require a material.');
  validateColor(material.color, 'GLB base color');
  validateColor(material.emissiveColor ?? material.color, 'GLB emissive color');
  validateFactor(material.metallic, 'GLB metallic factor');
  validateFactor(material.roughness, 'GLB roughness factor');
  validateFactor(material.emission ?? 0, 'GLB emission', Infinity);
}

function validateTransformColumns(matrix) {
  const columns = [0, 4, 8].map(offset => {
    const values = [Math.fround(matrix[offset]), Math.fround(matrix[offset + 1]), Math.fround(matrix[offset + 2])];
    const length = Math.hypot(...values);
    // Three's matrix decomposition divides by scale, so zero scales cannot roundtrip.
    if (length === 0) throw new RangeError('GLB matrix requires nonzero scales.');
    return values.map(value => value / length);
  });
  // Normalized column products remove scale dependence and allow Float32 TRS roundoff.
  const tolerance = 8 * 2 ** -23;
  for (let first = 0; first < 3; first++) {
    for (let second = first + 1; second < 3; second++) {
      let dot = 0;
      for (let axis = 0; axis < 3; axis++) dot += columns[first][axis] * columns[second][axis];
      if (Math.abs(dot) > tolerance) throw new RangeError('GLB matrix cannot preserve shear. Use a transform with orthogonal rotation and scale columns.');
    }
  }
}

function paddedLength(length) {
  return Math.ceil(length / 4) * 4;
}

export function exportGlb(parts) {
  if (!Array.isArray(parts) || parts.length === 0) throw new TypeError('GLB export requires a nonempty parts array.');
  const validatedGeometries = new Set();
  const morphMetadata = new Map();
  for (const part of parts) {
    if (!validatedGeometries.has(part?.geometry)) {
      validateGeometry(part?.geometry);
      validatedGeometries.add(part.geometry);
    }
    validatePart(part);
    const metadata = morphMetadata.get(part.geometry);
    if (metadata) {
      validateMorphPose(part.morph, metadata);
    } else {
      morphMetadata.set(part.geometry, validateMorphGeometry(part.geometry, part.morph));
    }
    if (part.skin || part.geometry.skinIndices || part.geometry.skinWeights) {
      throw new RangeError('GLB export cannot preserve skinning yet. Bake the pose or export through a tool that preserves the skeleton.');
    }
    for (const channel of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
      if (part.material[channel]) {
        throw new RangeError(`GLB export cannot preserve ${channel} yet. Texture export must be implemented before exporting this material.`);
      }
    }
  }
  const document = {
    asset: { version: '2.0', generator: '67.js' },
    scene: 0,
    scenes: [{ nodes: parts.map((_, index) => index) }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  const chunks = [];
  let byteLength = 0;
  const geometries = new Map();
  const materials = new Map();
  const meshes = new Map();
  function accessor(data, type, target) {
    const viewIndex = document.bufferViews.length;
    document.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, target });
    chunks.push({ offset: byteLength, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    byteLength += paddedLength(data.byteLength);
    const entry = { bufferView: viewIndex, componentType: data instanceof Float32Array ? 5126 : 5125, count: data.length / COMPONENT_COUNTS[type], type };
    if (type === 'VEC3') {
      entry.min = [Infinity, Infinity, Infinity];
      entry.max = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < data.length; index++) {
        const component = index % 3;
        entry.min[component] = Math.min(entry.min[component], data[index]);
        entry.max[component] = Math.max(entry.max[component], data[index]);
      }
    }
    document.accessors.push(entry);
    return document.accessors.length - 1;
  }
  for (const part of parts) {
    if (!geometries.has(part.geometry)) {
      const geometry = {
        attributes: { POSITION: accessor(part.geometry.positions, 'VEC3', 34962), NORMAL: accessor(part.geometry.normals, 'VEC3', 34962) },
        indices: accessor(part.geometry.indices, 'SCALAR', 34963),
      };
      if (part.geometry.colors) geometry.attributes.COLOR_0 = accessor(part.geometry.colors, 'VEC3', 34962);
      if (part.geometry.uvs) geometry.attributes.TEXCOORD_0 = accessor(part.geometry.uvs, 'VEC2', 34962);
      if (part.geometry.morphTargets) {
        geometry.targets = part.geometry.morphTargets.map(target => {
          const channels = {};
          if (target.positions) channels.POSITION = accessor(target.positions, 'VEC3', 34962);
          if (target.normals) channels.NORMAL = accessor(target.normals, 'VEC3', 34962);
          return channels;
        });
      }
      geometries.set(part.geometry, geometry);
    }
    const materialKey = JSON.stringify(part.material);
    if (!materials.has(materialKey)) {
      materials.set(materialKey, document.materials.length);
      const material = {
        pbrMetallicRoughness: { baseColorFactor: [...part.material.color, 1], metallicFactor: part.material.metallic, roughnessFactor: part.material.roughness },
        emissiveFactor: (part.material.emission ?? 0) === 0 ? [0, 0, 0] : Array.from(part.material.emissiveColor ?? part.material.color),
      };
      writeAlphaFields(material, part.material);
      const strength = part.material.emission ?? 0;
      if (strength !== 0 && strength !== 1) {
        material.extensions = { [EMISSIVE_STRENGTH]: { emissiveStrength: strength } };
        document.extensionsUsed = [EMISSIVE_STRENGTH];
        document.extensionsRequired = [EMISSIVE_STRENGTH];
      }
      document.materials.push(material);
    }
    const geometry = geometries.get(part.geometry);
    const material = materials.get(materialKey);
    const meshKey = `${geometry.indices}:${material}`;
    if (!meshes.has(meshKey)) {
      meshes.set(meshKey, document.meshes.length);
      document.meshes.push({ primitives: [{ ...geometry, material }] });
    }
    const node = { name: part.name, mesh: meshes.get(meshKey), matrix: Array.from(part.matrix) };
    if (part.morph) node.weights = Array.from(part.morph.weights);
    document.nodes.push(node);
  }
  document.buffers.push({ byteLength });
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = paddedLength(json.length);
  const result = new ArrayBuffer(12 + 8 + jsonLength + 8 + byteLength);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  header.setUint32(binaryHeader, byteLength, true);
  header.setUint32(binaryHeader + 4, 0x004e4942, true);
  for (const chunk of chunks) bytes.set(chunk.data, binaryHeader + 8 + chunk.offset);
  return result;
}

export function downloadGlb(parts) {
  const url = URL.createObjectURL(new Blob([exportGlb(parts)], { type: 'model/gltf-binary' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '67js-wall-e.glb';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
