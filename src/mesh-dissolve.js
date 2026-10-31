import { faceNormals } from './mesh-normals.js';
import {
  facePolygons, buildPolygonMesh, boundaryLoops, edgeFaces, vertexNeighbors, faceOfCorner,
} from './mesh-polygons.js';

// fill_holes and the dissolve family, after Blender's bmesh.ops holes_fill, dissolve_faces, dissolve_edges,
// dissolve_verts and dissolve_limit.

/**
 * Cap each closed boundary loop with one polygon wound to match the surface around it. `sides` skips loops with more
 * edges. The cap copies non-tag face data from a face beside the hole and gets the tag `<name>.fill`.
 */
export function fillHoles(mesh, { sides = Infinity, name = 'fill' } = {}) {
  const polygons = facePolygons(mesh);
  let filled = 0;
  let skipped = 0;
  for (const loop of boundaryLoops(mesh)) {
    if (!loop.closed || loop.vertices.length > sides) {
      skipped++;
      continue;
    }
    polygons.push({
      vertices: [...loop.vertices].reverse(),
      sourceFace: faceOfCorner(mesh, loop.corners[0]),
      sourceCorners: [...loop.corners].reverse(),
      sourceEdges: [...loop.corners].reverse().map(corner => mesh.cornerEdges[corner]),
      keepTags: false,
      tags: [`${name}.fill`],
    });
    filled++;
  }
  if (filled === 0) {
    throw new RangeError(skipped === 0
      ? 'The mesh has no open boundary to fill.'
      : `No boundary loop could be filled: ${skipped} skipped because they are open chains or have more than ${sides} sides.`);
  }
  return { mesh: buildPolygonMesh(mesh, polygons), filled, skipped };
}

function findGroup(parents, face) {
  let root = face;
  while (parents[root] !== root) root = parents[root];
  while (parents[face] !== root) {
    const next = parents[face];
    parents[face] = root;
    face = next;
  }
  return root;
}

/**
 * Merge the faces on both sides of every masked edge into polygons: faces joined through masked edges become one
 * polygon whose outline is their combined boundary. Vertices only the old faces used disappear. Throws when a group's
 * outline is not a single loop (the group would need a hole or touch itself).
 */
function mergeAcrossEdges(mesh, edgeMask, name) {
  const table = edgeFaces(mesh);
  const parents = Array.from({ length: mesh.faceCount }, (_, face) => face);
  const dissolved = new Uint8Array(mesh.edgeCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const faces = table.faces[edge];
    if (!edgeMask[edge] || faces.length !== 2) continue;
    dissolved[edge] = 1;
    parents[findGroup(parents, faces[0])] = findGroup(parents, faces[1]);
  }
  const members = new Map();
  for (let face = 0; face < mesh.faceCount; face++) {
    const root = findGroup(parents, face);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(face);
  }
  const original = facePolygons(mesh);
  const polygons = [];
  let merged = 0;
  for (const faces of members.values()) {
    if (faces.length === 1) {
      polygons.push(original[faces[0]]);
      continue;
    }
    polygons.push(groupOutline(mesh, faces, dissolved, name));
    merged++;
  }
  return { polygons, merged, dissolvedEdges: dissolved.reduce((sum, flag) => sum + flag, 0) };
}

