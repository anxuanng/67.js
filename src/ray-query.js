import { rayBoxDistance, traverseTriangleBvh } from './triangle-bvh.js';
import { intersectRayTriangle, readTriangle } from './triangle-math.js';

/**
 * Ray queries against a triangle world ({ positions, indices, bvh }) with preallocated state: the traversal callbacks
 * are built once, not once per ray. `trace` returns a shared state object, so read it before the next query.
 */
export function createTracer(world) {
  const origin = new Float64Array(3);
  const direction = new Float64Array(3);
  const triangle = new Float64Array(9);
  const state = { nearestDistance: Infinity, nearestTriangle: -1, stopAtAnyHit: false };
  const scoreBounds = (bounds, offset) => rayBoxDistance(origin, direction, bounds, offset);
  const shouldVisit = score => score < state.nearestDistance;
  const visitTriangle = triangleId => {
    readTriangle(world.positions, world.indices, triangleId, triangle);
    const distance = intersectRayTriangle(origin, direction, triangle);
    if (distance < 0 || distance >= state.nearestDistance) return false;
    state.nearestDistance = distance;
    state.nearestTriangle = triangleId;
    return state.stopAtAnyHit;
  };
  function trace(originX, originY, originZ, directionX, directionY, directionZ, limit, stopAtAnyHit) {
    origin[0] = originX;
    origin[1] = originY;
    origin[2] = originZ;
    direction[0] = directionX;
    direction[1] = directionY;
    direction[2] = directionZ;
    state.nearestDistance = limit;
    state.nearestTriangle = -1;
    state.stopAtAnyHit = stopAtAnyHit;
    traverseTriangleBvh(world.bvh, scoreBounds, shouldVisit, visitTriangle);
    return state;
  }
  return { trace };
}

/** Inverse-square falloff of a point or spot light, with the optional smooth range cutoff and a floor at its radius. */
export function pointLightFalloff(distanceSquared, light) {
  let cutoff = 1;
  if (light.range > 0) {
    const ratio = distanceSquared / (light.range * light.range);
    const fade = Math.max(1 - ratio * ratio, 0);
    cutoff = fade * fade;
  }
  return cutoff / Math.max(distanceSquared, light.radius * light.radius);
}
