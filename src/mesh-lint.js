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
  for (let part = 0; part < partCount; part++) {
    if (partOpen[part] || partWindingBroken[part]) continue;
    closedParts++;
    if (volumes[part] < 0) addProblem(problems, 'inverted-part', part);
  }
  const problemList = [...problems.values()];
  return {
    ok: !problemList.some(problem => problem.severity === 'error'),
    counts: { vertices: mesh.vertexCount, edges: mesh.edgeCount, faces: mesh.faceCount, corners: mesh.cornerCount },
    parts: { count: partCount, closed: closedParts },
    tags: tagCounts(mesh),
    bounds,
    problems: problemList,
  };
}
