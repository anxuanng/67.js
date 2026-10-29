import { editMesh } from './mesh-edit.js';
import { MeshBuilder } from './mesh-stack.js';
import { selectEdges, edgeFaces } from './mesh-bevel.js';

// Loop cut, as Blender's: an edge ring is walked across quads (from an edge to the opposite edge of each quad), every
// ring edge is split into cuts + 1 pieces, and each quad of the ring is split into bands between the new points.
// Faces outside the ring that share a split edge get the new points inserted, so no T-junctions remain.

/**
 * Edge rings through the seed edges. Each ring lists its edges with the vertex on the "low" side (consistent across
 * the ring) and the quads it crosses, each with the loop on its entry edge. The low side of a ring is the end of its
 * first seed edge with the lower coordinate along that edge's direction.
 */
function edgeRings(edit, seeds, positionOf) {
  const loops = edit.loops.arrays;
  const ringOfEdge = new Map();
  const ringOfFace = new Map();
  const rings = [];
  const isQuad = face => edit.faces.arrays.size[face] === 4;
  for (const seed of seeds) {
    if (ringOfEdge.has(seed)) continue;
    const [first, second] = edit.edgeVertices(seed);
    const firstPosition = positionOf(first);
    const secondPosition = positionOf(second);
    const direction = [0, 1, 2].map(axis => secondPosition[axis] - firstPosition[axis]);
    const dominant = direction.map(Math.abs).indexOf(Math.max(...direction.map(Math.abs)));
    const lowVertex = direction[dominant] >= 0 ? first : second;
    const ring = { index: rings.length, edges: new Map([[seed, lowVertex]]), quads: [], closed: false };
    ringOfEdge.set(seed, ring.index);
    // Walk out of the seed through each of its faces; a closed ring comes back to the seed.
    for (const startLoop of edit.edgeLoops(seed)) {
      let loop = startLoop;
      let low = lowVertex;
      while (isQuad(loops.face[loop])) {
        const face = loops.face[loop];
        if (ringOfFace.has(face)) {
          if (ringOfFace.get(face) === ring.index) {
            ring.closed = true;
            break;
          }
          throw new RangeError(`Loop cut rings cross at face ${face}. Cut them in separate edits.`);
        }
        ringOfFace.set(face, ring.index);
        ring.quads.push({ face, entryLoop: loop, entryLow: low });
        // In the quad a->b->c->d with the entry loop on a->b, the opposite loop is c->d; d sits across from a.
        const opposite = loops.next[loops.next[loop]];
        const oppositeEdge = loops.edge[opposite];
        const oppositeLow = loops.vertex[loop] === low ? loops.vertex[loops.next[opposite]] : loops.vertex[opposite];
        if (ringOfEdge.has(oppositeEdge) && ringOfEdge.get(oppositeEdge) !== ring.index) {
          throw new RangeError(`Loop cut rings cross at edge ${oppositeEdge}. Cut them in separate edits.`);
        }
        ring.edges.set(oppositeEdge, oppositeLow);
        ringOfEdge.set(oppositeEdge, ring.index);
        const across = loops.radialNext[opposite];
        if (across === opposite || edit.edgeFaceCount(oppositeEdge) !== 2) break;
        loop = across;
        low = oppositeLow;
      }
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Loop-cut the edge rings through the edges an edge rule selects (see selectEdges; `along` picks edges parallel to
 * a direction, which is usually what "cut around" means). cuts: 1 to 16 new loops per ring, evenly spaced; with one
 * cut, factor (0 to 1, default 0.5) places it measured from each ring's low side. Bands between the cuts get the tags
 * `<name>.band-0` (low side) to `<name>.band-<cuts>`; they keep the face's other tags.
 */
export function loopCut(mesh, edgeRule, { cuts = 1, factor = 0.5, name = 'loop' } = {}) {
  const table = edgeFaces(mesh);
  const seeds = [];
  selectEdges(mesh, edgeRule, table).forEach((selected, edge) => {
    if (selected) seeds.push(edge);
  });
  if (!seeds.length) throw new RangeError('The edge rule selects no edges to start a loop cut. Check with mesh_inspect; along [0, 1, 0] picks vertical edges.');
  const edit = editMesh(mesh);
  const loops = edit.loops.arrays;
  const positionOf = vertex => edit.vertexPosition(vertex);
  const rings = edgeRings(edit, seeds, positionOf);
  const fractions = cuts === 1 ? [factor] : Array.from({ length: cuts }, (_, index) => (index + 1) / (cuts + 1));

  const builder = new MeshBuilder(mesh);
  const vertexPoint = new Uint32Array(mesh.vertexCount);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) vertexPoint[vertex] = builder.addVertex(...positionOf(vertex));
  // New points on each split edge, ordered from its low vertex.
  const edgePoints = new Map();
  const lowOfEdge = new Map();
  for (const ring of rings) {
    for (const [edge, low] of ring.edges) {
      const high = edit.edgeOtherVertex(edge, low);
      const start = positionOf(low);
      const end = positionOf(high);
      edgePoints.set(edge, fractions.map(t => builder.addVertex(...[0, 1, 2].map(axis => start[axis] + (end[axis] - start[axis]) * t))));
      lowOfEdge.set(edge, low);
    }
  }
  // Points along a face's edge in the face's own direction, with the fraction of each from the loop's start.
  const pointsAlong = loop => {
    const edge = loops.edge[loop];
    const points = edgePoints.get(edge);
    if (!points) return [];
    const forward = loops.vertex[loop] === lowOfEdge.get(edge);
    return (forward ? points.map((point, index) => ({ point, t: fractions[index] })) : points.map((point, index) => ({ point, t: 1 - fractions[index] })).reverse());
  };
  const cornerIndex = loop => mesh.faceOffsets[loops.face[loop]] + edit.faceLoops(loops.face[loop]).indexOf(loop);

  const quadOfRing = new Map();
  for (const ring of rings) {
    for (const quad of ring.quads) quadOfRing.set(quad.face, quad);
  }
  for (let face = 0; face < mesh.faceCount; face++) {
    const quad = quadOfRing.get(face);
    if (!quad) {
      // Not crossed by a ring: keep the face, inserting points on any split edge.
      const vertices = [];
      const sourceCorners = [];
      for (const loop of edit.faceLoops(face)) {
        const corner = cornerIndex(loop);
        vertices.push(vertexPoint[loops.vertex[loop]]);
        sourceCorners.push(corner);
        const nextCorner = cornerIndex(loops.next[loop]);
        for (const { point, t } of pointsAlong(loop)) {
          vertices.push(point);
          sourceCorners.push({ from: corner, to: nextCorner, t });
        }
      }
      builder.addFace(vertices, { sourceFace: face, sourceCorners });
      continue;
    }
    // Crossed: split into bands between matching points on the entry edge (a->b) and the opposite edge (c->d).
    const entry = quad.entryLoop;
    const sideOne = loops.next[entry];
    const opposite = loops.next[sideOne];
    const sideTwo = loops.next[opposite];
    const along = pointsAlong(entry);
    const back = pointsAlong(opposite).reverse();
    const cornerA = cornerIndex(entry);
    const cornerB = cornerIndex(sideOne);
    const cornerC = cornerIndex(opposite);
    const cornerD = cornerIndex(sideTwo);
    const rail = [{ point: vertexPoint[loops.vertex[entry]], source: cornerA }, ...along.map(({ point, t }) => ({ point, source: { from: cornerA, to: cornerB, t } })), { point: vertexPoint[loops.vertex[sideOne]], source: cornerB }];
    // The opposite edge runs c->d; reversed, its points run d->c, matching the entry rail a->b.
    const otherRail = [{ point: vertexPoint[loops.vertex[sideTwo]], source: cornerD }, ...back.map(({ point, t }) => ({ point, source: { from: cornerC, to: cornerD, t } })), { point: vertexPoint[loops.vertex[opposite]], source: cornerC }];
    const lowAtStart = loops.vertex[entry] === quad.entryLow;
    for (let step = 0; step + 1 < rail.length; step++) {
      const band = lowAtStart ? step : rail.length - 2 - step;
      builder.addFace(
        [rail[step].point, rail[step + 1].point, otherRail[step + 1].point, otherRail[step].point],
        { sourceFace: face, sourceCorners: [rail[step].source, rail[step + 1].source, otherRail[step + 1].source, otherRail[step].source], tags: [`${name}.band-${band}`] },
      );
    }
  }
  return {
    mesh: builder.build(),
    rings: rings.length,
    closedRings: rings.filter(ring => ring.closed).length,
    splitEdges: edgePoints.size,
  };
}
