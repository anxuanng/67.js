import { createMeshData, deriveEdges, TAG_PREFIX, meshBounds } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { edgeCornerTable } from './mesh-topology.js';
import { mergeByDistance } from './mesh-ops.js';

// Generative modifiers in Blender's spirit (Mirror, Array, Solidify), as pure MeshData -> MeshData functions.
// They run either as edits (destructive, in the edit log) or as stack nodes evaluated after the edits.

/**
 * Collects vertices and faces for a new mesh, carrying attributes from a source mesh: face attributes from a source
 * face, corner attributes from source corners, and edge attributes from the source edge each new corner's edge
 * came from. Faces built without a source get zeroed attributes.
 */
export class MeshBuilder {
  constructor(source) {
    this.source = source;
    this.positions = [];
    this.faceOffsets = [0];
    this.cornerVertices = [];
    this.cornerSources = [];
    this.cornerEdgeSources = [];
    this.faceSources = [];
    this.faceKeepsTags = [];
    this.faceTags = [];
    this.faceTagSwaps = [];
  }

  addVertex(x, y, z) {
    this.positions.push(x, y, z);
    return this.positions.length / 3 - 1;
  }

  /**
   * vertices: new vertex indices in winding order. sourceCorners / sourceEdges: per corner, the source corner whose
   * attributes it copies (or { from, to, t } to interpolate between two) and the source edge its outgoing edge copies
   * (-1 for none).
   */
  addFace(vertices, { sourceFace = -1, sourceCorners = null, sourceEdges = null, keepTags = true, tags = [], tagSwap = null } = {}) {
    for (let corner = 0; corner < vertices.length; corner++) {
      this.cornerVertices.push(vertices[corner]);
      this.cornerSources.push(sourceCorners ? sourceCorners[corner] : -1);
      this.cornerEdgeSources.push(sourceEdges ? sourceEdges[corner] : -1);
    }
    this.faceOffsets.push(this.cornerVertices.length);
    this.faceSources.push(sourceFace);
    this.faceKeepsTags.push(keepTags);
    this.faceTags.push(tags);
    this.faceTagSwaps.push(tagSwap);
  }

  build() {
    const source = this.source;
    const faceOffsets = Uint32Array.from(this.faceOffsets);
    const cornerVertices = Uint32Array.from(this.cornerVertices);
    const vertexCount = this.positions.length / 3;
    const edges = deriveEdges(vertexCount, faceOffsets, cornerVertices);
    const faceCount = this.faceSources.length;
    const attributes = { point: {}, edge: {}, face: {}, corner: {} };
    for (const [name, attribute] of Object.entries(source.attributes.face)) {
      const data = new attribute.data.constructor(faceCount * attribute.size);
      const isTag = name.startsWith(TAG_PREFIX);
      for (let face = 0; face < faceCount; face++) {
        const sourceFace = this.faceSources[face];
        if (sourceFace === -1 || (!this.faceKeepsTags[face] && isTag)) continue;
        // A mirrored face reads the opposite side's tag, so "left" stays on the left.
        const swapped = isTag ? this.faceTagSwaps[face]?.[name.slice(TAG_PREFIX.length)] : undefined;
        const from = swapped === undefined ? attribute : source.attributes.face[TAG_PREFIX + swapped];
        if (!from) continue;
        data.set(from.data.subarray(sourceFace * attribute.size, (sourceFace + 1) * attribute.size), face * attribute.size);
      }
      attributes.face[name] = { data, size: attribute.size };
    }
    for (let face = 0; face < faceCount; face++) {
      for (const tag of this.faceTags[face]) {
        const name = TAG_PREFIX + tag;
        attributes.face[name] ??= { data: new Uint8Array(faceCount), size: 1 };
        attributes.face[name].data[face] = 1;
      }
    }
    for (const [name, attribute] of Object.entries(source.attributes.corner)) {
      const data = new attribute.data.constructor(cornerVertices.length * attribute.size);
      const blends = attribute.data instanceof Float32Array;
      this.cornerSources.forEach((sourceCorner, corner) => {
        if (sourceCorner === -1) return;
        if (typeof sourceCorner === 'number') {
          data.set(attribute.data.subarray(sourceCorner * attribute.size, (sourceCorner + 1) * attribute.size), corner * attribute.size);
          return;
        }
        // Interpolated corner: linear for float attributes (UVs, colours), nearest for integer ones.
        const { from, to, t } = sourceCorner;
        for (let component = 0; component < attribute.size; component++) {
          const start = attribute.data[from * attribute.size + component];
          const end = attribute.data[to * attribute.size + component];
          data[corner * attribute.size + component] = blends ? start + (end - start) * t : (t < 0.5 ? start : end);
        }
      });
      attributes.corner[name] = { data, size: attribute.size };
    }
    for (const [name, attribute] of Object.entries(source.attributes.edge)) {
      const data = new attribute.data.constructor(edges.edgeCount * attribute.size);
      this.cornerEdgeSources.forEach((sourceEdge, corner) => {
        if (sourceEdge !== -1) {
          const edge = edges.cornerEdges[corner];
          data.set(attribute.data.subarray(sourceEdge * attribute.size, (sourceEdge + 1) * attribute.size), edge * attribute.size);
        }
      });
      attributes.edge[name] = { data, size: attribute.size };
    }
    return createMeshData({
      positions: Float32Array.from(this.positions), faceOffsets, cornerVertices,
      edgeVertices: edges.edgeVertices, cornerEdges: edges.cornerEdges, attributes,
    });
  }
}

