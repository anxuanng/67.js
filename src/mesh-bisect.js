import { facePolygons, buildPolygonMesh } from './mesh-polygons.js';

// Cutting a mesh with a plane (bisect_plane, after bmesh.ops.bisect_plane) or with a polyline projected along a
// direction (the knife). Both insert one shared point on every cut edge, so no T-junctions appear, and split each
// crossed face along the cut.

const subtract = (first, second) => [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
const lerp = (first, second, fraction) => first.map((value, axis) => value + (second[axis] - value) * fraction);
const unit = vector => {
  const size = Math.hypot(...vector);
  if (size === 0) throw new RangeError('A direction cannot be zero.');
  return vector.map(value => value / size);
};

function positionOf(mesh, extraPositions, vertex) {
  if (vertex >= mesh.vertexCount) return extraPositions[vertex - mesh.vertexCount];
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

/** A polygon's outline from `first` to `last` along its vertex loop, inclusive and wrapping around. */
export function loopRange(items, first, last) {
  const range = [];
  for (let index = first; ; index = (index + 1) % items.length) {
    range.push(items[index]);
    if (index === last) return range;
  }
}

/** Split a polygon along a chain between its vertices at `first` and `last`; the chain's own points are `inner`. */
export function splitPolygon(polygon, first, last, inner, innerCorner) {
  const build = (from, to, chain, chainCorners) => ({
    ...polygon,
    vertices: [...loopRange(polygon.vertices, from, to), ...chain],
    sourceCorners: [...loopRange(polygon.sourceCorners, from, to), ...chainCorners],
    sourceEdges: [...loopRange(polygon.sourceEdges, from, to), ...chain.map(() => -1)],
  });
  return [
    build(first, last, [...inner].reverse(), inner.map(() => innerCorner)),
    build(last, first, inner, inner.map(() => innerCorner)),
  ];
}

// ----- bisect_plane -----

function planeSigns(mesh, point, normal, distance) {
  const signs = new Int8Array(mesh.vertexCount);
  const offsets = new Float64Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const offset = dot(subtract(positionOf(mesh, [], vertex), point), normal);
    offsets[vertex] = offset;
    signs[vertex] = offset > distance ? 1 : offset < -distance ? -1 : 0;
  }
  return { signs, offsets };
}

/** One point per mesh edge whose ends lie on opposite sides of the plane. */
function crossingPoints(mesh, signs, offsets, extraPositions) {
  const points = new Map();
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    if (signs[first] * signs[second] !== -1) continue;
    const fraction = offsets[first] / (offsets[first] - offsets[second]);
    extraPositions.push(lerp(positionOf(mesh, [], first), positionOf(mesh, [], second), fraction));
    points.set(edge, { vertex: mesh.vertexCount + extraPositions.length - 1, from: first, fraction });
  }
  return points;
}

/** The polygon's outline with the crossing points inserted, plus each point's side (0 on the plane). */
function withCrossings(mesh, polygon, signs, points) {
  const outline = { ...polygon, vertices: [], sourceCorners: [], sourceEdges: [] };
  const sides = [];
  const count = polygon.vertices.length;
  for (let index = 0; index < count; index++) {
    const vertex = polygon.vertices[index];
    const corner = polygon.sourceCorners[index];
    const edge = polygon.sourceEdges[index];
    outline.vertices.push(vertex);
    outline.sourceCorners.push(corner);
    outline.sourceEdges.push(edge);
    sides.push(signs[vertex]);
    const crossing = points.get(edge);
    if (!crossing) continue;
    const nextCorner = polygon.sourceCorners[(index + 1) % count];
    const fraction = crossing.from === vertex ? crossing.fraction : 1 - crossing.fraction;
    outline.vertices.push(crossing.vertex);
    outline.sourceCorners.push({ from: corner, to: nextCorner, t: fraction });
    outline.sourceEdges.push(edge);
    sides.push(0);
  }
  return { outline, sides };
}

function sideOf(sides) {
  return sides.find(side => side !== 0) ?? 0;
}

/** Cut one polygon; returns [{ polygon, side }]. */
function bisectPolygon(mesh, polygon, signs, points, index) {
  const { outline, sides } = withCrossings(mesh, polygon, signs, points);
  if (!sides.includes(1) || !sides.includes(-1)) return { pieces: [{ polygon: outline, side: sideOf(sides) }], cut: false };
  const onPlane = sides.map((side, position) => (side === 0 ? position : -1)).filter(position => position >= 0);
  if (onPlane.length !== 2) {
    throw new RangeError(`Face ${index} crosses the plane ${onPlane.length} times. Split it into convex faces first.`);
  }
  const [first, last] = onPlane;
  const forward = loopRange(sides, first, last);
  const pieces = splitPolygon(outline, first, last, [], -1);
  return {
    pieces: [
      { polygon: pieces[0], side: sideOf(forward) },
      { polygon: pieces[1], side: -sideOf(forward) },
    ],
    cut: true,
  };
}

function cutHalfEdges(pieces, onPlane) {
  const halfEdges = [];
  for (const { polygon } of pieces) {
    polygon.vertices.forEach((vertex, position) => {
      const next = polygon.vertices[(position + 1) % polygon.vertices.length];
      if (onPlane(vertex) && onPlane(next)) halfEdges.push({ from: vertex, to: next, polygon, position });
    });
  }
  return halfEdges;
}

