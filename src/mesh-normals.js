import { cornerCycles, cornerFaces, edgeCornerTable, UnionFind } from './mesh-topology.js';

/**
 * Unit face normals by Newell's method, which handles non-planar polygons, and face areas.
 * Degenerate faces get a zero normal and zero area.
 */
export function faceNormals(mesh) {
  const normals = new Float32Array(mesh.faceCount * 3);
  const areas = new Float64Array(mesh.faceCount);
  const positions = mesh.positions;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    for (let corner = start; corner < end; corner++) {
      const current = mesh.cornerVertices[corner] * 3;
      const next = mesh.cornerVertices[corner + 1 === end ? start : corner + 1] * 3;
      normalX += (positions[current + 1] - positions[next + 1]) * (positions[current + 2] + positions[next + 2]);
      normalY += (positions[current + 2] - positions[next + 2]) * (positions[current] + positions[next]);
      normalZ += (positions[current] - positions[next]) * (positions[current + 1] + positions[next + 1]);
    }
    const length = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
    areas[face] = length / 2;
    if (length > 0) {
      normals[face * 3] = normalX / length;
      normals[face * 3 + 1] = normalY / length;
      normals[face * 3 + 2] = normalZ / length;
    }
  }
  return { normals, areas };
}

function cornerAngle(positions, previous, current, next) {
  const firstX = positions[previous] - positions[current];
  const firstY = positions[previous + 1] - positions[current + 1];
  const firstZ = positions[previous + 2] - positions[current + 2];
  const secondX = positions[next] - positions[current];
  const secondY = positions[next + 1] - positions[current + 1];
  const secondZ = positions[next + 2] - positions[current + 2];
  const crossX = firstY * secondZ - firstZ * secondY;
  const crossY = firstZ * secondX - firstX * secondZ;
  const crossZ = firstX * secondY - firstY * secondX;
  const crossLength = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
  return Math.atan2(crossLength, firstX * secondX + firstY * secondY + firstZ * secondZ);
}

/**
 * Corner normals with hard edges, following Blender's model: corners around a vertex are smoothed together across
 * an edge unless the edge is marked sharp (edge attribute "sharp"), is a boundary or non-manifold edge, has faces
 * with opposite winding, or bends by more than sharpAngle (radians; Infinity disables the angle test).
 * Face normals are weighted by corner angle. Returns one normal per smooth group (groupNormals) and the group of
 * every corner (groupOfCorner); the normal of corner c is groupNormals[groupOfCorner[c]].
 */
export function cornerNormals(mesh, { sharpAngle = Infinity } = {}) {
  const { normals: faceNormal } = faceNormals(mesh);
  const { nextCorner, previousCorner } = cornerCycles(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const table = edgeCornerTable(mesh);
  const sharp = mesh.attributes.edge.sharp?.data;
  const cosineLimit = Number.isFinite(sharpAngle) ? Math.cos(sharpAngle) : -2;
  const groups = new UnionFind(mesh.cornerCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) continue;
    if (sharp && sharp[edge]) continue;
    const first = table.edgeCorners[table.edgeOffsets[edge]];
    const second = table.edgeCorners[table.edgeOffsets[edge] + 1];
    // Consistent winding runs the shared edge in opposite directions.
    if (mesh.cornerVertices[first] === mesh.cornerVertices[second]) continue;
    const firstFace = facesOfCorners[first];
    const secondFace = facesOfCorners[second];
    const cosine = faceNormal[firstFace * 3] * faceNormal[secondFace * 3] +
      faceNormal[firstFace * 3 + 1] * faceNormal[secondFace * 3 + 1] +
      faceNormal[firstFace * 3 + 2] * faceNormal[secondFace * 3 + 2];
    if (cosine < cosineLimit) continue;
    // first runs a->b and second runs b->a, so the corners at a are first and next(second), at b next(first) and second.
    groups.union(first, nextCorner[second]);
    groups.union(nextCorner[first], second);
  }
  // Number the smooth groups once, so accumulation and lookup avoid repeated find() calls.
  const groupOfCorner = new Uint32Array(mesh.cornerCount);
  const groupOfRoot = new Int32Array(mesh.cornerCount).fill(-1);
  const firstCorners = new Uint32Array(mesh.cornerCount);
  let groupCount = 0;
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const root = groups.find(corner);
    if (groupOfRoot[root] === -1) {
      groupOfRoot[root] = groupCount;
      firstCorners[groupCount] = corner;
      groupCount++;
    }
    groupOfCorner[corner] = groupOfRoot[root];
  }
  const groupFirstCorner = firstCorners.subarray(0, groupCount);
  const accumulated = new Float64Array(groupCount * 3);
  const positions = mesh.positions;
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const face = facesOfCorners[corner];
    const weight = cornerAngle(
      positions,
      mesh.cornerVertices[previousCorner[corner]] * 3,
      mesh.cornerVertices[corner] * 3,
      mesh.cornerVertices[nextCorner[corner]] * 3,
    );
    const group = groupOfCorner[corner];
    accumulated[group * 3] += faceNormal[face * 3] * weight;
    accumulated[group * 3 + 1] += faceNormal[face * 3 + 1] * weight;
    accumulated[group * 3 + 2] += faceNormal[face * 3 + 2] * weight;
  }
  const groupNormals = new Float32Array(groupCount * 3);
  for (let group = 0; group < groupCount; group++) {
    let normalX = accumulated[group * 3];
    let normalY = accumulated[group * 3 + 1];
    let normalZ = accumulated[group * 3 + 2];
    let length = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
    if (length === 0) {
      // A degenerate fan falls back to its own face normal, then to +Z.
      const face = facesOfCorners[groupFirstCorner[group]];
      normalX = faceNormal[face * 3];
      normalY = faceNormal[face * 3 + 1];
      normalZ = faceNormal[face * 3 + 2];
      length = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
      if (length === 0) {
        normalZ = 1;
        length = 1;
      }
    }
    groupNormals[group * 3] = normalX / length;
    groupNormals[group * 3 + 1] = normalY / length;
    groupNormals[group * 3 + 2] = normalZ / length;
  }
  return {
    groupNormals, groupOfCorner, groupCount, groupFirstCorner, faceNormals: faceNormal,
  };
}

export function faceCentroids(mesh) {
  const centroids = new Float64Array(mesh.faceCount * 3);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const vertex = mesh.cornerVertices[corner] * 3;
      centroids[face * 3] += mesh.positions[vertex];
      centroids[face * 3 + 1] += mesh.positions[vertex + 1];
      centroids[face * 3 + 2] += mesh.positions[vertex + 2];
    }
    const size = end - start;
    centroids[face * 3] /= size;
    centroids[face * 3 + 1] /= size;
    centroids[face * 3 + 2] /= size;
  }
  return centroids;
}

/** Angle-weighted vertex normals from face normals. */
export function vertexNormals(mesh) {
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