function faceCorners(mesh, face) {
  const corners = [];
  for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) corners.push(corner);
  return corners;
}

/** Add a face of the source mesh, optionally reversed, through a vertex map. */
function copyFace(builder, mesh, face, vertexMap, { reversed = false, keepTags = true, tags = [], tagSwap = null } = {}) {
  const corners = faceCorners(mesh, face);
  if (reversed) corners.reverse();
  const vertices = corners.map(corner => vertexMap[mesh.cornerVertices[corner]]);
  // Forward, the edge after corner k is cornerEdges[k]. Reversed, the edge after corner k leads back to the
  // corner that preceded it, which is cornerEdges of the next corner in the reversed list.
  const sourceEdges = corners.map((corner, index) => reversed ? mesh.cornerEdges[corners[(index + 1) % corners.length]] : mesh.cornerEdges[corner]);
  builder.addFace(vertices, { sourceFace: face, sourceCorners: corners, sourceEdges, keepTags, tags, tagSwap });
}

/**
 * Remove pairs of faces over the same vertex set, which mirror planes and touching array copies leave inside a
 * solid. A duplicated face with the same winding keeps one copy.
 */
export function removeCoincidentFaces(mesh) {
  const byKey = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    const key = faceCorners(mesh, face).map(corner => mesh.cornerVertices[corner]).sort((left, right) => left - right).join(',');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(face);
  }
  const removed = new Uint8Array(mesh.faceCount);
  let removedCount = 0;
  for (const faces of byKey.values()) {
    if (faces.length < 2) continue;
    for (const face of faces) removed[face] = 1;
    removedCount += faces.length;
  }
  if (!removedCount) return { mesh, removedFaces: 0 };
  const used = new Uint8Array(mesh.vertexCount);
  const builder = new MeshBuilder(mesh);
  const vertexMap = new Int32Array(mesh.vertexCount).fill(-1);
  for (let face = 0; face < mesh.faceCount; face++) {
    if (removed[face]) continue;
    for (const corner of faceCorners(mesh, face)) used[mesh.cornerVertices[corner]] = 1;
  }
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (used[vertex]) vertexMap[vertex] = builder.addVertex(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
  }
  for (let face = 0; face < mesh.faceCount; face++) {
    if (!removed[face]) copyFace(builder, mesh, face, vertexMap);
  }
  if (builder.faceSources.length === 0) throw new RangeError('Removing coincident faces left nothing.');
  return { mesh: builder.build(), removedFaces: removedCount };
}

const AXES = Object.freeze({ x: 0, y: 1, z: 2 });
const MIRROR_TAG_SWAPS = Object.freeze({
  x: Object.freeze({ right: 'left', left: 'right' }),
  y: Object.freeze({ top: 'bottom', bottom: 'top' }),
  z: Object.freeze({ front: 'back', back: 'front' }),
});

