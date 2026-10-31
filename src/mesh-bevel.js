import { editMesh } from './mesh-edit.js';
import { faceNormals } from './mesh-normals.js';
import { selectFaces } from './mesh-select.js';
import { MeshBuilder } from './mesh-stack.js';

// Edge bevel on manifold meshes, a compact take on Blender's bmesh_bevel for the common cases agents need:
// rounding the rim between two tagged regions, or every edge sharper than an angle.
//
// For each face corner touching a beveled edge, the corner moves into its face: away from both edges when both are
// beveled (as an inset corner), or along the other, unbeveled edge when only one is (a slide point shared with the
// face on the other side of that edge, so no T-junctions appear). Each beveled edge becomes a strip of `segments`
// quads following a quadratic profile around the original edge. Where beveled edges meet at a vertex, the gap left
// between the strips is filled with one polygon found by walking around the vertex.

/**
 * Edge selection rules:
 *   { "between": [faceRule, faceRule] }  edges shared by a face matching the first rule and one matching the second
 *   { "angle": 30 }                      edges whose two faces bend by at least this many degrees
 *   { "boundaryOf": faceRule }           edges between a matching face and a non-matching one
 *   { "along": [x, y, z], "maxAngle": 10 } edges parallel to a direction (either way) within maxAngle degrees
 *   { "all": true }                      every edge with two faces
 *   { "open": true }                     every boundary edge (one face); { "open": { "inside": { min, max } } } limits it to a box
 * Returns a Uint8Array over MeshData edges.
 */
export function selectEdges(mesh, rule, table) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new TypeError('Edge rule must be an object.');
  const keys = Object.keys(rule);
  const mask = new Uint8Array(mesh.edgeCount);
  const facesOf = edge => table.faces[edge];
  if (keys.length !== 1 && rule.along === undefined) throw new TypeError('Edge rule takes exactly one of between, angle, boundaryOf, along, open, all.');
  if (rule.open !== undefined) return selectOpenEdges(mesh, rule, table);
  if (rule.all === true) {
    for (let edge = 0; edge < mesh.edgeCount; edge++) mask[edge] = facesOf(edge).length === 2 ? 1 : 0;
    return mask;
  }
  if (rule.angle !== undefined) {
    if (!Number.isFinite(rule.angle) || rule.angle < 0 || rule.angle > 180) throw new RangeError('Edge rule angle is degrees from 0 to 180.');
    const { normals } = faceNormals(mesh);
    const limit = Math.cos(rule.angle * Math.PI / 180) + 1e-9;
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      const faces = facesOf(edge);
      if (faces.length !== 2) continue;
      const [first, second] = faces;
      const cosine = normals[first * 3] * normals[second * 3] + normals[first * 3 + 1] * normals[second * 3 + 1] + normals[first * 3 + 2] * normals[second * 3 + 2];
      if (cosine <= limit) mask[edge] = 1;
    }
    return mask;
  }
  if (rule.along !== undefined) {
    const extra = keys.filter(key => key !== 'along' && key !== 'maxAngle');
    if (extra.length) throw new TypeError(`Edge rule along does not take ${extra.join(', ')}.`);
    if (!Array.isArray(rule.along) || rule.along.length !== 3 || !rule.along.every(Number.isFinite)) throw new TypeError('along needs a direction [x, y, z].');
    const direction = normalize(rule.along);
    if (length(direction) === 0) throw new RangeError('along cannot be zero.');
    const maxAngle = rule.maxAngle ?? 10;
    if (!Number.isFinite(maxAngle) || maxAngle < 0 || maxAngle > 90) throw new RangeError('maxAngle is degrees from 0 to 90.');
    const limit = Math.cos(maxAngle * Math.PI / 180) - 1e-9;
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      const first = mesh.edgeVertices[edge * 2] * 3;
      const second = mesh.edgeVertices[edge * 2 + 1] * 3;
      const vector = normalize([
        mesh.positions[second] - mesh.positions[first],
        mesh.positions[second + 1] - mesh.positions[first + 1],
        mesh.positions[second + 2] - mesh.positions[first + 2],
      ]);
      if (Math.abs(dot(vector, direction)) >= limit) mask[edge] = 1;
    }
    return mask;
  }
  if (rule.between !== undefined) {
    if (!Array.isArray(rule.between) || rule.between.length !== 2) throw new TypeError('between needs two face rules.');
    const first = selectFaces(mesh, rule.between[0]);
    const second = selectFaces(mesh, rule.between[1]);
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      const faces = facesOf(edge);
      if (faces.length !== 2) continue;
      const [left, right] = faces;
      if ((first[left] && second[right]) || (first[right] && second[left])) mask[edge] = 1;
    }
    return mask;
  }
  if (rule.boundaryOf !== undefined) {
    const selected = selectFaces(mesh, rule.boundaryOf);
    for (let edge = 0; edge < mesh.edgeCount; edge++) {
      const faces = facesOf(edge);
      if (faces.length === 2 && selected[faces[0]] !== selected[faces[1]]) mask[edge] = 1;
    }
    return mask;
  }
  throw new TypeError('Edge rule takes exactly one of between, angle, boundaryOf, along, open, all.');
}

