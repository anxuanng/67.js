// Frustum culling and level-of-detail selection for instanced batches (issue 37).
//
// Everything here is a pure function of the geometry, the instance matrices, the view-projection matrix and the
// canvas height. It keeps no state between frames, so a frame drawn after a seek to any time picks the same
// instances and the same levels as one drawn in sequence.

const PLANE_COUNT = 6;
const MINIMUM_DEPTH = 1e-6;

/** Pixel error that a level may cause before the next finer level is used. */
export const DEFAULT_LOD_PIXEL_ERROR = 1;

const boundingSpheres = new WeakMap();

/** Smallest sphere around the geometry's vertices that is centred on the middle of their bounding box. */
export function geometryBoundingSphere(geometry) {
  const cached = boundingSpheres.get(geometry);
  if (cached) return cached;
  const positions = geometry.positions;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  let radiusSquared = 0;
  for (let index = 0; index < positions.length; index += 3) {
    const dx = positions[index] - center[0];
    const dy = positions[index + 1] - center[1];
    const dz = positions[index + 2] - center[2];
    radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
  }
  const sphere = Object.freeze({ center: Object.freeze(center), radius: Math.sqrt(radiusSquared) });
  boundingSpheres.set(geometry, sphere);
  return sphere;
}

/**
 * Fills `planes` (6 x 4 numbers, normalised, normals pointing inside) from a column-major view-projection matrix,
 * so a point is inside when every plane gives a distance of zero or more.
 */
export function extractFrustumPlanes(viewProjection, planes) {
  for (let plane = 0; plane < PLANE_COUNT; plane++) {
    const axis = plane >> 1;
    const sign = plane % 2 === 0 ? 1 : -1;
    for (let component = 0; component < 4; component++) {
      planes[plane * 4 + component] = viewProjection[component * 4 + 3] + sign * viewProjection[component * 4 + axis];
    }
    const length = Math.hypot(planes[plane * 4], planes[plane * 4 + 1], planes[plane * 4 + 2]);
    for (let component = 0; component < 4; component++) planes[plane * 4 + component] /= length || 1;
  }
  return planes;
}

function largestColumnLength(matrix, offset) {
  const first = matrix[offset] ** 2 + matrix[offset + 1] ** 2 + matrix[offset + 2] ** 2;
  const second = matrix[offset + 4] ** 2 + matrix[offset + 5] ** 2 + matrix[offset + 6] ** 2;
  const third = matrix[offset + 8] ** 2 + matrix[offset + 9] ** 2 + matrix[offset + 10] ** 2;
  return Math.sqrt(Math.max(first, second, third));
}

function isOutsideFrustum(planes, x, y, z, radius) {
  for (let plane = 0; plane < PLANE_COUNT; plane++) {
    const offset = plane * 4;
    if (planes[offset] * x + planes[offset + 1] * y + planes[offset + 2] * z + planes[offset + 3] < -radius) return true;
  }
  return false;
}

/** The coarsest level whose error, at this size on screen, stays within `pixelError`. Level 0 is always allowed. */
export function chooseLevel(levelErrors, worldScale, pixelsPerUnit, pixelError) {
  let chosen = 0;
  for (let level = 1; level < levelErrors.length; level++) {
    if (levelErrors[level] * worldScale * pixelsPerUnit > pixelError) break;
    chosen = level;
  }
  return chosen;
}

/** Instance indices of one batch, split by level, reused between frames. */
export class InstanceSelection {
  constructor(instanceCount, levelCount) {
    this.indices = Array.from({ length: levelCount }, () => new Uint32Array(instanceCount));
    this.counts = new Uint32Array(levelCount);
    this.visibleCount = 0;
  }

  /** True when every instance is drawn at level 0, so the batch can use its full instance buffer as it is. */
  get isEverything() {
    return this.visibleCount === this.indices[0].length && this.counts[0] === this.visibleCount;
  }
}

/**
 * Splits a batch's instances into the ones that touch the frustum, by level. `bounds` is the geometry's bounding
 * sphere, `levelErrors` the error of each level in geometry units (level 0 is 0), and `pixelsPerUnit` the pixels
 * that one world unit covers at depth 1 (half the canvas height times projection[5]). `margin` widens every sphere by that many
 * world units, for vertices that move away from their geometry (wind sway).
 */
export function selectInstances(selection, { instanceData, instanceCount, stride, bounds, margin = 0, levelErrors, planes, viewProjection, pixelsPerUnit, pixelError = DEFAULT_LOD_PIXEL_ERROR }) {
  selection.counts.fill(0);
  selection.visibleCount = 0;
  const hasLevels = levelErrors.length > 1;
  const [centerX, centerY, centerZ] = bounds.center;
  for (let index = 0; index < instanceCount; index++) {
    const offset = index * stride;
    const x = instanceData[offset] * centerX + instanceData[offset + 4] * centerY + instanceData[offset + 8] * centerZ + instanceData[offset + 12];
    const y = instanceData[offset + 1] * centerX + instanceData[offset + 5] * centerY + instanceData[offset + 9] * centerZ + instanceData[offset + 13];
    const z = instanceData[offset + 2] * centerX + instanceData[offset + 6] * centerY + instanceData[offset + 10] * centerZ + instanceData[offset + 14];
    const worldScale = largestColumnLength(instanceData, offset);
    if (isOutsideFrustum(planes, x, y, z, bounds.radius * worldScale + margin)) continue;
    let level = 0;
    if (hasLevels) {
      const depth = viewProjection[3] * x + viewProjection[7] * y + viewProjection[11] * z + viewProjection[15];
      level = depth > MINIMUM_DEPTH ? chooseLevel(levelErrors, worldScale, pixelsPerUnit / depth, pixelError) : 0;
    }
    selection.indices[level][selection.counts[level]++] = index;
    selection.visibleCount++;
  }
  return selection;
}
