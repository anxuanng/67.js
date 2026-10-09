import { mat4 } from 'gl-matrix';

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ZERO_PIVOT = Object.freeze([0, 0, 0]);

function copiedFloats(value, size, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== size) {
    throw new TypeError(`${label} needs ${size} finite Float32 values.`);
  }
  const result = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    if (!Number.isFinite(value[index]) || !Number.isFinite(Math.fround(value[index]))) {
      throw new TypeError(`${label} needs ${size} finite Float32 values.`);
    }
    result[index] = value[index];
  }
  return result;
}

function validMatrix(matrix, name) {
  for (let index = 0; index < 16; index++) {
    if (!Number.isFinite(matrix[index]) || !Number.isFinite(Math.fround(matrix[index]))) {
      throw new RangeError(`Node ${name} matrix must contain finite Float32 values.`);
    }
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new RangeError(`Node ${name} matrix must be affine.`);
  }
  const determinant = mat4.determinant(matrix);
  if (!Number.isFinite(determinant) || determinant === 0) throw new RangeError(`Node ${name} matrix must be nonsingular.`);
}

function limit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function compileOrder(parents, maxDepth) {
  const children = Array.from({ length: parents.length }, () => []);
  const order = [];
  const depths = new Uint32Array(parents.length);
  for (let index = 0; index < parents.length; index++) {
    if (parents[index] < 0) {
      order.push(index);
      depths[index] = 1;
    } else children[parents[index]].push(index);
  }
  for (let cursor = 0; cursor < order.length; cursor++) {
    const parentIndex = order[cursor];
    if (depths[parentIndex] > maxDepth) throw new RangeError('Scene graph exceeds maxDepth.');
    const descendants = children[parentIndex];
    for (let index = 0; index < descendants.length; index++) {
      const childIndex = descendants[index];
      depths[childIndex] = depths[parentIndex] + 1;
      order.push(childIndex);
    }
  }
  if (order.length !== parents.length) throw new RangeError('Scene graph parent references contain a cycle.');
  return order;
}

function materialAlias(node, matrix) {
  return Object.freeze({
    name: node.name,
    geometry: node.geometry,
    matrix,
    get material() {
      return node.material;
    },
    set material(value) {
      node.material = value;
    },
  });
}