// { "open": true } picks the boundary edges, those with one face; { "open": { "inside": { min, max } } } keeps the
// ones whose midpoint lies in the box, which picks one hole among several.
function selectOpenEdges(mesh, rule, table) {
  const mask = new Uint8Array(mesh.edgeCount);
  const box = rule.open === true ? null : rule.open?.inside;
  if (!box && rule.open !== true) throw new TypeError('Edge rule open is true or { "inside": { "min": [x, y, z], "max": [x, y, z] } }.');
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (table.faces[edge].length !== 1) continue;
    const first = mesh.edgeVertices[edge * 2] * 3;
    const second = mesh.edgeVertices[edge * 2 + 1] * 3;
    const inside = !box || [0, 1, 2].every(axis => {
      const middle = (mesh.positions[first + axis] + mesh.positions[second + axis]) / 2;
      return middle >= box.min[axis] - 1e-6 && middle <= box.max[axis] + 1e-6;
    });
    mask[edge] = inside ? 1 : 0;
  }
  return mask;
}

/** Faces of every MeshData edge. */
export function edgeFaces(mesh) {
  const faces = Array.from({ length: mesh.edgeCount }, () => []);
  for (let face = 0; face < mesh.faceCount; face++) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) faces[mesh.cornerEdges[corner]].push(face);
  }
  return { faces };
}

// Clamped slides stop at 49% of an edge: at exactly half, neighbouring faces collapse to zero area.
const CLAMP_FRACTION = 0.49;

