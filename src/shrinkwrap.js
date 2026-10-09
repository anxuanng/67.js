import { Matrix3, Matrix4, Vector3 } from 'three';
import { createMeshQueryIndex } from './mesh-query.js';
import { recomputeNormals } from './geometry-normals.js';

const OPTIONS = new Set(['sourceToTarget', 'mode', 'direction', 'maxDistance', 'clearance', 'onMiss', 'maxVertices', 'maxTriangles', 'maxQueries', 'maxTriangleTests', 'memoryBudgetMiB']);

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new TypeError(`${label} must remain finite in Float32.`);
  return value;
}

function limit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  return value;
}

function transform(input) {
  if (input === undefined) return new Matrix4();
  if ((!Array.isArray(input) && !ArrayBuffer.isView(input)) || input.length !== 16) throw new TypeError('sourceToTarget requires 16 affine components.');
  const components = Array.from(input, value => Math.fround(finite(value, 'sourceToTarget')));
  if (components[3] !== 0 || components[7] !== 0 || components[11] !== 0 || components[15] !== 1) throw new RangeError('sourceToTarget must be affine.');
  const matrix = new Matrix4().fromArray(components);
  if (!Number.isFinite(matrix.determinant()) || matrix.determinant() === 0) throw new RangeError('sourceToTarget must remain nonsingular.');
  return matrix;
}

function faceNormal(positions, indices, offset) {
  const first = indices[offset] * 3;
  const second = indices[offset + 1] * 3;
  const third = indices[offset + 2] * 3;
  const edgeFirst = new Vector3(positions[second] - positions[first], positions[second + 1] - positions[first + 1], positions[second + 2] - positions[first + 2]);
  const edgeSecond = new Vector3(positions[third] - positions[first], positions[third + 1] - positions[first + 1], positions[third + 2] - positions[first + 2]);
  const normal = new Vector3().crossVectors(edgeFirst, edgeSecond);
  const longest = Math.max(edgeFirst.length(), edgeSecond.length(), edgeFirst.clone().sub(edgeSecond).length());
  return { normal, altitude: normal.length() / longest };
}

function validateSource(source, maxVertices, maxTriangles) {
  const { positions, normals, indices } = source ?? {};
  if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 ||
      !(normals instanceof Float32Array) || normals.length !== positions.length ||
      !(indices instanceof Uint32Array) || !indices.length || indices.length % 3) throw new TypeError('Shrinkwrap requires Float32 positions and normals with Uint32 triangles.');
  if (source.skinIndices !== undefined || source.skinWeights !== undefined || source.morphTargets !== undefined) throw new TypeError('Shrinkwrap requires static geometry without skin or morph channels.');
  const count = positions.length / 3;
  if (count > maxVertices || indices.length / 3 > maxTriangles) throw new RangeError('Source exceeds maxVertices or maxTriangles.');
  for (const value of positions) finite(value, 'Source position');
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (!Number.isFinite(length) || Math.abs(length - 1) > 0.001) throw new TypeError('Source normals must be finite unit vectors.');
  }
  for (const index of indices) if (index >= count) throw new RangeError('Source index exceeds the vertex count.');
  for (const [channel, size] of [['uvs', 2], ['colors', 3]]) {
    if (source[channel] !== undefined && (!(source[channel] instanceof Float32Array) || source[channel].length !== count * size || !source[channel].every(Number.isFinite))) {
      throw new TypeError(`Source ${channel} must contain finite Float32 values matching the vertex count.`);
    }
  }
  for (let offset = 0; offset < indices.length; offset += 3) {
    if (!(faceNormal(positions, indices, offset).altitude > 0)) throw new RangeError('Source contains a degenerate triangle.');
  }
  return count;
}

function validateTriangles(before, after, indices, hitNormals) {
  for (let offset = 0; offset < indices.length; offset += 3) {
    const original = faceNormal(before, indices, offset);
    const output = faceNormal(after, indices, offset);
    const maximum = Math.max(...Array.from(indices.subarray(offset, offset + 3)).flatMap(vertex => Array.from(after.subarray(vertex * 3, vertex * 3 + 3), Math.abs)));
    if (!Number.isFinite(output.altitude) || output.altitude <= maximum * 2 ** -21 + 2 ** -149) throw new RangeError('Shrinkwrap collapses a triangle within Float32 precision. Reduce projection or clearance.');
    if (output.normal.dot(original.normal) <= 0) throw new RangeError('Shrinkwrap flips or folds a triangle relative to the transformed source.');
    const targetNormal = new Vector3();
    let allMatched = true;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[offset + corner];
      if (!hitNormals[vertex]) allMatched = false;
      else targetNormal.add(hitNormals[vertex]);
    }
    // A closest point at a hard crease can select a perpendicular neighboring face.
    if (allMatched && output.normal.dot(targetNormal) < 0) throw new RangeError('Shrinkwrap triangle faces away from its matched target surface.');
  }
}

