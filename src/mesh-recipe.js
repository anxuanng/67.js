import { editMesh, meshData } from './mesh-edit.js';
import { countSelected, selectFaces } from './mesh-select.js';
import {
  extrudeFaceRegion, extrudeIndividual, insetRegion, insetIndividual, deleteFaces, flipFaces, translateFaces, mergeByDistance, tagFaces,
  FALLOFF_CURVES,
} from './mesh-ops.js';

// Replayable edit log for agent recipes. Each edit is plain JSON; names follow Blender's bmesh.ops where they match.

export const MAX_MESH_EDITS = 64;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MAX_OFFSET = 1e6;

export const MESH_EDIT_OPERATIONS = Object.freeze({
  extrude_face_region: { fields: ['select', 'name', 'offset', 'direction'], tags: ['cap', 'side'] },
  extrude_individual: { fields: ['select', 'name', 'offset', 'direction'], tags: ['cap', 'side'] },
  inset_region: { fields: ['select', 'name', 'thickness', 'depth'], tags: ['cap', 'rim'] },
  inset_individual: { fields: ['select', 'name', 'thickness', 'depth'], tags: ['cap', 'rim'] },
  delete: { fields: ['select'], tags: [] },
  flip_normals: { fields: ['select'], tags: [] },
  translate: { fields: ['select', 'offset', 'falloff'], tags: [] },
  merge_by_distance: { fields: ['distance'], tags: [] },
  tag: { fields: ['select', 'name'], tags: [] },
});

function editError(index, message) {
  return new TypeError(`Mesh edit ${index} (${message})`);
}

function finiteNumber(value, index, label, { minimum = -MAX_OFFSET, maximum = MAX_OFFSET, exclusiveMinimum = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (exclusiveMinimum && value === minimum)) {
    throw editError(index, `${label} must be a number ${exclusiveMinimum ? 'above' : 'from'} ${minimum}${maximum < MAX_OFFSET ? ` to ${maximum}` : ''}`);
  }
  return value;
}

function vector(value, index, label) {
  if (!Array.isArray(value) || value.length !== 3) throw editError(index, `${label} needs three numbers`);
  return value.map(component => finiteNumber(component, index, label));
}

/** Validate an edit list without running it. Returns normalized copies with default names filled in. */
export function normalizeMeshEdits(edits) {
  if (!Array.isArray(edits)) throw new TypeError('edits must be an array.');
  if (edits.length > MAX_MESH_EDITS) throw new RangeError(`A mesh holds at most ${MAX_MESH_EDITS} edits. Apply fewer or start from a new base.`);
  return edits.map((edit, index) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw editError(index, 'each edit must be an object');
    const definition = MESH_EDIT_OPERATIONS[edit.op];
    if (!definition) throw editError(index, `op must be one of ${Object.keys(MESH_EDIT_OPERATIONS).join(', ')}`);
    for (const key of Object.keys(edit)) {
      if (key !== 'op' && !definition.fields.includes(key)) throw editError(index, `${edit.op} does not take ${key}; fields: ${definition.fields.join(', ')}`);
    }
    const normalized = { op: edit.op };
    if (definition.fields.includes('select')) {
      if (edit.select === undefined && ['delete', 'tag'].includes(edit.op)) throw editError(index, `${edit.op} needs select`);
      normalized.select = edit.select ?? { all: true };
    }
    if (definition.fields.includes('name')) {
      const name = edit.name ?? (edit.op === 'tag' ? undefined : `${edit.op.split('_')[0]}-${index + 1}`);
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw editError(index, 'name must be 1 to 48 letters, digits, dots, dashes or underscores');
      normalized.name = name;
    }
    switch (edit.op) {
      case 'extrude_face_region':
      case 'extrude_individual':
        normalized.offset = finiteNumber(edit.offset, index, 'offset');
        if (edit.direction !== undefined) normalized.direction = vector(edit.direction, index, 'direction');
        break;
      case 'inset_region':
      case 'inset_individual':
        normalized.thickness = finiteNumber(edit.thickness, index, 'thickness', { minimum: 0, exclusiveMinimum: true });
        normalized.depth = edit.depth === undefined ? 0 : finiteNumber(edit.depth, index, 'depth');
        break;
      case 'translate':
        normalized.offset = vector(edit.offset, index, 'offset');
        if (edit.falloff !== undefined) {
          const falloff = edit.falloff;
          if (!falloff || typeof falloff !== 'object') throw editError(index, 'falloff must be { radius, curve, connected }');
          for (const key of Object.keys(falloff)) {
            if (!['radius', 'curve', 'connected'].includes(key)) throw editError(index, `falloff does not take ${key}`);
          }
          const curve = falloff.curve ?? 'smooth';
          if (!Object.hasOwn(FALLOFF_CURVES, curve)) throw editError(index, `falloff curve must be one of ${Object.keys(FALLOFF_CURVES).join(', ')}`);
          if (falloff.connected !== undefined && typeof falloff.connected !== 'boolean') throw editError(index, 'falloff.connected must be boolean');
          normalized.falloff = {
            radius: finiteNumber(falloff.radius, index, 'falloff.radius', { minimum: 0, exclusiveMinimum: true }),
            curve, connected: falloff.connected ?? false,
          };
        }
        break;
      case 'merge_by_distance':
        normalized.distance = finiteNumber(edit.distance ?? 1e-4, index, 'distance', { minimum: 0, maximum: 1e3 });
        break;
    }
    return normalized;
  });
}

