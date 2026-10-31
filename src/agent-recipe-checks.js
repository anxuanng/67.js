// Checks shared by the recipe sections that bake geometry (cloth, particles, hair).

export function knownKeys(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) {
      throw new TypeError(`Unknown or unsupported ${label} field: ${key}. Allowed fields: ${fields.join(', ')}.`);
    }
  }
}

export function finiteNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a finite number within ${minimum} and ${maximum}.`);
  }
  return value;
}

export function vectorOfThree(value, label, limit) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} needs 3 numbers.`);
  }
  return value.map(component => finiteNumber(component, label, -limit, limit));
}

export function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be an array of at most ${maximum} entries.`);
  }
  return value;
}

export function rootNodeWithGeometry(nodeId, recipeNodes, claimedNodes, motionNodeIds, physicsNodeIds, label, system = 'cloth') {
  const node = typeof nodeId === 'string' ? recipeNodes.get(nodeId) : undefined;
  if (!node) {
    throw new RangeError(`${label} node was not found: ${String(nodeId).slice(0, 64)}.`);
  }
  if (node.geometry === undefined) {
    throw new RangeError(`${label} node ${nodeId} has no geometry.`);
  }
  if (node.parent !== null) {
    throw new RangeError(`${label} node ${nodeId} must be a root node; reparent it first.`);
  }
  if (claimedNodes.has(nodeId)) {
    throw new RangeError(`Node ${nodeId} is used twice in ${system}.`);
  }
  if (motionNodeIds.has(nodeId) || physicsNodeIds.has(nodeId)) {
    throw new RangeError(`Node ${nodeId} has a motion translation or rotation track or a physics body. ${label} needs a node that stays where it is.`);
  }
  claimedNodes.add(nodeId);
}

const NODES_OF_SECTION = {
  cloth: section => [...section.sheets, ...(section.colliders ?? [])].map(entry => entry.node),
  particles: section => section.systems.map(system => system.node),
};

/**
 * What a baking section needs to check its nodes. Nodes already used by the sections named in `earlierSections`
 * (validated before this one) are claimed, so one node never serves two sections.
 */
export function bakingContext(recipe, earlierSections = []) {
  const claimedNodes = new Set();
  for (const name of earlierSections) {
    if (recipe[name]) {
      NODES_OF_SECTION[name](recipe[name]).forEach(nodeId => claimedNodes.add(nodeId));
    }
  }
  return {
    recipeNodes: new Map(recipe.nodes.map(node => [node.id, node])),
    claimedNodes,
    motionNodeIds: new Set((recipe.motion?.tracks ?? [])
      .filter(track => track.kind === 'node' && (track.property === 'translation' || track.property === 'rotation'))
      .map(track => track.id)),
    physicsNodeIds: new Set((recipe.physics?.bodies ?? []).map(body => body.node)),
  };
}
