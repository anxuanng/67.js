import { TAG_PREFIX, meshTags } from './mesh-data.js';
import { faceNormals } from './mesh-normals.js';
import { cornerFaces, edgeCornerTable } from './mesh-topology.js';

// Semantic face selection for agents. A rule is plain JSON; the result is a Uint8Array mask with one byte per face.
//
//   { "all": true }
//   { "tag": "top" }                                   faces carrying a tag (tags double as named selections)
//   { "normal": [0, 1, 0], "maxAngle": 10 }            faces whose normal is within maxAngle degrees of a direction
//   { "inside": { "min": [x, y, z], "max": [x, y, z] } } faces whose centroid lies in a box
//   { "faces": [0, 4, 7] }                             explicit face indices
//   { "and": [rule, ...] }, { "or": [rule, ...] }, { "not": rule }
//   { "grow": rule, "steps": 1 }                       add faces sharing an edge, repeated
//   { "boundary": rule }                               faces of the selection that touch an unselected face or an open edge

export const MAX_RULE_DEPTH = 16;
const MAX_RULE_NODES = 256;
const RULE_KEYS = ['all', 'tag', 'normal', 'inside', 'faces', 'and', 'or', 'not', 'grow', 'boundary'];

function ruleError(message) {
  return new TypeError(`Selection rule: ${message}`);
}

function vector3(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw ruleError(`${label} needs three finite numbers.`);
  return value;
}

function faceCentroids(mesh) {
  const centroids = new Float64Array(mesh.faceCount * 3);
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner++) {
      const vertex = mesh.cornerVertices[corner] * 3;
      centroids[face * 3] += mesh.positions[vertex];
      centroids[face * 3 + 1] += mesh.positions[vertex + 1];
      centroids[face * 3 + 2] += mesh.positions[vertex + 2];
    }
    const size = end - start;
    centroids[face * 3] /= size;
    centroids[face * 3 + 1] /= size;
    centroids[face * 3 + 2] /= size;
  }
  return centroids;
}

/** Faces sharing an edge with each face, as compressed rows (built lazily once per selection call). */
function faceAdjacency(mesh) {
  const table = edgeCornerTable(mesh);
  const facesOfCorners = cornerFaces(mesh);
  const neighbors = Array.from({ length: mesh.faceCount }, () => []);
  const openFaces = new Uint8Array(mesh.faceCount);
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const start = table.edgeOffsets[edge];
    const end = table.edgeOffsets[edge + 1];
    if (end - start === 1) openFaces[facesOfCorners[table.edgeCorners[start]]] = 1;
    for (let first = start; first < end; first++) {
      for (let second = first + 1; second < end; second++) {
        const faceFirst = facesOfCorners[table.edgeCorners[first]];
        const faceSecond = facesOfCorners[table.edgeCorners[second]];
        neighbors[faceFirst].push(faceSecond);
        neighbors[faceSecond].push(faceFirst);
      }
    }
  }
  return { neighbors, openFaces };
}

/**
 * Evaluate a selection rule on a mesh. Throws a TypeError naming the bad part of the rule, and a RangeError for an
 * unknown tag (listing the known ones).
 */
