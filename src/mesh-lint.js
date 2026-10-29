import { meshBounds, tagCounts } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { cornerFaces, edgeCornerTable, faceParts } from './mesh-topology.js';

const SAMPLE_LIMIT = 8;

// Every problem names the operation that usually fixes it, so an agent can act without another lookup.
const PROBLEMS = Object.freeze({
  'non-manifold-edge': { severity: 'error', fix: 'Delete the extra faces or split the edge; booleans and solidify need two faces per edge.' },
  'inconsistent-winding': { severity: 'error', fix: 'Run recalc_normals on the part so neighbouring faces wind the same way.' },
  'inverted-part': { severity: 'error', fix: 'Run flip_normals on the part; its normals point inward.' },
  'degenerate-face': { severity: 'error', fix: 'Run merge_by_distance or dissolve the zero-area faces.' },
  'loose-vertex': { severity: 'warning', fix: 'Delete loose vertices; they do not render and confuse bounds.' },
  'boundary-edge': { severity: 'warning', fix: 'Open surface. Fill the hole or add solidify if the part must be closed.' },
});

function addProblem(problems, kind, element) {
  let problem = problems.get(kind);
  if (!problem) {
    problem = { kind, ...PROBLEMS[kind], count: 0, sample: [] };
    problems.set(kind, problem);
  }
  problem.count++;
  if (problem.sample.length < SAMPLE_LIMIT) problem.sample.push(element);
}

/**
 * Signed volume of each part, from the divergence theorem over its triangulated fan.
 * Only meaningful for closed, consistently wound parts.
 */
function partVolumes(mesh, facePart, partCount) {
  const volumes = new Float64Array(partCount);
  const positions = mesh.positions;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    const anchor = mesh.cornerVertices[start] * 3;
    for (let corner = start + 1; corner + 1 < end; corner++) {
      const second = mesh.cornerVertices[corner] * 3;
      const third = mesh.cornerVertices[corner + 1] * 3;
      volumes[facePart[face]] += (
        positions[anchor] * (positions[second + 1] * positions[third + 2] - positions[second + 2] * positions[third + 1]) +
        positions[anchor + 1] * (positions[second + 2] * positions[third] - positions[second] * positions[third + 2]) +
        positions[anchor + 2] * (positions[second] * positions[third + 1] - positions[second + 1] * positions[third])
      ) / 6;
    }
  }
  return volumes;
}

// A slightly skewed ray direction avoids running exactly along axis-aligned edges and faces.
const RAY_DIRECTION = [0.8017837, 0.5345225, 0.2672612];

/** Whether the ray from origin along RAY_DIRECTION crosses triangle (a, b, c), by Moller-Trumbore. */
function rayHitsTriangle(origin, positions, a, b, c) {
  const edgeFirst = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
  const edgeSecond = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
  const [directionX, directionY, directionZ] = RAY_DIRECTION;
  const perpendicular = [
    directionY * edgeSecond[2] - directionZ * edgeSecond[1],
    directionZ * edgeSecond[0] - directionX * edgeSecond[2],
    directionX * edgeSecond[1] - directionY * edgeSecond[0],
  ];
  const determinant = edgeFirst[0] * perpendicular[0] + edgeFirst[1] * perpendicular[1] + edgeFirst[2] * perpendicular[2];
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant;
  const toOrigin = [origin[0] - positions[a], origin[1] - positions[a + 1], origin[2] - positions[a + 2]];
  const u = (toOrigin[0] * perpendicular[0] + toOrigin[1] * perpendicular[1] + toOrigin[2] * perpendicular[2]) * inverse;
  if (u < 0 || u > 1) return false;
  const cross = [
    toOrigin[1] * edgeFirst[2] - toOrigin[2] * edgeFirst[1],
    toOrigin[2] * edgeFirst[0] - toOrigin[0] * edgeFirst[2],
    toOrigin[0] * edgeFirst[1] - toOrigin[1] * edgeFirst[0],
  ];
  const v = (directionX * cross[0] + directionY * cross[1] + directionZ * cross[2]) * inverse;
  if (v < 0 || u + v > 1) return false;
  const distance = (edgeSecond[0] * cross[0] + edgeSecond[1] * cross[1] + edgeSecond[2] * cross[2]) * inverse;
  return distance > 0;
}

