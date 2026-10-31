import { createMeshData, TAG_PREFIX } from './mesh-data.js';
import { meshFromGeometry, withFaceAttributes } from './mesh-convert.js';
import { editMesh } from './mesh-edit.js';
import { validateTopology } from './mesh-validate.js';
import { extractRender } from './mesh-render.js';
import { applyMeshEdits } from './mesh-recipe.js';
import { buildTriangleBvh, traverseTriangleBvh, pointBoxDistance } from './triangle-bvh.js';
import { barycentricWeights, closestPointOnTriangle, readTriangle } from './triangle-math.js';
import { IMPORTED_MESH_EDIT_LIMITS } from './mesh-operations.js';

// Edits imported renderer geometry (an imported GLB part) with the polygon mesh edit vocabulary. The part becomes a
// welded polygon mesh, the edits run on it, and the result is extracted back to renderer geometry. Vertices the edits
// create or move have no skin weights, morph deltas, vertex colours or UVs of their own, so those are transferred from
// the nearest point of the original surface, as Blender's Data Transfer does. The result says how far the transfer
// reached, and an edit that would turn the transfer into a guess is rejected.

const EXACT_WEIGHT = 1 - 1e-6;
const MAX_INFLUENCES = 4;

/** Nearest-surface lookups on the original triangles: which triangle, the barycentric weights and the distance. */
function createSurfaceSampler(geometry) {
  const positions = Float64Array.from(geometry.positions);
  const bvh = buildTriangleBvh(positions, geometry.indices);
  const triangle = new Float64Array(9);
  const candidate = new Float64Array(3);
  const closest = new Float64Array(3);
  const scratchWeights = new Float64Array(3);
  const query = new Float64Array(3);

  function nearest(x, y, z, result) {
    query[0] = x;
    query[1] = y;
    query[2] = z;
    let bestSquared = Infinity;
    let bestTriangle = 0;
    traverseTriangleBvh(
      bvh,
      (bounds, offset) => pointBoxDistance(query, bounds, offset),
      score => score * score <= bestSquared,
      triangleId => {
        readTriangle(positions, geometry.indices, triangleId, triangle);
        closestPointOnTriangle(query, triangle, candidate);
        const squared = (candidate[0] - x) ** 2 + (candidate[1] - y) ** 2 + (candidate[2] - z) ** 2;
        if (squared < bestSquared) {
          bestSquared = squared;
          bestTriangle = triangleId;
          closest.set(candidate);
        }
        return false;
      },
    );
    readTriangle(positions, geometry.indices, bestTriangle, triangle);
    const weights = barycentricWeights(closest, triangle, scratchWeights);
    result.triangle = bestTriangle;
    result.distance = Math.sqrt(bestSquared);
    for (let corner = 0; corner < 3; corner++) {
      result.weights[corner] = weights ? Math.max(0, weights[corner]) : (corner === 0 ? 1 : 0);
    }
    const total = result.weights[0] + result.weights[1] + result.weights[2];
    for (let corner = 0; corner < 3; corner++) result.weights[corner] /= total;
    return result;
  }

  return { nearest, triangleVertex: (triangleId, corner) => geometry.indices[triangleId * 3 + corner] };
}

function createLookup() {
  return { triangle: 0, distance: 0, weights: new Float64Array(3) };
}

function exactCorner(weights) {
  for (let corner = 0; corner < 3; corner++) {
    if (weights[corner] >= EXACT_WEIGHT) return corner;
  }
  return -1;
}

function blendValues(source, size, vertices, weights, target, targetVertex) {
  const exact = exactCorner(weights);
  for (let component = 0; component < size; component++) {
    let value = 0;
    if (exact >= 0) {
      value = source[vertices[exact] * size + component];
    } else {
      for (let corner = 0; corner < 3; corner++) value += source[vertices[corner] * size + component] * weights[corner];
    }
    target[targetVertex * size + component] = value;
  }
}

