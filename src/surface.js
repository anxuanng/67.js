import { vec3 } from 'gl-matrix';
import { clipTrianglesToProjector, createProjectorMatrix, invertMatrix } from './surface-decal.js';

const PROCEDURAL_TAGS = new Set(['armor', 'floor', 'water', 'foliage', 'grass', 'terrain', 'fire', 'smoke']);
const OPTION_FIELDS = new Set(['position', 'rotation', 'size', 'clearance', 'maxAngle', 'maxVertices', 'maxTriangles']);

function createVector(x = 0, y = 0, z = 0) {
  return Float64Array.of(x, y, z);
}

function finiteFloat(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new TypeError(`${label} must be a finite Float32 value.`);
  }
  return Math.fround(value);
}

function vector(input, fallback, label) {
  const values = input ?? fallback;
  if ((!Array.isArray(values) && !ArrayBuffer.isView(values)) || values.length !== 3) {
    throw new TypeError(`${label} requires three components.`);
  }
  return Array.from(values, value => finiteFloat(value, label));
}

function limit(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 1_000_000) {
    throw new RangeError(`${label} must be an integer within ${minimum} and 1000000.`);
  }
  return value;
}

function validateTarget(target, maxTriangles) {
  const geometry = target?.geometry;
  if (!geometry || typeof geometry !== 'object') throw new TypeError('Surface patches require a target part with geometry.');
  if (target.skin || geometry.skinIndices !== undefined || geometry.skinWeights !== undefined) {
    throw new RangeError('Surface patches cannot follow skinning. Use a static target.');
  }
  if (target.morph || geometry.morphTargets !== undefined) throw new RangeError('Surface patches cannot follow morphing. Use a static target.');
  if (target.assembly) throw new RangeError('Surface patches cannot follow assembly shader offsets. Use a static target.');
  if (PROCEDURAL_TAGS.has(target.material?.tag)) throw new RangeError('Surface patches require a standard material target without procedural deformation or shading.');
  const positions = geometry.positions;
  const normals = geometry.normals;
  const indices = geometry.indices;
  if (!(indices instanceof Uint32Array) || indices.length === 0 || indices.length % 3 !== 0) {
    throw new TypeError('Target indices require a nonempty Uint32Array of triangles.');
  }
  if (indices.length / 3 > maxTriangles) throw new RangeError('Surface target exceeds maxTriangles. Reduce target detail or raise the limit.');
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3 !== 0 || positions.length / 3 > maxTriangles * 3) {
    throw new TypeError('Target positions require bounded nonempty Float32 XYZ vertices.');
  }
  if (!(normals instanceof Float32Array) || normals.length !== positions.length) throw new TypeError('Target normals require matching Float32 XYZ vertices.');
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(positions[offset + axis]) || !Number.isFinite(normals[offset + axis])) throw new RangeError('Surface target vertices and normals must remain finite.');
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (Math.abs(length - 1) > 0.001) throw new RangeError('Surface target normals require unit vectors.');
  }
  for (const index of indices) if (index >= positions.length / 3) throw new RangeError('Surface target index exceeds the vertex count.');
  return geometry;
}

function readPoint(array, vertex) {
  return createVector(array[vertex * 3], array[vertex * 3 + 1], array[vertex * 3 + 2]);
}

function faceDirection(points) {
  const first = vec3.subtract(createVector(), points[1], points[0]);
  const second = vec3.subtract(createVector(), points[2], points[0]);
  const face = vec3.cross(createVector(), first, second);
  const area = vec3.length(face);
  return area === 0 ? null : vec3.scale(face, face, 1 / area);
}

function candidateIndices(geometry, projectorInverse, direction, size, maxAngle, maxVertices) {
  const indices = [];
  const minimumFacing = Math.max(0, Math.cos(maxAngle));
  let vertexBound = 0;
  let drawable = false;
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const corners = [0, 1, 2].map(corner => geometry.indices[offset + corner]);
    const points = corners.map(vertex => readPoint(geometry.positions, vertex));
    const face = faceDirection(points);
    if (!face) continue;
    drawable = true;
    const facing = vec3.dot(face, direction);
    if (facing <= 0 || facing < minimumFacing) continue;
    for (const vertex of corners) {
      if (vec3.dot(readPoint(geometry.normals, vertex), face) <= 0) throw new RangeError('Surface target normals must face outward with their triangles.');
    }
    const projected = points.map(point => vec3.transformMat4(createVector(), point, projectorInverse));
    let outside = false;
    let clippingPlanes = 0;
    for (let axis = 0; axis < 3; axis++) {
      const minimum = Math.min(projected[0][axis], projected[1][axis], projected[2][axis]);
      const maximum = Math.max(projected[0][axis], projected[1][axis], projected[2][axis]);
      const halfSize = size[axis] / 2;
      if (minimum > halfSize || maximum < -halfSize) outside = true;
      if (maximum > halfSize) clippingPlanes++;
      if (minimum < -halfSize) clippingPlanes++;
    }
    if (outside) continue;
    // Each of the six clipping passes can double triangle fragments.
    vertexBound += 3 * 2 ** clippingPlanes;
    if (vertexBound > maxVertices) throw new RangeError('Surface clipping reservation exceeds maxVertices. Reduce the projector or raise the limit.');
    indices.push(...corners);
  }
  if (!drawable) throw new RangeError('Surface target has no drawable triangles.');
  if (indices.length === 0) throw new RangeError('Surface projector misses all outward-facing target triangles.');
  return indices;
}