function groupOutline(mesh, faces, dissolved, name) {
  const outgoing = new Map();
  let boundaryCount = 0;
  for (const face of faces) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      if (dissolved[mesh.cornerEdges[corner]]) continue;
      const vertex = mesh.cornerVertices[corner];
      if (outgoing.has(vertex)) throw new RangeError(`Dissolving would pinch a face at vertex ${vertex}. Dissolve fewer edges.`);
      outgoing.set(vertex, corner);
      boundaryCount++;
    }
  }
  const lowestFace = Math.min(...faces);
  const polygon = { vertices: [], sourceFace: lowestFace, sourceCorners: [], sourceEdges: [], tags: [`${name}.merged`] };
  const start = outgoing.values().next().value;
  let corner = start;
  do {
    polygon.vertices.push(mesh.cornerVertices[corner]);
    polygon.sourceCorners.push(corner);
    polygon.sourceEdges.push(mesh.cornerEdges[corner]);
    const face = faceOfCorner(mesh, corner);
    const nextCorner = corner + 1 === mesh.faceOffsets[face + 1] ? mesh.faceOffsets[face] : corner + 1;
    corner = outgoing.get(mesh.cornerVertices[nextCorner]);
  } while (corner !== undefined && corner !== start);
  if (polygon.vertices.length !== boundaryCount) {
    throw new RangeError('Dissolving would leave a face with a hole or a split outline. Dissolve fewer edges.');
  }
  return polygon;
}

/** Merge connected selected faces into one polygon each. */
export function dissolveFaces(mesh, faceMask, { name = 'dissolve' } = {}) {
  const table = edgeFaces(mesh);
  const edgeMask = new Uint8Array(mesh.edgeCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const faces = table.faces[edge];
    edgeMask[edge] = faces.length === 2 && faceMask[faces[0]] && faceMask[faces[1]] ? 1 : 0;
  }
  const outcome = mergeAcrossEdges(mesh, edgeMask, name);
  if (outcome.merged === 0) throw new RangeError('The selection holds no two faces that share an edge, so nothing dissolves.');
  return { mesh: buildPolygonMesh(mesh, outcome.polygons), merged: outcome.merged };
}

/** Merge the two faces beside each selected edge. Boundary edges cannot dissolve and are ignored. */
export function dissolveEdges(mesh, edgeMask, { name = 'dissolve' } = {}) {
  const outcome = mergeAcrossEdges(mesh, edgeMask, name);
  if (outcome.merged === 0) throw new RangeError('The rule selects no edge with a face on each side, so nothing dissolves.');
  return { mesh: buildPolygonMesh(mesh, outcome.polygons), merged: outcome.merged, dissolvedEdges: outcome.dissolvedEdges };
}

function removeVertices(polygons, removable) {
  for (const polygon of polygons) {
    const keep = polygon.vertices.map(vertex => !removable.has(vertex));
    if (keep.every(Boolean)) continue;
    if (keep.filter(Boolean).length < 3) throw new RangeError('Removing the vertices would collapse a face below three corners.');
    for (const field of ['vertices', 'sourceCorners', 'sourceEdges']) {
      polygon[field] = polygon[field].filter((_, index) => keep[index]);
    }
  }
}

/**
 * Remove vertices. A vertex with two edges leaves its faces, which just lose a corner. A vertex with more edges merges
 * every face around it (the edges between them dissolve); one on the open boundary stays as a corner of that face.
 */
export function dissolveVertices(mesh, vertexMask, { name = 'dissolve' } = {}) {
  const neighbors = vertexNeighbors(facePolygons(mesh));
  const edgeMask = new Uint8Array(mesh.edgeCount);
  const straight = new Set();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!vertexMask[vertex]) continue;
    if ((neighbors.get(vertex)?.size ?? 0) === 2) straight.add(vertex);
  }
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    if ((vertexMask[first] && !straight.has(first)) || (vertexMask[second] && !straight.has(second))) edgeMask[edge] = 1;
  }
  const outcome = mergeAcrossEdges(mesh, edgeMask, name);
  removeVertices(outcome.polygons, straight);
  const selected = vertexMask.reduce((sum, flag) => sum + flag, 0);
  if (selected === 0) throw new RangeError('The rule selects no vertices.');
  return { mesh: buildPolygonMesh(mesh, outcome.polygons), merged: outcome.merged, removedStraight: straight.size };
}

function edgeDirection(mesh, from, to) {
  const direction = [0, 1, 2].map(axis => mesh.positions[to * 3 + axis] - mesh.positions[from * 3 + axis]);
  const size = Math.hypot(...direction) || 1;
  return direction.map(value => value / size);
}

