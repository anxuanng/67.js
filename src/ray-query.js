// Ray queries against a triangle world ({ positions, indices, bvh }). The traversal is written out here instead of going
// through the generic visitor in triangle-bvh.js: a path trace asks for hundreds of millions of rays, and a callback
// per box or triangle, plus boxed numbers on a plain-array stack, dominated the time (issue #129).

const STACK_SIZE = 160;
const MINIMUM_DIRECTION = 1e-30;
const BOX_TOLERANCE = 1e-12;
const TRIANGLE_STRIDE = 9;

/** Each triangle as corner and two edges, in leaf order, so a leaf reads one run of memory and no index lookups. */
function packLeafTriangles(positions, indices, triangleOrder) {
  const packed = new Float64Array(triangleOrder.length * TRIANGLE_STRIDE);
  for (let slot = 0; slot < triangleOrder.length; slot++) {
    const first = indices[triangleOrder[slot] * 3] * 3;
    const second = indices[triangleOrder[slot] * 3 + 1] * 3;
    const third = indices[triangleOrder[slot] * 3 + 2] * 3;
    const target = slot * TRIANGLE_STRIDE;
    for (let axis = 0; axis < 3; axis++) {
      packed[target + axis] = positions[first + axis];
      packed[target + 3 + axis] = positions[second + axis] - positions[first + axis];
      packed[target + 6 + axis] = positions[third + axis] - positions[first + axis];
    }
  }
  return packed;
}

/** Distance along the ray to a node box (zero when the origin is inside), or Infinity for a miss. */
function boxEntryDistance(bounds, offset, originX, originY, originZ, inverseX, inverseY, inverseZ) {
  const firstX = (bounds[offset] - originX) * inverseX;
  const secondX = (bounds[offset + 3] - originX) * inverseX;
  const firstY = (bounds[offset + 1] - originY) * inverseY;
  const secondY = (bounds[offset + 4] - originY) * inverseY;
  const firstZ = (bounds[offset + 2] - originZ) * inverseZ;
  const secondZ = (bounds[offset + 5] - originZ) * inverseZ;
  const entry = Math.max(0, Math.min(firstX, secondX), Math.min(firstY, secondY), Math.min(firstZ, secondZ));
  const exit = Math.min(Math.max(firstX, secondX), Math.max(firstY, secondY), Math.max(firstZ, secondZ));
  return entry <= exit * (1 + BOX_TOLERANCE) + BOX_TOLERANCE ? entry : Infinity;
}

function safeInverse(component) {
  if (component > MINIMUM_DIRECTION || component < -MINIMUM_DIRECTION) return 1 / component;
  return component < 0 ? -1 / MINIMUM_DIRECTION : 1 / MINIMUM_DIRECTION;
}

/**
 * Ray queries with preallocated state. `trace` returns a shared state object, so read it before the next query.
 * Visits nodes nearest first and skips any whose box starts past the nearest hit found so far.
 */
