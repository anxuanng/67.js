import { selectEdges, edgeFaces } from './mesh-bevel.js';
import { selectFaces, countSelected } from './mesh-select.js';
import {
  fillHoles, dissolveFaces, dissolveEdges, dissolveVertices, dissolveLimited, selectVertices,
} from './mesh-dissolve.js';
import { bisectPlane } from './mesh-bisect.js';
import { bridgeEdgeLoops, gridFill } from './mesh-bridge.js';
import { subdivideEdges, edgeSplitSize } from './mesh-edgesplit.js';
import { knifeCut } from './mesh-knife.js';

// The cutting edits as recipe operations: validation of their fields and running them on MeshData. The geometry lives
// in the modules imported above; this file only connects it to the edit log.

export const CUT_OPERATIONS = Object.freeze([
  'fill_holes', 'dissolve_faces', 'dissolve_edges', 'dissolve_verts', 'dissolve_limited',
  'bisect_plane', 'bridge_edge_loops', 'subdivide_edges', 'grid_fill', 'knife_project',
]);

const MAX_PATH_POINTS = 256;
const EDGE_RULE_HINT = 'an edge rule such as { "all": true }, { "angle": 30 }, { "along": [x, y, z] } or { "open": true }';

function ruleObject(value, index, label, hint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Mesh edit ${index} (${label} must be ${hint})`);
  return value;
}

function integerInRange(value, index, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Mesh edit ${index} (${label} must be an integer from ${minimum} to ${maximum})`);
  }
  return value;
}

