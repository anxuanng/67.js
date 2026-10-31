import { facePolygons, buildPolygonMesh } from './mesh-polygons.js';
import { splitPolygon } from './mesh-bisect.js';

// Knife: cut along a polyline in object space, projected onto the mesh along a direction, as if the line were a
// curtain that hangs along that direction. Every face the curtain crosses is split along it, front and back (the
// editor's "cut through"). A stretch of the line that starts or ends inside a face, without reaching its edge, makes no
// cut, because a face cannot hold a dangling edge.

const MAX_PATH_POINTS = 256;
const SNAP = 1e-6;

const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
const lerp = (first, second, fraction) => first.map((value, axis) => value + (second[axis] - value) * fraction);
const cross2 = (first, second) => first[0] * second[1] - first[1] * second[0];

function projectionBasis(direction) {
  const length = Math.hypot(...direction);
  if (length === 0) throw new RangeError('direction cannot be zero.');
  const along = direction.map(value => value / length);
  const weakest = along.map(Math.abs).indexOf(Math.min(...along.map(Math.abs)));
  const helper = [0, 0, 0];
  helper[weakest] = 1;
  const first = cross(along, helper);
  const firstLength = Math.hypot(...first);
  const sideways = first.map(value => value / firstLength);
  return { along, sideways, upwards: cross(along, sideways) };
}

function insidePolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [ax, ay] = polygon[index];
    const [bx, by] = polygon[previous];
    if ((ay > point[1]) !== (by > point[1]) && point[0] < ((bx - ax) * (point[1] - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** Where each mesh edge meets the projected line: { t, vertex, s, inserted } sorted by t from the edge's first vertex. */
function edgeCrossings(mesh, flat, vertexPoint, line, extraPositions) {
  const crossings = new Map();
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    const start = flat[first];
    const span = [flat[second][0] - start[0], flat[second][1] - start[1]];
    const found = [];
    for (let index = 0; index + 1 < line.points.length; index++) {
      const origin = line.points[index];
      const step = [line.points[index + 1][0] - origin[0], line.points[index + 1][1] - origin[1]];
      const denominator = cross2(span, step);
      if (Math.abs(denominator) < 1e-12) continue;
      const offset = [origin[0] - start[0], origin[1] - start[1]];
      const t = cross2(offset, step) / denominator;
      const u = cross2(offset, span) / denominator;
      if (t < -SNAP || t > 1 + SNAP || u < -SNAP || u > 1 + SNAP) continue;
      const clamped = Math.min(1, Math.max(0, t));
      const s = line.lengths[index] + Math.min(1, Math.max(0, u)) * (line.lengths[index + 1] - line.lengths[index]);
      if (found.some(other => Math.abs(other.t - clamped) < SNAP)) continue;
      if (clamped < SNAP) found.push({ t: 0, vertex: first, s, inserted: false });
      else if (clamped > 1 - SNAP) found.push({ t: 1, vertex: second, s, inserted: false });
      else {
        extraPositions.push(lerp(vertexPoint(first), vertexPoint(second), clamped));
        found.push({ t: clamped, vertex: mesh.vertexCount + extraPositions.length - 1, s, inserted: true });
      }
    }
    if (found.length) crossings.set(edge, found.sort((left, right) => left.t - right.t));
  }
  return crossings;
}

function outlineWithCrossings(mesh, polygon, crossings) {
  const outline = { ...polygon, vertices: [], sourceCorners: [], sourceEdges: [] };
  const size = polygon.vertices.length;
  const events = [];
  polygon.vertices.forEach((vertex, index) => {
    outline.vertices.push(vertex);
    outline.sourceCorners.push(polygon.sourceCorners[index]);
    outline.sourceEdges.push(polygon.sourceEdges[index]);
    const edge = polygon.sourceEdges[index];
    const found = crossings.get(edge);
    if (!found) return;
    const forward = vertex === mesh.edgeVertices[edge * 2];
    for (const crossing of forward ? found : [...found].reverse()) {
      events.push(crossing);
      if (!crossing.inserted) continue;
      outline.vertices.push(crossing.vertex);
      outline.sourceCorners.push({ from: polygon.sourceCorners[index], to: polygon.sourceCorners[(index + 1) % size], t: forward ? crossing.t : 1 - crossing.t });
      outline.sourceEdges.push(edge);
    }
  });
  return { outline, events };
}

function faceNormal(points) {
  const normal = [0, 0, 0];
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    normal[0] += (point[1] - next[1]) * (point[2] + next[2]);
    normal[1] += (point[2] - next[2]) * (point[0] + next[0]);
    normal[2] += (point[0] - next[0]) * (point[1] + next[1]);
  });
  return normal;
}

