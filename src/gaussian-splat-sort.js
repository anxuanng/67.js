// Back-to-front order of Gaussian splats for one view. Translucent splats blend correctly only when the farthest is
// drawn first, so every change of view re-sorts them. A counting sort on the view depth quantised to 65536 steps
// does that in three linear passes (bench/gaussian-splats/README.md has the time). Splats behind the camera are left
// out of the order. Splats closer than one step of depth (the span divided by 65536) may draw in either order.

const DEPTH_STEPS = 65536;
const UNCHANGED_TOLERANCE = 1e-6;

function viewDepthRange(modelView, { minimum, maximum }) {
  let nearest = Infinity;
  let farthest = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? maximum[0] : minimum[0];
    const y = corner & 2 ? maximum[1] : minimum[1];
    const z = corner & 4 ? maximum[2] : minimum[2];
    const depth = modelView[2] * x + modelView[6] * y + modelView[10] * z + modelView[14];
    nearest = Math.min(nearest, depth);
    farthest = Math.max(farthest, depth);
  }
  return { nearest, farthest };
}

/**
 * Creates a sorter for splats at `positions` (xyz triples, `count` of them) inside `bounds`. `sort(modelView)` takes the
 * column-major model-view matrix and returns `{ order, visibleCount, changed }`: `order[0 .. visibleCount)` holds splat
 * indices from the farthest to the nearest in front of the camera. `order` is reused between calls, and `changed` is
 * false when the view depth axis has not moved since the previous call, so the caller can skip its upload.
 */
export function createSplatSorter(positions, count, bounds) {
  const keys = new Int32Array(count);
  const order = new Uint32Array(count);
  const bucketStarts = new Uint32Array(DEPTH_STEPS + 1);
  const lastAxis = new Float64Array(4).fill(NaN);
  let visibleCount = 0;

  function sort(modelView) {
    const axis = [modelView[2], modelView[6], modelView[10], modelView[14]];
    const unchanged = axis.every((value, index) => Math.abs(value - lastAxis[index]) <= UNCHANGED_TOLERANCE);
    if (unchanged) return { order, visibleCount, changed: false };
    lastAxis.set(axis);
    const { nearest, farthest } = viewDepthRange(modelView, bounds);
    const frontLimit = Math.min(farthest, 0);
    const span = frontLimit - nearest;
    const scale = span > 0 ? (DEPTH_STEPS - 1) / span : 0;
    bucketStarts.fill(0);
    let kept = 0;
    for (let index = 0; index < count; index++) {
      const depth = axis[0] * positions[index * 3] + axis[1] * positions[index * 3 + 1] + axis[2] * positions[index * 3 + 2] + axis[3];
      if (depth >= 0) {
        keys[index] = -1;
        continue;
      }
      const key = Math.min(DEPTH_STEPS - 1, Math.max(0, ((depth - nearest) * scale) | 0));
      keys[index] = key;
      bucketStarts[key + 1]++;
      kept++;
    }
    for (let key = 0; key < DEPTH_STEPS; key++) bucketStarts[key + 1] += bucketStarts[key];
    for (let index = 0; index < count; index++) {
      const key = keys[index];
      if (key >= 0) order[bucketStarts[key]++] = index;
    }
    visibleCount = kept;
    return { order, visibleCount, changed: true };
  }

  return { sort, get visibleCount() { return visibleCount; } };
}
