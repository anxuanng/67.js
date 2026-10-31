// Bounding volume hierarchy over triangles, stored in typed arrays. Nodes sit in depth-first order:
// the left child of node n is n + 1 and rightChild[n] holds the right child, or -1 for a leaf.
const BIN_COUNT = 16;

function triangleBoundsAndCentroids(positions, indices) {
  const triangleCount = indices.length / 3;
  const bounds = new Float64Array(triangleCount * 6);
  const centroids = new Float64Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    for (let axis = 0; axis < 3; axis++) {
      const first = positions[indices[triangle * 3] * 3 + axis];
      const second = positions[indices[triangle * 3 + 1] * 3 + axis];
      const third = positions[indices[triangle * 3 + 2] * 3 + axis];
      const low = Math.min(first, second, third);
      const high = Math.max(first, second, third);
      bounds[triangle * 6 + axis] = low;
      bounds[triangle * 6 + 3 + axis] = high;
      centroids[triangle * 3 + axis] = (low + high) / 2;
    }
  }
  return { bounds, centroids };
}

function unionBounds(triangleBounds, order, start, end, out, outOffset) {
  for (let axis = 0; axis < 3; axis++) {
    out[outOffset + axis] = Infinity;
    out[outOffset + 3 + axis] = -Infinity;
  }
  for (let slot = start; slot < end; slot++) {
    const offset = order[slot] * 6;
    for (let axis = 0; axis < 3; axis++) {
      out[outOffset + axis] = Math.min(out[outOffset + axis], triangleBounds[offset + axis]);
      out[outOffset + 3 + axis] = Math.max(out[outOffset + 3 + axis], triangleBounds[offset + 3 + axis]);
    }
  }
}

function surfaceArea(bounds, offset) {
  const width = bounds[offset + 3] - bounds[offset];
  const height = bounds[offset + 4] - bounds[offset + 1];
  const depth = bounds[offset + 5] - bounds[offset + 2];
  return width < 0 ? 0 : 2 * (width * height + height * depth + depth * width);
}

function centroidAxis(centroids, order, start, end) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let slot = start; slot < end; slot++) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], centroids[order[slot] * 3 + axis]);
      high[axis] = Math.max(high[axis], centroids[order[slot] * 3 + axis]);
    }
  }
  const extents = high.map((value, axis) => value - low[axis]);
  const axis = extents.indexOf(Math.max(...extents));
  return { axis, low: low[axis], extent: extents[axis] };
}

// Cheapest surface area heuristic split over equal-width centroid bins, as the bin index of the last left bin.
function bestBinSplit(triangleBounds, centroids, order, start, end, split) {
  const counts = new Uint32Array(BIN_COUNT);
  const binBounds = new Float64Array(BIN_COUNT * 6);
  for (let bin = 0; bin < BIN_COUNT; bin++) unionBounds(triangleBounds, order, 0, 0, binBounds, bin * 6);
  const scale = BIN_COUNT / split.extent;
  for (let slot = start; slot < end; slot++) {
    const triangle = order[slot];
    const bin = Math.min(BIN_COUNT - 1, Math.floor((centroids[triangle * 3 + split.axis] - split.low) * scale));
    counts[bin]++;
    for (let axis = 0; axis < 3; axis++) {
      binBounds[bin * 6 + axis] = Math.min(binBounds[bin * 6 + axis], triangleBounds[triangle * 6 + axis]);
      binBounds[bin * 6 + 3 + axis] = Math.max(binBounds[bin * 6 + 3 + axis], triangleBounds[triangle * 6 + 3 + axis]);
    }
  }
  const leftCost = sweepCosts(counts, binBounds, 0, 1);
  const rightCost = sweepCosts(counts, binBounds, BIN_COUNT - 1, -1);
  let bestBin = -1;
  let bestCost = Infinity;
  let leftCount = 0;
  for (let bin = 0; bin < BIN_COUNT - 1; bin++) {
    leftCount += counts[bin];
    if (leftCount === 0 || leftCount === end - start) continue;
    const cost = leftCost[bin] + rightCost[bin + 1];
    if (cost < bestCost) {
      bestCost = cost;
      bestBin = bin;
    }
  }
  return bestBin;
}

function sweepCosts(counts, binBounds, firstBin, step) {
  const costs = new Float64Array(BIN_COUNT);
  const running = new Float64Array(6);
  unionBounds(binBounds, [], 0, 0, running, 0);
  let count = 0;
  for (let bin = firstBin; bin >= 0 && bin < BIN_COUNT; bin += step) {
    count += counts[bin];
    for (let axis = 0; axis < 3; axis++) {
      running[axis] = Math.min(running[axis], binBounds[bin * 6 + axis]);
      running[3 + axis] = Math.max(running[3 + axis], binBounds[bin * 6 + 3 + axis]);
    }
    costs[bin] = count * surfaceArea(running, 0);
  }
  return costs;
}