/** Defines topology once and retains local, staged and published world matrices. */
export function createSceneGraph(definitions = [], { maxNodes = 4096, maxDepth = 256 } = {}) {
  limit(maxNodes, 'maxNodes');
  limit(maxDepth, 'maxDepth');
  if (!Array.isArray(definitions)) throw new TypeError('Scene graph definitions must be an array.');
  if (definitions.length > maxNodes) throw new RangeError('Scene graph exceeds maxNodes.');
  const namedIndices = new Map();
  const records = definitions.map((definition, index) => {
    if (!definition || typeof definition.name !== 'string' || !definition.name.trim()) throw new TypeError('Scene graph nodes need names.');
    if (namedIndices.has(definition.name)) throw new RangeError(`Duplicate scene graph node name: ${definition.name}`);
    namedIndices.set(definition.name, index);
    const parent = definition.parent ?? null;
    if (parent !== null && (typeof parent !== 'string' || !parent.trim())) throw new TypeError('Node parent must be a name or null.');
    const geometry = definition.geometry;
    const material = definition.material;
    if ((geometry != null) !== (material != null)) throw new TypeError('Mesh nodes need both geometry and material.');
    if (geometry != null && (typeof geometry !== 'object' || typeof material !== 'object')) throw new TypeError('Node geometry and material must be objects.');
    const localMatrix = copiedFloats(definition.matrix ?? IDENTITY, 16, `${definition.name} matrix`);
    validMatrix(localMatrix, definition.name);
    return {
      name: definition.name,
      parent,
      localMatrix,
      worldMatrix: mat4.create(),
      stagedWorld: mat4.create(),
      effectiveLocal: new Float64Array(16),
      pivot: copiedFloats(definition.pivot ?? ZERO_PIVOT, 3, `${definition.name} pivot`),
      geometry,
      material,
    };
  });
  let parents = new Int32Array(records.length);
  for (let index = 0; index < records.length; index++) {
    const parent = records[index].parent;
    if (parent !== null && !namedIndices.has(parent)) throw new RangeError(`Node ${records[index].name} parent was not found: ${parent}`);
    parents[index] = parent === null ? -1 : namedIndices.get(parent);
  }
  let order = compileOrder(parents, maxDepth);
  const parts = [];
  const animationTargets = [];
  const nodes = records.map(record => {
    if (record.geometry != null) parts.push(materialAlias(record, record.worldMatrix));
    animationTargets.push(materialAlias(record, record.localMatrix));
    return Object.freeze({
      name: record.name,
      localMatrix: record.localMatrix,
      worldMatrix: record.worldMatrix,
      pivot: record.pivot,
      geometry: record.geometry,
      get parent() {
        return record.parent;
      },
      get material() {
        return record.material;
      },
      set material(value) {
        record.material = value;
      },
    });
  });

  function evaluate(candidateOrder, candidateParents, overrideIndex = -1, overrideMatrix = null) {
    for (let cursor = 0; cursor < candidateOrder.length; cursor++) {
      const index = candidateOrder[cursor];
      const record = records[index];
      const local = index === overrideIndex ? overrideMatrix : record.localMatrix;
      validMatrix(local, record.name);
      const pivot = record.pivot;
      for (let axis = 0; axis < 3; axis++) {
        if (!Number.isFinite(pivot[axis])) throw new RangeError(`Node ${record.name} pivot must stay finite.`);
      }
      const effective = record.effectiveLocal;
      effective.set(local);
      // Conjugating the local transform rotates and scales about the parent-space pivot.
      for (let axis = 0; axis < 3; axis++) {
        effective[12 + axis] += pivot[axis] - local[axis] * pivot[0] - local[4 + axis] * pivot[1] - local[8 + axis] * pivot[2];
      }
      const parentIndex = candidateParents[index];
      if (parentIndex < 0) record.stagedWorld.set(effective);
      else mat4.multiply(record.stagedWorld, records[parentIndex].stagedWorld, effective);
      validMatrix(record.stagedWorld, record.name);
    }
  }

  function commitWorlds() {
    for (let index = 0; index < records.length; index++) records[index].worldMatrix.set(records[index].stagedWorld);
  }

  function nodeIndex(name) {
    if (!namedIndices.has(name)) throw new RangeError(`Scene graph node was not found: ${name}`);
    return namedIndices.get(name);
  }

  const graph = Object.freeze({
    nodes: Object.freeze(nodes),
    parts: Object.freeze(parts),
    animationTargets: Object.freeze(animationTargets),
    getNode(name) {
      return nodes[nodeIndex(name)];
    },
    update() {
      evaluate(order, parents);
      commitWorlds();
      return parts;
    },
    reparent(name, parent = null, { keepWorld = false } = {}) {
      if (typeof keepWorld !== 'boolean') throw new TypeError('keepWorld must be boolean.');
      const index = nodeIndex(name);
      const parentIndex = parent === null ? -1 : nodeIndex(parent);
      const candidateParents = new Int32Array(parents);
      candidateParents[index] = parentIndex;
      const candidateOrder = compileOrder(candidateParents, maxDepth);
      let candidateLocal = null;
      if (keepWorld) {
        // Fresh staged worlds include caller edits that have not yet been published.
        evaluate(order, parents);
        const desiredLocal = new Float64Array(records[index].stagedWorld);
        if (parentIndex >= 0) {
          const inverseParent = new Float64Array(16);
          if (!mat4.invert(inverseParent, records[parentIndex].stagedWorld)) throw new RangeError('New parent world matrix must be invertible.');
          mat4.multiply(desiredLocal, inverseParent, desiredLocal);
        }
        const pivot = records[index].pivot;
        for (let axis = 0; axis < 3; axis++) {
          desiredLocal[12 + axis] = desiredLocal[12 + axis] - pivot[axis] + desiredLocal[axis] * pivot[0] + desiredLocal[4 + axis] * pivot[1] + desiredLocal[8 + axis] * pivot[2];
        }
        candidateLocal = new Float32Array(desiredLocal);
        validMatrix(candidateLocal, name);
      }
      evaluate(candidateOrder, candidateParents, candidateLocal ? index : -1, candidateLocal);
      if (candidateLocal) records[index].localMatrix.set(candidateLocal);
      records[index].parent = parent;
      parents = candidateParents;
      order = candidateOrder;
      commitWorlds();
      return graph;
    },
  });
  graph.update();
  return graph;
}
