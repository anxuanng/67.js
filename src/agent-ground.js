// The automatic floor of agent scenes: a shadow-catching disc under the scene's lowest geometry.
// It is not a recipe node. It is built from the scene's world bounds each time the preview draws, so the exported
// recipe never holds it, and it is left out when a part of the recipe already forms a floor or `environment.ground`
// is false. Callers give it to the renderer as the `ground` option (renderer.js draws and shadows it like any part).
import { mat4 } from 'gl-matrix';

const DISC_SEGMENTS = 48;
// A part is a floor when it spans this share of the scene's width and depth, is thin, and is the lowest geometry.
const FLOOR_SPAN_SHARE = 0.9;
const FLOOR_THINNESS = 0.25;
const FLOOR_LOWEST_TOLERANCE = 1e-3;
// The disc reaches this many scene half-widths past the scene, so its edge stays out of a framed shot.
const DISC_REACH = 6;
const MINIMUM_RADIUS = 2;
const FLOOR_COLOR = [0.6, 0.6, 0.58];

/** World-space axis-aligned bounds of one part, from its positions and matrix. */
function partBounds(part) {
  const { positions } = part.geometry;
  const matrix = part.matrix;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] + matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { minimum, maximum };
}

function sceneBounds(boundsList) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const bounds of boundsList) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis]);
    }
  }
  return { minimum, maximum };
}

function formsFloor(bounds, scene) {
  const widthX = scene.maximum[0] - scene.minimum[0];
  const widthZ = scene.maximum[2] - scene.minimum[2];
  const partX = bounds.maximum[0] - bounds.minimum[0];
  const partZ = bounds.maximum[2] - bounds.minimum[2];
  const partHeight = bounds.maximum[1] - bounds.minimum[1];
  const isWide = partX >= FLOOR_SPAN_SHARE * widthX && partZ >= FLOOR_SPAN_SHARE * widthZ;
  const isThin = partHeight <= FLOOR_THINNESS * Math.max(partX, partZ);
  const isLowest = bounds.minimum[1] <= scene.minimum[1] + FLOOR_LOWEST_TOLERANCE;
  return isWide && isThin && isLowest;
}

/**
 * Where the automatic floor goes: `{ center, radius, height }`, or null when the scene is empty, `environment.ground`
 * is false, or a part already forms a floor. The decision uses bounds only, so it is deterministic.
 */
export function agentGroundPlacement(parts, environment) {
  if (environment.ground === false || parts.length === 0) {
    return null;
  }
  const boundsList = parts.map(partBounds);
  if (!boundsList.every(bounds => bounds.minimum.every(Number.isFinite) && bounds.maximum.every(Number.isFinite))) {
    return null;
  }
  const scene = sceneBounds(boundsList);
  if (boundsList.some(bounds => formsFloor(bounds, scene))) {
    return null;
  }
  const halfWidth = Math.max(scene.maximum[0] - scene.minimum[0], scene.maximum[2] - scene.minimum[2]) / 2;
  return {
    center: [(scene.minimum[0] + scene.maximum[0]) / 2, (scene.minimum[2] + scene.maximum[2]) / 2],
    radius: Math.max(MINIMUM_RADIUS, halfWidth * DISC_REACH),
    height: scene.minimum[1],
  };
}

function discGeometry() {
  const positions = [0, 0, 0];
  for (let segment = 0; segment < DISC_SEGMENTS; segment++) {
    const angle = (segment / DISC_SEGMENTS) * Math.PI * 2;
    positions.push(Math.cos(angle), 0, Math.sin(angle));
  }
  const indices = [];
  for (let segment = 0; segment < DISC_SEGMENTS; segment++) {
    indices.push(0, 1 + ((segment + 1) % DISC_SEGMENTS), 1 + segment);
  }
  const normals = positions.map((_, index) => (index % 3 === 1 ? 1 : 0));
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

/** Moves the floor part to a placement. The part is created once and its matrix is rewritten in place. */
export function placeAgentGround(part, placement) {
  mat4.fromTranslation(part.matrix, [placement.center[0], placement.height, placement.center[1]]);
  mat4.scale(part.matrix, part.matrix, [placement.radius, 1, placement.radius]);
}

/** The floor part for a placement. It is a plain lit surface, so the key light's shadow falls on it. */
export function createAgentGround(placement) {
  const part = {
    name: 'Automatic floor',
    geometry: discGeometry(),
    matrix: mat4.create(),
    material: { color: FLOOR_COLOR, metallic: 0, roughness: 0.9, emission: 0, tag: 'surface' },
  };
  placeAgentGround(part, placement);
  return part;
}
