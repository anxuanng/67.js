/**
 * A minimal four-wheel car as a GLB: a body box, a tail-light box with its own emissive material, and four
 * 16-sided wheels (radius 0.35 m) named like a real export. Forward is +z, wheelbase 2.4 m, track 1.4 m.
 */
export const CAR_WHEEL_RADIUS = 0.35;
export const CAR_WHEELBASE = 2.4;
export const CAR_TRACK = 1.4;

const WHEEL_SEGMENTS = 16;
const WHEEL_HALF_WIDTH = 0.12;

function boxGeometry(minimum, maximum) {
  const faces = [
    { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
    { normal: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
    { normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const face of faces) {
    const first = positions.length / 3;
    for (const corner of face.corners) {
      positions.push(...corner.map((flag, axis) => (flag ? maximum[axis] : minimum[axis])));
      normals.push(...face.normal);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions, normals, indices };
}

/** A cylinder whose axis is x, so a wheel at a car's side rolls about x when the car drives along z. */
function wheelGeometry() {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let segment = 0; segment < WHEEL_SEGMENTS; segment++) {
    const angle = (segment / WHEEL_SEGMENTS) * Math.PI * 2;
    const y = Math.cos(angle) * CAR_WHEEL_RADIUS;
    const z = Math.sin(angle) * CAR_WHEEL_RADIUS;
    for (const x of [-WHEEL_HALF_WIDTH, WHEEL_HALF_WIDTH]) {
      positions.push(x, y, z);
      normals.push(0, Math.cos(angle), Math.sin(angle));
    }
  }
  for (let segment = 0; segment < WHEEL_SEGMENTS; segment++) {
    const next = (segment + 1) % WHEEL_SEGMENTS;
    const a = segment * 2;
    const b = next * 2;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { positions, normals, indices };
}

function boundsOf(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return { minimum, maximum };
}

function packGlb(document, chunks, byteLength) {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const result = new ArrayBuffer(28 + jsonLength + byteLength);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, byteLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  chunks.forEach((chunk, index) => {
    bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), 28 + jsonLength + document.bufferViews[index].byteOffset);
  });
  return result;
}

export function carAsset() {
  const chunks = [];
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [], meshes: [], materials: [
      { name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.25, 0.7, 1], metallicFactor: 0.2, roughnessFactor: 0.4 } },
      { name: 'Rubber', pbrMetallicRoughness: { baseColorFactor: [0.03, 0.03, 0.03, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
      { name: 'TailLamp', pbrMetallicRoughness: { baseColorFactor: [0.5, 0, 0, 1] }, emissiveFactor: [1, 0.05, 0.05] },
    ],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  let offset = 0;
  function append(data, type, componentType = 5126) {
    const components = { SCALAR: 1, VEC3: 3 }[type];
    const accessor = document.accessors.length;
    document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength });
    chunks.push(data);
    offset += Math.ceil(data.byteLength / 4) * 4;
    document.buffers[0].byteLength = offset;
    document.accessors.push({ bufferView: chunks.length - 1, componentType, count: data.length / components, type });
    return accessor;
  }
  function addMesh(geometry, material) {
    const positionAccessor = append(new Float32Array(geometry.positions), 'VEC3');
    const { minimum, maximum } = boundsOf(geometry.positions);
    document.accessors[positionAccessor].min = minimum;
    document.accessors[positionAccessor].max = maximum;
    const attributes = { POSITION: positionAccessor, NORMAL: append(new Float32Array(geometry.normals), 'VEC3') };
    const indices = append(new Uint16Array(geometry.indices), 'SCALAR', 5123);
    document.meshes.push({ primitives: [{ attributes, indices, material }] });
    return document.meshes.length - 1;
  }
  const bodyMesh = addMesh(boxGeometry([-0.8, 0.4, -2.0], [0.8, 1.1, 2.0]), 0);
  const lampMesh = addMesh(boxGeometry([-0.6, 0.6, -0.04], [0.6, 0.8, 0.04]), 2);
  const wheelMesh = addMesh(wheelGeometry(), 1);
  const halfBase = CAR_WHEELBASE / 2;
  const halfTrack = CAR_TRACK / 2;
  document.nodes.push(
    { name: 'Car', children: [1, 2, 3, 4, 5, 6, 7] },
    { name: 'Body', mesh: bodyMesh },
    { name: 'TailLamp', mesh: lampMesh, translation: [0, 0, -2.04] },
    { name: 'Wheel_FL', mesh: wheelMesh, translation: [halfTrack, CAR_WHEEL_RADIUS, halfBase] },
    { name: 'Wheel_FR', mesh: wheelMesh, translation: [-halfTrack, CAR_WHEEL_RADIUS, halfBase] },
    { name: 'Wheel_RL', mesh: wheelMesh, translation: [halfTrack, CAR_WHEEL_RADIUS, -halfBase] },
    { name: 'Wheel_RR', mesh: wheelMesh, translation: [-halfTrack, CAR_WHEEL_RADIUS, -halfBase] },
    { name: 'Steering_Wheel_Cover', mesh: bodyMesh, translation: [0, 0.9, 0.5], scale: [0.1, 0.1, 0.1] },
  );
  return packGlb(document, chunks, offset);
}