function booleanField(value, index, label) {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Mesh edit ${index} (${label} must be boolean)`);
  return value ?? false;
}

/** Fill in `normalized` for a cutting edit, throwing a TypeError that names the edit when a field is wrong. */
export function normalizeCutEdit(edit, normalized, index, { finiteNumber, vector }) {
  switch (edit.op) {
    case 'fill_holes':
      if (edit.sides !== undefined) normalized.sides = integerInRange(edit.sides, index, 'sides', 3, 4096);
      break;
    case 'dissolve_faces':
      break;
    case 'dissolve_edges':
    case 'bridge_edge_loops':
    case 'subdivide_edges':
    case 'grid_fill':
      normalized.edges = ruleObject(edit.edges, index, 'edges', EDGE_RULE_HINT);
      break;
    case 'dissolve_verts':
      normalized.verts = ruleObject(edit.verts, index, 'verts', 'a vertex rule: { "all": true }, { "vertices": [indices] }, { "valence": 2 } or { "inside": { "min": [x, y, z], "max": [x, y, z] } }');
      break;
    case 'dissolve_limited':
      normalized.edges = edit.edges === undefined ? { all: true } : ruleObject(edit.edges, index, 'edges', EDGE_RULE_HINT);
      normalized.angle = edit.angle === undefined ? 5 : finiteNumber(edit.angle, index, 'angle', { minimum: 0, maximum: 180 });
      break;
    case 'bisect_plane':
      normalized.point = vector(edit.point, index, 'point');
      normalized.normal = vector(edit.normal, index, 'normal');
      if (normalized.normal.every(component => component === 0)) throw new TypeError(`Mesh edit ${index} (normal cannot be zero)`);
      normalized.distance = edit.distance === undefined ? 1e-4 : finiteNumber(edit.distance, index, 'distance', { minimum: 0, maximum: 1e3 });
      normalized.clearInner = booleanField(edit.clearInner, index, 'clearInner');
      normalized.clearOuter = booleanField(edit.clearOuter, index, 'clearOuter');
      normalized.fill = booleanField(edit.fill, index, 'fill');
      if (normalized.clearInner && normalized.clearOuter) throw new TypeError(`Mesh edit ${index} (clearInner and clearOuter together would remove everything)`);
      break;
    case 'bridge_edge_loops':
      break;
    case 'knife_project':
      if (!Array.isArray(edit.path) || edit.path.length < 2 || edit.path.length > MAX_PATH_POINTS) {
        throw new TypeError(`Mesh edit ${index} (path needs 2 to ${MAX_PATH_POINTS} points [x, y, z] in object space)`);
      }
      normalized.path = edit.path.map(point => vector(point, index, 'path point'));
      normalized.direction = vector(edit.direction, index, 'direction');
      if (normalized.direction.every(component => component === 0)) throw new TypeError(`Mesh edit ${index} (direction cannot be zero)`);
      break;
  }
  if (edit.op === 'bridge_edge_loops') {
    normalized.segments = edit.segments === undefined ? 1 : integerInRange(edit.segments, index, 'segments', 1, 64);
    normalized.twistOffset = edit.twistOffset === undefined ? 0 : integerInRange(edit.twistOffset, index, 'twistOffset', -4096, 4096);
  }
  if (edit.op === 'subdivide_edges') normalized.cuts = edit.cuts === undefined ? 1 : integerInRange(edit.cuts, index, 'cuts', 1, 16);
}

/** Refuse a subdivide_edges that would grow past the limits, before it allocates anything. */
export function checkCutBudget(mesh, edit, limits, index) {
  if (edit.op !== 'subdivide_edges') return;
  const mask = selectEdges(mesh, edit.edges, edgeFaces(mesh));
  const size = edgeSplitSize(mesh, mask, edit.cuts);
  if (size.vertices > limits.maxVertices || size.faces > limits.maxFaces) {
    throw new RangeError(`Mesh edit ${index} (subdivide_edges) would make up to ${size.vertices} vertices and ${size.faces} faces, over the limit of ${limits.maxVertices} vertices and ${limits.maxFaces} faces. Lower cuts or select fewer edges.`);
  }
}

function edgeMaskOf(mesh, rule) {
  return selectEdges(mesh, rule, edgeFaces(mesh));
}

/** Run a cutting edit. Returns { mesh, result } where result holds the counts to report. */
export function runCutEdit(mesh, edit) {
  switch (edit.op) {
    case 'fill_holes': {
      const outcome = fillHoles(mesh, { sides: edit.sides ?? Infinity, name: edit.name });
      return { mesh: outcome.mesh, result: { filled: outcome.filled, skipped: outcome.skipped } };
    }
    case 'dissolve_faces': {
      const mask = selectFaces(mesh, edit.select);
      if (countSelected(mask) === 0) throw new RangeError('The rule selects no faces. Check it with mesh_inspect tags and counts.');
      const outcome = dissolveFaces(mesh, mask, { name: edit.name });
      return { mesh: outcome.mesh, result: { merged: outcome.merged } };
    }
    case 'dissolve_edges': {
      const outcome = dissolveEdges(mesh, edgeMaskOf(mesh, edit.edges), { name: edit.name });
      return { mesh: outcome.mesh, result: { merged: outcome.merged, dissolvedEdges: outcome.dissolvedEdges } };
    }
    case 'dissolve_verts': {
      const outcome = dissolveVertices(mesh, selectVertices(mesh, edit.verts), { name: edit.name });
      return { mesh: outcome.mesh, result: { merged: outcome.merged, removedStraight: outcome.removedStraight } };
    }
    case 'dissolve_limited': {
      const outcome = dissolveLimited(mesh, edgeMaskOf(mesh, edit.edges), { angle: edit.angle, name: edit.name });
      return { mesh: outcome.mesh, result: { merged: outcome.merged, removedStraight: outcome.removedStraight } };
    }
    case 'bisect_plane': {
      const outcome = bisectPlane(mesh, edit);
      return { mesh: outcome.mesh, result: { cutFaces: outcome.cutFaces, capped: outcome.capped, unfilled: outcome.unfilled } };
    }
    case 'bridge_edge_loops': {
      const outcome = bridgeEdgeLoops(mesh, edgeMaskOf(mesh, edit.edges), { segments: edit.segments, twist: edit.twistOffset, name: edit.name });
      return { mesh: outcome.mesh, result: { loopEdges: outcome.loopEdges, strips: outcome.strips } };
    }
    case 'subdivide_edges': {
      const outcome = subdivideEdges(mesh, edgeMaskOf(mesh, edit.edges), { cuts: edit.cuts, name: edit.name });
      return { mesh: outcome.mesh, result: { splitEdges: outcome.splitEdges, splitFaces: outcome.splitFaces } };
    }
    case 'grid_fill': {
      const outcome = gridFill(mesh, edgeMaskOf(mesh, edit.edges), { name: edit.name });
      return { mesh: outcome.mesh, result: { loops: outcome.loops } };
    }
    case 'knife_project': {
      const outcome = knifeCut(mesh, edit);
      return { mesh: outcome.mesh, result: { cutFaces: outcome.cutFaces, newVertices: outcome.newVertices } };
    }
  }
  throw new TypeError(`Not a cutting edit: ${edit.op}`);
}
