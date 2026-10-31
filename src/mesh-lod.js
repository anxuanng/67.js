import { decimateMesh } from './mesh-decimate.js';
import { createSurfaceDistance } from './mesh-surface-distance.js';
import { meshBounds } from './mesh-data.js';
import { meshFromGeometry } from './mesh-convert.js';
import { extractRender } from './mesh-render.js';

// Levels of detail for runtime selection (issue 37). Level 0 is the input; each next level keeps the given ratio of
// the input's triangles. Every level reports the farthest its vertices lie from the input surface, in the input's
// units, so a renderer can choose the level whose error stays under a pixel at the distance it is drawn.

export const DEFAULT_LOD_RATIOS = Object.freeze([0.5, 0.25, 0.1]);
export const MAX_LOD_LEVELS = 8;

function checkRatios(ratios) {
  if (!Array.isArray(ratios) || ratios.length < 1 || ratios.length > MAX_LOD_LEVELS) {
    throw new RangeError(`ratios needs 1 to ${MAX_LOD_LEVELS} numbers.`);
  }
  ratios.forEach((ratio, index) => {
    if (typeof ratio !== 'number' || !(ratio > 0) || !(ratio < 1) || (index > 0 && ratio >= ratios[index - 1])) {
      throw new RangeError('ratios must be strictly decreasing numbers above 0 and below 1.');
    }
  });
}

function farthestFromSurface(mesh, surface) {
  const point = [0, 0, 0];
  const visited = new Uint8Array(mesh.vertexCount);
  let farthest = 0;
  for (const vertex of mesh.cornerVertices) {
    if (visited[vertex]) continue;
    visited[vertex] = 1;
    for (let axis = 0; axis < 3; axis++) point[axis] = mesh.positions[vertex * 3 + axis];
    farthest = Math.max(farthest, surface.query(point).distance);
  }
  return farthest;
}

/**
 * Decimate a polygon mesh into levels. Returns [{ level, ratio, mesh, triangles, error, relativeError }], where
 * relativeError is the error over the diagonal of the input's bounds.
 */
export function generateMeshLods(mesh, { ratios = DEFAULT_LOD_RATIOS } = {}) {
  checkRatios(ratios);
  const surface = createSurfaceDistance(mesh);
  const bounds = meshBounds(mesh);
  const diagonal = Math.hypot(...bounds.max.map((value, axis) => value - bounds.min[axis]));
  const levels = [{ level: 0, ratio: 1, mesh, triangles: surface.triangleCount, error: 0, relativeError: 0 }];
  let previousRatio = 1;
  let previous = mesh;
  ratios.forEach((ratio, index) => {
    // Each level continues from the one before, so the work shrinks with the mesh.
    const reduced = decimateMesh(previous, { ratio: ratio / previousRatio });
    const error = farthestFromSurface(reduced.mesh, surface);
    levels.push({ level: index + 1, ratio, mesh: reduced.mesh, triangles: reduced.triangles.after, error, relativeError: error / diagonal });
    previous = reduced.mesh;
    previousRatio = ratio;
  });
  return levels;
}

/**
 * Levels for renderer geometry, such as a recipe part from generateMeshGeometry or an imported asset's part. Each
 * level carries a geometry made by extractRender, with edges sharper than `smoothAngle` degrees kept hard.
 */
export function generateGeometryLods(geometry, { ratios = DEFAULT_LOD_RATIOS, smoothAngle = 30 } = {}) {
  const mesh = meshFromGeometry(geometry, { quads: false, tags: 'none' });
  return generateMeshLods(mesh, { ratios }).map(({ mesh: levelMesh, ...rest }) => ({
    ...rest,
    geometry: rest.level === 0 ? geometry : extractRender(levelMesh, { sharpAngle: smoothAngle * Math.PI / 180 }).geometry,
  }));
}

/**
 * Levels for an imported asset: each is the asset with every part's geometry replaced by that level's geometry,
 * so it can be handed to the scene as it is. Parts that share a geometry share its levels. Skinned and morphed
 * parts are refused, because decimation would break their per-vertex weights.
 */
export function generateAssetLods(asset, options = {}) {
  const parts = asset?.parts;
  if (!Array.isArray(parts) || !parts.length) throw new TypeError('An asset needs a parts array.');
  for (const part of parts) {
    if (part.skin || part.morph) throw new RangeError(`Part ${part.name ?? part.id ?? '?'} is skinned or morphed; LODs support static parts only.`);
  }
  const byGeometry = new Map();
  for (const part of parts) {
    if (!byGeometry.has(part.geometry)) byGeometry.set(part.geometry, generateGeometryLods(part.geometry, options));
  }
  const levelCount = byGeometry.get(parts[0].geometry).length;
  return Array.from({ length: levelCount }, (value, level) => {
    const levelParts = parts.map(part => ({ ...part, geometry: byGeometry.get(part.geometry)[level].geometry }));
    const reports = [...byGeometry.values()].map(levels => levels[level]);
    return {
      level,
      ratio: reports[0].ratio,
      triangles: reports.reduce((total, report) => total + report.triangles, 0),
      error: Math.max(...reports.map(report => report.error)),
      asset: { ...asset, parts: levelParts },
    };
  });
}