function patchGeometry(decal, clearance, maxVertices) {
  const sourcePositions = decal.positions;
  const vertexCount = sourcePositions.length / 3;
  if (vertexCount === 0) throw new RangeError('Surface projector clips to an empty patch.');
  if (vertexCount > maxVertices) throw new RangeError('Surface output exceeds maxVertices.');
  const positions = new Float32Array(sourcePositions);
  const normals = new Float32Array(decal.normals);
  const uvs = new Float32Array(decal.uvs);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (!Number.isFinite(length) || length === 0) throw new RangeError('Surface projection produced an invalid normal.');
    let displacement = 0;
    for (let axis = 0; axis < 3; axis++) {
      normals[offset + axis] /= length;
      positions[offset + axis] = sourcePositions[offset + axis] + normals[offset + axis] * clearance;
      if (!Number.isFinite(positions[offset + axis])) throw new RangeError('Surface clearance exceeds finite Float32 coordinates.');
      displacement += (positions[offset + axis] - sourcePositions[offset + axis]) * normals[offset + axis];
    }
    if (clearance > 0 && displacement <= 0) throw new RangeError('Surface clearance collapses at Float32 precision. Increase clearance or center the target locally.');
    for (let axis = 0; axis < 2; axis++) {
      const value = uvs[vertex * 2 + axis];
      if (!Number.isFinite(value) || value < -1e-6 || value > 1 + 1e-6) throw new RangeError('Surface projection produced invalid projector UVs.');
    }
  }
  const indices = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 3) {
    const sourceCorners = [0, 1, 2].map(corner => readPoint(sourcePositions, vertex + corner));
    const sourceFace = faceDirection(sourceCorners);
    if (!sourceFace) continue;
    if (clearance > 0) {
      for (let corner = 0; corner < 3; corner++) {
        const displacement = vec3.subtract(createVector(), readPoint(positions, vertex + corner), sourceCorners[corner]);
        if (vec3.dot(displacement, sourceFace) <= 0) throw new RangeError('Surface clearance cannot create a positive triangle-plane gap at Float32 precision. Increase clearance or center the target locally.');
      }
    }
    const moved = [0, 1, 2].map(corner => readPoint(positions, vertex + corner));
    const edgeFirst = vec3.subtract(createVector(), moved[1], moved[0]);
    const edgeSecond = vec3.subtract(createVector(), moved[2], moved[0]);
    const edge = vec3.cross(createVector(), edgeFirst, edgeSecond);
    if (vec3.length(edge) === 0 || vec3.dot(edge, sourceFace) <= 0) {
      throw new RangeError('Surface clearance collapses or reverses a triangle. Reduce clearance.');
    }
    indices.push(vertex, vertex + 1, vertex + 2);
  }
  if (indices.length === 0) throw new RangeError('Surface output has no drawable triangles at Float32 precision.');
  return { positions, normals, uvs, indices: new Uint32Array(indices) };
}

/** Static conforming patch. Projector and clearance use target-local coordinates.
 * Share target.matrix on the patch part to follow rigid affine animation.
 * RGB, original UVs, textures and material are not copied from the target.
 */
export function createSurfacePatch(target, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Surface options require an object.');
  for (const field of Object.keys(options)) if (!OPTION_FIELDS.has(field)) throw new TypeError(`Unsupported surface option ${field}.`);
  const position = vector(options.position, [0, 0, 0], 'position');
  const rotation = vector(options.rotation, [0, 0, 0], 'rotation').map(value => value % (Math.PI * 2));
  const size = vector(options.size, [1, 1, 1], 'size');
  if (size.some(value => value <= 0)) throw new RangeError('Surface projector size must stay positive after Float32 conversion.');
  const clearance = finiteFloat(options.clearance ?? 0.001, 'clearance');
  if (clearance < 0) throw new RangeError('Surface clearance must be nonnegative.');
  if (options.clearance > 0 && clearance === 0) throw new RangeError('Surface clearance collapses at Float32 precision. Increase clearance.');
  const maxAngle = options.maxAngle ?? Math.PI / 2;
  if (!Number.isFinite(maxAngle) || maxAngle <= 0 || maxAngle > Math.PI / 2) throw new RangeError('maxAngle must be greater than zero and at most PI/2.');
  const maxVertices = limit(options.maxVertices ?? 250_000, 3, 'maxVertices');
  const maxTriangles = limit(options.maxTriangles ?? 250_000, 1, 'maxTriangles');
  const geometry = validateTarget(target, maxTriangles);
  const projector = createProjectorMatrix(position, rotation);
  const direction = vec3.normalize(createVector(), createVector(projector[8], projector[9], projector[10]));
  const selected = candidateIndices(geometry, invertMatrix(projector), direction, size, maxAngle, maxVertices);
  // Clipping happens in target-local space, so the patch lands where the target's own vertices are.
  const decal = clipTrianglesToProjector(geometry.positions, geometry.normals, selected, projector, size);
  return patchGeometry(decal, clearance, maxVertices);
}
