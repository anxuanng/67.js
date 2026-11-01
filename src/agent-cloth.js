import { mat4 } from 'gl-matrix';
import { runKernel } from './kernel-offload.js';
import { bakeCloth, sampleClothFrames, weldVertices } from './cloth.js';
import { recomputeNormals } from './geometry-normals.js';
import { bakingContext, boundedArray, finiteNumber, knownKeys, rootNodeWithGeometry, vectorOfThree } from './agent-recipe-checks.js';

const FRAMES_PER_SECOND = 60;
const MAX_DURATION_SECONDS = 10;
const MAX_SHEETS = 8;
const MAX_COLLIDERS = 16;
const PIN_EDGES = ['top', 'bottom', 'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
const COLLIDER_SHAPES = ['ball', 'box'];
const CLOTH_FIELDS = ['duration', 'gravity', 'wind', 'sheets', 'colliders'];
const SHEET_FIELDS = ['node', 'pin', 'stiffness', 'bend', 'density', 'damping', 'friction', 'thickness'];
const COLLIDER_FIELDS = ['node', 'shape'];
const PIN_TOLERANCE = 1e-4;

function normalizeSheet(input, context) {
  knownKeys(input, SHEET_FIELDS, 'cloth sheet');
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, 'Cloth sheet');
  const sheet = { node: input.node };
  if (input.pin !== undefined) {
    const edges = boundedArray(input.pin, PIN_EDGES.length, 'Cloth pin');
    for (const edge of edges) {
      if (!PIN_EDGES.includes(edge)) {
        throw new RangeError(`Cloth pin must be one of ${PIN_EDGES.join(', ')}.`);
      }
    }
    sheet.pin = [...new Set(edges)];
  }
  const ranges = { stiffness: [0.01, 1], bend: [0, 1], density: [0.01, 10], damping: [0, 100], friction: [0, 1], thickness: [0, 0.5] };
  for (const [field, [minimum, maximum]] of Object.entries(ranges)) {
    if (input[field] !== undefined) sheet[field] = finiteNumber(input[field], `Cloth ${field}`, minimum, maximum);
  }
  return sheet;
}

function normalizeCollider(input, context) {
  knownKeys(input, COLLIDER_FIELDS, 'cloth collider');
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, 'Cloth collider');
  const shape = input.shape ?? 'box';
  if (!COLLIDER_SHAPES.includes(shape)) {
    throw new RangeError(`Cloth collider shape must be one of ${COLLIDER_SHAPES.join(', ')}.`);
  }
  return { node: input.node, shape };
}

/** Validate a recipe cloth section against its nodes. Returns the plain, bounded form stored in the recipe. */
export function normalizeAgentCloth(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, CLOTH_FIELDS, 'cloth');
  const context = bakingContext(recipe);
  const result = { duration: finiteNumber(input.duration, 'Cloth duration', 0.1, MAX_DURATION_SECONDS) };
  result.sheets = boundedArray(input.sheets, MAX_SHEETS, 'Cloth sheets').map(sheet => normalizeSheet(sheet, context));
  if (!result.sheets.length) {
    throw new RangeError('Cloth needs at least one sheet. Use null to clear it.');
  }
  if (input.gravity !== undefined) result.gravity = vectorOfThree(input.gravity, 'Cloth gravity', 1000);
  if (input.wind !== undefined) result.wind = vectorOfThree(input.wind, 'Cloth wind', 100);
  if (input.colliders !== undefined) {
    result.colliders = boundedArray(input.colliders, MAX_COLLIDERS, 'Cloth colliders').map(collider => normalizeCollider(collider, context));
  }
  return result;
}

function localBounds(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return { minimum, maximum };
}

function nodeMatrix(node) {
  return mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
}

function colliderFor(collider, node, geometry) {
  const matrix = nodeMatrix(node);
  const { minimum, maximum } = localBounds(geometry.positions);
  const localCenter = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const halfExtents = minimum.map((value, axis) => Math.max(((maximum[axis] - value) / 2) * Math.abs(node.scale[axis]), 1e-4));
  const center = [
    matrix[0] * localCenter[0] + matrix[4] * localCenter[1] + matrix[8] * localCenter[2] + matrix[12],
    matrix[1] * localCenter[0] + matrix[5] * localCenter[1] + matrix[9] * localCenter[2] + matrix[13],
    matrix[2] * localCenter[0] + matrix[6] * localCenter[1] + matrix[10] * localCenter[2] + matrix[14],
  ];
  if (collider.shape === 'ball') {
    return { kind: 'ball', center, radius: Math.max(...halfExtents) };
  }
  const axes = [0, 1, 2].map(column => {
    const axis = [matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]];
    const length = Math.hypot(...axis);
    return axis.map(component => component / length);
  });
  return { kind: 'box', center, axes, halfExtents };
}

