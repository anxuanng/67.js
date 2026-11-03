const DEFAULT_SUN_DIRECTION = [-3, 6, 4];
const SHADOW_VIEWS = {
  world: { distance: 75, target: [0, 2, -10], extent: 65, near: 1, far: 220 },
  studio: { distance: 7.2, target: [0, 1, 0], extent: 3.5, near: 0.1, far: 15 },
};

/**
 * The sun's shadow view for whatever `shadowBounds` leaves out. The eye sits on the sun's side of the target, so
 * shadows fall the way the shading says the light travels. A `shadowBounds.eye` still wins.
 */
export function resolveShadowLight(world, lightDirection, shadowBounds = {}) {
  const { distance, ...view } = SHADOW_VIEWS[world ? 'world' : 'studio'];
  const target = shadowBounds.target ?? view.target;
  const requested = lightDirection ?? DEFAULT_SUN_DIRECTION;
  const direction = Math.hypot(requested[0], requested[1], requested[2]) > 1e-6 ? requested : DEFAULT_SUN_DIRECTION;
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const eye = target.map((value, axis) => value + (direction[axis] / length) * distance);
  return { ...view, eye, ...shadowBounds, target };
}