/**
 * Mirror across the plane through the local origin perpendicular to `axis`. Vertices within `merge` of the plane
 * are snapped onto it and shared by both halves; faces lying in the plane on both halves are removed, so mirroring
 * a closed half gives a closed whole. Mirrored faces get the tag `<name>.mirrored`, and their axis tags swap
 * sides (left and right for x, top and bottom for y, front and back for z).
 */
export function mirrorMesh(mesh, { axis = 'x', merge = 0.001, name = 'mirror' } = {}) {
  const axisIndex = AXES[axis];
  if (axisIndex === undefined) throw new RangeError('axis must be x, y or z.');
  const builder = new MeshBuilder(mesh);
  const original = new Uint32Array(mesh.vertexCount);
  const mirrored = new Uint32Array(mesh.vertexCount);
  const onPlane = new Uint8Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const point = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
    if (Math.abs(point[axisIndex]) <= merge) {
      point[axisIndex] = 0;
      onPlane[vertex] = 1;
    }
    original[vertex] = builder.addVertex(point[0], point[1], point[2]);
  }
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (onPlane[vertex]) {
      mirrored[vertex] = original[vertex];
      continue;
    }
    const point = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
    point[axisIndex] = -point[axisIndex];
    mirrored[vertex] = builder.addVertex(point[0], point[1], point[2]);
  }
  for (let face = 0; face < mesh.faceCount; face++) copyFace(builder, mesh, face, original);
  for (let face = 0; face < mesh.faceCount; face++) {
    copyFace(builder, mesh, face, mirrored, { reversed: true, tags: [`${name}.mirrored`], tagSwap: MIRROR_TAG_SWAPS[axis] });
  }
  return removeCoincidentFaces(builder.build()).mesh;
}

/**
 * Repeat the mesh `count` times. Each copy moves by `offset` plus `relativeOffset` times the mesh's bounding-box
 * size. With `merge`, vertices of touching copies weld and the faces between them are removed. The last copy gets
 * the tag `<name>.last`.
 */
export function arrayMesh(mesh, { count = 2, offset = [0, 0, 0], relativeOffset = [1, 0, 0], merge = 0, name = 'array' } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 256) throw new RangeError('count must be an integer from 1 to 256.');
  const bounds = meshBounds(mesh);
  const step = [0, 1, 2].map(axis => offset[axis] + relativeOffset[axis] * (bounds.max[axis] - bounds.min[axis]));
  const builder = new MeshBuilder(mesh);
  for (let copy = 0; copy < count; copy++) {
    const vertexMap = new Uint32Array(mesh.vertexCount);
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      vertexMap[vertex] = builder.addVertex(
        mesh.positions[vertex * 3] + step[0] * copy,
        mesh.positions[vertex * 3 + 1] + step[1] * copy,
        mesh.positions[vertex * 3 + 2] + step[2] * copy,
      );
    }
    const tags = copy === count - 1 && count > 1 ? [`${name}.last`] : [];
    for (let face = 0; face < mesh.faceCount; face++) copyFace(builder, mesh, face, vertexMap, { tags });
  }
  let result = builder.build();
  if (merge > 0) {
    result = mergeByDistance(result, merge).mesh;
    result = removeCoincidentFaces(result).mesh;
  }
  return result;
}

/** Angle-weighted vertex normals from face normals. */
function vertexNormals(mesh) {
  const { normals } = faceNormals(mesh);
  const sums = new Float64Array(mesh.vertexCount * 3);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const previous = mesh.cornerVertices[corner === start ? end - 1 : corner - 1] * 3;
      const current = mesh.cornerVertices[corner] * 3;
      const next = mesh.cornerVertices[corner + 1 === end ? start : corner + 1] * 3;
      const first = [0, 1, 2].map(axis => mesh.positions[previous + axis] - mesh.positions[current + axis]);
      const second = [0, 1, 2].map(axis => mesh.positions[next + axis] - mesh.positions[current + axis]);
      const lengths = Math.hypot(...first) * Math.hypot(...second);
      const angle = lengths > 0 ? Math.acos(Math.max(-1, Math.min(1, (first[0] * second[0] + first[1] * second[1] + first[2] * second[2]) / lengths))) : 0;
      for (let axis = 0; axis < 3; axis++) sums[current + axis] += normals[face * 3 + axis] * angle;
    }
  }
  const result = new Float64Array(mesh.vertexCount * 3);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const length = Math.hypot(sums[vertex * 3], sums[vertex * 3 + 1], sums[vertex * 3 + 2]);
    if (length === 0) continue;
    for (let axis = 0; axis < 3; axis++) result[vertex * 3 + axis] = sums[vertex * 3 + axis] / length;
  }
  return result;
}