export function selectFaces(mesh, rule) {
  const cache = {};
  let nodes = 0;
  const normals = () => (cache.normals ??= faceNormals(mesh).normals);
  const centroids = () => (cache.centroids ??= faceCentroids(mesh));
  const adjacency = () => (cache.adjacency ??= faceAdjacency(mesh));

  function evaluate(node, depth) {
    nodes++;
    if (nodes > MAX_RULE_NODES) throw ruleError(`more than ${MAX_RULE_NODES} rule nodes.`);
    if (depth > MAX_RULE_DEPTH) throw ruleError(`nesting deeper than ${MAX_RULE_DEPTH}.`);
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw ruleError('each rule must be an object.');
    const keys = Object.keys(node);
    const kind = keys.find(key => RULE_KEYS.includes(key));
    if (!kind) throw ruleError(`use one of ${RULE_KEYS.join(', ')}; got ${keys.join(', ') || 'nothing'}.`);
    const mask = new Uint8Array(mesh.faceCount);
    switch (kind) {
      case 'all':
        if (node.all !== true || keys.length !== 1) throw ruleError('"all" must be true and alone.');
        mask.fill(1);
        return mask;
      case 'tag': {
        if (typeof node.tag !== 'string' || keys.length !== 1) throw ruleError('"tag" needs one tag name.');
        const attribute = mesh.attributes.face[TAG_PREFIX + node.tag];
        if (!attribute) throw new RangeError(`Unknown tag ${node.tag}. Known tags: ${meshTags(mesh).join(', ') || 'none'}.`);
        mask.set(attribute.data);
        return mask;
      }
      case 'normal': {
        const extra = keys.filter(key => key !== 'normal' && key !== 'maxAngle');
        if (extra.length) throw ruleError(`unknown fields ${extra.join(', ')} in a normal rule.`);
        const direction = vector3(node.normal, 'normal');
        const length = Math.hypot(...direction);
        if (length === 0) throw ruleError('normal cannot be zero.');
        const maxAngle = node.maxAngle ?? 10;
        if (!Number.isFinite(maxAngle) || maxAngle < 0 || maxAngle > 180) throw ruleError('maxAngle is degrees from 0 to 180.');
        const limit = Math.cos(maxAngle * Math.PI / 180) - 1e-9;
        const faceNormal = normals();
        for (let face = 0; face < mesh.faceCount; face++) {
          const cosine = (faceNormal[face * 3] * direction[0] + faceNormal[face * 3 + 1] * direction[1] + faceNormal[face * 3 + 2] * direction[2]) / length;
          if (cosine >= limit) mask[face] = 1;
        }
        return mask;
      }
      case 'inside': {
        if (keys.length !== 1 || !node.inside || typeof node.inside !== 'object') throw ruleError('"inside" needs { min, max }.');
        const minimum = vector3(node.inside.min, 'inside.min');
        const maximum = vector3(node.inside.max, 'inside.max');
        const centroid = centroids();
        for (let face = 0; face < mesh.faceCount; face++) {
          let contained = true;
          for (let axis = 0; axis < 3; axis++) {
            const value = centroid[face * 3 + axis];
            if (value < minimum[axis] || value > maximum[axis]) contained = false;
          }
          if (contained) mask[face] = 1;
        }
        return mask;
      }
      case 'faces': {
        if (keys.length !== 1 || !Array.isArray(node.faces) || node.faces.length > mesh.faceCount) throw ruleError('"faces" needs an array of face indices.');
        for (const face of node.faces) {
          if (!Number.isInteger(face) || face < 0 || face >= mesh.faceCount) throw new RangeError(`Face index ${face} is outside 0..${mesh.faceCount - 1}.`);
          mask[face] = 1;
        }
        return mask;
      }
      case 'and':
      case 'or': {
        const children = node[kind];
        if (keys.length !== 1 || !Array.isArray(children) || children.length === 0) throw ruleError(`"${kind}" needs a nonempty array of rules.`);
        if (kind === 'and') mask.fill(1);
        for (const child of children) {
          const childMask = evaluate(child, depth + 1);
          for (let face = 0; face < mesh.faceCount; face++) {
            mask[face] = kind === 'and' ? mask[face] & childMask[face] : mask[face] | childMask[face];
          }
        }
        return mask;
      }
      case 'not': {
        if (keys.length !== 1) throw ruleError('"not" takes one rule.');
        const childMask = evaluate(node.not, depth + 1);
        for (let face = 0; face < mesh.faceCount; face++) mask[face] = childMask[face] ? 0 : 1;
        return mask;
      }
      case 'grow': {
        const extra = keys.filter(key => key !== 'grow' && key !== 'steps');
        if (extra.length) throw ruleError(`unknown fields ${extra.join(', ')} in a grow rule.`);
        const steps = node.steps ?? 1;
        if (!Number.isInteger(steps) || steps < 1 || steps > 64) throw ruleError('grow steps must be an integer from 1 to 64.');
        mask.set(evaluate(node.grow, depth + 1));
        const { neighbors } = adjacency();
        for (let step = 0; step < steps; step++) {
          const previous = mask.slice();
          for (let face = 0; face < mesh.faceCount; face++) {
            if (!previous[face]) continue;
            for (const neighbor of neighbors[face]) mask[neighbor] = 1;
          }
        }
        return mask;
      }
      case 'boundary': {
        if (keys.length !== 1) throw ruleError('"boundary" takes one rule.');
        const inner = evaluate(node.boundary, depth + 1);
        const { neighbors, openFaces } = adjacency();
        for (let face = 0; face < mesh.faceCount; face++) {
          if (!inner[face]) continue;
          if (openFaces[face] || neighbors[face].some(neighbor => !inner[neighbor])) mask[face] = 1;
        }
        return mask;
      }
    }
    throw ruleError(`unsupported rule ${kind}.`);
  }

  return evaluate(rule, 0);
}

export function countSelected(mask) {
  let count = 0;
  for (let index = 0; index < mask.length; index++) count += mask[index];
  return count;
}
