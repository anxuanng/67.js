import { MeshBuilder } from './mesh-stack.js';
import { edgeFaces } from './mesh-bevel.js';

// Shared pieces for the edits that rebuild a mesh from a list of polygons (fill, dissolve, bisect, bridge, knife).
//
// A polygon is { vertices, sourceFace, sourceCorners, sourceEdges, tags }. Vertex numbers below the mesh's vertex count
// are its own vertices; higher numbers index the `extraPositions` array, offset by that count.

/** One polygon per face, each keeping its source face, corners and edges so attributes carry over. */
export function facePolygons(mesh) {
  const polygons = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    const polygon = { vertices: [], sourceFace: face, sourceCorners: [], sourceEdges: [], tags: [] };
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      polygon.vertices.push(mesh.cornerVertices[corner]);
      polygon.sourceCorners.push(corner);
      polygon.sourceEdges.push(mesh.cornerEdges[corner]);
    }
    polygons.push(polygon);
  }
  return polygons;
}

/** Build MeshData from polygons, dropping vertices that no polygon uses. */
export function buildPolygonMesh(mesh, polygons, extraPositions = []) {
  const used = new Set();
  for (const polygon of polygons) {
    for (const vertex of polygon.vertices) used.add(vertex);
  }
  const builder = new MeshBuilder(mesh);
  const remap = new Map();
  for (const vertex of [...used].sort((first, second) => first - second)) {
    const position = vertex < mesh.vertexCount
      ? [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]]
      : extraPositions[vertex - mesh.vertexCount];
    remap.set(vertex, builder.addVertex(...position));
  }
  for (const polygon of polygons) {
    builder.addFace(polygon.vertices.map(vertex => remap.get(vertex)), {
      sourceFace: polygon.sourceFace,
      sourceCorners: polygon.sourceCorners,
      sourceEdges: polygon.sourceEdges,
      keepTags: polygon.keepTags ?? true,
      tags: polygon.tags,
    });
  }
  return builder.build();
}

export function edgeFaceCounts(mesh) {
  const counts = new Uint32Array(mesh.edgeCount);
  for (const edge of mesh.cornerEdges) counts[edge]++;
  return counts;
}

/**
 * Boundary loops: chains of edges that have one face, each followed in the direction its own face runs. `vertices[i]`
 * to `vertices[i + 1]` is the half-edge of `corners[i]`. A chain that does not return to its start is `closed: false`.
 */
export function boundaryLoops(mesh, edgeMask = null) {
  const counts = edgeFaceCounts(mesh);
  const outgoing = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const edge = mesh.cornerEdges[corner];
      if (counts[edge] !== 1 || (edgeMask && !edgeMask[edge])) continue;
      const vertex = mesh.cornerVertices[corner];
      if (!outgoing.has(vertex)) outgoing.set(vertex, []);
      outgoing.get(vertex).push(corner);
    }
  }
  const nextCornerOf = corner => {
    const face = faceOfCorner(mesh, corner);
    return corner + 1 === mesh.faceOffsets[face + 1] ? mesh.faceOffsets[face] : corner + 1;
  };
  const taken = new Set();
  const loops = [];
  for (const candidates of outgoing.values()) {
    for (const firstCorner of candidates) {
      if (taken.has(firstCorner)) continue;
      const loop = { vertices: [], corners: [], closed: false };
      let corner = firstCorner;
      while (corner !== undefined && !taken.has(corner)) {
        taken.add(corner);
        loop.vertices.push(mesh.cornerVertices[corner]);
        loop.corners.push(corner);
        const arrival = mesh.cornerVertices[nextCornerOf(corner)];
        if (arrival === loop.vertices[0]) {
          loop.closed = true;
          break;
        }
        corner = (outgoing.get(arrival) ?? []).find(other => !taken.has(other));
      }
      loops.push(loop);
    }
  }
  return loops;
}

export function faceOfCorner(mesh, corner) {
  let low = 0;
  let high = mesh.faceCount - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (mesh.faceOffsets[middle] <= corner) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Distinct neighbouring vertices of each vertex, across a polygon list. */
export function vertexNeighbors(polygons) {
  const neighbors = new Map();
  const link = (first, second) => {
    if (!neighbors.has(first)) neighbors.set(first, new Set());
    neighbors.get(first).add(second);
  };
  for (const polygon of polygons) {
    polygon.vertices.forEach((vertex, index) => {
      const next = polygon.vertices[(index + 1) % polygon.vertices.length];
      link(vertex, next);
      link(next, vertex);
    });
  }
  return neighbors;
}

export { edgeFaces };
