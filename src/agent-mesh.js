import { meshFromGeometry } from './mesh-convert.js';
import { lintMesh } from './mesh-lint.js';
import { applyMeshEdits } from './mesh-recipe.js';
import { extractRender } from './mesh-render.js';

// Compact, agent-facing mesh reports for scene geometry. Reports are cached per immutable geometry object, so
// repeated inspection of an unchanged scene costs nothing.

export const MESH_SMOOTH_ANGLE_DEFAULT = 30;
const reports = new WeakMap();
// Render geometry generated from a mesh recipe keeps its polygon mesh and edit results here.
const polygonMeshes = new WeakMap();

/**
 * Build render geometry for a recipe `mesh` geometry: convert the base, run the edit log, and extract triangles with
 * edges sharper than smoothAngle (degrees) kept hard, as Blender's auto smooth does.
 */
export function generateMeshGeometry(baseGeometry, edits, { maxVertices, smoothAngle = MESH_SMOOTH_ANGLE_DEFAULT }) {
  const base = meshFromGeometry(baseGeometry);
  const { mesh, results } = applyMeshEdits(base, edits, { maxVertices, maxFaces: maxVertices });
  const { geometry } = extractRender(mesh, { sharpAngle: smoothAngle * Math.PI / 180 });
  if (geometry.positions.length / 3 > maxVertices) {
    throw new RangeError(`The edited mesh needs ${geometry.positions.length / 3} render vertices, over maxVertices ${maxVertices}.`);
  }
  polygonMeshes.set(geometry, { mesh, results });
  return geometry;
}

function faceSizeHistogram(mesh) {
  const histogram = { triangles: 0, quads: 0, ngons: 0 };
  for (let face = 0; face < mesh.faceCount; face++) {
    const size = mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
    if (size === 3) histogram.triangles++;
    else if (size === 4) histogram.quads++;
    else histogram.ngons++;
  }
  return histogram;
}

function roundedBounds(bounds) {
  const round = value => Math.round(value * 1e5) / 1e5;
  return { min: bounds.min.map(round), max: bounds.max.map(round) };
}

/**
 * Polygon view and lint of renderer geometry: counts, face sizes, connected parts, face tags, bounds and problems
 * with suggested fixes. The geometry is welded and joined into quads first, as meshFromGeometry does.
 */
export function meshReport(geometry) {
  let report = reports.get(geometry);
  if (report) return report;
  const polygon = polygonMeshes.get(geometry);
  const mesh = polygon?.mesh ?? meshFromGeometry(geometry);
  const lint = lintMesh(mesh);
  report = Object.freeze({
    ok: lint.ok,
    counts: { ...lint.counts, triangles: geometry.indices.length / 3, renderVertices: geometry.positions.length / 3 },
    faces: faceSizeHistogram(mesh),
    parts: lint.parts,
    tags: lint.tags,
    bounds: roundedBounds(lint.bounds),
    problems: lint.problems,
    ...(polygon ? { edits: polygon.results } : {}),
  });
  reports.set(geometry, report);
  return report;
}
