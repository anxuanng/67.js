import { validateMorphGeometry } from './morph.js';

function paddedLength(length) {
  return Math.ceil(length / 4) * 4;
}

export function exportGlb(parts) {
  for (const part of parts) {
    validateMorphGeometry(part.geometry, part.morph);
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
    const entry = { bufferView: viewIndex, componentType: data instanceof Float32Array ? 5126 : 5125, count: type === 'VEC3' ? data.length / 3 : data.length, type };
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
      document.materials.push({
        pbrMetallicRoughness: { baseColorFactor: [...part.material.color, 1], metallicFactor: part.material.metallic, roughnessFactor: part.material.roughness },
        emissiveFactor: part.material.color.map((component) => Math.min(1, component * (part.material.emission ?? 0))),
      });
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
