import { recomputeNormals } from './geometry-normals.js';
import { finite, prepareStrokes, applyStroke } from './sculpt-strokes.js';

function limit(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
}

function validateGeometry(geometry, maxVertices, maxTriangles) {
  const { positions, normals, indices } = geometry ?? {};
  if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 ||
      !(normals instanceof Float32Array) || normals.length !== positions.length ||
      !(indices instanceof Uint32Array) || !indices.length || indices.length % 3) {
    throw new TypeError('Sculpting requires indexed Float32 positions and normals with Uint32 triangles.');
  }
  const count = positions.length / 3;
  if (count > maxVertices || indices.length / 3 > maxTriangles) {
    throw new RangeError('Sculpt geometry exceeds maxVertices or maxTriangles.');
  }
  if (geometry.morphTargets || geometry.skinIndices || geometry.skinWeights) {
    throw new TypeError('Sculpting requires static geometry without morph or skin channels.');
  }
  for (const value of positions) finite(value, 'position');
  for (let offset = 0; offset < normals.length; offset += 3) {
    if (!normals.subarray(offset, offset + 3).every(Number.isFinite) ||
        Math.abs(Math.hypot(...normals.subarray(offset, offset + 3)) - 1) > 0.001) {
      throw new TypeError('Sculpt normals must be finite unit vectors.');
    }
  }
  for (const index of indices) {
    if (index >= count) throw new RangeError('Sculpt triangle index is out of bounds.');
  }
  for (const [channel, size] of [['uvs', 2], ['colors', 3]]) {
    if (geometry[channel] === undefined) continue;
    if (!(geometry[channel] instanceof Float32Array) || geometry[channel].length !== count * size ||
        !geometry[channel].every(Number.isFinite)) {
      throw new TypeError(`Sculpt ${channel} must match the vertex count and contain finite floats.`);
    }
  }
  return count;
}


function positionGroups(geometry, count, smooth) {
  const lookup = new Map();
  const groups = [];
  const groupIds = new Uint32Array(count);
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 3;
    const point = Array.from(geometry.positions.subarray(offset, offset + 3));
    const key = point.join(',');
    let groupId = lookup.get(key);
    if (groupId === undefined) {
      groupId = groups.length;
      lookup.set(key, groupId);
      groups.push({ point, normal: [0, 0, 0], neighbors: smooth ? new Set() : null });
    }
    groupIds[vertex] = groupId;
    for (let axis = 0; axis < 3; axis++) groups[groupId].normal[axis] += geometry.normals[offset + axis];
  }
  for (const group of groups) {
    const length = Math.hypot(...group.normal);
    if (!length) throw new RangeError('Coincident vertices have cancelling normals; separate the overlapping surfaces.');
    group.normal = group.normal.map(value => value / length);
  }
  if (smooth) {
    for (let offset = 0; offset < geometry.indices.length; offset += 3) {
      const triangle = Array.from(geometry.indices.subarray(offset, offset + 3), index => groupIds[index]);
      for (let corner = 0; corner < 3; corner++) {
        const first = triangle[corner];
        const second = triangle[(corner + 1) % 3];
        if (first === second) continue;
        groups[first].neighbors.add(second);
        groups[second].neighbors.add(first);
      }
    }
  }
  return { groups, groupIds };
}


function triangleArea(positions, indices, offset) {
  const first = indices[offset] * 3;
  const second = indices[offset + 1] * 3;
  const third = indices[offset + 2] * 3;
  const edgeFirst = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
  const edgeSecond = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
  return Math.hypot(
    edgeFirst[1] * edgeSecond[2] - edgeFirst[2] * edgeSecond[1],
    edgeFirst[2] * edgeSecond[0] - edgeFirst[0] * edgeSecond[2],
    edgeFirst[0] * edgeSecond[1] - edgeFirst[1] * edgeSecond[0],
  );
}

function validateResult(source, result) {
  let drawable = false;
  for (let offset = 0; offset < result.indices.length; offset += 3) {
    const area = triangleArea(result.positions, result.indices, offset);
    if (area > 0) drawable = true;
    if (!area && triangleArea(source.positions, source.indices, offset) > 0) {
      throw new RangeError('Sculpt stroke collapsed a triangle at Float32 precision. Reduce strength.');
    }
  }
  if (!drawable) throw new RangeError('Sculpt geometry has no drawable triangles.');
}

/** Apply serializable construction-time brush strokes without mutating the source. */
export function sculptGeometry(geometry, strokes, {
  maxVertices = 250_000, maxTriangles = 500_000, maxStrokes = 256, maxVertexVisits = 20_000_000,
} = {}) {
  limit(maxVertices, 1_000_000, 'maxVertices');
  limit(maxTriangles, 2_000_000, 'maxTriangles');
  limit(maxStrokes, 4096, 'maxStrokes');
  limit(maxVertexVisits, 100_000_000, 'maxVertexVisits');
  const count = validateGeometry(geometry, maxVertices, maxTriangles);
  if (!Array.isArray(strokes) || strokes.length > maxStrokes) throw new RangeError('Strokes exceed maxStrokes or are not an array.');
  if (count * strokes.length > maxVertexVisits) throw new RangeError('Sculpting exceeds maxVertexVisits; split or reduce the strokes.');
  const prepared = prepareStrokes(strokes);
  const result = {
    positions: new Float32Array(geometry.positions),
    normals: new Float32Array(geometry.normals),
    indices: new Uint32Array(geometry.indices),
  };
  for (const channel of ['uvs', 'colors']) {
    if (geometry[channel]) result[channel] = new Float32Array(geometry[channel]);
  }
  if (!prepared.some(stroke => stroke.strength !== 0)) {
    validateResult(geometry, result);
    return result;
  }
  const { groups, groupIds } = positionGroups(geometry, count, prepared.some(stroke => stroke.type === 'smooth'));
  for (const stroke of prepared) applyStroke(groups, stroke);
  for (let vertex = 0; vertex < count; vertex++) result.positions.set(groups[groupIds[vertex]].point, vertex * 3);
  validateResult(geometry, result);
  result.normals = recomputeNormals(geometry, result.positions);
  return result;
}