// Particles on the requested edges of the sheet's local bounds, so 'top' is the row of highest local y.
function pinnedParticles(localPositions, representatives, pin) {
  if (!pin?.length) return [];
  const particlePositions = representatives.map(vertex => localPositions.subarray(vertex * 3, vertex * 3 + 3));
  const { minimum, maximum } = localBounds(particlePositions.reduce((all, point) => [...all, ...point], []));
  const tolerance = PIN_TOLERANCE * Math.max(maximum[0] - minimum[0], maximum[1] - minimum[1], 1e-6);
  const at = (point, axis, extreme) => Math.abs(point[axis] - (extreme === 'min' ? minimum[axis] : maximum[axis])) <= tolerance;
  const tests = {
    top: point => at(point, 1, 'max'), bottom: point => at(point, 1, 'min'),
    left: point => at(point, 0, 'min'), right: point => at(point, 0, 'max'),
    topLeft: point => at(point, 1, 'max') && at(point, 0, 'min'), topRight: point => at(point, 1, 'max') && at(point, 0, 'max'),
    bottomLeft: point => at(point, 1, 'min') && at(point, 0, 'min'), bottomRight: point => at(point, 1, 'min') && at(point, 0, 'max'),
  };
  const pinned = [];
  particlePositions.forEach((point, particle) => {
    if (pin.some(edge => tests[edge](point))) pinned.push(particle);
  });
  return pinned;
}

function bakeSheet(sheet, cloth, node, geometry, colliders, frameCount) {
  const welded = weldVertices(geometry.positions, geometry.indices);
  const matrix = nodeMatrix(node);
  const worldPositions = new Float64Array(welded.representatives.length * 3);
  welded.representatives.forEach((vertex, particle) => {
    const source = geometry.positions.subarray(vertex * 3, vertex * 3 + 3);
    const world = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      world[axis] = matrix[axis] * source[0] + matrix[4 + axis] * source[1] + matrix[8 + axis] * source[2] + matrix[12 + axis];
    }
    worldPositions.set(world, particle * 3);
  });
  const recording = Object.freeze({ ...runKernel('cloth', [worldPositions, welded.triangles, {
    pinned: pinnedParticles(geometry.positions, welded.representatives, sheet.pin),
    gravity: cloth.gravity, wind: cloth.wind, stiffness: sheet.stiffness, bend: sheet.bend,
    density: sheet.density, damping: sheet.damping, friction: sheet.friction, thickness: sheet.thickness,
    colliders, frameCount, framesPerSecond: FRAMES_PER_SECOND,
  }], bakeCloth) });
  return { recording, welded, inverse: mat4.invert(mat4.create(), matrix), geometry, particleScratch: new Float32Array(recording.particleCount * 3) };
}

function frozenGeometry(baked, time) {
  const { recording, welded, inverse, geometry, particleScratch } = baked;
  sampleClothFrames(recording, time, particleScratch);
  const positions = new Float32Array(geometry.positions.length);
  for (let vertex = 0; vertex < welded.particleOfVertex.length; vertex++) {
    const source = welded.particleOfVertex[vertex] * 3;
    for (let axis = 0; axis < 3; axis++) {
      positions[vertex * 3 + axis] = inverse[axis] * particleScratch[source] + inverse[4 + axis] * particleScratch[source + 1] + inverse[8 + axis] * particleScratch[source + 2] + inverse[12 + axis];
    }
  }
  const normals = recomputeNormals(geometry, positions);
  return Object.freeze({ ...geometry, positions, normals });
}

function sheetReport(baked, node, sheet) {
  const { recording, welded, geometry } = baked;
  const last = new Float32Array(recording.particleCount * 3);
  sampleClothFrames(recording, Infinity, last);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < last.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], last[index + axis]);
      maximum[axis] = Math.max(maximum[axis], last[index + axis]);
    }
  }
  const round = values => values.map(value => Number(value.toFixed(4)));
  return {
    node: node.id, particles: recording.particleCount, triangles: welded.triangles.length / 3, vertices: geometry.positions.length / 3,
    pinned: pinnedParticles(geometry.positions, welded.representatives, sheet.pin).length,
    finalBoundsMin: round(minimum), finalBoundsMax: round(maximum),
  };
}

/**
 * Bake the cloth section. The result is a pure function of time: `sample(t)` returns the deformed geometry of each
 * sheet node (null at time zero, where the sheet is at rest), and a seek never runs the solver again.
 */
export function bakeAgentCloth(cloth, recipe, geometries) {
  const nodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const frameCount = Math.round(cloth.duration * FRAMES_PER_SECOND) + 1;
  const colliders = (cloth.colliders ?? []).map(collider => colliderFor(collider, nodes.get(collider.node), geometries.get(nodes.get(collider.node).geometry)));
  const baked = new Map(cloth.sheets.map(sheet => {
    const node = nodes.get(sheet.node);
    return [sheet.node, bakeSheet(sheet, cloth, node, geometries.get(node.geometry), colliders, frameCount)];
  }));
  let reportCache = null;
  return Object.freeze({
    duration: cloth.duration,
    sample(time) {
      if (time <= 0) return null;
      const clamped = Math.min(time, cloth.duration);
      return new Map([...baked].map(([nodeId, sheetBake]) => [nodeId, frozenGeometry(sheetBake, clamped)]));
    },
    /** Particle counts and where each sheet ends, as numbers an agent can read without a picture. */
    report() {
      reportCache ??= {
        duration: cloth.duration, frames: frameCount, gravity: cloth.gravity ?? [0, -9.81, 0], wind: cloth.wind ?? [0, 0, 0],
        sheets: cloth.sheets.map(sheet => sheetReport(baked.get(sheet.node), nodes.get(sheet.node), sheet)),
      };
      return structuredClone(reportCache);
    },
  });
}
