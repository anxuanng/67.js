import { computeIrradianceCoefficients, createEnvironmentMap, evaluateIrradiance } from './environment.js'
import { CLOSED_ROOM_SHARE, closedRoomShare } from './closed-room.js'
import { worldBounds } from './probe-trace.js'

// The ground of a scene is its floor: a part that spans the scene (the same test as the automatic floor of agent scenes),
// is thin and is the lowest geometry. Its albedo comes from its material.
const GROUND_SPAN_SHARE = 0.9
const GROUND_THINNESS = 0.25
const GROUND_LOWEST_TOLERANCE = 1e-3
const GROUND_MAXIMUM_METALLIC = 0.5
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke', 'floor'])

function sceneBoundsOf(boundsList) {
  const minimum = [Infinity, Infinity, Infinity]
  const maximum = [-Infinity, -Infinity, -Infinity]
  for (const bounds of boundsList) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis])
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis])
    }
  }
  return { minimum, maximum }
}

function groundAlbedo(material) {
  const tinted = !material.map && !material.graph && material.alphaMode !== 'blend' && !(material.transmission > 0) && !EXCLUDED_TAGS.has(material.tag)
  if (!tinted || !Array.isArray(material.color) || (material.metallic ?? 0) > GROUND_MAXIMUM_METALLIC) {
    return null
  }
  return material.color.slice(0, 3).map(channel => channel * (1 - (material.metallic ?? 0)))
}

/**
 * The floor of a scene as `{ albedo }`, or null: the lowest, thin part that spans the scene, when it is a plain
 * coloured, non-metal, opaque surface. A textured floor, water and a scene without a floor give null.
 */
export function findGroundSurface(parts) {
  if (parts.length < 2) {
    return null
  }
  const boundsList = parts.map(part => worldBounds(part))
  const scene = sceneBoundsOf(boundsList)
  const widthX = scene.maximum[0] - scene.minimum[0]
  const widthZ = scene.maximum[2] - scene.minimum[2]
  for (const [index, bounds] of boundsList.entries()) {
    const partX = bounds.maximum[0] - bounds.minimum[0]
    const partZ = bounds.maximum[2] - bounds.minimum[2]
    const partHeight = bounds.maximum[1] - bounds.minimum[1]
    const spansScene = partX >= GROUND_SPAN_SHARE * widthX && partZ >= GROUND_SPAN_SHARE * widthZ
    const isThin = partHeight <= GROUND_THINNESS * Math.max(partX, partZ)
    const isLowest = bounds.minimum[1] <= scene.minimum[1] + GROUND_LOWEST_TOLERANCE
    if (spansScene && isThin && isLowest) {
      const albedo = groundAlbedo(parts[index].material)
      return albedo ? { albedo } : null
    }
  }
  return null
}

/**
 * Returns the environment map with an `irradianceSource`: a copy whose lower half is the light a flat ground sends back
 * up, albedo times the sun and the sky that reach it, over pi. Only the diffuse light reads that copy, so a wall, a figure
 * or a roof gets ground bounce at no cost per frame, while the background and the reflections still show the original sky. The ground is taken as unshadowed, level (y up) and
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
  return Object.freeze({ ...map, irradianceSource: createEnvironmentMap({ ...map, data: bounced }) })
}

// The renderer keys its prefiltered copy of a map on the map object, so the same inputs must return the same object.
const cache = new WeakMap()

function isDrawnWithBakedLight(parts) {
  return parts.some(part => part.material?.lightMap)
}

function isClosedRoom(parts) {
  const share = closedRoomShare(parts, new Map(parts.map(part => [part.name, part.matrix])))
  return share !== null && share >= CLOSED_ROOM_SHARE
}

// What the parts say about their ground does not change from frame to frame, and a preview asks every frame, so the
// answer is kept for as long as the same parts array (of the same length) is asked about.
const groundOfParts = new WeakMap()

function groundOf(parts, automaticAlbedo) {
  const key = JSON.stringify([parts.length, automaticAlbedo])
  const remembered = groundOfParts.get(parts)
  if (remembered?.key === key) {
    return remembered.ground
  }
  const found = isDrawnWithBakedLight(parts) ? null : findGroundSurface(parts) ?? (automaticAlbedo && { albedo: automaticAlbedo })
  const ground = found && !isClosedRoom(parts) ? found : null
  groundOfParts.set(parts, { key, ground })
  return ground
}

// The term knows the sun and the sky only. A scene lit by point, spot or area lights has a floor those lights brighten, which
// it would not count, so it would take the sky's own light away from the lower half and darken the scene (measured on
// `light-linking` and `spot-area`).
function hasLocalLights(environment) {
  return [environment.pointLights, environment.spotLights, environment.areaLights].some(lights => lights?.length > 0)
}

/**
 * The environment with the ground's bounce in its map, found from the parts: the same environment when the scene has no
 * plain floor, a baked part (its light map already holds the bounce), a closed room (a bake or the room's own walls
 * give that light), a point, spot or area light, or no map. `automaticAlbedo` is the colour of a floor the preview adds when no part forms one.
 * `environment.groundBounce: false` turns it off.
 */
export function groundBounceEnvironment(parts, environment, { automaticAlbedo = null } = {}) {
  if (!environment.map || environment.groundBounce === false || hasLocalLights(environment)) {
    return environment
  }
  const ground = groundOf(parts, automaticAlbedo)
  if (!ground) {
    return environment
  }
  const { lightDirection } = environment
  const keyColor = environment.keyColor.map(channel => channel * (environment.keyIntensity ?? 1))
  const key = JSON.stringify([ground.albedo, keyColor, lightDirection])
  const byInputs = cache.get(environment.map) ?? new Map()
  cache.set(environment.map, byInputs)
  if (!byInputs.has(key)) {
    byInputs.set(key, withGroundBounce(environment.map, { albedo: ground.albedo, keyColor, lightDirection }))
  }
  return { ...environment, map: byInputs.get(key) }
}
