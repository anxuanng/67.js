import { createMeshData, deriveEdges, DOMAINS, meshBounds, TAG_PREFIX } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { cornerCycles, cornerFaces, edgeCornerTable } from './mesh-topology.js';

const NORMAL_SPLIT_TOLERANCE = 1e-4;
const AXIS_TAGS = Object.freeze([
  { name: 'right', axis: 0, sign: 1, side: true },
  { name: 'left', axis: 0, sign: -1, side: true },
  { name: 'top', axis: 1, sign: 1, side: false },
  { name: 'bottom', axis: 1, sign: -1, side: false },
  { name: 'front', axis: 2, sign: 1, side: true },
  { name: 'back', axis: 2, sign: -1, side: true },
]);

function spatialHash(cellX, cellY, cellZ, mask) {
  return (Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663) ^ Math.imul(cellZ, 83492791)) & mask;
}

/**
 * Map each input vertex to a welded vertex. Vertices closer than `tolerance` merge into the first one seen.
 * Uses a hashed uniform grid with cell size equal to the tolerance, so each lookup checks 27 cells.
 */
export function weldVertices(positions, tolerance) {
  const count = positions.length / 3;
  const weldMap = new Uint32Array(count);
  const representatives = [];
  let tableSize = 1;
  while (tableSize < count * 2) tableSize *= 2;
  const mask = tableSize - 1;
  const bucketHead = new Int32Array(tableSize).fill(-1);
  const bucketNext = new Int32Array(count).fill(-1);
  const cellSize = tolerance > 0 ? tolerance : 1;
  const squaredTolerance = tolerance * tolerance;
  const searchRadius = tolerance > 0 ? 1 : 0;
  for (let vertex = 0; vertex < count; vertex++) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    const cellZ = Math.floor(z / cellSize);
    let match = -1;
    for (let offsetX = -searchRadius; offsetX <= searchRadius && match === -1; offsetX++) {
      for (let offsetY = -searchRadius; offsetY <= searchRadius && match === -1; offsetY++) {
        for (let offsetZ = -searchRadius; offsetZ <= searchRadius && match === -1; offsetZ++) {
          let candidate = bucketHead[spatialHash(cellX + offsetX, cellY + offsetY, cellZ + offsetZ, mask)];
          while (candidate !== -1) {
            const source = representatives[candidate];
            const deltaX = positions[source * 3] - x;
            const deltaY = positions[source * 3 + 1] - y;
            const deltaZ = positions[source * 3 + 2] - z;
            if (deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ <= squaredTolerance) {
              match = candidate;
              break;
            }
            candidate = bucketNext[candidate];
          }
        }
      }
    }
    if (match === -1) {
      match = representatives.length;
      representatives.push(vertex);
      const bucket = spatialHash(cellX, cellY, cellZ, mask);
      bucketNext[match] = bucketHead[bucket];
      bucketHead[bucket] = match;
    }
    weldMap[vertex] = match;
  }
  return { weldMap, representatives };
}

/**
 * Rebuild a mesh from faces described by source corners. Corner attributes follow their source corner, face
 * attributes their source face, and edge attributes are kept for edges that join the same vertex pair as before.
 */
export function rebuildFromCorners(source, faceOffsets, sourceCorners, sourceFaces) {
  const cornerVertices = new Uint32Array(sourceCorners.length);
  for (let corner = 0; corner < sourceCorners.length; corner++) cornerVertices[corner] = source.cornerVertices[sourceCorners[corner]];
  const edges = deriveEdges(source.vertexCount, faceOffsets, cornerVertices);
  const attributes = { point: { ...source.attributes.point }, edge: {}, face: {}, corner: {} };
  for (const [name, attribute] of Object.entries(source.attributes.corner)) {
    attributes.corner[name] = gatherAttribute(attribute, sourceCorners);
  }
  for (const [name, attribute] of Object.entries(source.attributes.face)) {
    attributes.face[name] = gatherAttribute(attribute, sourceFaces);
  }
  const edgeAttributes = Object.entries(source.attributes.edge);
  if (edgeAttributes.length) {
    const sourceEdgeOfNewEdge = new Int32Array(edges.edgeCount).fill(-1);
    const sourceEdges = deriveEdgeLookup(source);
    for (let edge = 0; edge < edges.edgeCount; edge++) {
      sourceEdgeOfNewEdge[edge] = sourceEdges(edges.edgeVertices[edge * 2], edges.edgeVertices[edge * 2 + 1]);
    }
    for (const [name, attribute] of edgeAttributes) {
      const data = new attribute.data.constructor(edges.edgeCount * attribute.size);
      for (let edge = 0; edge < edges.edgeCount; edge++) {
        const sourceEdge = sourceEdgeOfNewEdge[edge];
        if (sourceEdge === -1) continue;
        for (let component = 0; component < attribute.size; component++) {
          data[edge * attribute.size + component] = attribute.data[sourceEdge * attribute.size + component];
        }
      }
      attributes.edge[name] = { data, size: attribute.size };
    }
  }
  return createMeshData({
    positions: source.positions, faceOffsets, cornerVertices,
    edgeVertices: edges.edgeVertices, cornerEdges: edges.cornerEdges, attributes,
  });
}

