import { MeshBuilder } from './mesh-stack.js';
import { triangulateMesh } from './mesh-render.js';
import { faceNormals } from './mesh-normals.js';
import { edgeCornerTable, cornerFaces, UnionFind } from './mesh-topology.js';

// Modifiers that change how a mesh is cut into faces and vertices without moving its surface: triangulate and edge_split.
// Both are exact (Blender's Triangulate and Edge Split modifiers give the same counts) and both check their output
// size before allocating it.

const SHARP_TOLERANCE = 1e-6;

function nextCornerInFace(mesh, corner, face) {
  return corner + 1 === mesh.faceOffsets[face + 1] ? mesh.faceOffsets[face] : corner + 1;
}

function copyPositions(mesh, builder) {
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    builder.addVertex(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
  }
}

function sourceCornersOfFace(mesh, face) {
  const corners = [];
  for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) corners.push(corner);
  return corners;
}

function addUnchangedFace(builder, mesh, face) {
  const corners = sourceCornersOfFace(mesh, face);
  builder.addFace(corners.map(corner => mesh.cornerVertices[corner]), {
    sourceFace: face, sourceCorners: corners, sourceEdges: corners.map(corner => mesh.cornerEdges[corner]),
  });
}

function addTriangle(builder, mesh, face, triangleCorners) {
  // An edge of the triangle is a real edge of the face only when its end is the next corner of the face.
  const sourceEdges = triangleCorners.map((corner, position) => {
    const following = triangleCorners[(position + 1) % 3];
    return nextCornerInFace(mesh, corner, face) === following ? mesh.cornerEdges[corner] : -1;
  });
  builder.addFace(triangleCorners.map(corner => mesh.cornerVertices[corner]), {
    sourceFace: face, sourceCorners: triangleCorners, sourceEdges,
  });
}

/**
 * Cut every face with at least `minVertices` corners into triangles (quads along the shorter diagonal, larger faces by
 * ear clipping), keeping winding, tags and corner attributes. Throws before allocating when the result would pass `maxFaces`.
 */
export function triangulateFaces(mesh, { minVertices = 4, maxFaces = Infinity } = {}) {
  let triangleTotal = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const size = mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
    triangleTotal += size >= minVertices ? size - 2 : 1;
  }
  if (triangleTotal > maxFaces) {
    throw new RangeError(`triangulate would make ${triangleTotal} faces, over the limit of ${maxFaces}.`);
  }
  const { triangleCorners, triangleFaces } = triangulateMesh(mesh, faceNormals(mesh).normals);
  const builder = new MeshBuilder(mesh);
  copyPositions(mesh, builder);
  let triangle = 0;
  let triangulated = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const size = mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
    if (size < minVertices) {
      addUnchangedFace(builder, mesh, face);
      triangle += size - 2;
      continue;
    }
    if (size > 3) triangulated++;
    for (let count = size - 2; count > 0; count--, triangle++) {
      addTriangle(builder, mesh, face, Array.from(triangleCorners.subarray(triangle * 3, triangle * 3 + 3)));
    }
  }
  return { mesh: builder.build(), triangulated, triangles: triangleTotal };
}

function sharedCorner(mesh, faces, corner, vertex) {
  return mesh.cornerVertices[corner] === vertex ? corner : nextCornerInFace(mesh, corner, faces[corner]);
}

/** Groups the corners around each vertex that stay joined: neighbours across an edge that is not sharp. */
function smoothCornerGroups(mesh, angleDegrees) {
  const normals = faceNormals(mesh).normals;
  const table = edgeCornerTable(mesh);
  const faces = cornerFaces(mesh);
  const limit = Math.cos(angleDegrees * Math.PI / 180) - SHARP_TOLERANCE;
  const groups = new UnionFind(mesh.cornerCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const start = table.edgeOffsets[edge];
    if (table.edgeOffsets[edge + 1] - start !== 2) continue;
    const first = table.edgeCorners[start];
    const second = table.edgeCorners[start + 1];
    const firstNormal = faces[first] * 3;
    const secondNormal = faces[second] * 3;
    const alignment = normals[firstNormal] * normals[secondNormal]
      + normals[firstNormal + 1] * normals[secondNormal + 1]
      + normals[firstNormal + 2] * normals[secondNormal + 2];
    if (alignment < limit) continue;
    for (const vertex of [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]) {
      groups.union(sharedCorner(mesh, faces, first, vertex), sharedCorner(mesh, faces, second, vertex));
    }
  }
  return groups;
}

/**
 * Give each smooth fan of faces around a vertex its own copy of the vertex, so edges bending more than `angle` degrees
 * (and edges shared by three or more faces) come apart. Open boundary edges join nothing and stay as they are.
 * Throws before allocating when the vertex count would pass `maxVertices`.
 */
export function splitSharpEdges(mesh, { angle = 30, maxVertices = Infinity } = {}) {
  const groups = smoothCornerGroups(mesh, angle);
  const vertexOfGroup = new Map();
  const firstGroupOfVertex = new Uint8Array(mesh.vertexCount);
  let vertexTotal = mesh.vertexCount;
  const groupsPerCorner = new Uint32Array(mesh.cornerCount);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const root = groups.find(corner);
    groupsPerCorner[corner] = root;
    if (vertexOfGroup.has(root)) continue;
    const vertex = mesh.cornerVertices[corner];
    vertexOfGroup.set(root, firstGroupOfVertex[vertex] ? -1 : vertex);
    if (firstGroupOfVertex[vertex]) vertexTotal++;
    firstGroupOfVertex[vertex] = 1;
  }
  if (vertexTotal > maxVertices) {
    throw new RangeError(`edge_split would make ${vertexTotal} vertices, over the limit of ${maxVertices}.`);
  }
  const builder = new MeshBuilder(mesh);
  copyPositions(mesh, builder);
  const splitVertices = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    const corners = sourceCornersOfFace(mesh, face);
    const vertices = corners.map(corner => {
      const root = groupsPerCorner[corner];
      if (vertexOfGroup.get(root) === -1) {
        const source = mesh.cornerVertices[corner] * 3;
        const copy = builder.addVertex(mesh.positions[source], mesh.positions[source + 1], mesh.positions[source + 2]);
        vertexOfGroup.set(root, copy);
        splitVertices.push(copy);
      }
      return vertexOfGroup.get(root);
    });
    builder.addFace(vertices, { sourceFace: face, sourceCorners: corners, sourceEdges: corners.map(corner => mesh.cornerEdges[corner]) });
  }
  return { mesh: builder.build(), addedVertices: splitVertices.length };
}