const subtract = (first, second) => [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
const add = (first, second) => [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
const scale = (vector, factor) => [vector[0] * factor, vector[1] * factor, vector[2] * factor];
const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
const length = vector => Math.hypot(vector[0], vector[1], vector[2]);
const normalize = vector => {
  const size = length(vector);
  return size === 0 ? [0, 0, 0] : scale(vector, 1 / size);
};

// The superellipse x^r + y^r = 1 between the two slide points, with the same meaning of profile as Blender. Returns how
// far a point sits toward each slide point from the corner, for t from 0 to 1 along the curve.
const MINIMUM_PROFILE = 0.001;
function profileWeights(profile, t) {
  const exponent = -2 * Math.log(Math.sqrt(Math.max(profile, MINIMUM_PROFILE))) / Math.LN2;
  const angle = t * Math.PI / 2;
  return [1 - Math.sin(angle) ** exponent, 1 - Math.cos(angle) ** exponent];
}

/**
 * Bevel the selected edges. Options: width (distance from the edge into each face), segments (1 is a flat chamfer),
 * profile (0.5 round, 0.25 flat, 1 square, below 0.25 concave), clampOverlap (shrink width so slides stay within half
 * of their edge).
 * Returns { mesh, width, clamped, bevelEdges, stripFaces, cornerFaces, filledCorners }. Strip faces get `<name>.strip`,
 * corner fills `<name>.corner`; the faces around keep their tags.
 */
export function bevelEdges(mesh, edgeRule, { width, segments = 1, profile = 0.5, clampOverlap = true, name = 'bevel' }) {
  const table = edgeFaces(mesh);
  const beveled = selectEdges(mesh, edgeRule, table);
  let bevelCount = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) bevelCount += beveled[edge];
  if (!bevelCount) throw new RangeError('The edge rule selects no edges with two faces. Check tags with mesh_inspect, or lower angle.');
  const edit = editMesh(mesh);
  const loops = edit.loops.arrays;
  const positionOf = vertex => edit.vertexPosition(vertex);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!beveled[edge]) continue;
    const edgeLoops = edit.edgeLoops(edge);
    if (edgeLoops.length !== 2 || loops.vertex[edgeLoops[0]] === loops.vertex[edgeLoops[1]]) {
      throw new RangeError(`Edge ${edge} needs exactly two consistently wound faces to bevel. Run mesh_inspect and fix non-manifold or flipped faces first.`);
    }
  }
  const { normals: faceNormal } = faceNormals(mesh);
  const normalOf = face => [faceNormal[face * 3], faceNormal[face * 3 + 1], faceNormal[face * 3 + 2]];
  const otherEnd = (edge, vertex) => edit.edgeOtherVertex(edge, vertex);

  // Pass 1: slide distances per (vertex, unbeveled edge), the largest any neighbouring face needs, and the clamp.
  const slideNeeds = new Map();
  let effectiveWidth = width;
  const corners = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    for (const loop of edit.faceLoops(face)) {
      const vertex = loops.vertex[loop];
      const incoming = loops.edge[loops.prev[loop]];
      const outgoing = loops.edge[loop];
      const inBeveled = beveled[incoming] === 1;
      const outBeveled = beveled[outgoing] === 1;
      corners.push({ face, loop, vertex, incoming, outgoing, inBeveled, outBeveled });
      if (inBeveled === outBeveled) continue;
      const bevelEdge = inBeveled ? incoming : outgoing;
      const slideEdge = inBeveled ? outgoing : incoming;
      const origin = positionOf(vertex);
      const along = subtract(positionOf(otherEnd(slideEdge, vertex)), origin);
      const across = normalize(subtract(positionOf(otherEnd(bevelEdge, vertex)), origin));
      const sine = length(cross(normalize(along), across));
      if (sine < 1e-6) throw new RangeError(`Face ${face} has a beveled edge parallel to its neighbour at vertex ${vertex}; bevel cannot slide there.`);
      const key = `${vertex}|${slideEdge}`;
      const need = slideNeeds.get(key) ?? { vertex, slideEdge, sine: Infinity, edgeLength: length(along) };
      need.sine = Math.min(need.sine, sine);
      slideNeeds.set(key, need);
      if (clampOverlap) effectiveWidth = Math.min(effectiveWidth, CLAMP_FRACTION * need.edgeLength * sine);
    }
  }
  if (clampOverlap) {
    // Inset corners: keep both offsets within half of the shorter beveled edge at that corner.
    for (const corner of corners) {
      if (!corner.inBeveled || !corner.outBeveled) continue;
      const origin = positionOf(corner.vertex);
      const first = length(subtract(positionOf(otherEnd(corner.incoming, corner.vertex)), origin));
      const second = length(subtract(positionOf(otherEnd(corner.outgoing, corner.vertex)), origin));
      effectiveWidth = Math.min(effectiveWidth, CLAMP_FRACTION * Math.min(first, second));
    }
  }
  const clamped = effectiveWidth < width;

  // Pass 2: points. Original vertices are added lazily so vertices cut away by the bevel disappear.
  const builder = new MeshBuilder(mesh);
  const originalPoint = new Map();
  const pointPositions = new Map();
  const vertexPoint = vertex => {
    if (!originalPoint.has(vertex)) {
      const position = positionOf(vertex);
      const point = builder.addVertex(...position);
      pointPositions.set(point, position);
      originalPoint.set(vertex, point);
    }
    return originalPoint.get(vertex);
  };
  const addPoint = position => {
    const point = builder.addVertex(...position);
    pointPositions.set(point, position);
    return point;
  };
  const slidePoint = new Map();
  for (const [key, need] of slideNeeds) {
    const origin = positionOf(need.vertex);
    const direction = normalize(subtract(positionOf(otherEnd(need.slideEdge, need.vertex)), origin));
    slidePoint.set(key, addPoint(add(origin, scale(direction, effectiveWidth / need.sine))));
  }
  const pointOnEdge = (vertex, edge) => slidePoint.get(`${vertex}|${edge}`) ?? vertexPoint(vertex);
  const sequenceOfLoop = new Map();
  for (const corner of corners) {
    let sequence;
    if (corner.inBeveled && corner.outBeveled) {
      const origin = positionOf(corner.vertex);
      const normal = normalOf(corner.face);
      const previous = positionOf(otherEnd(corner.incoming, corner.vertex));
      const next = positionOf(otherEnd(corner.outgoing, corner.vertex));
      const inwardIn = normalize(cross(normal, subtract(origin, previous)));
      const inwardOut = normalize(cross(normal, subtract(next, origin)));
      const bisector = normalize(add(inwardIn, inwardOut));
      const cosine = Math.max(0.05, dot(bisector, inwardIn));
      sequence = [addPoint(add(origin, scale(bisector, effectiveWidth / cosine)))];
    } else if (corner.inBeveled) {
      sequence = [slidePoint.get(`${corner.vertex}|${corner.outgoing}`)];
    } else if (corner.outBeveled) {
      sequence = [slidePoint.get(`${corner.vertex}|${corner.incoming}`)];
    } else {
      const start = pointOnEdge(corner.vertex, corner.incoming);
      const end = pointOnEdge(corner.vertex, corner.outgoing);
      sequence = start === end ? [start] : [start, end];
    }
    sequenceOfLoop.set(corner.loop, sequence);
  }
  const positionOfPoint = point => pointPositions.get(point);

  // Profile curves between two corner points around an original vertex, shared by the strip and the corner fill.
  const curves = new Map();
  const curve = (vertex, from, to) => {
    const key = `${vertex}|${Math.min(from, to)}|${Math.max(from, to)}`;
    let points = curves.get(key);
    if (!points) {
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const corner = positionOf(vertex);
      const towardStart = subtract(positionOfPoint(low), corner);
      const towardEnd = subtract(positionOfPoint(high), corner);
      points = [low];
      for (let step = 1; step < segments; step++) {
        const [startWeight, endWeight] = profileWeights(profile, step / segments);
        points.push(addPoint(add(add(corner, scale(towardStart, startWeight)), scale(towardEnd, endWeight))));
      }
      points.push(high);
      curves.set(key, points);
    }
    return from === points[0] ? points : [...points].reverse();
  };

  // A quadratic Bezier control whose curve passes through the middle of the profile, for the patch inside a corner.
  const curveControl = (vertex, from, to) => {
    const corner = positionOf(vertex);
    const towardBoth = add(subtract(positionOfPoint(from), corner), subtract(positionOfPoint(to), corner));
    return add(corner, scale(towardBoth, 1.5 - 2 * Math.sqrt(profile)));
  };

  // A vertex with one beveled edge and three faces needs no fill: the profile lies in the third face, so that face
  // takes the curve's points, and the two slide points stay on its boundary.
  const endsInThirdFace = new Set();
  const cornersOfVertex = new Map();
  for (const corner of corners) {
    if (!cornersOfVertex.has(corner.vertex)) cornersOfVertex.set(corner.vertex, []);
    cornersOfVertex.get(corner.vertex).push(corner);
  }
  for (const [vertex, around] of cornersOfVertex) {
    const third = around.filter(corner => !corner.inBeveled && !corner.outBeveled);
    if (around.length !== 3 || third.length !== 1) continue;
    const [start, end] = sequenceOfLoop.get(third[0].loop);
    if (end === undefined) continue;
    sequenceOfLoop.set(third[0].loop, curve(vertex, start, end));
    endsInThirdFace.add(vertex);
  }

  /**
   * Fill a corner where three profile curves meet with a quadratic triangular Bezier patch. Each curve is a
   * quadratic Bezier, so a patch built from the three corner points and the three curve controls reproduces the
   * curves exactly on its border and stays smooth inside. Returns the number of triangles added.
   */
  function fillTriangularCorner(vertex, bridges, reversed) {
    const [first, second, third] = bridges;
    const cornerA = first[0];
    const cornerB = second[0];
    const cornerC = third[0];
    const [positionA, positionB, positionC] = [cornerA, cornerB, cornerC].map(positionOfPoint);
    const controlAB = curveControl(vertex, cornerA, cornerB);
    const controlBC = curveControl(vertex, cornerB, cornerC);
    const controlCA = curveControl(vertex, cornerC, cornerA);
    const grid = new Map();
    const pointAt = (a, b) => {
      const c = segments - a - b;
      const key = `${a},${b}`;
      if (grid.has(key)) return grid.get(key);
      let point;
      if (c === 0) point = first[b];
      else if (a === 0) point = second[c];
      else if (b === 0) point = third[a];
      else {
        const u = a / segments;
        const v = b / segments;
        const w = c / segments;
        let position = scale(positionA, u * u);
        position = add(position, scale(positionB, v * v));
        position = add(position, scale(positionC, w * w));
        position = add(position, scale(controlAB, 2 * u * v));
        position = add(position, scale(controlBC, 2 * v * w));
        position = add(position, scale(controlCA, 2 * w * u));
        point = addPoint(position);
      }
      grid.set(key, point);
      return point;
    };
    let triangles = 0;
    const emit = vertices => {
      builder.addFace(reversed ? [...vertices].reverse() : vertices, { keepTags: false, tags: [`${name}.corner`] });
      triangles++;
    };
    for (let a = 0; a < segments; a++) {
      for (let b = 0; a + b < segments; b++) {
        emit([pointAt(a, b), pointAt(a + 1, b), pointAt(a, b + 1)]);
        if (a + b < segments - 1) emit([pointAt(a + 1, b), pointAt(a + 1, b + 1), pointAt(a, b + 1)]);
      }
    }
    return triangles;
  }

  // Faces: every original face with its corners replaced by their sequences.
  for (let face = 0; face < mesh.faceCount; face++) {
    const vertices = [];
    const sourceCorners = [];
    edit.faceLoops(face).forEach((loop, index) => {
      for (const point of sequenceOfLoop.get(loop)) {
        if (vertices.length && vertices.at(-1) === point) continue;
        vertices.push(point);
        sourceCorners.push(mesh.faceOffsets[face] + index);
      }
    });
    while (vertices.length > 1 && vertices[0] === vertices.at(-1)) {
      vertices.pop();
      sourceCorners.pop();
    }
    if (vertices.length >= 3) builder.addFace(vertices, { sourceFace: face, sourceCorners });
  }
  // Strips along each beveled edge.
  let stripFaces = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!beveled[edge]) continue;
    const [first, second] = edit.edgeLoops(edge);
    const start = loops.vertex[first];
    const end = loops.vertex[loops.next[first]];
    // In the first face the edge runs start -> end; its corner points there are the sequence ends next to the edge.
    const firstAtStart = sequenceOfLoop.get(first).at(-1);
    const firstAtEnd = sequenceOfLoop.get(loops.next[first])[0];
    const secondAtEnd = sequenceOfLoop.get(second).at(-1);
    const secondAtStart = sequenceOfLoop.get(loops.next[second])[0];
    const startCurve = curve(start, firstAtStart, secondAtStart);
    const endCurve = curve(end, firstAtEnd, secondAtEnd);
    for (let step = 0; step < segments; step++) {
      // Where both ends of a strip step share a point (a curve that collapses), the quad becomes a triangle.
      const quad = [endCurve[step], startCurve[step], startCurve[step + 1], endCurve[step + 1]]
        .filter((point, index, list) => point !== list[(index + list.length - 1) % list.length]);
      if (quad.length < 3 || new Set(quad).size !== quad.length) continue;
      builder.addFace(quad, { keepTags: false, tags: [`${name}.strip`] });
      stripFaces++;
    }
  }
  // Corner fills: walk around each vertex touching a beveled edge. Each fill must run against the faces it borders,
  // so its winding is read from the directed edges already built.
  const directedEdges = new Set();
  for (let face = 0; face + 1 < builder.faceOffsets.length; face++) {
    const start = builder.faceOffsets[face];
    const end = builder.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      directedEdges.add(`${builder.cornerVertices[corner]},${builder.cornerVertices[corner + 1 === end ? start : corner + 1]}`);
    }
  }
  let cornerFaces = 0;
  let filledCorners = 0;
  const touched = new Set();
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!beveled[edge]) continue;
    for (const vertex of edit.edgeVertices(edge)) touched.add(vertex);
  }
  for (const vertex of touched) {
    if (endsInThirdFace.has(vertex)) continue;
    const firstSlot = edit.vertices.arrays.edgeSlot[vertex];
    const anyEdge = firstSlot >> 1;
    const startLoop = edit.edgeLoops(anyEdge).map(loop => loops.vertex[loop] === vertex ? loop : loops.next[loop])[0];
    const ring = [];
    const bridges = [];
    let singlePointFaces = true;
    let loop = startLoop;
    let guard = 0;
    let open = false;
    do {
      const sequence = sequenceOfLoop.get(loop);
      if (sequence.length !== 1) singlePointFaces = false;
      for (const point of sequence) ring.push(point);
      const outgoing = loops.edge[loop];
      const across = loops.radialNext[loop];
      if (across === loop) {
        // An open edge at this vertex: the faces do not close around it, so there is no single hole to fill.
        open = true;
        break;
      }
      const nextLoop = loops.next[across];
      if (beveled[outgoing]) {
        const bridge = curve(vertex, sequence.at(-1), sequenceOfLoop.get(nextLoop)[0]);
        bridges.push(bridge);
        for (const point of bridge.slice(1, -1)) ring.push(point);
      }
      loop = nextLoop;
      guard++;
    } while (loop !== startLoop && guard < 1024);
    if (open) continue;
    const polygon = ring.filter((point, index) => point !== ring[(index + ring.length - 1) % ring.length]);
    if (polygon.length < 3 || new Set(polygon).size !== polygon.length) continue;
    let sameDirection = 0;
    let oppositeDirection = 0;
    for (let index = 0; index < polygon.length; index++) {
      const from = polygon[index];
      const to = polygon[(index + 1) % polygon.length];
      if (directedEdges.has(`${from},${to}`)) sameDirection++;
      if (directedEdges.has(`${to},${from}`)) oppositeDirection++;
    }
    if (sameDirection > oppositeDirection) polygon.reverse();
    filledCorners++;
    if (segments > 1 && singlePointFaces && bridges.length === 3 && polygon.length === 3 * segments) {
      cornerFaces += fillTriangularCorner(vertex, bridges, sameDirection > oppositeDirection);
      continue;
    }
    if (segments === 1) {
      // A chamfer corner is flat: one polygon.
      builder.addFace(polygon, { keepTags: false, tags: [`${name}.corner`] });
      cornerFaces++;
      continue;
    }
    // A rounded corner is curved: fan triangles to a centre raised toward the original vertex by the same amount as
    // the apex of each profile curve, so the fill continues the strips instead of cutting a flat facet.
    let centroid = [0, 0, 0];
    for (const point of polygon) centroid = add(centroid, positionOfPoint(point));
    centroid = scale(centroid, 1 / polygon.length);
    const centre = addPoint(add(centroid, scale(subtract(positionOf(vertex), centroid), 2 * Math.sqrt(profile) - 1)));
    for (let index = 0; index < polygon.length; index++) {
      builder.addFace([polygon[index], polygon[(index + 1) % polygon.length], centre], { keepTags: false, tags: [`${name}.corner`] });
      cornerFaces++;
    }
  }
  return { mesh: builder.build(), width: effectiveWidth, clamped, bevelEdges: bevelCount, stripFaces, cornerFaces, filledCorners };
}
