import { meshFromGeometry } from './mesh-convert.js';
import { lintMesh } from './mesh-lint.js';

// Compact, agent-facing mesh reports for scene geometry. Reports are cached per immutable geometry object, so
// repeated inspection of an unchanged scene costs nothing.

const reports = new WeakMap();

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
  const mesh = meshFromGeometry(geometry);
  const lint = lintMesh(mesh);
  report = Object.freeze({
    ok: lint.ok,
    counts: { ...lint.counts, triangles: geometry.indices.length / 3, renderVertices: geometry.positions.length / 3 },
    faces: faceSizeHistogram(mesh),
    parts: lint.parts,
    tags: lint.tags,
    bounds: roundedBounds(lint.bounds),
    problems: lint.problems,
  });
  reports.set(geometry, report);
  return report;
}
