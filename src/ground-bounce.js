import { computeIrradianceCoefficients, createEnvironmentMap, evaluateIrradiance } from './environment.js'

/**
 * Returns a copy of an environment map whose lower half is the light a flat ground sends back up: albedo times the
 * sun and the sky that reach it, over pi. A wall, a figure or a roof then gets ground bounce from the same diffuse
 * and reflection lookups as the sky, at no cost per frame. The ground is taken as unshadowed, level (y up) and
 * infinite, so a scene with a small or mostly shaded floor should give a smaller albedo.
 *
 * `albedo` is the ground's linear colour, `keyColor` and `lightDirection` are the environment's sun (direction
 * towards the sun, any length), as `environment` takes them.
 */
export function withGroundBounce(map, { albedo, keyColor = [0, 0, 0], lightDirection = [0, 1, 0] }) {
  const { width, height, channels, data, intensity } = map
  const sunLength = Math.hypot(...lightDirection)
  const sunOnGround = Math.max(lightDirection[1] / sunLength, 0)
  const skyOnGround = evaluateIrradiance(computeIrradianceCoefficients(map), [0, 1, 0])
  const groundRadiance = albedo.map((channel, index) => {
    const sun = intensity > 0 ? (keyColor[index] * sunOnGround) / (Math.PI * intensity) : 0
    return channel * (sun + skyOnGround[index])
  })
  const bounced = new Float32Array(data)
  for (let row = Math.ceil(height / 2); row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = (row * width + column) * channels
      for (let index = 0; index < 3; index++) bounced[offset + index] = groundRadiance[index]
    }
  }
  return createEnvironmentMap({ ...map, data: bounced })
}
