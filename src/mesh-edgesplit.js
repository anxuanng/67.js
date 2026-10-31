import { facePolygons, buildPolygonMesh } from './mesh-polygons.js';

// subdivide_edges, after bmesh.ops.subdivide_edges with grid fill: every selected edge is split into cuts + 1 equal
// pieces, and the faces beside it follow the split edges:
//   a quad with two opposite edges split   becomes bands (as loop_cut does)
//   a quad with all four edges split       becomes a grid of (cuts + 1) squared quads
//   any other face                         keeps one n-gon with the new points inserted, so nothing is left cracked

function lerp(first, second, fraction) {
  return first.map((value, axis) => value + (second[axis] - value) * fraction);
}

export function edgeSplitSize(mesh, edgeMask, cuts) {
  let splitEdges = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) splitEdges += edgeMask[edge] ? 1 : 0;
  const pieces = cuts + 1;
  return { vertices: mesh.vertexCount + splitEdges * cuts + mesh.faceCount * cuts * cuts, faces: mesh.faceCount * pieces * pieces };
}

export function subdivideEdges(mesh, edgeMask, { cuts = 1, name = 'subdivide' } = {}) {
  const extraPositions = [];
  const base = mesh.vertexCount;
  const vertexPoint = vertex => [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
  const addPoint = point => {
    extraPositions.push(point);
    return base + extraPositions.length - 1;
  };
  const edgePoints = new Map();
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (!edgeMask[edge]) continue;
    const start = vertexPoint(mesh.edgeVertices[edge * 2]);
    const end = vertexPoint(mesh.edgeVertices[edge * 2 + 1]);
    edgePoints.set(edge, Array.from({ length: cuts }, (_, index) => addPoint(lerp(start, end, (index + 1) / (cuts + 1)))));
  }
  const pointPosition = vertex => (vertex >= base ? extraPositions[vertex - base] : vertexPoint(vertex));
  const fractions = Array.from({ length: cuts }, (_, index) => (index + 1) / (cuts + 1));

  // The new points on a polygon's edge after its corner `index`, in the polygon's own direction.
  const pointsAfter = (polygon, index) => {
    const points = edgePoints.get(polygon.sourceEdges[index]);
    if (!points) return [];
    const forward = polygon.vertices[index] === mesh.edgeVertices[polygon.sourceEdges[index] * 2];
    return (forward ? points : [...points].reverse()).map((vertex, step) => ({ vertex, t: fractions[step] }));
  };

  const output = [];
  let splitFaces = 0;
  for (const polygon of facePolygons(mesh)) {
    const size = polygon.vertices.length;
    const splitSides = polygon.vertices.map((_, index) => pointsAfter(polygon, index).length > 0);
    if (!splitSides.some(Boolean)) {
      output.push(polygon);
      continue;
    }
    splitFaces++;
    const pieces = size === 4 ? splitQuad(polygon, splitSides, pointsAfter, pointPosition, addPoint, cuts) : null;
    output.push(...(pieces ?? insertPoints(polygon, pointsAfter)).map(piece => ({ ...piece, tags: [...polygon.tags, `${name}.split`] })));
  }
  return { mesh: buildPolygonMesh(mesh, output, extraPositions), splitEdges: edgePoints.size, splitFaces };
}

function insertPoints(polygon, pointsAfter) {
  const result = { ...polygon, vertices: [], sourceCorners: [], sourceEdges: [] };
  const size = polygon.vertices.length;
  polygon.vertices.forEach((vertex, index) => {
    result.vertices.push(vertex);
    result.sourceCorners.push(polygon.sourceCorners[index]);
    result.sourceEdges.push(polygon.sourceEdges[index]);
    for (const { vertex: point, t } of pointsAfter(polygon, index)) {
      result.vertices.push(point);
      result.sourceCorners.push({ from: polygon.sourceCorners[index], to: polygon.sourceCorners[(index + 1) % size], t });
      result.sourceEdges.push(polygon.sourceEdges[index]);
    }
  });
  return [result];
}