/** The four heaviest joints among the three corners' influences, weights summing to what the corners summed to. */
function blendInfluences(indices, skinWeights, vertices, weights, targetIndices, targetWeights, targetVertex) {
  const exact = exactCorner(weights);
  const totals = new Map();
  for (let corner = 0; corner < 3; corner++) {
    if (exact >= 0 && corner !== exact) continue;
    const share = exact >= 0 ? 1 : weights[corner];
    for (let influence = 0; influence < MAX_INFLUENCES; influence++) {
      const weight = skinWeights[vertices[corner] * MAX_INFLUENCES + influence] * share;
      if (weight <= 0) continue;
      const joint = indices[vertices[corner] * MAX_INFLUENCES + influence];
      totals.set(joint, (totals.get(joint) ?? 0) + weight);
    }
  }
  const heaviest = [...totals].sort((first, second) => second[1] - first[1]).slice(0, MAX_INFLUENCES);
  const kept = heaviest.reduce((sum, [, weight]) => sum + weight, 0);
  let original = 0;
  for (const weight of totals.values()) original += weight;
  const scale = exact >= 0 || kept === 0 ? 1 : original / kept;
  for (let influence = 0; influence < MAX_INFLUENCES; influence++) {
    const [joint, weight] = heaviest[influence] ?? [0, 0];
    targetIndices[targetVertex * MAX_INFLUENCES + influence] = joint;
    targetWeights[targetVertex * MAX_INFLUENCES + influence] = weight * scale;
  }
}

function boundsDiagonal(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset++) {
    const axis = offset % 3;
    minimum[axis] = Math.min(minimum[axis], positions[offset]);
    maximum[axis] = Math.max(maximum[axis], positions[offset]);
  }
  return Math.hypot(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]);
}

function hasZeroUv(uv, start, end) {
  for (let corner = start; corner < end; corner++) {
    if (uv.data[corner * 2] === 0 && uv.data[corner * 2 + 1] === 0) return true;
  }
  return false;
}

/**
 * UVs for faces whose corners have none (an edit that adds corners leaves them at 0,0, and some edits drop the
 * attribute): each such face reads the UV island of the original triangle nearest its centre, so a face never
 * straddles a seam. Returns the mesh and the count of rebuilt faces.
 */
function rebuildMissingUvs(mesh, source, sampler) {
  const existing = mesh.attributes.corner.uv?.size === 2 ? mesh.attributes.corner.uv : undefined;
  const data = existing ? Float32Array.from(existing.data) : new Float32Array(mesh.cornerCount * 2);
  const lookup = createLookup();
  const triangle = new Float64Array(9);
  const weights = new Float64Array(3);
  const point = new Float64Array(3);
  let rebuilt = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    if (existing && !hasZeroUv(existing, start, end)) continue;
    let centreX = 0;
    let centreY = 0;
    let centreZ = 0;
    for (let corner = start; corner < end; corner++) {
      centreX += mesh.positions[mesh.cornerVertices[corner] * 3] / (end - start);
      centreY += mesh.positions[mesh.cornerVertices[corner] * 3 + 1] / (end - start);
      centreZ += mesh.positions[mesh.cornerVertices[corner] * 3 + 2] / (end - start);
    }
    sampler.nearest(centreX, centreY, centreZ, lookup);
    readTriangle(source.positions, source.indices, lookup.triangle, triangle);
    for (let corner = start; corner < end; corner++) {
      const vertex = mesh.cornerVertices[corner];
      point.set(mesh.positions.subarray(vertex * 3, vertex * 3 + 3));
      const found = barycentricWeights(point, triangle, weights);
      for (let component = 0; component < 2; component++) {
        let value = 0;
        for (let cornerOfTriangle = 0; cornerOfTriangle < 3; cornerOfTriangle++) {
          const weight = found ? found[cornerOfTriangle] : (cornerOfTriangle === 0 ? 1 : 0);
          value += source.uvs[sampler.triangleVertex(lookup.triangle, cornerOfTriangle) * 2 + component] * weight;
        }
        data[corner * 2 + component] = value;
      }
    }
    rebuilt++;
  }
  if (!rebuilt) return { mesh, rebuilt };
  const attributes = { point: { ...mesh.attributes.point }, edge: { ...mesh.attributes.edge }, face: { ...mesh.attributes.face }, corner: { ...mesh.attributes.corner } };
  attributes.corner.uv = { data, size: 2 };
  return {
    rebuilt,
    mesh: createMeshData({
      positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
      edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
    }),
  };
}

