import { facePolygons, buildPolygonMesh, boundaryLoops, faceOfCorner } from './mesh-polygons.js';

// bridge_edge_loops and grid_fill. Both work on boundary loops: chains of edges that have one face.

const MAX_GRID_VERTICES = 65536;

function position(mesh, extraPositions, vertex) {
  if (vertex >= mesh.vertexCount) return extraPositions[vertex - mesh.vertexCount];
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

const lerp = (first, second, fraction) => first.map((value, axis) => value + (second[axis] - value) * fraction);
const distanceSquared = (first, second) => first.reduce((sum, value, axis) => sum + (value - second[axis]) ** 2, 0);

function newVertex(mesh, extraPositions, point) {
  extraPositions.push(point);
  return mesh.vertexCount + extraPositions.length - 1;
}

function strip(vertices, sourceFace, tag) {
  return { vertices, sourceFace, sourceCorners: vertices.map(() => -1), sourceEdges: vertices.map(() => -1), keepTags: false, tags: [tag] };
}

/** The shift of the second loop against the first that puts matching vertices closest together. */
function bestShift(mesh, first, second) {
  let best = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < first.length; shift++) {
    let cost = 0;
    for (let index = 0; index < first.length; index++) {
      cost += distanceSquared(position(mesh, [], first[index]), position(mesh, [], second[(index + shift) % second.length]));
    }
    if (cost < bestCost - 1e-12) {
      best = shift;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Join two boundary loops with a strip of quads, `segments` quads deep. The loops must have the same number of edges.
 * Closed loops are matched at the rotation that puts vertices closest, then turned by `twist` vertices. The strip faces
 * wind opposite to the faces already on each loop, so the result is a closed surface where both loops were holes.
 * Strip faces get `<name>.bridge`.
 */
export function bridgeEdgeLoops(mesh, edgeMask, { segments = 1, twist = 0, name = 'bridge' } = {}) {
  const loops = boundaryLoops(mesh, edgeMask);
  if (loops.length !== 2) {
    throw new RangeError(`The edge rule selects ${loops.length} boundary loops; bridge needs exactly 2. Use { "open": true } for every hole, or { "open": { "inside": { "min": [x, y, z], "max": [x, y, z] } } } to pick some.`);
  }
  const [first, second] = loops;
  if (first.closed !== second.closed) throw new RangeError('One loop is closed and the other is an open chain; bridge needs two of the same kind.');
  if (first.vertices.length !== second.vertices.length) {
    throw new RangeError(`The loops have ${first.vertices.length} and ${second.vertices.length} edges; bridge needs the same number. Run subdivide_edges on the shorter one first.`);
  }
  const edgeCount = first.vertices.length;
  const closed = first.closed;
  if ((edgeCount + 1) * (segments + 1) > MAX_GRID_VERTICES) throw new RangeError('The bridge would make too many vertices. Lower segments.');
  const near = chainPoints(mesh, first);
  const farReversed = chainPoints(mesh, second).reverse();
  const shift = closed ? (bestShift(mesh, near, farReversed) + (twist % edgeCount) + edgeCount) % edgeCount : 0;
  const far = near.map((_, index) => farReversed[(index + shift) % farReversed.length]);
  const extraPositions = [];
  const rows = [near];
  for (let row = 1; row < segments; row++) {
    rows.push(near.map((vertex, index) => newVertex(
      mesh, extraPositions, lerp(position(mesh, extraPositions, vertex), position(mesh, extraPositions, far[index]), row / segments),
    )));
  }
  rows.push(far);
  const polygons = facePolygons(mesh);
  const sourceFace = faceOfCorner(mesh, first.corners[0]);
  for (let row = 0; row < segments; row++) {
    for (let index = 0; index < edgeCount; index++) {
      const next = (index + 1) % near.length;
      polygons.push(strip([rows[row][next], rows[row][index], rows[row + 1][index], rows[row + 1][next]], sourceFace, `${name}.bridge`));
    }
  }
  return { mesh: buildPolygonMesh(mesh, polygons, extraPositions), loopEdges: edgeCount, strips: segments * edgeCount };
}

function faceNextCorner(mesh, corner) {
  const face = faceOfCorner(mesh, corner);
  return corner + 1 === mesh.faceOffsets[face + 1] ? mesh.faceOffsets[face] : corner + 1;
}

// A closed loop lists each vertex once; an open chain also needs the vertex its last edge ends on.
function chainPoints(mesh, loop) {
  if (loop.closed) return [...loop.vertices];
  const lastCorner = loop.corners[loop.corners.length - 1];
  return [...loop.vertices, mesh.cornerVertices[faceNextCorner(mesh, lastCorner)]];
}

// ----- grid_fill -----

function turnAngle(mesh, previous, vertex, next) {
  const before = position(mesh, [], vertex).map((value, axis) => value - position(mesh, [], previous)[axis]);
  const after = position(mesh, [], next).map((value, axis) => value - position(mesh, [], vertex)[axis]);
  const size = Math.hypot(...before) * Math.hypot(...after) || 1;
  const cosine = before.reduce((sum, value, axis) => sum + value * after[axis], 0) / size;
  return Math.acos(Math.max(-1, Math.min(1, cosine)));
}

/** The split of a loop of even length into sides a, b, a, b that puts the four corners on its sharpest turns. */
function chooseCorners(mesh, vertices) {
  const count = vertices.length;
  let best = null;
  for (let a = 1; a < count / 2; a++) {
    const b = count / 2 - a;
    for (let start = 0; start < count; start++) {
      const corners = [0, a, a + b, 2 * a + b].map(offset => (start + offset) % count);
      const score = corners.reduce((sum, corner) => sum + turnAngle(mesh, vertices[(corner + count - 1) % count], vertices[corner], vertices[(corner + 1) % count]), 0)
        - Math.abs(a - b) * 1e-6;
      if (!best || score > best.score + 1e-9) best = { score, a, b, start };
    }
  }
  return best;
}

function gridPolygons(mesh, loop, name, extraPositions) {
  const vertices = loop.vertices;
  const count = vertices.length;
  const { a, b, start } = chooseCorners(mesh, vertices);
  const at = offset => vertices[(start + offset) % count];
  const grid = Array.from({ length: a + 1 }, () => new Array(b + 1));
  for (let i = 0; i <= a; i++) {
    grid[i][0] = at(i);
    grid[i][b] = at(2 * a + b - i);
  }
  for (let j = 0; j <= b; j++) {
    grid[a][j] = at(a + j);
    grid[0][j] = at(count - j);
  }
  const corner = (i, j) => position(mesh, extraPositions, grid[i][j]);
  for (let i = 1; i < a; i++) {
    for (let j = 1; j < b; j++) {
      const u = i / a;
      const v = j / b;
      const point = [0, 1, 2].map(axis => (1 - v) * corner(i, 0)[axis] + v * corner(i, b)[axis]
        + (1 - u) * corner(0, j)[axis] + u * corner(a, j)[axis]
        - ((1 - u) * (1 - v) * corner(0, 0)[axis] + u * (1 - v) * corner(a, 0)[axis] + (1 - u) * v * corner(0, b)[axis] + u * v * corner(a, b)[axis]));
      grid[i][j] = newVertex(mesh, extraPositions, point);
    }
  }
  const sourceFace = faceOfCorner(mesh, loop.corners[0]);
  const faces = [];
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      faces.push(strip([grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]], sourceFace, `${name}.fill`));
    }
  }
  return faces;
}

/**
 * Fill each closed boundary loop of the selected edges with a grid of quads, which needs an even number of edges
 * (at least 4). The loop is cut into four sides at its sharpest corners, opposite sides holding the same number of
 * edges; inner points come from a Coons patch. Cells get `<name>.fill`.
 */
export function gridFill(mesh, edgeMask, { name = 'grid' } = {}) {
  const loops = boundaryLoops(mesh, edgeMask);
  if (loops.length === 0) throw new RangeError('The edge rule selects no boundary loop. Use { "open": true } to pick the holes.');
  const polygons = facePolygons(mesh);
  const extraPositions = [];
  for (const loop of loops) {
    const count = loop.vertices.length;
    if (!loop.closed) throw new RangeError('A selected boundary chain is open; grid_fill needs closed loops.');
    if (count < 4 || count % 2 !== 0) throw new RangeError(`A loop has ${count} edges; grid_fill needs an even number, at least 4. Subdivide one edge or use fill_holes.`);
    polygons.push(...gridPolygons(mesh, loop, name, extraPositions));
  }
  return { mesh: buildPolygonMesh(mesh, polygons, extraPositions), loops: loops.length };
}
