import { mat4 } from 'gl-matrix';
import { SPOT_FACE } from './lighting.js';

export const SHADOW_ATLAS_WIDTH = 2048;
export const SHADOW_ATLAS_HEIGHT = 3072;
export const SHADOW_TILE_SIZE = 512;
export const SHADOW_TILES_PER_ROW = SHADOW_ATLAS_WIDTH / SHADOW_TILE_SIZE;
const NEAR_PLANE = 0.05;
// Without a range, a light shadows what is within this distance. Farther surfaces are lit as if nothing blocked them.
const DEFAULT_SHADOW_DISTANCE = 30;
// A cube face is a little wider than 90 degrees, so filtering at the edge of a tile never reads another face.
const FACE_FIELD_OF_VIEW = (92 * Math.PI) / 180;
const SPOT_FIELD_OF_VIEW_MARGIN = (4 * Math.PI) / 180;
const MAXIMUM_SPOT_FIELD_OF_VIEW = (170 * Math.PI) / 180;
// Order matches the face index the fragment shader picks: +X, -X, +Y, -Y, +Z, -Z.
const FACE_DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_UPS = [[0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, 1, 0]];

function spotUp(direction) {
  return Math.abs(direction[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
}

// Writes the view-projection of one atlas tile and returns the angle one shadow texel covers, in radians.
export function writeShadowTile({ light, face }, target) {
  const far = light.range > 0 ? light.range : DEFAULT_SHADOW_DISTANCE;
  const isSpot = face === SPOT_FACE;
  const fieldOfView = isSpot
    ? Math.min(2 * (light.angle ?? Math.PI / 4) + SPOT_FIELD_OF_VIEW_MARGIN, MAXIMUM_SPOT_FIELD_OF_VIEW)
    : FACE_FIELD_OF_VIEW;
  const direction = isSpot ? light.direction : FACE_DIRECTIONS[face];
  const up = isSpot ? spotUp(direction) : FACE_UPS[face];
  const lookTarget = [light.position[0] + direction[0], light.position[1] + direction[1], light.position[2] + direction[2]];
  const view = mat4.lookAt(mat4.create(), light.position, lookTarget, up);
  const projection = mat4.perspective(mat4.create(), fieldOfView, 1, NEAR_PLANE, far);
  mat4.multiply(target, projection, view);
  return 2 * Math.tan(fieldOfView / 2) / SHADOW_TILE_SIZE;
}

export function tileViewport(tileIndex) {
  const column = tileIndex % SHADOW_TILES_PER_ROW;
  const row = Math.floor(tileIndex / SHADOW_TILES_PER_ROW);
  return [column * SHADOW_TILE_SIZE, row * SHADOW_TILE_SIZE, SHADOW_TILE_SIZE, SHADOW_TILE_SIZE];
}
