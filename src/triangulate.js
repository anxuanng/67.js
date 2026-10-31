// Ear clipping for a simple contour with disjoint holes. Points are [x, y]; triangles come back counter-clockwise.
function cross(origin, first, second) {
  return (first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
}

export function signedArea(ring) {
  let area = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  return area / 2;
}

function samePosition(first, second) {
  return first[0] === second[0] && first[1] === second[1];
}

function segmentsTouch(startA, endA, startB, endB) {
  const sideStartB = cross(startA, endA, startB);
  const sideEndB = cross(startA, endA, endB);
  const sideStartA = cross(startB, endB, startA);
  const sideEndA = cross(startB, endB, endA);
  if (Math.sign(sideStartB) * Math.sign(sideEndB) < 0 && Math.sign(sideStartA) * Math.sign(sideEndA) < 0) return true;
  const within = (from, to, point) => point[0] >= Math.min(from[0], to[0]) && point[0] <= Math.max(from[0], to[0]) &&
    point[1] >= Math.min(from[1], to[1]) && point[1] <= Math.max(from[1], to[1]);
  return sideStartB === 0 && within(startA, endA, startB) || sideEndB === 0 && within(startA, endA, endB) ||
    sideStartA === 0 && within(startB, endB, startA) || sideEndA === 0 && within(startB, endB, endA);
}

// True when the direction toward target leaves the vertex into the region on the left of the ring.
function pointsIntoRegion(previous, vertex, next, target) {
  if (cross(previous, vertex, next) > 0) return cross(vertex, next, target) > 0 && cross(vertex, target, previous) > 0;
  return !(cross(vertex, previous, target) > 0 && cross(vertex, target, next) > 0);
}

function crossesBoundary(points, rings, from, to, ignoredA, ignoredB) {
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      if (start === ignoredA || end === ignoredA || start === ignoredB || end === ignoredB) continue;
      if (segmentsTouch(points[from], points[to], points[start], points[end])) return true;
    }
  }
  return false;
}

function bridgeHole(points, rings, merged, hole) {
  let holeStart = 0;
  for (let index = 1; index < hole.length; index++) {
    if (points[hole[index]][0] > points[hole[holeStart]][0]) holeStart = index;
  }
  const holeVertex = hole[holeStart];
  const holePrevious = hole[(holeStart + hole.length - 1) % hole.length];
  const holeNext = hole[(holeStart + 1) % hole.length];
  const candidates = [...new Set(merged)]
    .map(vertex => ({ vertex, distance: Math.hypot(points[vertex][0] - points[holeVertex][0], points[vertex][1] - points[holeVertex][1]) }))
    .sort((left, right) => left.distance - right.distance);
  for (const { vertex } of candidates) {
    if (!pointsIntoRegion(points[holePrevious], points[holeVertex], points[holeNext], points[vertex])) continue;
    if (crossesBoundary(points, rings, holeVertex, vertex, holeVertex, vertex)) continue;
    for (let position = 0; position < merged.length; position++) {
      if (merged[position] !== vertex) continue;
      const previous = points[merged[(position + merged.length - 1) % merged.length]];
      const next = points[merged[(position + 1) % merged.length]];
      if (!pointsIntoRegion(previous, points[vertex], next, points[holeVertex])) continue;
      const rotated = hole.map((_, offset) => hole[(holeStart + offset) % hole.length]);
      merged.splice(position + 1, 0, ...rotated, holeVertex, vertex);
      return;
    }
  }
  throw new RangeError('Triangulation could not connect a hole to the contour. Adjust the holes.');
}

function mergeHoles(points, outer, holes) {
  const rings = [outer, ...holes];
  const merged = [...outer];
  const pending = holes.map(hole => hole.slice()).sort((left, right) => {
    const rightmost = ring => Math.max(...ring.map(vertex => points[vertex][0]));
    return rightmost(right) - rightmost(left);
  });
  for (const hole of pending) bridgeHole(points, rings, merged, hole);
  return merged;
}

function clipEars(points, ring) {
  const count = ring.length;
  const previousOf = Array.from({ length: count }, (_, index) => (index + count - 1) % count);
  const nextOf = Array.from({ length: count }, (_, index) => (index + 1) % count);
  const triangles = [];
  const at = slot => points[ring[slot]];
  const isCoincident = (slot, tip) => [previousOf[tip], tip, nextOf[tip]].some(corner => samePosition(at(slot), at(corner)));
  const containsOtherVertex = tip => {
    const first = at(previousOf[tip]);
    const second = at(tip);
    const third = at(nextOf[tip]);
    for (let slot = nextOf[nextOf[tip]]; slot !== previousOf[tip]; slot = nextOf[slot]) {
      if (isCoincident(slot, tip)) continue;
      if (cross(at(previousOf[slot]), at(slot), at(nextOf[slot])) > 0) continue;
      const vertex = at(slot);
      if (cross(first, second, vertex) >= 0 && cross(second, third, vertex) >= 0 && cross(third, first, vertex) >= 0) return true;
    }
    return false;
  };
  const remove = tip => {
    nextOf[previousOf[tip]] = nextOf[tip];
    previousOf[nextOf[tip]] = previousOf[tip];
    return previousOf[tip];
  };
  const emit = tip => triangles.push([ring[previousOf[tip]], ring[tip], ring[nextOf[tip]]]);
  let remaining = count;
  let cursor = 0;
  let missed = 0;
  while (remaining > 3) {
    const area = cross(at(previousOf[cursor]), at(cursor), at(nextOf[cursor]));
    const forced = missed > remaining;
    if (area === 0) {
      cursor = remove(cursor);
      remaining--;
      missed = 0;
    } else if (area > 0 && (forced || !containsOtherVertex(cursor))) {
      emit(cursor);
      cursor = remove(cursor);
      remaining--;
      missed = 0;
    } else {
      cursor = nextOf[cursor];
      missed++;
      if (missed > remaining * 2) throw new RangeError('Triangulation failed. The contour or holes may touch or cross.');
    }
  }
  if (cross(at(previousOf[cursor]), at(cursor), at(nextOf[cursor])) > 0) emit(cursor);
  return triangles;
}

/** Vertex numbers follow the contour, then each hole in order. Returns counter-clockwise [a, b, c] triples. */
export function triangulate(contour, holes) {
  const points = [...contour, ...holes.flat()];
  const outerRing = contour.map((_, index) => index);
  if (signedArea(contour) < 0) outerRing.reverse();
  let offset = contour.length;
  const holeRings = holes.map(hole => {
    const ring = hole.map((_, index) => offset + index);
    offset += hole.length;
    if (signedArea(hole) > 0) ring.reverse();
    return ring;
  });
  return clipEars(points, mergeHoles(points, outerRing, holeRings));
}