function gatherAttribute(attribute, sourceIndices) {
  const data = new attribute.data.constructor(sourceIndices.length * attribute.size);
  for (let index = 0; index < sourceIndices.length; index++) {
    for (let component = 0; component < attribute.size; component++) {
      data[index * attribute.size + component] = attribute.data[sourceIndices[index] * attribute.size + component];
    }
  }
  return { data, size: attribute.size };
}

/** Lookup function from a vertex pair to the source edge index, built from per-vertex edge lists. */
function deriveEdgeLookup(mesh) {
  const firstEdge = new Int32Array(mesh.vertexCount).fill(-1);
  const nextEdge = new Int32Array(mesh.edgeCount).fill(-1);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const low = Math.min(mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]);
    nextEdge[edge] = firstEdge[low];
    firstEdge[low] = edge;
  }
  return (first, second) => {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    let edge = firstEdge[low];
    while (edge !== -1) {
      if (Math.max(mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]) === high) return edge;
      edge = nextEdge[edge];
    }
    return -1;
  };
}

function attributeList(domainAttributes) {
  return Object.values(domainAttributes);
}

function sameValues(attributes, first, second) {
  for (const attribute of attributes) {
    const size = attribute.size;
    const data = attribute.data;
    for (let component = 0; component < size; component++) {
      if (data[first * size + component] !== data[second * size + component]) return false;
    }
  }
  return true;
}

const cornerScratch = new Float64Array(12);

/**
 * Sum over the four corners of |corner angle - 90 degrees|, or -1 when the quad is not convex
 * (a corner turns against the others). Vertices are a, b, c, d in winding order.
 */
function quadCornerAngleError(positions, a, b, c, d) {
  const quad = [a, b, c, d];
  let error = 0;
  for (let index = 0; index < 4; index++) {
    const previous = quad[(index + 3) & 3] * 3;
    const current = quad[index] * 3;
    const next = quad[(index + 1) & 3] * 3;
    const firstX = positions[previous] - positions[current];
    const firstY = positions[previous + 1] - positions[current + 1];
    const firstZ = positions[previous + 2] - positions[current + 2];
    const secondX = positions[next] - positions[current];
    const secondY = positions[next + 1] - positions[current + 1];
    const secondZ = positions[next + 2] - positions[current + 2];
    const crossX = secondY * firstZ - secondZ * firstY;
    const crossY = secondZ * firstX - secondX * firstZ;
    const crossZ = secondX * firstY - secondY * firstX;
    cornerScratch[index * 3] = crossX;
    cornerScratch[index * 3 + 1] = crossY;
    cornerScratch[index * 3 + 2] = crossZ;
    const crossLength = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
    const angle = Math.atan2(crossLength, firstX * secondX + firstY * secondY + firstZ * secondZ);
    error += Math.abs(angle - Math.PI / 2);
  }
  for (let index = 1; index < 4; index++) {
    const dot = cornerScratch[0] * cornerScratch[index * 3] + cornerScratch[1] * cornerScratch[index * 3 + 1] +
      cornerScratch[2] * cornerScratch[index * 3 + 2];
    if (dot <= 0) return -1;
  }
  return error;
}

const SORT_BUCKETS = 65536;
const MAX_QUAD_ERROR = 2 * Math.PI;