/** Cut half-edges of one side that no polygon of that side (or lying in the plane) runs back over. */
function openCutEdges(sidePieces, otherCoplanar, onPlane) {
  const halfEdges = cutHalfEdges(sidePieces, onPlane);
  const keys = new Set(cutHalfEdges([...sidePieces, ...otherCoplanar], onPlane).map(({ from, to }) => `${from}>${to}`));
  return halfEdges.filter(({ from, to }) => !keys.has(`${to}>${from}`));
}

function chainLoops(halfEdges) {
  const outgoing = new Map(halfEdges.map(halfEdge => [halfEdge.from, halfEdge]));
  const used = new Set();
  const loops = [];
  let open = 0;
  for (const start of halfEdges) {
    if (used.has(start)) continue;
    const loop = [];
    let current = start;
    while (current && !used.has(current)) {
      used.add(current);
      loop.push(current);
      current = outgoing.get(current.to);
    }
    if (current === start) loops.push(loop);
    else open++;
  }
  return { loops, open };
}

function capPolygon(loop, tag) {
  const reversed = [...loop].reverse();
  const corner = halfEdge => halfEdge.polygon.sourceCorners[halfEdge.position];
  return {
    vertices: reversed.map(halfEdge => halfEdge.to),
    sourceFace: loop[0].polygon.sourceFace,
    sourceCorners: reversed.map(corner),
    sourceEdges: reversed.map(() => -1),
    keepTags: false,
    tags: [tag],
  };
}

/**
 * Cut the mesh at a plane through `point` with the given `normal`. Points within `distance` of the plane count as on
 * it. `clearInner` removes the side the normal points away from, `clearOuter` the side it points to. `fill` caps the
 * cut with polygons tagged `<name>.cap`; when both sides stay, the halves separate into two closed shells so no edge
 * has four faces. Faces get `<name>.inner` or `<name>.outer` by side.
 */
export function bisectPlane(mesh, { point, normal, distance = 1e-4, clearInner = false, clearOuter = false, fill = false, name = 'bisect' }) {
  const planeNormal = unit(normal);
  const { signs, offsets } = planeSigns(mesh, point, planeNormal, distance);
  const extraPositions = [];
  const points = crossingPoints(mesh, signs, offsets, extraPositions);
  const pieces = [];
  let cutFaces = 0;
  facePolygons(mesh).forEach((polygon, index) => {
    const result = bisectPolygon(mesh, polygon, signs, points, index);
    if (result.cut) cutFaces++;
    pieces.push(...result.pieces);
  });
  if (cutFaces === 0) throw new RangeError('The plane does not cross any face. Check point and normal against the mesh bounds.');
  const onPlane = vertex => vertex >= mesh.vertexCount || signs[vertex] === 0;
  const inner = pieces.filter(piece => piece.side === -1);
  const outer = pieces.filter(piece => piece.side === 1);
  const coplanar = pieces.filter(piece => piece.side === 0);
  for (const { polygon, side } of pieces) {
    if (side === -1) polygon.tags = [...polygon.tags, `${name}.inner`];
    if (side === 1) polygon.tags = [...polygon.tags, `${name}.outer`];
  }
  const kept = pieces.filter(({ side }) => (side === -1 && !clearInner) || (side === 1 && !clearOuter) || side === 0);
  const polygons = kept.map(({ polygon }) => polygon);
  const capsOf = sidePieces => {
    const { loops, open } = chainLoops(openCutEdges(sidePieces, coplanar, onPlane));
    return { caps: loops.map(loop => capPolygon(loop, `${name}.cap`)), open };
  };
  let capped = 0;
  let unfilled = 0;
  if (fill) {
    const innerCaps = clearInner ? { caps: [], open: 0 } : capsOf(inner);
    const outerCaps = clearOuter ? { caps: [], open: 0 } : capsOf(outer);
    if (!clearInner && !clearOuter) {
      separateOuterShell(mesh, [...outer.map(({ polygon }) => polygon), ...outerCaps.caps], onPlane, extraPositions);
    }
    polygons.push(...innerCaps.caps, ...outerCaps.caps);
    capped = innerCaps.caps.length + outerCaps.caps.length;
    unfilled = innerCaps.open + outerCaps.open;
  }
  return { mesh: buildPolygonMesh(mesh, polygons, extraPositions), cutFaces, capped, unfilled, newVertices: points.size };
}

// With both halves kept and capped, the outer half gets its own copies of the vertices on the plane.
function separateOuterShell(mesh, outerPolygons, onPlane, extraPositions) {
  const copies = new Map();
  const copyOf = vertex => {
    if (!copies.has(vertex)) {
      extraPositions.push(positionOf(mesh, extraPositions, vertex));
      copies.set(vertex, mesh.vertexCount + extraPositions.length - 1);
    }
    return copies.get(vertex);
  };
  for (const polygon of outerPolygons) {
    polygon.vertices = polygon.vertices.map(vertex => (onPlane(vertex) ? copyOf(vertex) : vertex));
  }
}