function rotated(polygon, shift) {
  const turn = items => items.map((_, index) => items[(index + shift) % items.length]);
  return { ...polygon, vertices: turn(polygon.vertices), sourceCorners: turn(polygon.sourceCorners), sourceEdges: turn(polygon.sourceEdges) };
}

function splitQuad(polygon, splitSides, pointsAfter, pointPosition, addPoint, cuts) {
  const count = splitSides.filter(Boolean).length;
  const oppositePair = count === 2 && splitSides[0] === splitSides[2];
  if (count !== 4 && !oppositePair) return null;
  // Rotate so a split pair is the first and third sides: a to b, and c to d.
  const quad = count === 4 || splitSides[0] ? polygon : rotated(polygon, 1);
  const [a, b, c, d] = quad.vertices;
  const [cornerA, cornerB, cornerC, cornerD] = quad.sourceCorners;
  const along = side => pointsAfter(quad, side);
  const bottom = [{ vertex: a, source: cornerA }, ...along(0).map(({ vertex, t }) => ({ vertex, source: { from: cornerA, to: cornerB, t } })), { vertex: b, source: cornerB }];
  const top = [{ vertex: d, source: cornerD }, ...along(2).reverse().map(({ vertex, t }) => ({ vertex, source: { from: cornerD, to: cornerC, t: 1 - t } })), { vertex: c, source: cornerC }];
  if (count === 2) return bandFaces(quad, bottom, top);
  return gridFaces(quad, bottom, top, along, pointPosition, addPoint, cuts);
}

function face(quad, vertices, sources) {
  return { ...quad, vertices, sourceCorners: sources, sourceEdges: vertices.map(() => -1) };
}

function bandFaces(quad, bottom, top) {
  const bands = [];
  for (let step = 0; step + 1 < bottom.length; step++) {
    bands.push(face(quad, [bottom[step].vertex, bottom[step + 1].vertex, top[step + 1].vertex, top[step].vertex], [bottom[step].source, bottom[step + 1].source, top[step + 1].source, top[step].source]));
  }
  return bands;
}

function gridFaces(quad, bottom, top, along, pointPosition, addPoint, cuts) {
  const [a, b, c, d] = quad.vertices;
  const [cornerA, cornerB, cornerC, cornerD] = quad.sourceCorners;
  const rows = cuts + 2;
  // Left side runs a to d, right side b to c; sides after corner b and d are walked against their own direction.
  const rightSide = [b, ...along(1).map(({ vertex }) => vertex), c];
  const leftSide = [a, ...along(3).reverse().map(({ vertex }) => vertex), d];
  const grid = Array.from({ length: rows }, () => new Array(rows));
  const sources = Array.from({ length: rows }, () => new Array(rows));
  for (let column = 0; column < rows; column++) {
    grid[column][0] = bottom[column].vertex;
    grid[column][rows - 1] = top[column].vertex;
  }
  for (let row = 0; row < rows; row++) {
    grid[0][row] = leftSide[row];
    grid[rows - 1][row] = rightSide[row];
  }
  const corners = [cornerA, cornerB, cornerC, cornerD];
  for (let column = 0; column < rows; column++) {
    for (let row = 0; row < rows; row++) {
      const s = column / (rows - 1);
      const t = row / (rows - 1);
      const weights = [(1 - s) * (1 - t), s * (1 - t), s * t, (1 - s) * t];
      sources[column][row] = { weights: corners.map((corner, index) => [corner, weights[index]]) };
    }
  }
  const [pa, pb, pc, pd] = [a, b, c, d].map(pointPosition);
  for (let column = 1; column < rows - 1; column++) {
    for (let row = 1; row < rows - 1; row++) {
      const s = column / (rows - 1);
      const t = row / (rows - 1);
      grid[column][row] = addPoint(lerp(lerp(pa, pb, s), lerp(pd, pc, s), t));
    }
  }
  const cells = [];
  for (let column = 0; column + 1 < rows; column++) {
    for (let row = 0; row + 1 < rows; row++) {
      const cell = [[column, row], [column + 1, row], [column + 1, row + 1], [column, row + 1]];
      cells.push(face(quad, cell.map(([x, y]) => grid[x][y]), cell.map(([x, y]) => sources[x][y])));
    }
  }
  return cells;
}