/** Whether a vertex of `part` lies inside the faces of the other parts (odd number of ray crossings). */
function insideOtherPart(mesh, facePart, part) {
  let face = 0;
  while (facePart[face] !== part) face++;
  const vertex = mesh.cornerVertices[mesh.faceOffsets[face]] * 3;
  const origin = [mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]];
  let crossings = 0;
  for (let other = 0; other < mesh.faceCount; other++) {
    if (facePart[other] === part) continue;
    const start = mesh.faceOffsets[other];
    const anchor = mesh.cornerVertices[start] * 3;
    for (let corner = start + 1; corner + 1 < mesh.faceOffsets[other + 1]; corner++) {
      if (rayHitsTriangle(origin, mesh.positions, anchor, mesh.cornerVertices[corner] * 3, mesh.cornerVertices[corner + 1] * 3)) crossings++;
    }
  }
  return crossings % 2 === 1;
}

/**
 * Check a mesh for problems that break later operations or rendering.
 * Returns { ok, counts, parts, tags, bounds, problems }, where each problem has kind, severity, count, a sample of
 * element indices (faces, edges or vertices by kind) and a suggested fix. ok is false when any error is present.
 */
export function lintMesh(mesh) {
  const problems = new Map();
  const table = edgeCornerTable(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const { facePart, partCount } = faceParts(mesh, table, facesOfCorners);
  const partOpen = new Uint8Array(partCount);
  const partWindingBroken = new Uint8Array(partCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const start = table.edgeOffsets[edge];
    const faceCount = table.edgeOffsets[edge + 1] - start;
    const part = facePart[facesOfCorners[table.edgeCorners[start]]];
    if (faceCount === 1) {
      addProblem(problems, 'boundary-edge', edge);
      partOpen[part] = 1;
    } else if (faceCount > 2) {
      addProblem(problems, 'non-manifold-edge', edge);
      partOpen[part] = 1;
    } else if (mesh.cornerVertices[table.edgeCorners[start]] === mesh.cornerVertices[table.edgeCorners[start + 1]]) {
      addProblem(problems, 'inconsistent-winding', edge);
      partWindingBroken[part] = 1;
    }
  }
  const bounds = meshBounds(mesh);
  const diagonal = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]));
  const minimumArea = (diagonal * 1e-7) ** 2;
  const { areas } = faceNormals(mesh);
  for (let face = 0; face < mesh.faceCount; face++) {
    if (areas[face] <= minimumArea) addProblem(problems, 'degenerate-face', face);
  }
  const used = new Uint8Array(mesh.vertexCount);
  for (const vertex of mesh.cornerVertices) used[vertex] = 1;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!used[vertex]) addProblem(problems, 'loose-vertex', vertex);
  }
  const volumes = partVolumes(mesh, facePart, partCount);
  let closedParts = 0;
  let cavities = 0;
  for (let part = 0; part < partCount; part++) {
    if (partOpen[part] || partWindingBroken[part]) continue;
    closedParts++;
    if (volumes[part] >= 0) continue;
    // A negative shell inside another part is a cavity (a hollow), which is valid; elsewhere it is inside out.
    if (insideOtherPart(mesh, facePart, part)) cavities++;
    else addProblem(problems, 'inverted-part', part);
  }
  const problemList = [...problems.values()];
  return {
    ok: !problemList.some(problem => problem.severity === 'error'),
    counts: { vertices: mesh.vertexCount, edges: mesh.edgeCount, faces: mesh.faceCount, corners: mesh.cornerCount },
    parts: { count: partCount, closed: closedParts, cavities },
    tags: tagCounts(mesh),
    bounds,
    problems: problemList,
  };
}