function partition(order, centroids, start, end, axis, isLeft) {
  let left = start;
  let right = end - 1;
  while (left <= right) {
    if (isLeft(centroids[order[left] * 3 + axis])) {
      left++;
    } else {
      const swapped = order[left];
      order[left] = order[right];
      order[right] = swapped;
      right--;
    }
  }
  return left;
}

function splitRange(triangleBounds, centroids, order, start, end) {
  const split = centroidAxis(centroids, order, start, end);
  if (!(split.extent > 0)) return -1;
  const bestBin = bestBinSplit(triangleBounds, centroids, order, start, end, split);
  const boundary = split.low + split.extent * (bestBin + 1) / BIN_COUNT;
  let middle = bestBin < 0 ? start : partition(order, centroids, start, end, split.axis, value => value < boundary);
  if (middle === start || middle === end) {
    const midpoint = split.low + split.extent / 2;
    middle = partition(order, centroids, start, end, split.axis, value => value < midpoint);
  }
  return middle === start || middle === end ? -1 : middle;
}

/**
 * Builds a hierarchy over the triangles of an indexed mesh. The mesh arrays are kept by reference.
 * `triangleOrder` maps leaf slots back to triangle ids.
 */
export function buildTriangleBvh(positions, indices, { leafSize = 8, maxDepth = 64 } = {}) {
  const triangleCount = indices.length / 3;
  const { bounds: triangleBounds, centroids } = triangleBoundsAndCentroids(positions, indices);
  const triangleOrder = Uint32Array.from({ length: triangleCount }, (value, slot) => slot);
  const capacity = Math.max(1, triangleCount * 2);
  const nodeBounds = new Float64Array(capacity * 6);
  const rightChild = new Int32Array(capacity).fill(-1);
  const rangeStart = new Uint32Array(capacity);
  const rangeCount = new Uint32Array(capacity);
  let nodeCount = 0;
  const pending = [{ start: 0, end: triangleCount, depth: 0, parent: -1 }];
  while (pending.length) {
    const { start, end, depth, parent } = pending.pop();
    const node = nodeCount++;
    if (parent >= 0) rightChild[parent] = node;
    unionBounds(triangleBounds, triangleOrder, start, end, nodeBounds, node * 6);
    rangeStart[node] = start;
    rangeCount[node] = end - start;
    const middle = end - start <= leafSize || depth >= maxDepth ? -1 : splitRange(triangleBounds, centroids, triangleOrder, start, end);
    if (middle < 0) continue;
    pending.push({ start: middle, end, depth: depth + 1, parent: node });
    pending.push({ start, end: middle, depth: depth + 1, parent: -1 });
  }
  return { positions, indices, triangleOrder, nodeBounds, rightChild, rangeStart, rangeCount, nodeCount };
}

/**
 * Visits triangles nearest first. `scoreBounds(nodeBounds, offset)` rates a node box (Infinity skips it),
 * `shouldVisit(score)` is asked again when a node is popped so a shrinking limit prunes it, and
 * `visitTriangle(triangleId)` returns true to stop the traversal.
 */
export function traverseTriangleBvh(bvh, scoreBounds, shouldVisit, visitTriangle) {
  const stack = [0];
  // The root is always entered, so a query that misses the whole mesh still reports the triangles it tested.
  const scores = [0];
  while (stack.length) {
    const node = stack.pop();
    if (!shouldVisit(scores.pop())) continue;
    const right = bvh.rightChild[node];
    if (right < 0) {
      const end = bvh.rangeStart[node] + bvh.rangeCount[node];
      for (let slot = bvh.rangeStart[node]; slot < end; slot++) {
        if (visitTriangle(bvh.triangleOrder[slot])) return true;
      }
      continue;
    }
    const left = node + 1;
    const leftScore = scoreBounds(bvh.nodeBounds, left * 6);
    const rightScore = scoreBounds(bvh.nodeBounds, right * 6);
    const nearFirst = leftScore <= rightScore;
    stack.push(nearFirst ? right : left);
    scores.push(nearFirst ? rightScore : leftScore);
    stack.push(nearFirst ? left : right);
    scores.push(nearFirst ? leftScore : rightScore);
  }
  return false;
}

/** Distance from a point to a node box; zero inside. */
export function pointBoxDistance(point, bounds, offset) {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(bounds[offset + axis] - point[axis], 0, point[axis] - bounds[offset + 3 + axis]);
    squared += gap * gap;
  }
  return Math.sqrt(squared);
}