/** Candidate order by error, using a counting sort on quantized errors (ties keep edge order). */
function orderByError(errors, count) {
  const bucketOfCandidate = new Uint32Array(count);
  const bucketStart = new Uint32Array(SORT_BUCKETS + 1);
  for (let candidate = 0; candidate < count; candidate++) {
    const bucket = Math.min(SORT_BUCKETS - 1, Math.floor(errors[candidate] / MAX_QUAD_ERROR * SORT_BUCKETS));
    bucketOfCandidate[candidate] = bucket;
    bucketStart[bucket + 1]++;
  }
  for (let bucket = 0; bucket < SORT_BUCKETS; bucket++) bucketStart[bucket + 1] += bucketStart[bucket];
  const order = new Uint32Array(count);
  for (let candidate = 0; candidate < count; candidate++) {
    order[bucketStart[bucketOfCandidate[candidate]]] = candidate;
    bucketStart[bucketOfCandidate[candidate]]++;
  }
  return order;
}

/**
 * Join pairs of triangles into quads, as Blender's "Triangles to Quads": only across smooth, manifold edges whose two
 * triangles are within maxAngle of coplanar, form a convex quad, and agree on every corner and face attribute.
 * Best-shaped pairs (corners closest to right angles) join first.
 */
export function joinTriangles(mesh, { maxAngle = Math.PI / 180 } = {}) {
  const { normals } = faceNormals(mesh);
  const table = edgeCornerTable(mesh);
  const { nextCorner } = cornerCycles(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const sharp = mesh.attributes.edge.sharp?.data;
  const cornerAttributes = attributeList(mesh.attributes.corner);
  const faceAttributes = attributeList(mesh.attributes.face);
  const cosineLimit = Math.cos(maxAngle);
  const vertices = mesh.cornerVertices;
  // Each candidate stores its error and its first corner; the other three corners follow from the topology.
  const candidateErrors = new Float64Array(mesh.edgeCount);
  const candidateFirstCorner = new Uint32Array(mesh.edgeCount);
  const candidateSecondCorner = new Uint32Array(mesh.edgeCount);
  let candidateCount = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const offset = table.edgeOffsets[edge];
    if (table.edgeOffsets[edge + 1] - offset !== 2) continue;
    if (sharp && sharp[edge]) continue;
    const first = table.edgeCorners[offset];
    const second = table.edgeCorners[offset + 1];
    const firstFace = facesOfCorners[first];
    const secondFace = facesOfCorners[second];
    if (mesh.faceOffsets[firstFace + 1] - mesh.faceOffsets[firstFace] !== 3) continue;
    if (mesh.faceOffsets[secondFace + 1] - mesh.faceOffsets[secondFace] !== 3) continue;
    if (vertices[first] === vertices[second]) continue;
    const cosine = normals[firstFace * 3] * normals[secondFace * 3] + normals[firstFace * 3 + 1] * normals[secondFace * 3 + 1] +
      normals[firstFace * 3 + 2] * normals[secondFace * 3 + 2];
    if (cosine < cosineLimit) continue;
    if (!sameValues(faceAttributes, firstFace, secondFace)) continue;
    // first runs a->b in its face, second runs b->a. The quad is a, (second's opposite), b, (first's opposite).
    const firstNext = nextCorner[first];
    const firstOpposite = nextCorner[firstNext];
    const secondNext = nextCorner[second];
    const secondOpposite = nextCorner[secondNext];
    if (!sameValues(cornerAttributes, first, secondNext) || !sameValues(cornerAttributes, firstNext, second)) continue;
    if (vertices[firstOpposite] === vertices[secondOpposite]) continue;
    const error = quadCornerAngleError(mesh.positions, vertices[first], vertices[secondOpposite], vertices[firstNext], vertices[firstOpposite]);
    if (error < 0) continue;
    candidateErrors[candidateCount] = error;
    candidateFirstCorner[candidateCount] = first;
    candidateSecondCorner[candidateCount] = second;
    candidateCount++;
  }
  if (!candidateCount) return mesh;
  const order = orderByError(candidateErrors, candidateCount);
  const joined = new Uint8Array(mesh.faceCount);
  // For the lower-numbered face of each joined pair: the first corner of its quad; the partner face is skipped.
  const quadFirstCorner = new Int32Array(mesh.faceCount).fill(-1);
  const quadSecondCorner = new Uint32Array(mesh.faceCount);
  let joinedPairs = 0;
  for (let index = 0; index < candidateCount; index++) {
    const candidate = order[index];
    const first = candidateFirstCorner[candidate];
    const second = candidateSecondCorner[candidate];
    const firstFace = facesOfCorners[first];
    const secondFace = facesOfCorners[second];
    if (joined[firstFace] || joined[secondFace]) continue;
    joined[firstFace] = 1;
    joined[secondFace] = 1;
    const keeper = Math.min(firstFace, secondFace);
    quadFirstCorner[keeper] = first;
    quadSecondCorner[keeper] = second;
    joinedPairs++;
  }
  const faceCount = mesh.faceCount - joinedPairs;
  const faceOffsets = new Uint32Array(faceCount + 1);
  const sourceCorners = new Uint32Array(mesh.cornerCount - joinedPairs * 2);
  const sourceFaces = new Uint32Array(faceCount);
  let outputFace = 0;
  let outputCorner = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const first = quadFirstCorner[face];
    if (joined[face] && first === -1) continue;
    if (first !== -1) {
      const firstNext = nextCorner[first];
      sourceCorners[outputCorner] = first;
      sourceCorners[outputCorner + 1] = nextCorner[nextCorner[quadSecondCorner[face]]];
      sourceCorners[outputCorner + 2] = firstNext;
      sourceCorners[outputCorner + 3] = nextCorner[firstNext];
      outputCorner += 4;
    } else {
      for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
        sourceCorners[outputCorner] = corner;
        outputCorner++;
      }
    }
    sourceFaces[outputFace] = face;
    outputFace++;
    faceOffsets[outputFace] = outputCorner;
  }
  return rebuildFromCorners(mesh, faceOffsets, sourceCorners, sourceFaces);
}

