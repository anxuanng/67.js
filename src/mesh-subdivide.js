import { createMeshData, deriveEdges } from './mesh-data.js';
import { selectEdges, edgeFaces } from './mesh-bevel.js';

// Catmull-Clark subdivision with semi-sharp creases, on the rules Pixar published and OpenSubdiv implements
// (Sdc::Crease, "uniform" creasing): a crease of sharpness s acts fully sharp for s levels, and a fraction blends the
// smooth and sharp rules. Boundary edges are infinitely sharp, and a boundary vertex with one face stays a corner.
// Each level turns every n-gon into n quads, so the new face k is the old corner k.

export const MAX_SUBDIVISION_LEVELS = 4;
export const MAX_CREASE_SHARPNESS = 10;


/** Counts after `levels` levels, from counts alone, so a budget can be checked before anything is allocated. */
export function subdivisionSize(mesh, levels) {
  let vertices = mesh.vertexCount;
  let edges = mesh.edgeCount;
  let faces = mesh.faceCount;
  let corners = mesh.cornerCount;
  for (let level = 0; level < levels; level++) {
    vertices += edges + faces;
    edges = 2 * edges + corners;
    faces = corners;
    corners *= 4;
  }
  return { vertices, edges, faces, corners };
}

function creaseSharpness(mesh, creaseRule, sharpness) {
  const edgeSharpness = new Float64Array(mesh.edgeCount);
  if (!creaseRule) return edgeSharpness;
  const selected = selectEdges(mesh, creaseRule, edgeFaces(mesh));
  if (!selected.includes(1)) throw new RangeError('The crease rule selects no edges with two faces. Check tags with mesh_inspect, or lower angle.');
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (selected[edge]) edgeSharpness[edge] = sharpness;
  }
  return edgeSharpness;
}

function nextCornerOf(corner, faceStart, faceEnd) {
  return corner + 1 === faceEnd ? faceStart : corner + 1;
}

function facePoints(level) {
  const { positions, faceOffsets, cornerVertices, faceCount } = level;
  const points = new Float64Array(faceCount * 3);
  for (let face = 0; face < faceCount; face++) {
    const start = faceOffsets[face];
    const end = faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const vertex = cornerVertices[corner] * 3;
      points[face * 3] += positions[vertex];
      points[face * 3 + 1] += positions[vertex + 1];
      points[face * 3 + 2] += positions[vertex + 2];
    }
    const size = end - start;
    points[face * 3] /= size;
    points[face * 3 + 1] /= size;
    points[face * 3 + 2] /= size;
  }
  return points;
}

// Per edge: the two adjacent faces (-1 when absent) and how many faces use it.
function edgeAdjacency(level) {
  const { faceOffsets, cornerEdges, edgeCount, faceCount } = level;
  const firstFace = new Int32Array(edgeCount).fill(-1);
  const secondFace = new Int32Array(edgeCount).fill(-1);
  const faceUses = new Uint32Array(edgeCount);
  for (let face = 0; face < faceCount; face++) {
    for (let corner = faceOffsets[face]; corner < faceOffsets[face + 1]; corner++) {
      const edge = cornerEdges[corner];
      if (faceUses[edge] === 0) firstFace[edge] = face;
      if (faceUses[edge] === 1) secondFace[edge] = face;
      faceUses[edge]++;
    }
  }
  return { firstFace, secondFace, faceUses };
}

function effectiveSharpness(level, adjacency) {
  const sharpness = new Float64Array(level.edgeCount);
  for (let edge = 0; edge < level.edgeCount; edge++) {
    sharpness[edge] = adjacency.faceUses[edge] === 2 ? level.edgeSharpness[edge] : Infinity;
  }
  return sharpness;
}

function edgePoints(level, faceCentroids, adjacency, sharpness) {
  const { positions, edgeVertices, edgeCount } = level;
  const points = new Float64Array(edgeCount * 3);
  for (let edge = 0; edge < edgeCount; edge++) {
    const first = edgeVertices[edge * 2] * 3;
    const second = edgeVertices[edge * 2 + 1] * 3;
    const sharpWeight = Math.min(1, sharpness[edge]);
    const faceA = adjacency.firstFace[edge] * 3;
    const faceB = adjacency.secondFace[edge] * 3;
    for (let axis = 0; axis < 3; axis++) {
      const midpoint = (positions[first + axis] + positions[second + axis]) / 2;
      if (sharpWeight >= 1) {
        points[edge * 3 + axis] = midpoint;
        continue;
      }
      const smooth = (positions[first + axis] + positions[second + axis] + faceCentroids[faceA + axis] + faceCentroids[faceB + axis]) / 4;
      points[edge * 3 + axis] = smooth + (midpoint - smooth) * sharpWeight;
    }
  }
  return points;
}