function checkBudget(mesh, limits, index, op) {
  if (mesh.vertexCount > limits.maxVertices || mesh.faceCount > limits.maxFaces) {
    throw new RangeError(`Mesh edit ${index} (${op}) grows the mesh to ${mesh.vertexCount} vertices and ${mesh.faceCount} faces, over the limit of ${limits.maxVertices} vertices or ${limits.maxFaces} faces.`);
  }
}

/**
 * Run an edit log on MeshData. Returns the final mesh and one compact result per edit: how many faces it selected,
 * the tags it created (and their face counts) and the mesh size after it.
 * An edit that selects no faces throws, because silently doing nothing hides a wrong selection from the agent.
 */
export function applyMeshEdits(mesh, edits, { maxVertices = 250_000, maxFaces = 250_000 } = {}) {
  const normalized = normalizeMeshEdits(edits);
  const limits = { maxVertices, maxFaces };
  const results = [];
  let current = mesh;
  normalized.forEach((edit, index) => {
    const result = { op: edit.op };
    if (edit.name) result.name = edit.name;
    if (edit.op === 'merge_by_distance') {
      const merged = mergeByDistance(current, edit.distance);
      current = merged.mesh;
      result.removedVertices = merged.removedVertices;
      result.removedFaces = merged.removedFaces;
    } else {
      let mask;
      try {
        mask = selectFaces(current, edit.select);
      } catch (error) {
        throw new error.constructor(`Mesh edit ${index} (${edit.op}): ${error.message}`);
      }
      const selected = countSelected(mask);
      if (selected === 0) throw new RangeError(`Mesh edit ${index} (${edit.op}) selects no faces. Check the rule with mesh_inspect tags and counts.`);
      result.selected = selected;
      const editable = editMesh(current);
      let created = null;
      switch (edit.op) {
        case 'extrude_face_region':
          created = extrudeFaceRegion(editable, mask, edit);
          break;
        case 'extrude_individual':
          created = extrudeIndividual(editable, mask, edit);
          break;
        case 'inset_region':
        case 'inset_individual': {
          const inset = edit.op === 'inset_region' ? insetRegion(editable, mask, edit) : insetIndividual(editable, mask, edit);
          created = { capFaces: inset.capFaces, sideFaces: inset.sideFaces, sideTag: 'rim' };
          break;
        }
        case 'delete':
          result.deletedFaces = deleteFaces(editable, mask).deletedFaces;
          break;
        case 'flip_normals':
          flipFaces(editable, mask);
          break;
        case 'translate':
          result.movedVertices = translateFaces(editable, mask, edit).movedVertices;
          break;
        case 'tag':
          tagFaces(editable, Array.from(mask.keys()).filter(face => mask[face]), edit.name);
          result.tags = { [edit.name]: selected };
          break;
      }
      if (created) {
        const sideTag = `${edit.name}.${created.sideTag ?? 'side'}`;
        tagFaces(editable, created.capFaces, `${edit.name}.cap`);
        tagFaces(editable, created.sideFaces, sideTag);
        result.tags = { [`${edit.name}.cap`]: created.capFaces.length, [sideTag]: created.sideFaces.length };
      }
      current = meshData(editable);
    }
    checkBudget(current, limits, index, edit.op);
    result.after = { vertices: current.vertexCount, faces: current.faceCount };
    results.push(result);
  });
  return { mesh: current, results };
}
