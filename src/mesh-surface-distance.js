import { buildTriangleBvh, traverseTriangleBvh, pointBoxDistance } from './triangle-bvh.js';
import { readTriangle, closestPointOnTriangle, barycentricWeights } from './triangle-math.js';
import { triangulateMesh } from './mesh-render.js';
import { faceNormals, vertexNormals } from './mesh-normals.js';

// Distance from a point to a polygon mesh through a triangle BVH, signed by the angle-weighted vertex normals
// interpolated at the nearest point (negative inside a closed mesh). Used by remesh and by the measured error of
// decimation and generated levels.

/** The mesh as indexed triangles over its own vertices. */
export function triangulatedSurface(mesh) {
  const { triangleCorners } = triangulateMesh(mesh, faceNormals(mesh).normals);
  const indices = new Uint32Array(triangleCorners.length);
  for (let index = 0; index < indices.length; index++) indices[index] = mesh.cornerVertices[triangleCorners[index]];
  return { positions: mesh.positions, indices };
}

export function createSurfaceDistance(mesh, { signed = false } = {}) {
  const { positions, indices } = triangulatedSurface(mesh);
  const bvh = buildTriangleBvh(positions, indices);
  const normals = signed ? vertexNormals(mesh) : null;
  const triangle = new Float64Array(9);
  const candidate = [0, 0, 0];
  const weights = [0, 0, 0];

  function signAt(point, triangleId) {
    readTriangle(positions, indices, triangleId, triangle);
    closestPointOnTriangle(point, triangle, candidate);
    if (!barycentricWeights(candidate, triangle, weights)) return 1;
    let along = 0;
    for (let axis = 0; axis < 3; axis++) {
      let interpolated = 0;
      for (let corner = 0; corner < 3; corner++) interpolated += weights[corner] * normals[indices[triangleId * 3 + corner] * 3 + axis];
      along += interpolated * (point[axis] - candidate[axis]);
    }
    return along < 0 ? -1 : 1;
  }

  /** Distance to the surface, and the nearest triangle. With `signed`, the distance is negative inside. */
  function query(point) {
    let best = Infinity;
    let bestTriangle = -1;
    traverseTriangleBvh(
      bvh,
      (bounds, offset) => pointBoxDistance(point, bounds, offset),
      score => score <= best,
      triangleId => {
        readTriangle(positions, indices, triangleId, triangle);
        closestPointOnTriangle(point, triangle, candidate);
        const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1], candidate[2] - point[2]);
        if (distance < best) {
          best = distance;
          bestTriangle = triangleId;
        }
        return false;
      },
    );
    return { distance: signed && bestTriangle >= 0 ? best * signAt(point, bestTriangle) : best, triangle: bestTriangle };
  }

  return { query, triangleCount: indices.length / 3 };
}

function farthestVertex(mesh, surface) {
  const point = [0, 0, 0];
  const measured = new Uint8Array(mesh.vertexCount);
  let farthest = 0;
  for (const vertex of mesh.cornerVertices) {
    if (measured[vertex]) continue;
    measured[vertex] = 1;
    for (let axis = 0; axis < 3; axis++) point[axis] = mesh.positions[vertex * 3 + axis];
    farthest = Math.max(farthest, surface.query(point).distance);
  }
  return farthest;
}

/**
 * How far two surfaces are apart, measured at vertices in both directions: `toReference` is the farthest vertex of
 * `mesh` from `reference`, `fromReference` the other way, and `hausdorff` the larger of the two.
 */
export function surfaceDeviation(mesh, reference) {
  const toReference = farthestVertex(mesh, createSurfaceDistance(reference));
  const fromReference = farthestVertex(reference, createSurfaceDistance(mesh));
  return { toReference, fromReference, hausdorff: Math.max(toReference, fromReference) };
}

/** Signed volume of a closed polygon mesh; positive when faces wind outward. */
export function signedVolume(mesh) {
  const { positions, indices } = triangulatedSurface(mesh);
  let volume = 0;
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const [a, b, c] = [0, 1, 2].map(corner => indices[triangle * 3 + corner] * 3);
    volume += (
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) +
      positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])
    ) / 6;
  }
  return volume;
}
