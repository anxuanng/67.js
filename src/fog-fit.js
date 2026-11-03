import { geometryBoundingSphere } from './render-culling.js';

export const DEFAULT_FOG_DENSITY = 0.006;

// Optical depth across the whole scene. 1.2 is what the old fixed density gave a 200 m scene, so smaller scenes keep
// their look and larger ones get a thinner fog that leaves 30 percent of the contrast at the far side.
const SCENE_OPTICAL_DEPTH = 1.2;

function largestAxisScale(matrix) {
  let largest = 0;
  for (let column = 0; column < 3; column++) {
    largest = Math.max(largest, Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
  }
  return largest;
}

/** Diagonal of the box around every part's bounding sphere, in world units. Zero when no part has geometry. */
export function sceneDiagonal(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    if (!part.geometry?.positions?.length || !part.matrix) continue;
    const sphere = geometryBoundingSphere(part.geometry);
    const matrix = part.matrix;
    const radius = sphere.radius * largestAxisScale(matrix);
    for (let axis = 0; axis < 3; axis++) {
      const center = matrix[axis] * sphere.center[0] + matrix[4 + axis] * sphere.center[1] + matrix[8 + axis] * sphere.center[2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], center - radius);
      maximum[axis] = Math.max(maximum[axis], center + radius);
    }
  }
  if (!Number.isFinite(minimum[0])) return 0;
  return Math.hypot(maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]);
}

/** The fog density a scene gets when it sets none: the old default, thinned for scenes wider than about 200 m. */
export function fittedFogDensity(parts) {
  const diagonal = sceneDiagonal(parts);
  if (!(diagonal > 0)) return DEFAULT_FOG_DENSITY;
  return Math.min(DEFAULT_FOG_DENSITY, SCENE_OPTICAL_DEPTH / diagonal);
}
