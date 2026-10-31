import { createMeshQueryIndex, createMeshPairQuery } from './mesh-query.js';
import { faceNormals } from './mesh-normals.js';

/**
 * Shape checks that need a spatial index: parts that cross, solids that cross themselves, walls too thin to print or
 * survive a bevel, parts that float free, and meshes that are almost symmetric. Each check has a budget so a lint call
 * stays cheap; a check that would pass it is skipped and named in the result instead of running long.
 */
export const GEOMETRY_LINT_BUDGET = Object.freeze({
  maxTrianglesPerPart: 20_000,
  maxTotalTriangles: 60_000,
  maxPartPairs: 64,
  maxThinWallSamples: 256,
  maxSymmetryVertices: 50_000,
  maxSampleElements: 8,
});

// Fractions of the mesh bounds diagonal.
const THIN_WALL_RATIO = 0.005;
const CONTACT_RATIO = 1e-4;
const SYMMETRY_MATCH_RATIO = 1e-4;
// Below this share of matched vertices a mesh is simply not symmetric; at or above it, the misses are mistakes.
const SYMMETRY_INTENT_SHARE = 0.8;
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function partFaces(facePart, partCount) {
  const faces = Array.from({ length: partCount }, () => []);
  for (let face = 0; face < facePart.length; face++) faces[facePart[face]].push(face);
  return faces;
}

/** Fan-triangulates the faces of one part into a compact Float32/Uint32 geometry for the query index. */
function partGeometry(mesh, faces) {
  const compactIndex = new Map();
  const positions = [];
  const indices = [];
  const compact = vertex => {
    let index = compactIndex.get(vertex);
    if (index === undefined) {
      index = compactIndex.size;
      compactIndex.set(vertex, index);
      positions.push(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
    }
    return index;
  };
  for (const face of faces) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const anchor = compact(mesh.cornerVertices[start]);
    for (let corner = start + 1; corner + 1 < end; corner++) {
      indices.push(anchor, compact(mesh.cornerVertices[corner]), compact(mesh.cornerVertices[corner + 1]));
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function geometryBounds(geometry) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], geometry.positions[offset + axis]);
      max[axis] = Math.max(max[axis], geometry.positions[offset + axis]);
    }
  }
  return { min, max };
}

function boundsGap(first, second) {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(first.min[axis] - second.max[axis], second.min[axis] - first.max[axis], 0);
    squared += gap * gap;
  }
  return Math.sqrt(squared);
}

function limitedSample(elements) {
  return elements.slice(0, GEOMETRY_LINT_BUDGET.maxSampleElements);
}

function findFloatingParts(bounds, contactDistance) {
  if (bounds.length < 2) return [];
  const floating = [];
  for (let part = 0; part < bounds.length; part++) {
    const touching = bounds.some((other, otherPart) => otherPart !== part && boundsGap(bounds[part], other) <= contactDistance);
    if (!touching) floating.push(part);
  }
  return floating;
}

function findIntersectingParts(geometries, bounds, contactDistance, skipped) {
  const crossing = [];
  let pairsTested = 0;
  for (let first = 0; first < geometries.length; first++) {
    for (let second = first + 1; second < geometries.length; second++) {
      if (boundsGap(bounds[first], bounds[second]) > contactDistance) continue;
      if (pairsTested++ >= GEOMETRY_LINT_BUDGET.maxPartPairs) {
        skipped.add('intersecting-parts');
        return crossing;
      }
      const firstIndex = createMeshQueryIndex(geometries[first]);
      const secondIndex = createMeshQueryIndex(geometries[second]);
      try {
        const result = createMeshPairQuery(firstIndex, secondIndex).evaluate(IDENTITY_MATRIX, IDENTITY_MATRIX);
        if (result.kind === 'surface-intersection') crossing.push(first * 1000 + second);
      } catch {
        skipped.add('intersecting-parts');
      } finally {
        firstIndex.dispose();
        secondIndex.dispose();
      }
    }
  }
  return crossing;
}

const SELF_INTERSECTION_MESSAGE = /intersect|overlap/i;

function hasSelfIntersection(geometry, skipped) {
  try {
    createMeshQueryIndex(geometry, { solid: true }).dispose();
    return false;
  } catch (error) {
    if (SELF_INTERSECTION_MESSAGE.test(error.message)) return true;
    skipped.add('self-intersection');
    return false;
  }
}

function faceCentroid(mesh, face) {
  const start = mesh.faceOffsets[face];
  const end = mesh.faceOffsets[face + 1];
  const centroid = [0, 0, 0];
  for (let corner = start; corner < end; corner++) {
    for (let axis = 0; axis < 3; axis++) centroid[axis] += mesh.positions[mesh.cornerVertices[corner] * 3 + axis];
  }
  return centroid.map(value => value / (end - start));
}

/** Casts a ray from each sampled face straight into the solid; a near hit means the wall is thin there. */
function findThinFaces(mesh, geometry, faces, normals, diagonal) {
  const index = createMeshQueryIndex(geometry);
  const nudge = diagonal * CONTACT_RATIO;
  const limit = diagonal * THIN_WALL_RATIO;
  const stride = Math.max(1, Math.ceil(faces.length / GEOMETRY_LINT_BUDGET.maxThinWallSamples));
  const thin = [];
  try {
    for (let position = 0; position < faces.length; position += stride) {
      const face = faces[position];
      const normal = [normals[face * 3], normals[face * 3 + 1], normals[face * 3 + 2]];
      const centroid = faceCentroid(mesh, face);
      const origin = centroid.map((value, axis) => value - normal[axis] * nudge);
      const hit = index.raycast(IDENTITY_MATRIX, { origin, direction: normal.map(value => -value) });
      if (hit && hit.distance + nudge < limit) thin.push(face);
    }
  } finally {
    index.dispose();
  }
  return thin;
}

