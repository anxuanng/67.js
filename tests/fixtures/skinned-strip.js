/** Two-joint strip with blended middle vertices and a visibly bending upper segment. */
export function skinnedStripAsset(edit = () => {}) {
  const chunks = [];
  const document = {
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Character', translation: [1, 2, 0], children: [1, 2] },
      { name: 'Strip', mesh: 0, skin: 0 },
      { name: 'Root', children: [3] },
      { name: 'Tip', translation: [0, 1, 0] },
    ],
    meshes: [{ primitives: [{ attributes: {}, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.7, 0.2, 0.1, 1], metallicFactor: 0.1, roughnessFactor: 0.6 } }],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
    skins: [{ joints: [2, 3], skeleton: 2 }],
    animations: [],
  };
  let offset = 0;
  function append(data, type, normalized = false) {
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const accessor = document.accessors.length;
    chunks.push(data);
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    offset += Math.ceil(data.byteLength / 4) * 4;
    document.buffers[0].byteLength = offset;
    document.accessors.push({ bufferView: chunks.length - 1, componentType: data instanceof Uint16Array ? 5123 : data instanceof Uint8Array ? 5121 : 5126, count: data.length / components, type, normalized });
    return accessor;
  }
  const primitive = document.meshes[0].primitives[0];
  primitive.attributes.POSITION = append(new Float32Array([-0.3, 0, 0, 0.3, 0, 0, -0.3, 1, 0, 0.3, 1, 0, -0.3, 2, 0, 0.3, 2, 0]), 'VEC3');
  document.accessors[primitive.attributes.POSITION].min = [-0.3, 0, 0];
  document.accessors[primitive.attributes.POSITION].max = [0.3, 2, 0];
  primitive.attributes.NORMAL = append(new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat()), 'VEC3');
  primitive.attributes.TEXCOORD_0 = append(new Float32Array([0, 0, 1, 0, 0, 0.5, 1, 0.5, 0, 1, 1, 1]), 'VEC2');
  primitive.attributes.JOINTS_0 = append(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4');
  primitive.attributes.WEIGHTS_0 = append(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 'VEC4');
  primitive.indices = append(new Uint16Array([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]), 'SCALAR');
  document.skins[0].inverseBindMatrices = append(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]), 'MAT4');
  const times = append(new Float32Array([0, 2]), 'SCALAR');
  const rotations = append(new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]), 'VEC4');
  const translations = append(new Float32Array([0, 0, 0, 2, 0, 0]), 'VEC3');
  document.animations = [
    { name: 'Bend', samplers: [{ input: times, output: rotations, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 3, path: 'rotation' } }] },
    { name: 'Move', samplers: [{ input: times, output: translations, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }] },
  ];
  edit(document, append, chunks);
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + offset);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, offset, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  chunks.forEach((chunk, index) => bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), 28 + jsonLength + document.bufferViews[index].byteOffset));
  return result;
}
