// Adjacency tables derived from MeshData on demand. Each is linear in the corner count.

/** Face index of every corner. */
export function cornerFaces(mesh) {
  const faces = new Uint32Array(mesh.cornerCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    faces.fill(face, mesh.faceOffsets[face], mesh.faceOffsets[face + 1]);
  }
  return faces;
}

/** Next and previous corner within the same face. */
export function cornerCycles(mesh) {
  const nextCorner = new Uint32Array(mesh.cornerCount);
  const previousCorner = new Uint32Array(mesh.cornerCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const next = corner + 1 === end ? start : corner + 1;
      nextCorner[corner] = next;
      previousCorner[next] = corner;
    }
  }
  return { nextCorner, previousCorner };
}

/**
 * Corners grouped by edge, in compressed rows: edgeCorners[edgeOffsets[e] .. edgeOffsets[e + 1]) are the corners
 * whose edge (corner to next corner) is e. The row length is the number of faces using the edge.
 */
export function edgeCornerTable(mesh) {
  const edgeOffsets = new Uint32Array(mesh.edgeCount + 1);
  for (let corner = 0; corner < mesh.cornerCount; corner++) edgeOffsets[mesh.cornerEdges[corner] + 1]++;
  for (let edge = 0; edge < mesh.edgeCount; edge++) edgeOffsets[edge + 1] += edgeOffsets[edge];
  const fill = edgeOffsets.slice(0, mesh.edgeCount);
  const edgeCorners = new Uint32Array(mesh.cornerCount);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const edge = mesh.cornerEdges[corner];
    edgeCorners[fill[edge]] = corner;
    fill[edge]++;
  }
  return { edgeOffsets, edgeCorners };
}

/** Disjoint-set forest over integers with path halving and union by size. */
export class UnionFind {
  constructor(count) {
    this.parent = new Uint32Array(count);
    this.size = new Uint32Array(count).fill(1);
    for (let index = 0; index < count; index++) this.parent[index] = index;
  }

  find(index) {
    const parent = this.parent;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

  union(first, second) {
    let rootFirst = this.find(first);
    let rootSecond = this.find(second);
    if (rootFirst === rootSecond) return rootFirst;
    if (this.size[rootFirst] < this.size[rootSecond]) {
      const swap = rootFirst;
      rootFirst = rootSecond;
      rootSecond = swap;
    }
    this.parent[rootSecond] = rootFirst;
    this.size[rootFirst] += this.size[rootSecond];
    return rootFirst;
  }
}

/** Connected parts by shared edges. Returns the part index of every face and the part count. */
export function faceParts(mesh, table = edgeCornerTable(mesh), facesOfCorners = cornerFaces(mesh)) {
  const sets = new UnionFind(mesh.faceCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const start = table.edgeOffsets[edge];
    const end = table.edgeOffsets[edge + 1];
    for (let index = start + 1; index < end; index++) {
      sets.union(facesOfCorners[table.edgeCorners[start]], facesOfCorners[table.edgeCorners[index]]);
    }
  }
  const partOfRoot = new Map();
  const facePart = new Uint32Array(mesh.faceCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    const root = sets.find(face);
    let part = partOfRoot.get(root);
    if (part === undefined) {
      part = partOfRoot.size;
      partOfRoot.set(root, part);
    }
    facePart[face] = part;
  }
  return { facePart, partCount: partOfRoot.size };
}