// Sums over what touches each vertex, from which the smooth, crease and corner positions follow.
function vertexNeighborhoods(level, faceCentroids, sharpness) {
  const { positions, vertexCount, edgeVertices, edgeCount, faceOffsets, cornerVertices, faceCount } = level;
  const faceSum = new Float64Array(vertexCount * 3);
  const midpointSum = new Float64Array(vertexCount * 3);
  const sharpNeighborSum = new Float64Array(vertexCount * 3);
  const faceTotal = new Uint32Array(vertexCount);
  const edgeTotal = new Uint32Array(vertexCount);
  const sharpTotal = new Uint32Array(vertexCount);
  const sharpnessSum = new Float64Array(vertexCount);
  for (let face = 0; face < faceCount; face++) {
    for (let corner = faceOffsets[face]; corner < faceOffsets[face + 1]; corner++) {
      const vertex = cornerVertices[corner];
      faceTotal[vertex]++;
      for (let axis = 0; axis < 3; axis++) faceSum[vertex * 3 + axis] += faceCentroids[face * 3 + axis];
    }
  }
  for (let edge = 0; edge < edgeCount; edge++) {
    const isSharp = sharpness[edge] > 0;
    for (let end = 0; end < 2; end++) {
      const vertex = edgeVertices[edge * 2 + end];
      const other = edgeVertices[edge * 2 + 1 - end];
      edgeTotal[vertex]++;
      for (let axis = 0; axis < 3; axis++) {
        midpointSum[vertex * 3 + axis] += (positions[vertex * 3 + axis] + positions[other * 3 + axis]) / 2;
        if (isSharp) sharpNeighborSum[vertex * 3 + axis] += positions[other * 3 + axis];
      }
      if (isSharp) {
        sharpTotal[vertex]++;
        sharpnessSum[vertex] += Math.min(1, sharpness[edge]);
      }
    }
  }
  return { faceSum, midpointSum, sharpNeighborSum, faceTotal, edgeTotal, sharpTotal, sharpnessSum };
}

function vertexPoints(level, faceCentroids, sharpness) {
  const { positions, vertexCount } = level;
  const sums = vertexNeighborhoods(level, faceCentroids, sharpness);
  const points = new Float64Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const sharpCount = sums.sharpTotal[vertex];
    const valence = sums.edgeTotal[vertex];
    const isCorner = sharpCount >= 3 || (sharpCount === 2 && sums.faceTotal[vertex] === 1 && valence === 2);
    const isCrease = sharpCount === 2 && !isCorner;
    const blend = sharpCount >= 2 ? sums.sharpnessSum[vertex] / sharpCount : 0;
    for (let axis = 0; axis < 3; axis++) {
      const position = positions[vertex * 3 + axis];
      const facesAverage = sums.faceSum[vertex * 3 + axis] / Math.max(sums.faceTotal[vertex], 1);
      const edgesAverage = sums.midpointSum[vertex * 3 + axis] / Math.max(valence, 1);
      const smooth = (facesAverage + 2 * edgesAverage + (valence - 3) * position) / valence;
      let sharp = smooth;
      if (isCorner) sharp = position;
      if (isCrease) sharp = (6 * position + sums.sharpNeighborSum[vertex * 3 + axis]) / 8;
      points[vertex * 3 + axis] = smooth + (sharp - smooth) * Math.min(1, blend);
    }
  }
  return points;
}

// Corner attributes: floats blend linearly (UVs, colours), integer values copy from the corner they come from.
function refineCornerAttributes(level, attributes) {
  const refined = {};
  const { faceOffsets, faceCount } = level;
  for (const [name, attribute] of Object.entries(attributes)) {
    const { data, size } = attribute;
    const blends = data instanceof Float32Array;
    const next = new data.constructor(level.cornerCount * 4 * size);
    for (let face = 0; face < faceCount; face++) {
      const start = faceOffsets[face];
      const end = faceOffsets[face + 1];
      for (let component = 0; component < size; component++) {
        let sum = 0;
        for (let corner = start; corner < end; corner++) sum += data[corner * size + component];
        const center = blends ? sum / (end - start) : data[start * size + component];
        for (let corner = start; corner < end; corner++) {
          const base = corner * 4 * size + component;
          const here = data[corner * size + component];
          const after = data[nextCornerOf(corner, start, end) * size + component];
          const before = data[(corner === start ? end - 1 : corner - 1) * size + component];
          next[base] = here;
          next[base + size] = blends ? (here + after) / 2 : here;
          next[base + 2 * size] = center;
          next[base + 3 * size] = blends ? (here + before) / 2 : here;
        }
      }
    }
    refined[name] = { data: next, size };
  }
  return refined;
}

function refineFaceAttributes(level, attributes) {
  const refined = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    const { data, size } = attribute;
    const next = new data.constructor(level.cornerCount * size);
    for (let face = 0; face < level.faceCount; face++) {
      for (let corner = level.faceOffsets[face]; corner < level.faceOffsets[face + 1]; corner++) {
        next.set(data.subarray(face * size, (face + 1) * size), corner * size);
      }
    }
    refined[name] = { data: next, size };
  }
  return refined;
}