/** What the edited geometry keeps of the source, filled from the nearest original surface. Returns the farthest reach. */
function transferVertexAttributes(source, edited, sampler) {
  const vertexCount = edited.positions.length / 3;
  const skinned = Boolean(source.skinIndices && source.skinWeights);
  const morphTargets = source.morphTargets ?? [];
  if (skinned) {
    edited.skinIndices = new Uint16Array(vertexCount * MAX_INFLUENCES);
    edited.skinWeights = new Float32Array(vertexCount * MAX_INFLUENCES);
  }
  if (source.colors) edited.colors = new Float32Array(vertexCount * 3);
  if (morphTargets.length) {
    edited.morphTargets = morphTargets.map(target => ({
      ...(target.positions ? { positions: new Float32Array(vertexCount * 3) } : {}),
      ...(target.normals ? { normals: new Float32Array(vertexCount * 3) } : {}),
    }));
  }
  if (!skinned && !source.colors && !morphTargets.length) return 0;
  const lookup = createLookup();
  const vertices = [0, 0, 0];
  let farthest = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    sampler.nearest(edited.positions[vertex * 3], edited.positions[vertex * 3 + 1], edited.positions[vertex * 3 + 2], lookup);
    farthest = Math.max(farthest, lookup.distance);
    for (let corner = 0; corner < 3; corner++) vertices[corner] = sampler.triangleVertex(lookup.triangle, corner);
    if (skinned) blendInfluences(source.skinIndices, source.skinWeights, vertices, lookup.weights, edited.skinIndices, edited.skinWeights, vertex);
    if (source.colors) blendValues(source.colors, 3, vertices, lookup.weights, edited.colors, vertex);
    morphTargets.forEach((target, index) => {
      if (target.positions) blendValues(target.positions, 3, vertices, lookup.weights, edited.morphTargets[index].positions, vertex);
      if (target.normals) blendValues(target.normals, 3, vertices, lookup.weights, edited.morphTargets[index].normals, vertex);
    });
  }
  return farthest;
}

function tagFacesOfMaterial(mesh, materialTag) {
  if (!materialTag) return mesh;
  return withFaceAttributes(mesh, { [`${TAG_PREFIX}${materialTag}`]: { data: new Uint8Array(mesh.faceCount).fill(1), size: 1 } });
}

/**
 * Apply mesh edits to imported renderer geometry. `materialTag` names a face tag on every face (an imported part
 * has one material). Returns the edited geometry, its polygon mesh, the per-edit results and what was transferred.
 * Throws a RangeError that names the next action when skin weights or morph targets cannot follow the edit.
 */
export function editImportedGeometry(source, edits, { maxVertices, smoothAngle, resolveCutter, materialTag }) {
  const base = tagFacesOfMaterial(meshFromGeometry(source), materialTag);
  const outcome = applyMeshEdits(base, edits, {
    maxVertices, maxFaces: maxVertices,
    resolveCutter: resolveCutter && (cutter => meshFromGeometry(resolveCutter(cutter))),
  });
  validateTopology(editMesh(outcome.mesh));
  const sampler = createSurfaceSampler(source);
  const withUvs = source.uvs ? rebuildMissingUvs(outcome.mesh, source, sampler) : { mesh: outcome.mesh, rebuilt: 0 };
  const { geometry } = extractRender(withUvs.mesh, { sharpAngle: smoothAngle * Math.PI / 180 });
  if (geometry.positions.length / 3 > maxVertices) {
    throw new RangeError(`The edited part needs ${geometry.positions.length / 3} render vertices, over maxVertices ${maxVertices}. Use fewer or coarser edits.`);
  }
  const reach = transferVertexAttributes(source, geometry, sampler);
  const limit = boundsDiagonal(source.positions) * IMPORTED_MESH_EDIT_LIMITS.maxTransferFraction;
  const bound = Boolean(source.skinIndices) || Boolean(source.morphTargets?.length);
  if (bound && reach > limit) {
    throw new RangeError(`This edit puts geometry ${reach.toPrecision(3)} from the imported surface, over the ${limit.toPrecision(3)} limit, so skin weights and morph targets would be guesses. Keep edits within ${limit.toPrecision(3)} of the surface (smaller offsets, cut instead of extrude), or edit a part without skin or morphs.`);
  }
  return {
    geometry,
    mesh: withUvs.mesh,
    results: outcome.results,
    transfer: {
      skinWeights: Boolean(source.skinIndices), morphTargets: source.morphTargets?.length ?? 0, colors: Boolean(source.colors),
      uvs: Boolean(source.uvs), uvFacesRebuilt: withUvs.rebuilt, reach: Number(reach.toPrecision(4)), limit: bound ? Number(limit.toPrecision(4)) : null,
    },
  };
}
