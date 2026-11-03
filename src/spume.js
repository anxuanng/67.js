import { mat4 } from 'gl-matrix';
import './liquid-shader.js';

// Plays back a liquid bake from Spume (https://github.com/codepawl/spume).
// Spume bakes offline on an NVIDIA GPU; this addon only reads its cache folder:
// meta.json, frame_NNNN.glb (int16 positions over the accessor bounds, int8 normals),
// spray.bin (float16 x y z vx vy vz), spray_ids.bin (uint32) and spray_kinds.bin (uint8, optional).

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;
const COMPONENT_SHORT = 5122;
const COMPONENT_BYTE = 5120;
const SPRAY_FLOATS_PER_POINT = 6;
const MAX_FRAMES = 100000;

export const SPRAY_KINDS = Object.freeze({ spray: 0, foam: 1, bubble: 2 });

// `liquid` colour is what one metre of water lets through; `foam` draws soft blended droplets.
export const DEFAULT_WATER_MATERIAL = Object.freeze({ tag: 'liquid', color: [0.56, 0.84, 0.88], metallic: 0, roughness: 0.05, emission: 0 });
export const DEFAULT_SPRAY_MATERIAL = Object.freeze({ tag: 'foam', color: [0.95, 0.97, 0.98], metallic: 0, roughness: 0.6, emission: 0 });

const KIND_TINTS = [[1, 1, 1], [0.93, 0.96, 0.97], [0.7, 0.82, 0.86]];
const KIND_RADIUS_SCALES = [1, 1.5, 0.6];

// An octahedron is the cheapest closed shape that still reads as a droplet once it is a few pixels wide.
const OCTAHEDRON_DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const OCTAHEDRON_TRIANGLES = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5];

export function float16ToFloat32(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function readGlbChunks(bytes) {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buffer);
  if (buffer.byteLength < 28 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new TypeError('Spume frame is not a binary glTF 2.0 file.');
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength + 8 > buffer.byteLength) {
    throw new TypeError('Spume frame has no JSON chunk.');
  }
  const description = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  const binaryHeader = 20 + jsonLength;
  const binaryLength = view.getUint32(binaryHeader, true);
  if (view.getUint32(binaryHeader + 4, true) !== BINARY_CHUNK || binaryHeader + 8 + binaryLength > buffer.byteLength) {
    throw new TypeError('Spume frame has no binary chunk.');
  }
  return { description, buffer, binaryOffset: binaryHeader + 8 };
}

function accessorBytes(chunks, accessorIndex, componentBytes, componentsPerElement) {
  const accessor = chunks.description.accessors?.[accessorIndex];
  const bufferView = chunks.description.bufferViews?.[accessor?.bufferView];
  if (!accessor || !bufferView) throw new TypeError('Spume frame references a missing accessor.');
  const length = accessor.count * componentsPerElement;
  const start = chunks.binaryOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (start + length * componentBytes > chunks.buffer.byteLength) throw new RangeError('Spume accessor runs past the binary chunk.');
  return { accessor, start, length };
}

