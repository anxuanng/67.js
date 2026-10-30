import { LatheGeometry, ExtrudeGeometry, TubeGeometry, CatmullRomCurve3, Shape, Path, Vector2, Vector3 } from 'three';

const MAX_INPUT_POINTS = 4096;
const DEFAULT_VERTEX_LIMIT = 250_000;

function finite(value, name) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new TypeError(`${name} must be a finite float.`);
  return Math.fround(value);
}

function integer(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer within ${minimum} and ${maximum}.`);
  return value;
}

function pointsFrom(input, size, minimum, name) {
  if (!Array.isArray(input) || input.length < minimum || input.length > MAX_INPUT_POINTS) throw new RangeError(`${name} needs ${minimum} to ${MAX_INPUT_POINTS} points.`);
  const points = input.map(point => {
    if ((!Array.isArray(point) && !ArrayBuffer.isView(point)) || point.length !== size) throw new TypeError(`${name} points need ${size} components.`);
    return Array.from(point, value => finite(value, name));
  });
  for (let index = 1; index < points.length; index++) {
    if (points[index].every((value, axis) => value === points[index - 1][axis])) throw new RangeError(`${name} cannot contain consecutive duplicate points.`);
  }
  return points;
}

function checkBudget(vertices, maximum) {
  integer(maximum, 3, 1_000_000, 'maxVertices');
  if (vertices > maximum) throw new RangeError(`Modeling requires up to ${vertices} vertices, exceeding maxVertices ${maximum}. Reduce detail.`);
}

function meshFrom(source, maximum) {
  try {
    const position = source.getAttribute('position');
    checkBudget(position.count, maximum);
    const normal = source.getAttribute('normal');
    const uv = source.getAttribute('uv');
    const positions = new Float32Array(position.array);
    const normals = new Float32Array(normal.array);
    const uvs = new Float32Array(uv.array);
    const indices = source.index ? new Uint32Array(source.index.array) : Uint32Array.from({ length: position.count }, (_, index) => index);
    for (let offset = 0; offset < normals.length; offset += 3) {
      const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
      if (!Number.isFinite(length) || length === 0) throw new RangeError('Modeling produced an invalid normal. Adjust the profile or contour.');
      for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
    }
    for (const value of positions) if (!Number.isFinite(value)) throw new RangeError('Modeling geometry exceeds the finite Float32 range. Reduce coordinates.');
    for (const value of uvs) if (!Number.isFinite(value)) throw new RangeError('Modeling produced invalid UVs. Adjust the profile or contour.');
    let drawable = false;
    for (let offset = 0; offset < indices.length; offset += 3) {
      const first = indices[offset] * 3;
      const second = indices[offset + 1] * 3;
      const third = indices[offset + 2] * 3;
      const ax = positions[second] - positions[first];
      const ay = positions[second + 1] - positions[first + 1];
      const az = positions[second + 2] - positions[first + 2];
      const bx = positions[third] - positions[first];
      const by = positions[third + 1] - positions[first + 1];
      const bz = positions[third + 2] - positions[first + 2];
      if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 0) {
        drawable = true;
        break;
      }
    }
    if (!drawable) throw new RangeError('Modeling collapsed at Float32 precision. Center geometry locally and position it with a transform.');
    return { positions, normals, uvs, indices };
  } finally {
    source.dispose();
  }
}

/** Revolve a radius/height profile around Y, using the installed Three.js geometry implementation. */
export function lathe(profile, { segments = 64, startAngle = 0, sweep = Math.PI * 2, maxVertices = DEFAULT_VERTEX_LIMIT } = {}) {
  integer(segments, 3, 2048, 'segments');
  finite(startAngle, 'startAngle');
  startAngle %= Math.PI * 2;
  finite(sweep, 'sweep');
  if (sweep <= 0 || sweep > Math.PI * 2) throw new RangeError('sweep must be greater than zero and at most one full turn.');
  const points = pointsFrom(profile, 2, 2, 'profile');
  if (points.some(point => point[0] < 0) || !points.some(point => point[0] > 0)) throw new RangeError('Profile radii must be nonnegative, with at least one positive radius.');
  checkBudget((segments + 1) * points.length, maxVertices);
  return meshFrom(new LatheGeometry(points.map(point => new Vector2(...point)), segments, startAngle, sweep), maxVertices);
}

function orientation(first, second, third) {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function onSegment(first, second, point) {
  return orientation(first, second, point) === 0 && point[0] >= Math.min(first[0], second[0]) && point[0] <= Math.max(first[0], second[0]) && point[1] >= Math.min(first[1], second[1]) && point[1] <= Math.max(first[1], second[1]);
}

function intersects(first, second, third, fourth) {
  const a = orientation(first, second, third);
  const b = orientation(first, second, fourth);
  const c = orientation(third, fourth, first);
  const d = orientation(third, fourth, second);
  return Math.sign(a) !== Math.sign(b) && Math.sign(c) !== Math.sign(d) ||
    a === 0 && onSegment(first, second, third) || b === 0 && onSegment(first, second, fourth) ||
    c === 0 && onSegment(third, fourth, first) || d === 0 && onSegment(third, fourth, second);
}

function ringFrom(input, name) {
  const points = pointsFrom(input, 2, 3, name);
  if (points[0].every((value, axis) => value === points.at(-1)[axis])) points.pop();
  if (points.length < 3) throw new RangeError(`${name} needs three distinct points.`);
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = (index + 1) % points.length;
    area += points[index][0] * points[next][1] - points[next][0] * points[index][1];
    for (let other = index + 1; other < points.length; other++) {
      const otherNext = (other + 1) % points.length;
      if (other === next || otherNext === index) continue;
      if (intersects(points[index], points[next], points[other], points[otherNext])) throw new RangeError(`${name} cannot intersect or touch itself.`);
    }
  }
  if (area === 0) throw new RangeError(`${name} must enclose a nonzero area.`);
  return points;
}

function inside(point, ring) {
  let result = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function ringsIntersect(first, second) {
  for (let a = 0; a < first.length; a++) {
    for (let b = 0; b < second.length; b++) {
      if (intersects(first[a], first[(a + 1) % first.length], second[b], second[(b + 1) % second.length])) return true;
    }
  }
  return false;
}

/**
 * Triangulating a cap drops points that are collinear with their neighbours, so a long cap edge can run past wall
 * vertices and leave the solid open. Split those triangles at the skipped points, which keeps the surface unchanged.
 */
function closeTJunctions(geometry) {
  const { positions, normals, uvs, indices } = geometry;
  const vertexKey = vertex => `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
  const edgeKey = (first, second) => {
    const firstKey = vertexKey(first);
    const secondKey = vertexKey(second);
    return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
  };
  const edgeUses = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const key = edgeKey(indices[offset + side], indices[offset + (side + 1) % 3]);
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  const openEdges = new Set([...edgeUses].filter(([, uses]) => uses !== 2).map(([key]) => key));
  if (openEdges.size === 0) return geometry;
  const candidates = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    for (let side = 0; side < 3; side++) {
      const first = indices[offset + side];
      const second = indices[offset + (side + 1) % 3];
      if (!openEdges.has(edgeKey(first, second))) continue;
      candidates.set(vertexKey(first), first);
      candidates.set(vertexKey(second), second);
    }
  }
  const newPositions = Array.from(positions);
  const newNormals = Array.from(normals);
  const newUvs = Array.from(uvs);
  const pointsInside = (first, second) => {
    const start = [newPositions[first * 3], newPositions[first * 3 + 1], newPositions[first * 3 + 2]];
    const direction = [0, 1, 2].map(axis => newPositions[second * 3 + axis] - start[axis]);
    const lengthSquared = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
    const tolerance = 1e-6 * Math.max(Math.sqrt(lengthSquared), ...start.map(Math.abs));
    const inside = [];
    for (const candidate of candidates.values()) {
      const offsetFromStart = [0, 1, 2].map(axis => positions[candidate * 3 + axis] - start[axis]);
      const along = (offsetFromStart[0] * direction[0] + offsetFromStart[1] * direction[1] + offsetFromStart[2] * direction[2]) / lengthSquared;
      if (along <= 1e-6 || along >= 1 - 1e-6) continue;
      const distance = Math.hypot(...offsetFromStart.map((value, axis) => value - direction[axis] * along));
      if (distance <= tolerance) inside.push({ candidate, along });
    }
    return inside.sort((left, right) => left.along - right.along);
  };
  const addVertexOnEdge = (first, second, { candidate, along }) => {
    const vertex = newPositions.length / 3;
    for (let axis = 0; axis < 3; axis++) {
      newPositions.push(positions[candidate * 3 + axis]);
      newNormals.push(newNormals[first * 3 + axis] + (newNormals[second * 3 + axis] - newNormals[first * 3 + axis]) * along);
    }
    for (let axis = 0; axis < 2; axis++) newUvs.push(newUvs[first * 2 + axis] + (newUvs[second * 2 + axis] - newUvs[first * 2 + axis]) * along);
    return vertex;
  };
  const newIndices = [];
  const pending = [];
  for (let offset = indices.length - 3; offset >= 0; offset -= 3) pending.push([indices[offset], indices[offset + 1], indices[offset + 2]]);
  while (pending.length) {
    const triangle = pending.pop();
    let split = false;
    for (let side = 0; side < 3 && !split; side++) {
      const first = triangle[side];
      const second = triangle[(side + 1) % 3];
      const opposite = triangle[(side + 2) % 3];
      if (!openEdges.has(edgeKey(first, second))) continue;
      const inside = pointsInside(first, second);
      if (!inside.length) continue;
      const chain = [first, ...inside.map(point => addVertexOnEdge(first, second, point)), second];
      for (let link = chain.length - 2; link >= 0; link--) pending.push([chain[link], chain[link + 1], opposite]);
      split = true;
    }
    if (!split) newIndices.push(...triangle);
  }
  return {
    positions: Float32Array.from(newPositions), normals: Float32Array.from(newNormals),
    uvs: Float32Array.from(newUvs), indices: Uint32Array.from(newIndices),
  };
}