function pointAt(line, s) {
  let index = 0;
  while (index + 2 < line.lengths.length && line.lengths[index + 1] < s) index++;
  const span = line.lengths[index + 1] - line.lengths[index] || 1;
  return lerp(line.points[index], line.points[index + 1], (s - line.lengths[index]) / span);
}

/** Lift a flat point back onto a face's plane along the projection direction. */
function liftOntoFace(flatPoint, basis, centre, normal) {
  const origin = basis.sideways.map((value, axis) => value * flatPoint[0] + basis.upwards[axis] * flatPoint[1]);
  const distance = dot(normal, centre.map((value, axis) => value - origin[axis])) / dot(normal, basis.along);
  return origin.map((value, axis) => value + basis.along[axis] * distance);
}

/**
 * Cut the mesh along `path`, a polyline of at least two object-space points, projected along `direction`. Faces split
 * by the cut get `<name>.cut`. Returns { mesh, cutFaces, newVertices }.
 */
export function knifeCut(mesh, { path, direction, name = 'knife' }) {
  if (!Array.isArray(path) || path.length < 2 || path.length > MAX_PATH_POINTS) throw new RangeError(`path needs 2 to ${MAX_PATH_POINTS} points.`);
  const basis = projectionBasis(direction);
  const vertexPoint = vertex => [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
  const flatten = point => [dot(point, basis.sideways), dot(point, basis.upwards)];
  const flat = Array.from({ length: mesh.vertexCount }, (_, vertex) => flatten(vertexPoint(vertex)));
  const points = path.map(flatten);
  const lengths = [0];
  for (let index = 1; index < points.length; index++) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]));
  }
  const line = { points, lengths };
  const extraPositions = [];
  const crossings = edgeCrossings(mesh, flat, vertexPoint, line, extraPositions);
  const output = [];
  let cutFaces = 0;
  for (const polygon of facePolygons(mesh)) {
    const { outline, events } = outlineWithCrossings(mesh, polygon, crossings);
    const parts = splitFace(mesh, polygon, outline, events, { basis, line, flat, vertexPoint, extraPositions, name });
    if (parts.length > 1) cutFaces++;
    output.push(...parts);
  }
  if (cutFaces === 0) throw new RangeError('The line does not cross any face when projected along the direction. Check path and direction against the mesh bounds.');
  return { mesh: buildPolygonMesh(mesh, output, extraPositions), cutFaces, newVertices: extraPositions.length };
}

function splitFace(mesh, polygon, outline, events, context) {
  const { basis, line, flat, vertexPoint, extraPositions, name } = context;
  const corners3d = polygon.vertices.map(vertexPoint);
  const normal = faceNormal(corners3d);
  if (Math.abs(dot(normal, basis.along)) < 1e-9 * Math.hypot(...normal)) return [outline];
  const ordered = [];
  for (const event of [...events].sort((left, right) => left.s - right.s)) {
    const last = ordered[ordered.length - 1];
    if (last && last.vertex === event.vertex && Math.abs(last.s - event.s) < 1e-6) continue;
    ordered.push(event);
  }
  const flatOutline = polygon.vertices.map(vertex => flat[vertex]);
  const centre = corners3d[0];
  let parts = [outline];
  for (let index = 0; index + 1 < ordered.length; index++) {
    const from = ordered[index];
    const to = ordered[index + 1];
    if (from.vertex === to.vertex) continue;
    if (!insidePolygon(pointAt(line, (from.s + to.s) / 2), flatOutline)) continue;
    const inner = [];
    line.lengths.forEach((length, vertexIndex) => {
      if (length <= from.s + 1e-9 || length >= to.s - 1e-9) return;
      extraPositions.push(liftOntoFace(line.points[vertexIndex], basis, centre, normal));
      inner.push(mesh.vertexCount + extraPositions.length - 1);
    });
    parts = parts.flatMap(part => {
      const first = part.vertices.indexOf(from.vertex);
      const last = part.vertices.indexOf(to.vertex);
      if (first < 0 || last < 0) return [part];
      return splitPolygon(part, first, last, inner, part.sourceCorners[first]).map(piece => ({ ...piece, tags: [...polygon.tags, `${name}.cut`] }));
    });
  }
  return parts;
}
