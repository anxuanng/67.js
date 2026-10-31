import { prepareStrokes, applyStroke } from './sculpt-strokes.js';
import { vertexNormals } from './mesh-normals.js';
import { selectedVertices, withPositions } from './mesh-field-edits.js';
import { MAX_SCULPT_STROKES, MAX_SCULPT_VISITS } from './mesh-operations.js';

// The sculpt mesh edit: brush strokes (inflate, displace, smooth) on the vertices of the selected faces. The stroke
// maths is shared with sculptGeometry. Vertices outside the selection stay where they are, so a tag confines a stroke
// to a region; a stroke that crosses the region border leaves a step there, and a smooth stroke still reads its
// neighbours across the border.

/** The vertices as stroke groups: a point, a unit normal and the neighbouring groups (only when a stroke smooths). */
function strokeGroups(mesh, needsNeighbours) {
  const normals = vertexNormals(mesh);
  const groups = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const offset = vertex * 3;
    groups.push({
      point: Array.from(mesh.positions.subarray(offset, offset + 3)),
      normal: Array.from(normals.subarray(offset, offset + 3)),
      neighbors: needsNeighbours ? new Set() : null,
    });
  }
  if (needsNeighbours) {
    for (let edge = 0; edge < mesh.edgeVertices.length; edge += 2) {
      const first = mesh.edgeVertices[edge];
      const second = mesh.edgeVertices[edge + 1];
      groups[first].neighbors.add(second);
      groups[second].neighbors.add(first);
    }
  }
  return groups;
}

/** Refuse an edit whose strokes are too many, or whose vertex visits would run too long, before it starts. */
export function checkSculptBudget(mesh, strokeCount) {
  if (strokeCount > MAX_SCULPT_STROKES) throw new RangeError(`A sculpt edit takes at most ${MAX_SCULPT_STROKES} strokes. Split the work into several sculpt edits.`);
  if (mesh.vertexCount * strokeCount > MAX_SCULPT_VISITS) throw new RangeError('Sculpting would visit too many vertices. Use fewer strokes or a coarser mesh.');
}

/** Apply strokes to the vertices of the faces `select` picks (every face without a rule). */
export function sculptMesh(mesh, { select, strokes }) {
  const prepared = prepareStrokes(strokes);
  const needsNeighbours = prepared.some(stroke => stroke.type === 'smooth');
  const groups = strokeGroups(mesh, needsNeighbours);
  for (const stroke of prepared) applyStroke(groups, stroke);
  const flags = selectedVertices(mesh, select);
  const positions = new Float32Array(mesh.positions);
  let movedVertices = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!flags[vertex]) continue;
    const moved = groups[vertex].point;
    const changed = moved.some((value, axis) => Math.fround(value) !== positions[vertex * 3 + axis]);
    if (changed) movedVertices++;
    positions.set(moved, vertex * 3);
  }
  return { mesh: withPositions(mesh, positions), movedVertices };
}