// Spume quantises positions to int16 spread over each frame's own min..max box, so
// standard glTF loaders read them wrong; this restores metres.
export function decodeSpumeFrame(bytes) {
  const chunks = readGlbChunks(bytes);
  const primitive = chunks.description.meshes?.[0]?.primitives?.[0];
  if (!primitive || primitive.indices === undefined) throw new TypeError('Spume frame has no indexed mesh.');

  const position = accessorBytes(chunks, primitive.attributes.POSITION, 2, 3);
  if (position.accessor.componentType !== COMPONENT_SHORT || position.accessor.min?.length !== 3 || position.accessor.max?.length !== 3) {
    throw new TypeError('Spume positions must be int16 with min and max bounds.');
  }
  const quantised = new Int16Array(chunks.buffer.slice(position.start, position.start + position.length * 2));
  const positions = new Float32Array(position.length);
  const minimum = position.accessor.min;
  const span = position.accessor.max.map((maximum, axis) => Math.max(maximum - minimum[axis], 1e-6));
  for (let index = 0; index < positions.length; index++) {
    const axis = index % 3;
    positions[index] = minimum[axis] + (quantised[index] + 32768) / 65535 * span[axis];
  }

  const normal = accessorBytes(chunks, primitive.attributes.NORMAL, 1, 3);
  if (normal.accessor.componentType !== COMPONENT_BYTE) throw new TypeError('Spume normals must be int8.');
  const packedNormals = new Int8Array(chunks.buffer, normal.start, normal.length);
  const normals = new Float32Array(normal.length);
  for (let vertex = 0; vertex < normal.length; vertex += 3) {
    const x = Math.max(packedNormals[vertex] / 127, -1);
    const y = Math.max(packedNormals[vertex + 1] / 127, -1);
    const z = Math.max(packedNormals[vertex + 2] / 127, -1);
    const length = Math.hypot(x, y, z);
    if (length > 1e-6) {
      normals[vertex] = x / length;
      normals[vertex + 1] = y / length;
      normals[vertex + 2] = z / length;
    } else {
      normals[vertex + 1] = 1;
    }
  }

  const indexAccessor = chunks.description.accessors[primitive.indices];
  const indexBytes = indexAccessor?.componentType === COMPONENT_UNSIGNED_SHORT ? 2 : 4;
  if (![COMPONENT_UNSIGNED_SHORT, COMPONENT_UNSIGNED_INT].includes(indexAccessor?.componentType)) throw new TypeError('Spume indices must be uint16 or uint32.');
  const index = accessorBytes(chunks, primitive.indices, indexBytes, 1);
  const sourceIndices = indexBytes === 2
    ? new Uint16Array(chunks.buffer.slice(index.start, index.start + index.length * 2))
    : new Uint32Array(chunks.buffer.slice(index.start, index.start + index.length * 4));
  const indices = Uint32Array.from(sourceIndices);
  const vertexCount = positions.length / 3;
  if (indices.length % 3 !== 0 || !indices.every(value => value < vertexCount)) throw new RangeError('Spume frame triangles address missing vertices.');
  return { positions, normals, indices };
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new TypeError('Spume meta.json must be an object.');
  if (!Number.isFinite(meta.fps) || meta.fps <= 0) throw new RangeError('Spume meta.fps must be positive.');
  if (!Number.isInteger(meta.frameCount) || meta.frameCount < 1 || meta.frameCount > MAX_FRAMES) throw new RangeError(`Spume meta.frameCount must be between 1 and ${MAX_FRAMES}.`);
  if (typeof meta.frameFile !== 'string' || !meta.frameFile.includes('%04d')) throw new TypeError('Spume meta.frameFile must contain %04d.');
  const sprayIndex = meta.spray?.index;
  if (meta.spray && (!Array.isArray(sprayIndex) || sprayIndex.length !== meta.frameCount)) throw new RangeError('Spume spray index must list every frame.');
  if (meta.spray && meta.spray.floatsPerPoint !== SPRAY_FLOATS_PER_POINT) throw new RangeError('Spume spray must store six floats per point.');
}

export function frameFileName(meta, frameIndex) {
  return meta.frameFile.replace('%04d', String(frameIndex).padStart(4, '0'));
}