/**
 * Give a surface thickness, as Blender's Solidify (simple mode): a second shell along the vertex normals, reversed,
 * and rim quads along open edges. offset -1 grows inward from the surface (Blender's default), 1 outward, 0 centred.
 * With `evenThickness`, corners are pushed further so flat walls keep the full thickness. Inner faces get
 * `<name>.inner`, rim faces `<name>.rim`.
 */
export function solidifyMesh(mesh, { thickness, offset = -1, evenThickness = true, name = 'solidify' }) {
  const normals = vertexNormals(mesh);
  const outerShift = thickness * (offset + 1) / 2;
  const innerShift = thickness * (offset - 1) / 2;
  let scale = null;
  if (evenThickness) {
    // Divide by the mean cosine between the vertex normal and the normals of its faces.
    const { normals: faceNormal } = faceNormals(mesh);
    const cosineSum = new Float64Array(mesh.vertexCount);
    const cosineCount = new Uint32Array(mesh.vertexCount);
    for (let face = 0; face < mesh.faceCount; face++) {
      for (const corner of faceCorners(mesh, face)) {
        const vertex = mesh.cornerVertices[corner];
        cosineSum[vertex] += normals[vertex * 3] * faceNormal[face * 3] + normals[vertex * 3 + 1] * faceNormal[face * 3 + 1] + normals[vertex * 3 + 2] * faceNormal[face * 3 + 2];
        cosineCount[vertex]++;
      }
    }
    scale = new Float64Array(mesh.vertexCount);
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      const cosine = cosineCount[vertex] ? cosineSum[vertex] / cosineCount[vertex] : 1;
      scale[vertex] = 1 / Math.max(0.25, cosine);
    }
  }
  const builder = new MeshBuilder(mesh);
  const outer = new Uint32Array(mesh.vertexCount);
  const inner = new Uint32Array(mesh.vertexCount);
  for (const [map, shift] of [[outer, outerShift], [inner, innerShift]]) {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      const distance = shift * (scale ? scale[vertex] : 1);
      map[vertex] = builder.addVertex(
        mesh.positions[vertex * 3] + normals[vertex * 3] * distance,
        mesh.positions[vertex * 3 + 1] + normals[vertex * 3 + 1] * distance,
        mesh.positions[vertex * 3 + 2] + normals[vertex * 3 + 2] * distance,
      );
    }
  }
  for (let face = 0; face < mesh.faceCount; face++) copyFace(builder, mesh, face, outer);
  for (let face = 0; face < mesh.faceCount; face++) copyFace(builder, mesh, face, inner, { reversed: true, keepTags: false, tags: [`${name}.inner`] });
  const table = edgeCornerTable(mesh);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 1) continue;
    const corner = table.edgeCorners[table.edgeOffsets[edge]];
    const face = faceIndexOfCorner(mesh, corner);
    const start = mesh.cornerVertices[corner];
    const end = mesh.cornerVertices[corner + 1 === mesh.faceOffsets[face + 1] ? mesh.faceOffsets[face] : corner + 1];
    // The outer face runs start->end on this edge, so the rim runs end->start, then down to the inner shell.
    builder.addFace([outer[end], outer[start], inner[start], inner[end]], { sourceFace: face, keepTags: false, tags: [`${name}.rim`] });
  }
  return builder.build();
}

function faceIndexOfCorner(mesh, corner) {
  let low = 0;
  let high = mesh.faceCount - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (mesh.faceOffsets[middle] <= corner) low = middle;
    else high = middle - 1;
  }
  return low;
}