/** Construct a new static target-local mesh using one disposable target BVH. */
export function shrinkwrapGeometry(source, target, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Shrinkwrap options require an object.');
  for (const field of Object.keys(options)) if (!OPTIONS.has(field)) throw new TypeError(`Unsupported shrinkwrap option ${field}.`);
  const maxVertices = limit(options.maxVertices ?? 250_000, 1_000_000, 'maxVertices');
  const maxTriangles = limit(options.maxTriangles ?? 250_000, 1_000_000, 'maxTriangles');
  const maxQueries = limit(options.maxQueries ?? 250_000, 1_000_000, 'maxQueries');
  const maxTriangleTests = limit(options.maxTriangleTests ?? 20_000_000, 100_000_000, 'maxTriangleTests');
  const count = validateSource(source, maxVertices, maxTriangles);
  const matrix = transform(options.sourceToTarget);
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  if (!normalMatrix.elements.every(Number.isFinite)) throw new RangeError('sourceToTarget normal transform exceeds the precision domain.');
  const mode = options.mode ?? 'nearest';
  if (mode !== 'nearest' && mode !== 'project') throw new RangeError('Shrinkwrap mode must be nearest or project.');
  let direction;
  if (mode === 'project') {
    if ((!Array.isArray(options.direction) && !ArrayBuffer.isView(options.direction)) || options.direction.length !== 3) throw new TypeError('Project mode requires a target-local direction.');
    direction = Array.from(options.direction, value => finite(value, 'direction'));
    if (Math.hypot(...direction) === 0) throw new RangeError('Projection direction must be nonzero.');
  } else if (options.direction !== undefined) throw new TypeError('direction applies only to project mode.');
  const maxDistance = options.maxDistance ?? Infinity;
  if (maxDistance !== Infinity) finite(maxDistance, 'maxDistance');
  if (maxDistance < 0) throw new RangeError('maxDistance must be nonnegative.');
  const clearance = finite(options.clearance ?? 0, 'clearance');
  if (clearance < 0) throw new RangeError('clearance must be nonnegative.');
  const onMiss = options.onMiss ?? 'error';
  if (onMiss !== 'error' && onMiss !== 'keep') throw new RangeError('onMiss must be error or keep.');

  const before = new Float32Array(source.positions.length);
  const fallbackNormals = new Float32Array(source.normals.length);
  const point = new Vector3();
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    point.fromArray(source.positions, offset).applyMatrix4(matrix);
    for (const value of point.toArray()) finite(value, 'Transformed position');
    before.set(point.toArray(), offset);
    point.fromArray(source.normals, offset).applyMatrix3(normalMatrix).normalize();
    if (!point.toArray().every(Number.isFinite) || point.length() === 0) throw new RangeError('Transformed source normal is invalid.');
    fallbackNormals.set(point.toArray(), offset);
  }
  const groups = new Map();
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    const key = source.positions.subarray(offset, offset + 3).join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(vertex);
  }
  if (groups.size > maxQueries) throw new RangeError('Shrinkwrap exceeds maxQueries. Reduce source detail.');
  const result = { positions: new Float32Array(before), normals: null, indices: new Uint32Array(source.indices) };
  for (const channel of ['uvs', 'colors']) if (source[channel] !== undefined) result[channel] = new Float32Array(source[channel]);
  const hitNormals = new Array(count);
  const stats = { queriedVertices: 0, matchedVertices: 0, missedVertices: 0, triangleTests: 0 };
  const index = createMeshQueryIndex(target, { maxVertices, maxTriangles, memoryBudgetMiB: options.memoryBudgetMiB ?? 64 });
  try {
    for (const vertices of groups.values()) {
      const remaining = maxTriangleTests - stats.triangleTests;
      if (remaining <= 0) throw new RangeError('Shrinkwrap maxTriangleTests exhausted. Reduce source detail or raise the budget.');
      const origin = before.subarray(vertices[0] * 3, vertices[0] * 3 + 3);
      const query = mode === 'nearest'
        ? index.nearest(origin, { maxDistance, maxTriangleTests: remaining })
        : index.project({ origin, direction, maxDistance, maxTriangleTests: remaining });
      stats.queriedVertices++;
      stats.triangleTests += query.triangleTests;
      if (!query.hit) {
        stats.missedVertices++;
        if (onMiss === 'error') throw new RangeError(`Shrinkwrap missed source vertex ${vertices[0]}. Change maxDistance, direction, or onMiss.`);
        continue;
      }
      stats.matchedVertices++;
      const normal = new Vector3(...query.hit.normal);
      const roundedPoint = query.hit.point.map(Math.fround);
      const moved = query.hit.point.map((value, axis) => Math.fround(finite(value + query.hit.normal[axis] * clearance, 'Shrinkwrap position')));
      if (clearance > 0) {
        const displacement = new Vector3(...moved).sub(new Vector3(...roundedPoint));
        const actualGap = new Vector3(...moved).sub(new Vector3(...query.hit.point)).dot(normal);
        if (displacement.dot(normal) <= 0 || actualGap <= 0) throw new RangeError('Clearance collapses against the geometric face at Float32 precision. Increase clearance or reduce coordinates.');
      }
      for (const vertex of vertices) {
        result.positions.set(moved, vertex * 3);
        hitNormals[vertex] = normal;
      }
    }
    validateTriangles(before, result.positions, result.indices, hitNormals);
    result.normals = recomputeNormals(source, result.positions, fallbackNormals);
    return { geometry: result, stats };
  } finally {
    index.dispose();
  }
}