function readerFor(source) {
  if (typeof source === 'function') return source;
  if (typeof source === 'string' || source instanceof URL) {
    const base = String(source).endsWith('/') ? String(source) : `${source}/`;
    return async (name) => {
      const response = await fetch(new URL(name, new URL(base, globalThis.location?.href)));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Spume cache file ${name} failed with HTTP ${response.status}.`);
      return response.arrayBuffer();
    };
  }
  throw new TypeError('Spume cache source must be a folder URL or a read(name) function.');
}

/**
 * Reads a Spume cache folder. `source` is a folder URL, or `async (fileName) => ArrayBuffer | null`
 * for files from disk, a zip or a drop zone. Frames stay int16-packed until they are played.
 */
export async function loadSpumeCache(source) {
  const read = readerFor(source);
  const metaBytes = await read('meta.json');
  if (!metaBytes) throw new Error('Spume cache has no meta.json.');
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  validateMeta(meta);
  const frames = await Promise.all(Array.from({ length: meta.frameCount }, async (_, frameIndex) => {
    const bytes = await read(frameFileName(meta, frameIndex));
    if (!bytes) throw new Error(`Spume cache is missing ${frameFileName(meta, frameIndex)}.`);
    return bytes;
  }));
  let spray = null;
  if (meta.spray) {
    const totalPoints = meta.spray.index.reduce((total, [first, count]) => Math.max(total, first + count), 0);
    const [data, ids, kinds] = await Promise.all([read(meta.spray.file), read(meta.spray.ids), meta.spray.kinds ? read(meta.spray.kinds) : null]);
    if (totalPoints > 0) {
      if (!data || data.byteLength < totalPoints * SPRAY_FLOATS_PER_POINT * 2) throw new RangeError('Spume spray.bin is shorter than its index.');
      if (!ids || ids.byteLength < totalPoints * 4) throw new RangeError('Spume spray_ids.bin is shorter than its index.');
    }
    spray = {
      index: meta.spray.index,
      data: new Uint16Array(data ?? new ArrayBuffer(0), 0, totalPoints * SPRAY_FLOATS_PER_POINT),
      ids: new Uint32Array(ids ?? new ArrayBuffer(0), 0, totalPoints),
      // Caches from Spume 0.1 have no kinds file; every point then counts as spray.
      kinds: kinds && kinds.byteLength >= totalPoints ? new Uint8Array(kinds, 0, totalPoints) : null,
    };
  }
  return { meta, frames, spray, duration: meta.frameCount / meta.fps };
}

function hashUnit(value) {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}

function perpendicularAxes(direction) {
  const helper = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const first = [
    direction[1] * helper[2] - direction[2] * helper[1],
    direction[2] * helper[0] - direction[0] * helper[2],
    direction[0] * helper[1] - direction[1] * helper[0],
  ];
  const length = Math.hypot(...first);
  first[0] /= length;
  first[1] /= length;
  first[2] /= length;
  const second = [
    direction[1] * first[2] - direction[2] * first[1],
    direction[2] * first[0] - direction[0] * first[2],
    direction[0] * first[1] - direction[1] * first[0],
  ];
  return [first, second];
}

/**
 * Builds one static mesh of small octahedra for the frame's whitewater points.
 * Each droplet is stretched along its velocity by the distance it travels while the shutter is open,
 * the motion blur a camera gives fast spray, so it reads as a streak instead of a bead.
 * Returns null when no point of the requested kinds is in the frame.
 */
export function buildSprayGeometry(cache, frameIndex, { radius = 0.014, shutter = 1 / 60, kinds = ['spray', 'foam'], maxPoints = 12000 } = {}) {
  if (!(shutter >= 0 && shutter <= 1)) throw new RangeError('Spray shutter must be between 0 and 1 second.');
  const spray = cache.spray;
  if (!spray) return null;
  const [first, count] = spray.index[frameIndex];
  const allowedKinds = new Set(kinds.map(kind => {
    if (!(kind in SPRAY_KINDS)) throw new TypeError(`Unknown spray kind: ${kind}`);
    return SPRAY_KINDS[kind];
  }));
  const selected = [];
  for (let point = first; point < first + count; point++) {
    if (allowedKinds.has(spray.kinds ? spray.kinds[point] : SPRAY_KINDS.spray)) selected.push(point);
  }
  if (selected.length === 0) return null;
  // Thin evenly instead of keeping the first points, so a capped frame still covers the whole plume.
  const stride = Math.max(1, selected.length / maxPoints);
  const kept = Math.min(selected.length, maxPoints);
  const positions = new Float32Array(kept * 6 * 3);
  const normals = new Float32Array(kept * 6 * 3);
  const colors = new Float32Array(kept * 6 * 3);
  const indices = new Uint32Array(kept * OCTAHEDRON_TRIANGLES.length);
  for (let slot = 0; slot < kept; slot++) {
    const point = selected[Math.floor(slot * stride)];
    const kind = spray.kinds ? spray.kinds[point] : SPRAY_KINDS.spray;
    const pointRadius = radius * KIND_RADIUS_SCALES[kind] * (0.6 + 0.8 * hashUnit(spray.ids[point]));
    const base = point * SPRAY_FLOATS_PER_POINT;
    const center = [float16ToFloat32(spray.data[base]), float16ToFloat32(spray.data[base + 1]), float16ToFloat32(spray.data[base + 2])];
    const velocity = [float16ToFloat32(spray.data[base + 3]), float16ToFloat32(spray.data[base + 4]), float16ToFloat32(spray.data[base + 5])];
    const speed = Math.hypot(...velocity);
    const along = speed > 1e-3 ? velocity.map(component => component / speed) : [0, 1, 0];
    const [across, through] = perpendicularAxes(along);
    // Octahedron corners in OCTAHEDRON_DIRECTIONS order (+x, -x, +y, -y, +z, -z), mapped onto the droplet's own axes.
    const halfLength = pointRadius + speed * shutter * 0.5;
    const cornerAxes = [[across, pointRadius], [across, -pointRadius], [along, halfLength], [along, -halfLength], [through, pointRadius], [through, -pointRadius]];
    for (let corner = 0; corner < 6; corner++) {
      const vertex = (slot * 6 + corner) * 3;
      const [direction, extent] = cornerAxes[corner];
      const sign = Math.sign(extent);
      for (let axis = 0; axis < 3; axis++) {
        positions[vertex + axis] = center[axis] + direction[axis] * extent;
        normals[vertex + axis] = direction[axis] * sign;
        colors[vertex + axis] = KIND_TINTS[kind][axis];
      }
    }
    for (let corner = 0; corner < OCTAHEDRON_TRIANGLES.length; corner++) {
      indices[slot * OCTAHEDRON_TRIANGLES.length + corner] = slot * 6 + OCTAHEDRON_TRIANGLES[corner];
    }
  }
  return { positions, normals, colors, indices };
}

/**
 * Turns a loaded cache into renderer parts for any time. Feed the result to
 * `renderer.replaceParts([...sceneParts, ...player.partsAt(seconds)])`.
 */
export function createSpumePlayer(cache, {
  name = cache.meta.name ?? 'Spume',
  matrix = mat4.create(),
  waterMaterial = DEFAULT_WATER_MATERIAL,
  sprayMaterial = DEFAULT_SPRAY_MATERIAL,
  spray = {},
  loop = false,
  cachedFrames = 4,
} = {}) {
  if (!cache?.meta || !Array.isArray(cache.frames)) throw new TypeError('createSpumePlayer needs a cache from loadSpumeCache.');
  if (!Number.isInteger(cachedFrames) || cachedFrames < 1) throw new RangeError('cachedFrames must be a positive integer.');
  const frameCount = cache.meta.frameCount;
  const recent = new Map();

  function frameIndexAt(seconds) {
    if (!Number.isFinite(seconds)) throw new RangeError('Spume playback time must be finite.');
    const frame = Math.floor(seconds * cache.meta.fps + 1e-6);
    if (loop) return ((frame % frameCount) + frameCount) % frameCount;
    return Math.min(Math.max(frame, 0), frameCount - 1);
  }

  function partsForFrame(frameIndex) {
    const remembered = recent.get(frameIndex);
    if (remembered) {
      recent.delete(frameIndex);
      recent.set(frameIndex, remembered);
      return remembered;
    }
    const parts = [{ name: `${name} liquid`, geometry: decodeSpumeFrame(cache.frames[frameIndex]), matrix, material: waterMaterial }];
    const sprayGeometry = spray ? buildSprayGeometry(cache, frameIndex, spray) : null;
    if (sprayGeometry) parts.push({ name: `${name} whitewater`, geometry: sprayGeometry, matrix, material: sprayMaterial, castShadow: false });
    recent.set(frameIndex, parts);
    while (recent.size > cachedFrames) recent.delete(recent.keys().next().value);
    return parts;
  }

  return {
    frameCount,
    fps: cache.meta.fps,
    duration: cache.duration,
    frameIndexAt,
    partsAt: (seconds) => partsForFrame(frameIndexAt(seconds)),
    partsForFrame,
  };
}