/** Extrude a simple XY contour and disjoint enclosed holes along positive Z. */
export function extrude(contour, {
  holes = [], depth = 1, steps = 1, bevel = 0, bevelThickness = bevel,
  bevelSegments = 3, maxVertices = DEFAULT_VERTEX_LIMIT,
} = {}) {
  depth = finite(depth, 'depth');
  bevel = finite(bevel, 'bevel');
  bevelThickness = finite(bevelThickness, 'bevelThickness');
  if (depth <= 0 || bevel < 0 || bevelThickness < 0) throw new RangeError('depth must be positive and bevel dimensions must be nonnegative.');
  integer(steps, 1, 256, 'steps');
  integer(bevelSegments, 1, 32, 'bevelSegments');
  if (!Array.isArray(holes) || holes.length > 128) throw new RangeError('holes must be an array with at most 128 rings.');
  const inputPoints = (contour?.length ?? 0) + holes.reduce((count, hole) => count + (hole?.length ?? 0), 0);
  if (inputPoints > MAX_INPUT_POINTS + holes.length + 1) throw new RangeError(`Contours and holes must contain at most ${MAX_INPUT_POINTS} total points.`);
  const outer = ringFrom(contour, 'contour');
  const inner = holes.map((hole, index) => ringFrom(hole, `hole ${index}`));
  const totalPoints = outer.length + inner.reduce((count, ring) => count + ring.length, 0);
  if (totalPoints > MAX_INPUT_POINTS) throw new RangeError(`Contours and holes must contain at most ${MAX_INPUT_POINTS} total points.`);
  const beveled = bevel > 0 || bevelThickness > 0;
  checkBudget(6 * (totalPoints + inner.length * 2 - 2) + 6 * totalPoints * (steps + (beveled ? bevelSegments * 2 : 0)), maxVertices);
  for (let index = 0; index < inner.length; index++) {
    if (!inside(inner[index][0], outer) || ringsIntersect(outer, inner[index])) throw new RangeError('Every hole must lie strictly inside the contour.');
    for (let other = 0; other < index; other++) {
      if (ringsIntersect(inner[index], inner[other]) || inside(inner[index][0], inner[other]) || inside(inner[other][0], inner[index])) throw new RangeError('Holes cannot overlap, touch or contain each other.');
    }
  }
  const shape = new Shape(outer.map(point => new Vector2(...point)));
  shape.holes = inner.map(ring => new Path(ring.map(point => new Vector2(...point))));
  return closeTJunctions(meshFrom(new ExtrudeGeometry(shape, {
    depth, steps, bevelEnabled: beveled, bevelSize: bevel, bevelThickness, bevelSegments,
  }), maxVertices));
}

/** Sweep a circular tube along a centripetal Catmull-Rom curve. */
export function tube(path, {
  radius = 0.1, segments = 64, radialSegments = 12, closed = false,
  maxVertices = DEFAULT_VERTEX_LIMIT,
} = {}) {
  radius = finite(radius, 'radius');
  if (radius <= 0 || typeof closed !== 'boolean') throw new RangeError('radius must be positive and closed must be boolean.');
  integer(segments, 3, 2048, 'segments');
  integer(radialSegments, 3, 128, 'radialSegments');
  const points = pointsFrom(path, 3, closed ? 3 : 2, 'path');
  if (closed && points[0].every((value, axis) => value === points.at(-1)[axis])) points.pop();
  if (points.length < (closed ? 3 : 2)) throw new RangeError('The path has too few distinct points.');
  checkBudget((segments + 1) * (radialSegments + 1), maxVertices);
  const curve = new CatmullRomCurve3(points.map(point => new Vector3(...point)), closed, 'centripetal');
  return meshFrom(new TubeGeometry(curve, segments, radius, radialSegments, closed), maxVertices);
}