// Each half of an old edge is a new edge that keeps the old edge's attribute, and its sharpness minus one level.
function refineEdgeData(level, next, attributes) {
  const nextSharpness = new Float64Array(next.edgeCount);
  const sourceEdges = new Int32Array(next.edgeCount).fill(-1);
  for (let corner = 0; corner < level.cornerCount; corner++) {
    const oldEdge = level.cornerEdges[corner];
    const faceStart = level.cornerFaceStarts[corner];
    const previousCorner = corner === faceStart ? level.cornerFaceEnds[corner] - 1 : corner - 1;
    const halves = [next.cornerEdges[corner * 4], next.cornerEdges[corner * 4 + 3]];
    const parents = [oldEdge, level.cornerEdges[previousCorner]];
    halves.forEach((halfEdge, index) => {
      sourceEdges[halfEdge] = parents[index];
      nextSharpness[halfEdge] = Math.max(0, level.edgeSharpness[parents[index]] - 1);
    });
  }
  const refined = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    const { data, size } = attribute;
    const nextData = new data.constructor(next.edgeCount * size);
    sourceEdges.forEach((source, edge) => {
      if (source !== -1) nextData.set(data.subarray(source * size, (source + 1) * size), edge * size);
    });
    refined[name] = { data: nextData, size };
  }
  return { sharpness: nextSharpness, attributes: refined };
}

function cornerFaceRanges(level) {
  const starts = new Uint32Array(level.cornerCount);
  const ends = new Uint32Array(level.cornerCount);
  for (let face = 0; face < level.faceCount; face++) {
    for (let corner = level.faceOffsets[face]; corner < level.faceOffsets[face + 1]; corner++) {
      starts[corner] = level.faceOffsets[face];
      ends[corner] = level.faceOffsets[face + 1];
    }
  }
  return { cornerFaceStarts: starts, cornerFaceEnds: ends };
}

function refineTopology(level, faceCentroids, edgePositions, vertexPositions) {
  const { vertexCount, edgeCount, faceCount, faceOffsets, cornerVertices, cornerEdges } = level;
  const positions = new Float64Array((vertexCount + edgeCount + faceCount) * 3);
  positions.set(vertexPositions);
  positions.set(edgePositions, vertexCount * 3);
  positions.set(faceCentroids, (vertexCount + edgeCount) * 3);
  const nextCorners = new Uint32Array(level.cornerCount * 4);
  for (let face = 0; face < faceCount; face++) {
    const start = faceOffsets[face];
    const end = faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const previous = corner === start ? end - 1 : corner - 1;
      nextCorners[corner * 4] = cornerVertices[corner];
      nextCorners[corner * 4 + 1] = vertexCount + cornerEdges[corner];
      nextCorners[corner * 4 + 2] = vertexCount + edgeCount + face;
      nextCorners[corner * 4 + 3] = vertexCount + cornerEdges[previous];
    }
  }
  const nextFaceOffsets = new Uint32Array(level.cornerCount + 1);
  for (let face = 0; face <= level.cornerCount; face++) nextFaceOffsets[face] = face * 4;
  return { positions, faceOffsets: nextFaceOffsets, cornerVertices: nextCorners };
}

function refineLevel(level) {
  const centroids = facePoints(level);
  const adjacency = edgeAdjacency(level);
  const sharpness = effectiveSharpness(level, adjacency);
  const topology = refineTopology(
    level, centroids, edgePoints(level, centroids, adjacency, sharpness), vertexPoints(level, centroids, sharpness),
  );
  const edges = deriveEdges(topology.positions.length / 3, topology.faceOffsets, topology.cornerVertices);
  const next = {
    ...topology,
    vertexCount: topology.positions.length / 3,
    faceCount: level.cornerCount,
    cornerCount: level.cornerCount * 4,
    edgeVertices: edges.edgeVertices,
    cornerEdges: edges.cornerEdges,
    edgeCount: edges.edgeCount,
  };
  const edgeData = refineEdgeData({ ...level, ...cornerFaceRanges(level) }, next, level.attributes.edge);
  next.edgeSharpness = edgeData.sharpness;
  next.attributes = {
    face: refineFaceAttributes(level, level.attributes.face),
    corner: refineCornerAttributes(level, level.attributes.corner),
    edge: edgeData.attributes,
  };
  return next;
}

/**
 * Subdivide `levels` times. `creaseRule` is an edge rule (see selectEdges) and `sharpness` the crease strength from 0
 * to 10 (a crease holds for that many levels). Faces keep their tags, corner attributes such as uv blend linearly,
 * and edge attributes follow each half of a split edge. Point attributes are not carried.
 */
export function subdivideMesh(mesh, { levels = 1, crease, sharpness = MAX_CREASE_SHARPNESS } = {}) {
  let level = {
    positions: Float64Array.from(mesh.positions),
    vertexCount: mesh.vertexCount, edgeCount: mesh.edgeCount, faceCount: mesh.faceCount, cornerCount: mesh.cornerCount,
    faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges,
    edgeSharpness: creaseSharpness(mesh, crease, sharpness),
    attributes: mesh.attributes,
  };
  for (let step = 0; step < levels; step++) level = refineLevel(level);
  return createMeshData({
    positions: Float32Array.from(level.positions),
    faceOffsets: level.faceOffsets,
    cornerVertices: level.cornerVertices,
    edgeVertices: level.edgeVertices,
    cornerEdges: level.cornerEdges,
    attributes: { point: {}, ...level.attributes },
  });
}
