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

// How far the 9 tap filter (taps 2.5 texels apart, plus the bilinear blend) reaches from its centre, in shadow texels.
const FILTER_REACH_TEXELS = 3.5;

/**
 * The depth bias the sun shadow needs per unit of slope (tan of the angle between the surface normal and the sun), in
 * the shadow map's 0 to 1 depth. It is the world distance the depth changes across the filter on a 45 degree slope,
 * `extent * 2 / mapSize * FILTER_REACH_TEXELS`, divided by `far - near`, so the same scene gives the same bias in metres
 * for any depth range. `light` is the result of `resolveShadowLight`.
 */
export function shadowBiasPerSlope(light, mapSize) {
  const texelWorldSize = (light.extent * 2) / mapSize;
  return (texelWorldSize * FILTER_REACH_TEXELS) / (light.far - light.near);
}