/**
 * Dissolve what is flat enough: edges whose two faces bend by at most `angle` degrees (among the edges the mask
 * allows), then vertices left with two edges that run straight within the same angle. Faces keep their tags.
 */
export function dissolveLimited(mesh, edgeMask, { angle = 5, name = 'dissolve' } = {}) {
  const table = edgeFaces(mesh);
  const { normals } = faceNormals(mesh);
  const limit = Math.cos(angle * Math.PI / 180) - 1e-9;
  const flat = new Uint8Array(mesh.edgeCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const faces = table.faces[edge];
    if (!edgeMask[edge] || faces.length !== 2) continue;
    const [first, second] = faces;
    const cosine = [0, 1, 2].reduce((sum, axis) => sum + normals[first * 3 + axis] * normals[second * 3 + axis], 0);
    if (cosine >= limit) flat[edge] = 1;
  }
  const outcome = mergeAcrossEdges(mesh, flat, name);
  const neighbors = vertexNeighbors(outcome.polygons);
  const straight = new Set();
  for (const [vertex, around] of neighbors) {
    if (around.size !== 2 || vertex >= mesh.vertexCount) continue;
    const [first, second] = [...around];
    const incoming = edgeDirection(mesh, first, vertex);
    const outgoing = edgeDirection(mesh, vertex, second);
    const cosine = incoming.reduce((sum, value, axis) => sum + value * outgoing[axis], 0);
    if (cosine >= limit) straight.add(vertex);
  }
  removeStraightWherePossible(outcome.polygons, straight);
  if (outcome.merged === 0 && straight.size === 0) throw new RangeError(`Nothing is within ${angle} degrees of flat among the selected edges.`);
  return { mesh: buildPolygonMesh(mesh, outcome.polygons), merged: outcome.merged, removedStraight: straight.size };
}

// A straight vertex stays when removing it would leave a triangle with two corners.
function removeStraightWherePossible(polygons, straight) {
  const blocked = new Set();
  for (const polygon of polygons) {
    const removing = polygon.vertices.filter(vertex => straight.has(vertex)).length;
    if (polygon.vertices.length - removing < 3) polygon.vertices.forEach(vertex => blocked.add(vertex));
  }
  for (const vertex of blocked) straight.delete(vertex);
  removeVertices(polygons, straight);
}

/** Vertex rules: { "all": true }, { "vertices": [indices] }, { "valence": n } or { "inside": { min, max } }. */
export function selectVertices(mesh, rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).length !== 1) {
    throw new TypeError('Vertex rule takes exactly one of all, vertices, valence, inside.');
  }
  const mask = new Uint8Array(mesh.vertexCount);
  if (rule.all === true) return mask.fill(1);
  if (Array.isArray(rule.vertices)) {
    for (const vertex of rule.vertices) {
      if (!Number.isInteger(vertex) || vertex < 0 || vertex >= mesh.vertexCount) throw new RangeError(`Vertex ${vertex} does not exist.`);
      mask[vertex] = 1;
    }
    return mask;
  }
  if (Number.isInteger(rule.valence)) {
    const neighbors = vertexNeighbors(facePolygons(mesh));
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      mask[vertex] = (neighbors.get(vertex)?.size ?? 0) === rule.valence ? 1 : 0;
    }
    return mask;
  }
  if (rule.inside && Array.isArray(rule.inside.min) && Array.isArray(rule.inside.max)) {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      mask[vertex] = [0, 1, 2].every(axis => {
        const value = mesh.positions[vertex * 3 + axis];
        return value >= rule.inside.min[axis] - 1e-6 && value <= rule.inside.max[axis] + 1e-6;
      }) ? 1 : 0;
    }
    return mask;
  }
  throw new TypeError('Vertex rule takes exactly one of all, vertices (indices), valence (integer), inside ({ min, max }).');
}