/** Distance along a ray to a node box (zero when the origin is inside), or Infinity for a miss. */
export function rayBoxDistance(origin, direction, bounds, offset) {
  let entry = 0;
  let exit = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const low = bounds[offset + axis] - origin[axis];
    const high = bounds[offset + 3 + axis] - origin[axis];
    if (direction[axis] === 0) {
      if (low > 0 || high < 0) return Infinity;
      continue;
    }
    const first = low / direction[axis];
    const second = high / direction[axis];
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  return entry <= exit * (1 + 1e-12) + 1e-12 ? entry : Infinity;
}

function transformedTriangleBounds(first, second, secondPositions, out) {
  const { nodeCount, rightChild, rangeStart, rangeCount, triangleOrder, indices } = second;
  for (let node = nodeCount - 1; node >= 0; node--) {
    const offset = node * 6;
    if (rightChild[node] >= 0) {
      const children = [node + 1, rightChild[node]];
      for (let axis = 0; axis < 3; axis++) {
        out[offset + axis] = Math.min(out[children[0] * 6 + axis], out[children[1] * 6 + axis]);
        out[offset + 3 + axis] = Math.max(out[children[0] * 6 + 3 + axis], out[children[1] * 6 + 3 + axis]);
      }
      continue;
    }
    for (let axis = 0; axis < 3; axis++) {
      out[offset + axis] = Infinity;
      out[offset + 3 + axis] = -Infinity;
    }
    for (let slot = rangeStart[node]; slot < rangeStart[node] + rangeCount[node]; slot++) {
      for (let corner = 0; corner < 3; corner++) {
        const vertex = indices[triangleOrder[slot] * 3 + corner] * 3;
        for (let axis = 0; axis < 3; axis++) {
          out[offset + axis] = Math.min(out[offset + axis], secondPositions[vertex + axis]);
          out[offset + 3 + axis] = Math.max(out[offset + 3 + axis], secondPositions[vertex + axis]);
        }
      }
    }
  }
  return out;
}

function boxesOverlap(firstBounds, firstOffset, secondBounds, secondOffset) {
  for (let axis = 0; axis < 3; axis++) {
    if (firstBounds[firstOffset + axis] > secondBounds[secondOffset + 3 + axis]) return false;
    if (secondBounds[secondOffset + axis] > firstBounds[firstOffset + 3 + axis]) return false;
  }
  return true;
}

function boxSize(bounds, offset) {
  return Math.max(bounds[offset + 3] - bounds[offset], bounds[offset + 4] - bounds[offset + 1], bounds[offset + 5] - bounds[offset + 2]);
}

/**
 * Calls `visitPair(firstTriangleId, secondTriangleId)` for every triangle pair whose leaf boxes overlap.
 * `secondPositions` holds the second mesh vertices already moved into the first mesh space.
 * The visitor returns true to stop; the result is whether it did.
 */
export function traverseBvhPairs(first, second, secondPositions, visitPair) {
  const secondBounds = transformedTriangleBounds(first, second, secondPositions, new Float64Array(second.nodeCount * 6));
  const stack = [[0, 0]];
  while (stack.length) {
    const [firstNode, secondNode] = stack.pop();
    if (!boxesOverlap(first.nodeBounds, firstNode * 6, secondBounds, secondNode * 6)) continue;
    const firstIsLeaf = first.rightChild[firstNode] < 0;
    const secondIsLeaf = second.rightChild[secondNode] < 0;
    if (firstIsLeaf && secondIsLeaf) {
      if (visitLeafPair(first, second, firstNode, secondNode, visitPair)) return true;
    } else if (secondIsLeaf || (!firstIsLeaf && boxSize(first.nodeBounds, firstNode * 6) >= boxSize(secondBounds, secondNode * 6))) {
      stack.push([first.rightChild[firstNode], secondNode], [firstNode + 1, secondNode]);
    } else {
      stack.push([firstNode, second.rightChild[secondNode]], [firstNode, secondNode + 1]);
    }
  }
  return false;
}

function visitLeafPair(first, second, firstNode, secondNode, visitPair) {
  for (let firstSlot = first.rangeStart[firstNode]; firstSlot < first.rangeStart[firstNode] + first.rangeCount[firstNode]; firstSlot++) {
    for (let secondSlot = second.rangeStart[secondNode]; secondSlot < second.rangeStart[secondNode] + second.rangeCount[secondNode]; secondSlot++) {
      if (visitPair(first.triangleOrder[firstSlot], second.triangleOrder[secondSlot])) return true;
    }
  }
  return false;
}