export function createTracer(world) {
  const { nodeBounds, rightChild, rangeStart, rangeCount } = world.bvh;
  const leafTriangles = packLeafTriangles(world.positions, world.indices, world.bvh.triangleOrder);
  const triangleOrder = world.bvh.triangleOrder;
  const nodeStack = new Int32Array(STACK_SIZE);
  const entryStack = new Float64Array(STACK_SIZE);
  const state = { nearestDistance: Infinity, nearestTriangle: -1, stopAtAnyHit: false };

  /** Nearest hit among the triangles of one leaf, written into `state`. Returns true to stop at any hit. */
  function visitLeaf(node, originX, originY, originZ, directionX, directionY, directionZ) {
    const end = rangeStart[node] + rangeCount[node];
    for (let slot = rangeStart[node]; slot < end; slot++) {
      const base = slot * TRIANGLE_STRIDE;
      const edgeSecondX = leafTriangles[base + 6];
      const edgeSecondY = leafTriangles[base + 7];
      const edgeSecondZ = leafTriangles[base + 8];
      const pivotX = directionY * edgeSecondZ - directionZ * edgeSecondY;
      const pivotY = directionZ * edgeSecondX - directionX * edgeSecondZ;
      const pivotZ = directionX * edgeSecondY - directionY * edgeSecondX;
      const edgeFirstX = leafTriangles[base + 3];
      const edgeFirstY = leafTriangles[base + 4];
      const edgeFirstZ = leafTriangles[base + 5];
      const determinant = edgeFirstX * pivotX + edgeFirstY * pivotY + edgeFirstZ * pivotZ;
      if (determinant === 0) continue;
      const offsetX = originX - leafTriangles[base];
      const offsetY = originY - leafTriangles[base + 1];
      const offsetZ = originZ - leafTriangles[base + 2];
      const firstWeight = (offsetX * pivotX + offsetY * pivotY + offsetZ * pivotZ) / determinant;
      if (firstWeight < 0 || firstWeight > 1) continue;
      const queryX = offsetY * edgeFirstZ - offsetZ * edgeFirstY;
      const queryY = offsetZ * edgeFirstX - offsetX * edgeFirstZ;
      const queryZ = offsetX * edgeFirstY - offsetY * edgeFirstX;
      const secondWeight = (directionX * queryX + directionY * queryY + directionZ * queryZ) / determinant;
      if (secondWeight < 0 || firstWeight + secondWeight > 1) continue;
      const distance = (edgeSecondX * queryX + edgeSecondY * queryY + edgeSecondZ * queryZ) / determinant;
      if (distance < 0 || distance >= state.nearestDistance) continue;
      state.nearestDistance = distance;
      state.nearestTriangle = triangleOrder[slot];
      if (state.stopAtAnyHit) return true;
    }
    return false;
  }

  function trace(originX, originY, originZ, directionX, directionY, directionZ, limit, stopAtAnyHit) {
    state.nearestDistance = limit;
    state.nearestTriangle = -1;
    state.stopAtAnyHit = stopAtAnyHit;
    const inverseX = safeInverse(directionX);
    const inverseY = safeInverse(directionY);
    const inverseZ = safeInverse(directionZ);
    let stackSize = 1;
    nodeStack[0] = 0;
    // The root is always entered, so a query that misses the whole mesh still reports the triangles it tested.
    entryStack[0] = 0;
    while (stackSize > 0) {
      stackSize--;
      const node = nodeStack[stackSize];
      if (!(entryStack[stackSize] < state.nearestDistance)) continue;
      const right = rightChild[node];
      if (right < 0) {
        if (visitLeaf(node, originX, originY, originZ, directionX, directionY, directionZ)) return state;
        continue;
      }
      const left = node + 1;
      const leftEntry = boxEntryDistance(nodeBounds, left * 6, originX, originY, originZ, inverseX, inverseY, inverseZ);
      const rightEntry = boxEntryDistance(nodeBounds, right * 6, originX, originY, originZ, inverseX, inverseY, inverseZ);
      const nearFirst = leftEntry <= rightEntry;
      nodeStack[stackSize] = nearFirst ? right : left;
      entryStack[stackSize] = nearFirst ? rightEntry : leftEntry;
      nodeStack[stackSize + 1] = nearFirst ? left : right;
      entryStack[stackSize + 1] = nearFirst ? leftEntry : rightEntry;
      stackSize += 2;
    }
    return state;
  }
  return { trace };
}

/** Inverse-square falloff of a point or spot light, with the optional smooth range cutoff and a floor at its radius. */
export function pointLightFalloff(distanceSquared, light) {
  let cutoff = 1;
  if (light.range > 0) {
    const ratio = distanceSquared / (light.range * light.range);
    const fade = Math.max(1 - ratio * ratio, 0);
    cutoff = fade * fade;
  }
  return cutoff / Math.max(distanceSquared, light.radius * light.radius);
}