/**
 * Tag faces by the axis their normal points along (within 45 degrees): top, bottom, right (+X), left (-X),
 * front (+Z), back (-Z); the four horizontal directions also get "side". Existing tags are kept.
 */
export function tagFacesByAxis(mesh) {
  const { normals } = faceNormals(mesh);
  const tagData = new Map();
  const ensure = name => {
    if (!tagData.has(name)) tagData.set(name, mesh.attributes.face[TAG_PREFIX + name]?.data.slice() ?? new Uint8Array(mesh.faceCount));
    return tagData.get(name);
  };
  const threshold = Math.SQRT1_2;
  for (let face = 0; face < mesh.faceCount; face++) {
    for (const tag of AXIS_TAGS) {
      if (normals[face * 3 + tag.axis] * tag.sign < threshold) continue;
      ensure(tag.name)[face] = 1;
      if (tag.side) ensure('side')[face] = 1;
    }
  }
  return withFaceAttributes(mesh, Object.fromEntries([...tagData].map(([name, data]) => [TAG_PREFIX + name, { data, size: 1 }])));
}

/** Copy of a mesh with face attributes added or replaced; topology and other arrays are shared. */
export function withFaceAttributes(mesh, faceAttributes) {
  const attributes = {};
  for (const domain of DOMAINS) attributes[domain] = { ...mesh.attributes[domain] };
  Object.assign(attributes.face, faceAttributes);
  return createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

function differentNormals(normals, first, second) {
  return Math.abs(normals[first * 3] - normals[second * 3]) > NORMAL_SPLIT_TOLERANCE ||
    Math.abs(normals[first * 3 + 1] - normals[second * 3 + 1]) > NORMAL_SPLIT_TOLERANCE ||
    Math.abs(normals[first * 3 + 2] - normals[second * 3 + 2]) > NORMAL_SPLIT_TOLERANCE;
}

/**
 * Convert renderer geometry (indexed triangles with seam-split vertices) into a polygon mesh.
 * Coincident vertices weld within `weld` (default: 1e-6 of the bounds diagonal); UVs and colours become corner
 * attributes; edges where the input normals were split become "sharp" edges so extraction keeps the hard edges.
 * With `quads` (default true), flat triangle pairs join into quads. With `tags: 'axis'` (default), faces are tagged
 * top, bottom, side, right, left, front and back.
 */
export function meshFromGeometry(geometry, { weld, quads = true, tags = 'axis' } = {}) {
  const { positions, normals, indices } = geometry ?? {};
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0 || positions.length === 0) throw new TypeError('Geometry needs Float32 positions.');
  if (!(indices instanceof Uint32Array) || indices.length % 3 !== 0 || indices.length === 0) throw new TypeError('Geometry needs Uint32 triangle indices.');
  const sourceCount = positions.length / 3;
  for (const index of indices) if (index >= sourceCount) throw new RangeError('Geometry index exceeds the vertex count.');
  if (tags !== 'axis' && tags !== 'none') throw new RangeError('tags must be "axis" or "none".');
  let tolerance = weld;
  if (tolerance === undefined) {
    const sourceBounds = meshBounds({ positions });
    tolerance = Math.hypot(...sourceBounds.max.map((value, axis) => value - sourceBounds.min[axis])) * 1e-6;
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('weld must be a nonnegative distance.');
  const { weldMap, representatives } = weldVertices(positions, tolerance);
  const weldedPositions = new Float32Array(representatives.length * 3);
  for (let vertex = 0; vertex < representatives.length; vertex++) {
    weldedPositions.set(positions.subarray(representatives[vertex] * 3, representatives[vertex] * 3 + 3), vertex * 3);
  }
  const keptTriangles = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const first = weldMap[indices[triangle * 3]];
    const second = weldMap[indices[triangle * 3 + 1]];
    const third = weldMap[indices[triangle * 3 + 2]];
    if (first !== second && second !== third && third !== first) keptTriangles.push(triangle);
  }
  if (!keptTriangles.length) throw new RangeError('Every triangle collapses after welding. Reduce weld.');
  const faceCount = keptTriangles.length;
  const faceOffsets = new Uint32Array(faceCount + 1);
  const cornerVertices = new Uint32Array(faceCount * 3);
  const cornerSource = new Uint32Array(faceCount * 3);
  for (let face = 0; face < faceCount; face++) {
    faceOffsets[face + 1] = (face + 1) * 3;
    for (let corner = 0; corner < 3; corner++) {
      const source = indices[keptTriangles[face] * 3 + corner];
      cornerSource[face * 3 + corner] = source;
      cornerVertices[face * 3 + corner] = weldMap[source];
    }
  }
  const edges = deriveEdges(representatives.length, faceOffsets, cornerVertices);
  const cornerAttributes = {};
  if (geometry.uvs instanceof Float32Array && geometry.uvs.length === sourceCount * 2) {
    cornerAttributes.uv = gatherAttribute({ data: geometry.uvs, size: 2 }, cornerSource);
  }
  if (geometry.colors instanceof Float32Array && geometry.colors.length === sourceCount * 3) {
    cornerAttributes.color = gatherAttribute({ data: geometry.colors, size: 3 }, cornerSource);
  }
  const edgeAttributes = {};
  if (normals instanceof Float32Array && normals.length === positions.length) {
    const sharp = new Uint8Array(edges.edgeCount);
    const probe = createMeshData({ positions: weldedPositions, faceOffsets, cornerVertices, edgeVertices: edges.edgeVertices, cornerEdges: edges.cornerEdges });
    const table = edgeCornerTable(probe);
    const { nextCorner } = cornerCycles(probe);
    for (let edge = 0; edge < edges.edgeCount; edge++) {
      const start = table.edgeOffsets[edge];
      if (table.edgeOffsets[edge + 1] - start !== 2) continue;
      const first = table.edgeCorners[start];
      const second = table.edgeCorners[start + 1];
      // Opposite winding: first's start vertex is second's end vertex.
      const pairs = [[first, nextCorner[second]], [nextCorner[first], second]];
      if (pairs.some(([left, right]) => differentNormals(normals, cornerSource[left], cornerSource[right]))) sharp[edge] = 1;
    }
    edgeAttributes.sharp = { data: sharp, size: 1 };
  }
  let mesh = createMeshData({
    positions: weldedPositions, faceOffsets, cornerVertices,
    edgeVertices: edges.edgeVertices, cornerEdges: edges.cornerEdges,
    attributes: { corner: cornerAttributes, edge: edgeAttributes },
  });
  if (quads) mesh = joinTriangles(mesh);
  if (tags === 'axis') mesh = tagFacesByAxis(mesh);
  return mesh;
}