function cellKey(cell) {
  return `${cell[0]},${cell[1]},${cell[2]}`;
}

/** Vertices that have no partner when the mesh is mirrored across the plane at `plane` on one axis. */
function unmatchedMirrorVertices(mesh, axis, plane, tolerance) {
  const cellSize = tolerance * 4;
  const cells = new Set();
  const cellOf = point => point.map(value => Math.round(value / cellSize));
  const pointOf = vertex => [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) cells.add(cellKey(cellOf(pointOf(vertex))));
  const unmatched = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const mirrored = pointOf(vertex);
    mirrored[axis] = 2 * plane - mirrored[axis];
    const home = cellOf(mirrored);
    let matched = false;
    for (let x = -1; x <= 1 && !matched; x++) {
      for (let y = -1; y <= 1 && !matched; y++) {
        for (let z = -1; z <= 1 && !matched; z++) {
          matched = cells.has(cellKey([home[0] + x, home[1] + y, home[2] + z]));
        }
      }
    }
    if (!matched) unmatched.push(vertex);
  }
  return unmatched;
}

function findAsymmetry(mesh, bounds, diagonal) {
  const found = [];
  for (const [axis, name] of [[0, 'x'], [2, 'z']]) {
    // A mirrored model is usually centred on the origin; otherwise on its bounds or its mean. Take the best plane.
    let mean = 0;
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) mean += mesh.positions[vertex * 3 + axis];
    const planes = [0, (bounds.min[axis] + bounds.max[axis]) / 2, mean / mesh.vertexCount];
    const candidates = planes.map(plane => unmatchedMirrorVertices(mesh, axis, plane, diagonal * SYMMETRY_MATCH_RATIO));
    const unmatched = candidates.reduce((best, candidate) => (candidate.length < best.length ? candidate : best));
    const matchedShare = 1 - unmatched.length / mesh.vertexCount;
    if (unmatched.length > 0 && matchedShare >= SYMMETRY_INTENT_SHARE) found.push({ axis: name, unmatched });
  }
  return found;
}

// The query index rejects triangles below its precision domain; a check that cannot run is named, never thrown.
function attempt(check, skipped, work, fallback) {
  try {
    return work();
  } catch {
    skipped.add(check);
    return fallback;
  }
}

function problem(kind, elements, extra = {}) {
  return { kind, count: elements.length, sample: limitedSample(elements), ...extra };
}

/**
 * Runs the spatial checks on a polygon mesh. `solidParts` lists the parts that are closed, consistently wound and
 * outward facing. Returns { problems, skipped }, where each problem has kind, count and a sample of element indices
 * (part pairs as first * 1000 + second, parts, faces or vertices by kind).
 */
export function lintMeshGeometry(mesh, { facePart, partCount, solidParts, bounds, diagonal }) {
  const skipped = new Set();
  const found = [];
  const faces = partFaces(facePart, partCount);
  const contactDistance = diagonal * CONTACT_RATIO;
  const totalFaces = faces.reduce((total, partFaceList) => total + partFaceList.length, 0);
  // Budgets count faces; a quad is two triangles, so these are loose upper-bound proxies for triangles.
  const withinBudget = totalFaces <= GEOMETRY_LINT_BUDGET.maxTotalTriangles
    && faces.every(partFaceList => partFaceList.length <= GEOMETRY_LINT_BUDGET.maxTrianglesPerPart);
  if (withinBudget) {
    const geometries = faces.map(partFaceList => partGeometry(mesh, partFaceList));
    const partBounds = geometries.map(geometryBounds);
    const crossing = attempt('intersecting-parts', skipped, () => findIntersectingParts(geometries, partBounds, contactDistance, skipped), []);
    if (crossing.length) found.push(problem('intersecting-parts', crossing));
    const selfCrossing = solidParts.filter(part => hasSelfIntersection(geometries[part], skipped));
    if (selfCrossing.length) found.push(problem('self-intersection', selfCrossing));
    const { normals } = faceNormals(mesh);
    const thinFaces = solidParts.flatMap(part => attempt('thin-wall', skipped, () => findThinFaces(mesh, geometries[part], faces[part], normals, diagonal), []));
    if (thinFaces.length) found.push(problem('thin-wall', thinFaces));
    const floating = findFloatingParts(partBounds, contactDistance);
    if (floating.length) found.push(problem('floating-part', floating));
  } else {
    for (const check of ['intersecting-parts', 'self-intersection', 'thin-wall', 'floating-part']) skipped.add(check);
  }
  if (mesh.vertexCount <= GEOMETRY_LINT_BUDGET.maxSymmetryVertices) {
    for (const { axis, unmatched } of findAsymmetry(mesh, bounds, diagonal)) {
      found.push(problem('asymmetric', unmatched, { axis }));
    }
  } else {
    skipped.add('asymmetric');
  }
  return { problems: found, skipped: [...skipped] };
}
