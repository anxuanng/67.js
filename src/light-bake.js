import { buildTriangleBvh } from './triangle-bvh.js';
import { readTriangle } from './triangle-math.js';
import { createTracer, pointLightFalloff } from './ray-query.js';
import { extractRender } from './mesh-render.js';
import { meshFromGeometry } from './mesh-convert.js';
import { unwrapUv } from './mesh-uv.js';
import { createImage, linearToSrgbByte } from './material-texture-kit.js';

// Light bake: the light that bounces between surfaces, written into one lightmap texture per part. A part draws it
// through its emissive map, so the renderer, its shaders and every scene without a bake stay exactly as they were.
// The bake gathers light that reaches each texel after reflecting off other surfaces (point lights and the sun, shadowed
// by ray tracing). Direct light stays live, so shadows and moving lights keep working. Same input, same bytes.

export const BAKE_LIMITS = Object.freeze({
  maxResolution: { minimum: 4, maximum: 256, fallback: 128 },
  texelsPerUnit: { minimum: 0.5, maximum: 64, fallback: 6 },
  samples: { minimum: 1, maximum: 512, fallback: 128 },
  bounces: { minimum: 1, maximum: 4, fallback: 2 },
  maxSeconds: { minimum: 1, maximum: 600, fallback: 60 },
});
// Total ray work (texels x samples x bounces x rays per hit) a bake may ask for, checked before any ray is traced.
export const MAX_BAKE_RAY_WORK = 400_000_000;
export const MAX_BAKE_TEXELS = 1_000_000;
export const MAX_BAKE_TRIANGLES = 200_000;
export const MAX_BAKE_PARTS = 256;
export const MAX_BAKE_POINT_LIGHTS = 8;
export const MAX_BAKE_SPOT_LIGHTS = 8;
export const MAX_BAKE_AREA_LIGHTS = 4;
// The renderer's own soft edge for a spot light that gives none.
const DEFAULT_SPOT_PENUMBRA = 0.15;

const MAP_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const SURFACE_UTILIZATION_FLOOR = 0.05;
const DILATION_PASSES = 2;
const AVERAGE_GRID = 16;
const LIGHT_MAP_CLAMP_TO_EDGE = 33071;
const LIGHT_MAP_LINEAR = 9729;

function boundedNumber(options, name) {
  const limit = BAKE_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (!Number.isFinite(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Light bake ${name} must be a number from ${limit.minimum} to ${limit.maximum}.`);
  }
  return name === 'samples' || name === 'bounces' || name === 'maxResolution' ? Math.floor(value) : value;
}

/** Validates the bake options and fills in defaults. Throws a RangeError that names the field and its bounds. */
export function normalizeBakeOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Light bake options must be an object.');
  const normalized = {};
  for (const name of Object.keys(BAKE_LIMITS)) normalized[name] = boundedNumber(options, name);
  return normalized;
}

function finiteVector(value, length) {
  return (Array.isArray(value) || ArrayBuffer.isView(value)) && value.length === length && Array.from(value).every(Number.isFinite);
}

function normalizedDirection(direction, label) {
  if (!finiteVector(direction, 3) || Math.hypot(...direction) === 0) throw new RangeError(`${label} needs a finite, nonzero direction.`);
  const length = Math.hypot(...direction);
  return Array.from(direction, component => component / length);
}

function checkedLightList(lights, maximum, name) {
  if (!Array.isArray(lights) || lights.length > maximum) throw new RangeError(`Light bake takes at most ${maximum} ${name}.`);
}

function checkedLightBasics(light, label) {
  if (!finiteVector(light.position, 3) || !finiteVector(light.color ?? [1, 1, 1], 3) || !Number.isFinite(light.intensity) || light.intensity < 0) {
    throw new RangeError(`${label} needs a position, a color and a nonnegative intensity.`);
  }
}

/** Spot lights in the form the path tracer uses: a unit axis, the cosine of the outer half angle and the soft edge width. */
function normalizeSpotLights(spotLights) {
  checkedLightList(spotLights, MAX_BAKE_SPOT_LIGHTS, 'spot lights');
  return spotLights.map((light, index) => {
    const label = `Light bake spot light ${index}`;
    checkedLightBasics(light, label);
    const angle = light.angle ?? Math.PI / 4;
    const penumbra = light.penumbra ?? DEFAULT_SPOT_PENUMBRA;
    const range = light.range ?? 0;
    const radius = light.radius ?? 0.05;
    if (![angle, penumbra, range, radius].every(Number.isFinite) || angle <= 0 || angle >= Math.PI || penumbra < 0 || range < 0 || radius < 0) {
      throw new RangeError(`${label} has an invalid angle, penumbra, range or radius.`);
    }
    const cosineHalfAngle = Math.cos(angle);
    return {
      position: Array.from(light.position), color: Array.from(light.color ?? [1, 1, 1]), intensity: light.intensity, range, radius,
      direction: normalizedDirection(light.direction, label), cosineHalfAngle, blend: (1 - cosineHalfAngle) * penumbra,
    };
  });
}

/** Rectangular area lights: a unit normal and the two unit axes that span the rectangle (width along `across`). */
function normalizeAreaLights(areaLights) {
  checkedLightList(areaLights, MAX_BAKE_AREA_LIGHTS, 'area lights');
  return areaLights.map((light, index) => {
    const label = `Light bake area light ${index}`;
    checkedLightBasics(light, label);
    if (!(light.width >= 0) || !(light.height >= 0) || !Number.isFinite(light.width) || !Number.isFinite(light.height)) {
      throw new RangeError(`${label} needs a finite width and height.`);
    }
    const normal = normalizedDirection(light.direction, label);
    const guide = normalizedDirection(light.up ?? [0, 1, 0], label);
    let across = [guide[1] * normal[2] - guide[2] * normal[1], guide[2] * normal[0] - guide[0] * normal[2], guide[0] * normal[1] - guide[1] * normal[0]];
    const acrossLength = Math.hypot(...across);
    across = acrossLength < 1e-3 ? [1, 0, 0] : across.map(component => component / acrossLength);
    const along = [normal[1] * across[2] - normal[2] * across[1], normal[2] * across[0] - normal[0] * across[2], normal[0] * across[1] - normal[1] * across[0]];
    return { position: Array.from(light.position), color: Array.from(light.color ?? [1, 1, 1]), intensity: light.intensity, width: light.width, height: light.height, normal, across, along };
  });
}

function withAffects(normalizedLights, sourceLights) {
  return normalizedLights.map((light, index) => ({ ...light, affects: sourceLights[index].affects ?? null }));
}

/**
 * Each light gets `reach`, one byte per part: 1 when the light lights that part, or null when it lights every part.
 * A light limited by `affects` adds nothing at a surface of a part it skips, as in the renderer, so a part that a
 * light does not reach is not lit by it even as the bounce of another part.
 */
function withReach(lights, parts) {
  const reachOf = (light) => {
    if (light.affects === null) return null;
    const names = new Set(light.affects);
    return Uint8Array.from(parts, part => (names.has(part.name) ? 1 : 0));
  };
  const linked = light => ({ ...light, reach: reachOf(light) });
  return { pointLights: lights.pointLights.map(linked), spotLights: lights.spotLights.map(linked), areaLights: lights.areaLights.map(linked), sun: lights.sun && linked(lights.sun) };
}

function lightReaches(light, owner) {
  return light.reach === null || light.reach[owner] === 1;
}

function normalizeLights(lighting) {
  if (lighting === null || typeof lighting !== 'object') throw new TypeError('Light bake needs a lighting object.');
  const pointLights = lighting.pointLights ?? [];
  if (!Array.isArray(pointLights) || pointLights.length > MAX_BAKE_POINT_LIGHTS) throw new RangeError(`Light bake takes at most ${MAX_BAKE_POINT_LIGHTS} point lights.`);
  const normalizedPoints = pointLights.map((light, index) => {
    const range = light.range ?? 0;
    const radius = light.radius ?? 0.05;
    if (!finiteVector(light.position, 3) || !finiteVector(light.color ?? [1, 1, 1], 3) || !Number.isFinite(light.intensity) || light.intensity < 0) {
      throw new RangeError(`Light bake point light ${index} needs a position, a color and a nonnegative intensity.`);
    }
    if (!Number.isFinite(range) || range < 0 || !Number.isFinite(radius) || radius < 0) throw new RangeError(`Light bake point light ${index} has an invalid range or radius.`);
    return { position: Array.from(light.position), color: Array.from(light.color ?? [1, 1, 1]), intensity: light.intensity, range, radius };
  });
  const spotSources = lighting.spotLights ?? [];
  const areaSources = lighting.areaLights ?? [];
  const spotLights = withAffects(normalizeSpotLights(spotSources), spotSources);
  const areaLights = withAffects(normalizeAreaLights(areaSources), areaSources);
  const keyColor = lighting.keyColor ?? [0, 0, 0];
  const lightDirection = lighting.lightDirection ?? [0, 1, 0];
  if (!finiteVector(keyColor, 3) || keyColor.some(channel => channel < 0) || !finiteVector(lightDirection, 3)) throw new RangeError('Light bake keyColor and lightDirection must be finite vectors.');
  const directionLength = Math.hypot(...lightDirection);
  const hasSun = keyColor.some(channel => channel > 0) && directionLength > 0;
  const sunDirection = hasSun ? lightDirection.map(component => component / directionLength) : [0, 1, 0];
  return { pointLights: withAffects(normalizedPoints, pointLights), spotLights, areaLights, sun: hasSun ? { color: Array.from(keyColor), direction: sunDirection, affects: lighting.keyAffects ?? null } : null };
}

function validatePart(part, index) {
  const { geometry, matrix } = part ?? {};
  const label = `Light bake part ${index}`;
  if (!geometry || !(geometry.positions instanceof Float32Array) || geometry.positions.length === 0 || geometry.positions.length % 3 !== 0) throw new TypeError(`${label} needs Float32 positions.`);
  if (!(geometry.indices instanceof Uint32Array) || geometry.indices.length === 0 || geometry.indices.length % 3 !== 0) throw new TypeError(`${label} needs Uint32 triangle indices.`);
  if (!finiteVector(matrix, 16)) throw new RangeError(`${label} needs a finite 4x4 matrix.`);
  const vertexCount = geometry.positions.length / 3;
  for (let position = 0; position < geometry.positions.length; position++) {
    if (!Number.isFinite(geometry.positions[position])) throw new RangeError(`${label} has a non-finite position.`);
  }
  for (let slot = 0; slot < geometry.indices.length; slot++) {
    if (geometry.indices[slot] >= vertexCount) throw new RangeError(`${label} has an index past its last vertex.`);
  }
  const color = part.material?.color;
  if (!finiteVector(color, 3)) throw new RangeError(`${label} needs a material color.`);
}

function skipReason(part) {
  const material = part.material;
  if (part.generatesGeometry) {
    const generator = typeof part.generatesGeometry === 'string' ? part.generatesGeometry : 'a hair or particle system';
    return `${generator} rebuilds its geometry every frame, so it has no fixed surface to bake`;
  }
  if (part.skin || part.morph || part.geometry.skinIndices || part.geometry.morphTargets) return 'skinned or morphing parts move, so a fixed lightmap would not follow';
  if ((material.tag ?? 'surface') !== 'surface') return `the ${material.tag} material draws its own look`;
  if (material.opacity !== undefined && material.opacity < 1 || material.alphaMode && material.alphaMode !== 'opaque') return 'it is transparent';
  return null;
}

/**
 * A plain part shows the light through its emissive map on UV channel 0. A part with texture maps, a pattern, layers or
 * its own emission keeps channel 0 and its look, and receives the light through the lightMap slot on a second UV set.
 */
function usesLightMapSlot(material) {
  return MAP_FIELDS.some(field => material[field]) || Boolean(material.pattern || material.layers) || (material.emission ?? 0) > 0;
}

function srgbToLinear(byte) {
  const unit = byte / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** Mean linear colour of a base color map on a fixed grid of samples, or white when the image bytes are not readable. */
function averageMapColor(map) {
  const image = map?.image;
  if (!image?.data || !(image.width > 0) || !(image.height > 0)) return [1, 1, 1];
  const sum = [0, 0, 0];
  for (let row = 0; row < AVERAGE_GRID; row++) {
    for (let column = 0; column < AVERAGE_GRID; column++) {
      const x = Math.floor((column + 0.5) / AVERAGE_GRID * image.width);
      const y = Math.floor((row + 0.5) / AVERAGE_GRID * image.height);
      for (let channel = 0; channel < 3; channel++) sum[channel] += srgbToLinear(image.data[(y * image.width + x) * 4 + channel]);
    }
  }
  return sum.map(total => total / (AVERAGE_GRID * AVERAGE_GRID));
}

function diffuseAlbedo(material) {
  const keep = 1 - (material.metallic ?? 0);
  const mapAverage = averageMapColor(material.map);
  return material.color.map((channel, index) => Math.max(channel, 0) * keep * mapAverage[index]);
}

function emittedRadiance(material) {
  const strength = material.emission ?? 0;
  if (strength <= 0) return [0, 0, 0];
  return (material.emissiveColor ?? material.color).map(channel => channel * strength);
}

/** All parts in world space as one triangle soup: positions, indices, and the part each triangle belongs to. */
function buildWorld(parts) {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const part of parts) {
    vertexTotal += part.geometry.positions.length / 3;
    indexTotal += part.geometry.indices.length;
  }
  if (indexTotal / 3 > MAX_BAKE_TRIANGLES) throw new RangeError(`Light bake takes at most ${MAX_BAKE_TRIANGLES} triangles in total.`);
  const positions = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const triangleOwner = new Uint32Array(indexTotal / 3);
  let vertexOffset = 0;
  let triangleOffset = 0;
  parts.forEach((part, partIndex) => {
    const { matrix } = part;
    const source = part.geometry.positions;
    for (let vertex = 0; vertex < source.length / 3; vertex++) {
      const x = source[vertex * 3];
      const y = source[vertex * 3 + 1];
      const z = source[vertex * 3 + 2];
      const target = (vertexOffset + vertex) * 3;
      positions[target] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      positions[target + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      positions[target + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    for (let slot = 0; slot < part.geometry.indices.length; slot++) indices[triangleOffset * 3 + slot] = part.geometry.indices[slot] + vertexOffset;
    triangleOwner.fill(partIndex, triangleOffset, triangleOffset + part.geometry.indices.length / 3);
    vertexOffset += source.length / 3;
    triangleOffset += part.geometry.indices.length / 3;
  });
  return { positions, indices, triangleOwner, bvh: buildTriangleBvh(positions, indices) };
}

function sceneScale(positions) {
  let largest = 0;
  for (let index = 0; index < positions.length; index++) largest = Math.max(largest, Math.abs(positions[index]));
  return Math.max(largest, 1e-3);
}

/** Integer hash to [0, 1): the only source of randomness, so a bake repeats exactly. */
function hashUnit(first, second, third) {
  let value = Math.imul(first ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(second + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(third + 0x165667b1, 0x27d4eb2f);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967296;
}

function radicalInverse(index) {
  let bits = index;
  let result = 0;
  let scale = 0.5;
  while (bits > 0) {
    if (bits & 1) result += scale;
    bits >>>= 1;
    scale *= 0.5;
  }
  return result;
}

/** A cosine-weighted direction about `normal`, written into `out`. */
function cosineDirection(normal, firstUnit, secondUnit, out) {
  const radius = Math.sqrt(firstUnit);
  const angle = 2 * Math.PI * secondUnit;
  const localX = radius * Math.cos(angle);
  const localY = radius * Math.sin(angle);
  const localZ = Math.sqrt(Math.max(0, 1 - firstUnit));
  const helper = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let tangentX = normal[1] * helper[2] - normal[2] * helper[1];
  let tangentY = normal[2] * helper[0] - normal[0] * helper[2];
  let tangentZ = normal[0] * helper[1] - normal[1] * helper[0];
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  tangentZ /= tangentLength;
  const bitangentX = normal[1] * tangentZ - normal[2] * tangentY;
  const bitangentY = normal[2] * tangentX - normal[0] * tangentZ;
  const bitangentZ = normal[0] * tangentY - normal[1] * tangentX;
  out[0] = tangentX * localX + bitangentX * localY + normal[0] * localZ;
  out[1] = tangentY * localX + bitangentY * localY + normal[1] * localZ;
  out[2] = tangentZ * localX + bitangentZ * localY + normal[2] * localZ;
}

/**
 * Builds the function that returns the irradiance (light power per area, before the albedo and 1/pi of a diffuse
 * surface) of the direct lights at a point, with shadow rays against the world.
 */
function createDirectIrradiance(tracer, lights, offset, scale) {
  const result = [0, 0, 0];
  const shadowReach = scale * 1e6;
  function addLight(point, normal, toLight, distance, power) {
    const cosine = normal[0] * toLight[0] + normal[1] * toLight[1] + normal[2] * toLight[2];
    if (cosine <= 0) return;
    const blocked = tracer.trace(
      point[0] + normal[0] * offset, point[1] + normal[1] * offset, point[2] + normal[2] * offset,
      toLight[0], toLight[1], toLight[2], distance, true,
    ).nearestTriangle >= 0;
    if (blocked) return;
    for (let channel = 0; channel < 3; channel++) result[channel] += power[channel] * cosine;
  }
  const toLight = [0, 0, 0];
  const power = [0, 0, 0];
  // Aims `toLight` at a light's position and returns the distance, or 0 when the point sits on the light.
  function aimAtPosition(point, lightX, lightY, lightZ) {
    const deltaX = lightX - point[0];
    const deltaY = lightY - point[1];
    const deltaZ = lightZ - point[2];
    const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    if (distanceSquared < 1e-12) return { distance: 0, distanceSquared };
    const distance = Math.sqrt(distanceSquared);
    toLight[0] = deltaX / distance;
    toLight[1] = deltaY / distance;
    toLight[2] = deltaZ / distance;
    return { distance, distanceSquared };
  }
  function addSpotLight(point, normal, light) {
    const { distance, distanceSquared } = aimAtPosition(point, light.position[0], light.position[1], light.position[2]);
    if (distance === 0) return;
    const axisCosine = -(light.direction[0] * toLight[0] + light.direction[1] * toLight[1] + light.direction[2] * toLight[2]);
    const inside = axisCosine - light.cosineHalfAngle;
    if (inside <= 0) return;
    const edge = light.blend > 0 && inside < light.blend ? inside / light.blend : 1;
    const mask = edge * edge * (3 - 2 * edge);
    const strength = light.intensity * pointLightFalloff(distanceSquared, light) * mask;
    for (let channel = 0; channel < 3; channel++) power[channel] = light.color[channel] * strength;
    addLight(point, normal, toLight, distance - offset, power);
  }
  // One shadow ray to a point of the rectangle that changes with every call. The sequence depends only on the order of
  // the calls, so a bake repeats exactly and the many paths of a texel average the soft shadow.
  let areaSampleCount = 0;
  function addAreaLight(point, normal, light, lightIndex) {
    areaSampleCount++;
    const across = (hashUnit(areaSampleCount, 17, lightIndex) - 0.5) * light.width;
    const along = (hashUnit(areaSampleCount, 19, lightIndex) - 0.5) * light.height;
    const { distance, distanceSquared } = aimAtPosition(
      point,
      light.position[0] + light.across[0] * across + light.along[0] * along,
      light.position[1] + light.across[1] * across + light.along[1] * along,
      light.position[2] + light.across[2] * across + light.along[2] * along,
    );
    if (distance === 0) return;
    const emitCosine = -(light.normal[0] * toLight[0] + light.normal[1] * toLight[1] + light.normal[2] * toLight[2]);
    if (emitCosine <= 0) return;
    const strength = light.intensity * emitCosine / distanceSquared;
    for (let channel = 0; channel < 3; channel++) power[channel] = light.color[channel] * strength;
    addLight(point, normal, toLight, distance - offset, power);
  }
  return function directIrradiance(point, normal, owner) {
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    for (const light of lights.pointLights) {
      if (!lightReaches(light, owner)) continue;
      const deltaX = light.position[0] - point[0];
      const deltaY = light.position[1] - point[1];
      const deltaZ = light.position[2] - point[2];
      const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      if (distanceSquared < 1e-12) continue;
      const distance = Math.sqrt(distanceSquared);
      toLight[0] = deltaX / distance;
      toLight[1] = deltaY / distance;
      toLight[2] = deltaZ / distance;
      const strength = light.intensity * pointLightFalloff(distanceSquared, light);
      for (let channel = 0; channel < 3; channel++) power[channel] = light.color[channel] * strength;
      addLight(point, normal, toLight, distance - offset, power);
    }
    for (const light of lights.spotLights) {
      if (lightReaches(light, owner)) addSpotLight(point, normal, light);
    }
    for (let index = 0; index < lights.areaLights.length; index++) {
      if (lightReaches(lights.areaLights[index], owner)) addAreaLight(point, normal, lights.areaLights[index], index);
    }
    if (lights.sun && lightReaches(lights.sun, owner)) addLight(point, normal, lights.sun.direction, shadowReach, lights.sun.color);
    return result;
  };
}

function hitNormal(world, triangleId, direction, out) {
  readTriangle(world.positions, world.indices, triangleId, SCRATCH_TRIANGLE);
  const firstX = SCRATCH_TRIANGLE[3] - SCRATCH_TRIANGLE[0];
  const firstY = SCRATCH_TRIANGLE[4] - SCRATCH_TRIANGLE[1];
  const firstZ = SCRATCH_TRIANGLE[5] - SCRATCH_TRIANGLE[2];
  const secondX = SCRATCH_TRIANGLE[6] - SCRATCH_TRIANGLE[0];
  const secondY = SCRATCH_TRIANGLE[7] - SCRATCH_TRIANGLE[1];
  const secondZ = SCRATCH_TRIANGLE[8] - SCRATCH_TRIANGLE[2];
  let normalX = firstY * secondZ - firstZ * secondY;
  let normalY = firstZ * secondX - firstX * secondZ;
  let normalZ = firstX * secondY - firstY * secondX;
  const length = Math.hypot(normalX, normalY, normalZ) || 1;
  normalX /= length;
  normalY /= length;
  normalZ /= length;
  const facing = normalX * direction[0] + normalY * direction[1] + normalZ * direction[2] > 0 ? -1 : 1;
  out[0] = normalX * facing;
  out[1] = normalY * facing;
  out[2] = normalZ * facing;
}
const SCRATCH_TRIANGLE = new Float64Array(9);

/**
 * The mean radiance arriving at one texel from other surfaces: cosine-weighted paths of up to `bounces` reflections,
 * each hit adding its own emission and its direct light. The caller multiplies by the texel's albedo.
 */
function createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples, bounces }) {
  const direction = [0, 0, 0];
  const origin = [0, 0, 0];
  const normal = [0, 0, 0];
  const hitPoint = [0, 0, 0];
  const throughput = [1, 1, 1];
  return function gather(point, surfaceNormal, texelIndex, sum) {
    sum[0] = 0;
    sum[1] = 0;
    sum[2] = 0;
    const rotation = hashUnit(texelIndex, 1, 7);
    for (let sample = 0; sample < samples; sample++) {
      const firstUnit = (sample + 0.5) / samples;
      const secondUnit = (radicalInverse(sample) + rotation) % 1;
      cosineDirection(surfaceNormal, firstUnit, secondUnit, direction);
      origin[0] = point[0] + surfaceNormal[0] * offset;
      origin[1] = point[1] + surfaceNormal[1] * offset;
      origin[2] = point[2] + surfaceNormal[2] * offset;
      throughput[0] = 1;
      throughput[1] = 1;
      throughput[2] = 1;
      for (let bounce = 0; bounce < bounces; bounce++) {
        const hit = tracer.trace(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], Infinity, false);
        if (hit.nearestTriangle < 0) break;
        for (let axis = 0; axis < 3; axis++) hitPoint[axis] = origin[axis] + direction[axis] * hit.nearestDistance;
        hitNormal(world, hit.nearestTriangle, direction, normal);
        const owner = world.triangleOwner[hit.nearestTriangle];
        const albedo = albedoOfPart[owner];
        const emission = emissionOfPart[owner];
        const irradiance = directIrradiance(hitPoint, normal, owner);
        for (let channel = 0; channel < 3; channel++) {
          sum[channel] += throughput[channel] * (emission[channel] + albedo[channel] * irradiance[channel] / Math.PI);
          throughput[channel] *= albedo[channel];
        }
        if (throughput[0] + throughput[1] + throughput[2] < 1e-4) break;
        origin[0] = hitPoint[0] + normal[0] * offset;
        origin[1] = hitPoint[1] + normal[1] * offset;
        origin[2] = hitPoint[2] + normal[2] * offset;
        cosineDirection(normal, hashUnit(texelIndex, sample, bounce * 2 + 11), hashUnit(texelIndex, sample, bounce * 2 + 12), direction);
      }
    }
    for (let channel = 0; channel < 3; channel++) sum[channel] /= samples;
  };
}

function worldTriangleArea(part) {
  const { positions, indices } = part.geometry;
  const { matrix } = part;
  const world = new Float64Array(9);
  let area = 0;
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const source = indices[triangle * 3 + corner] * 3;
      const x = positions[source];
      const y = positions[source + 1];
      const z = positions[source + 2];
      world[corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      world[corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      world[corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    const firstX = world[3] - world[0];
    const firstY = world[4] - world[1];
    const firstZ = world[5] - world[2];
    const secondX = world[6] - world[0];
    const secondY = world[7] - world[1];
    const secondZ = world[8] - world[2];
    area += Math.hypot(firstY * secondZ - firstZ * secondY, firstZ * secondX - firstX * secondZ, firstX * secondY - firstY * secondX) / 2;
  }
  return area;
}

/** Gives a geometry its lightmap UVs in channel 0, from the unwrap that `uv_unwrap` uses. */
function unwrapForLightmap(geometry) {
  const { positions, normals, indices } = geometry;
  const mesh = meshFromGeometry({ positions, normals, indices }, { quads: false, tags: 'none' });
  const unwrapped = unwrapUv(mesh);
  const { geometry: unwrappedGeometry } = extractRender(unwrapped.mesh);
  return { geometry: unwrappedGeometry, utilization: Math.max(unwrapped.utilization, SURFACE_UTILIZATION_FLOOR) };
}

/**
 * Gives a geometry lightmap UVs in `lightUvs` and keeps its own `uvs` and `colors`. The unwrap splits vertices along its
 * seams, so each source vertex index rides through it as a corner colour and the attributes are gathered back from it.
 */
function unwrapIntoSecondUvSet(geometry) {
  const { positions, normals, indices } = geometry;
  const vertexCount = positions.length / 3;
  const sourceIndices = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) sourceIndices[vertex * 3] = vertex;
  const mesh = meshFromGeometry({ positions, normals, indices, colors: sourceIndices }, { quads: false, tags: 'none' });
  const unwrapped = unwrapUv(mesh);
  const { geometry: extracted } = extractRender(unwrapped.mesh);
  const newCount = extracted.positions.length / 3;
  const result = { positions: extracted.positions, normals: extracted.normals, indices: extracted.indices, lightUvs: extracted.uvs };
  const uvs = geometry.uvs ? new Float32Array(newCount * 2) : null;
  const colors = geometry.colors ? new Float32Array(newCount * 3) : null;
  for (let vertex = 0; vertex < newCount; vertex++) {
    const source = Math.round(extracted.colors[vertex * 3]);
    if (uvs) {
      uvs[vertex * 2] = geometry.uvs[source * 2];
      uvs[vertex * 2 + 1] = geometry.uvs[source * 2 + 1];
    }
    if (colors) {
      for (let channel = 0; channel < 3; channel++) colors[vertex * 3 + channel] = geometry.colors[source * 3 + channel];
    }
  }
  if (uvs) result.uvs = uvs;
  if (colors) result.colors = colors;
  return { geometry: result, utilization: Math.max(unwrapped.utilization, SURFACE_UTILIZATION_FLOOR) };
}

function lightmapResolution(area, utilization, options) {
  const wanted = Math.sqrt(area / utilization) * options.texelsPerUnit;
  const rounded = Math.ceil(wanted / 4) * 4;
  return Math.min(Math.max(rounded, BAKE_LIMITS.maxResolution.minimum), options.maxResolution);
}

/** The world position and facing of every texel a triangle of the geometry covers, or null where nothing covers it. */
function rasterizeTexels(geometry, matrix, resolution) {
  const texelCount = resolution * resolution;
  const positions = new Float64Array(texelCount * 3);
  const normals = new Float64Array(texelCount * 3);
  const covered = new Uint8Array(texelCount);
  const { positions: vertexPositions, normals: vertexNormals, indices } = geometry;
  const uvs = geometry.lightUvs ?? geometry.uvs;
  const worldCorner = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const corners = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
    for (let corner = 0; corner < 3; corner++) {
      const x = vertexPositions[corners[corner] * 3];
      const y = vertexPositions[corners[corner] * 3 + 1];
      const z = vertexPositions[corners[corner] * 3 + 2];
      worldCorner[corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      worldCorner[corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      worldCorner[corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    const faceNormal = worldFaceNormal(worldCorner, vertexNormals, corners[0], matrix);
    const texels = corners.map(corner => [uvs[corner * 2] * resolution, uvs[corner * 2 + 1] * resolution]);
    const [firstTexel, secondTexel, thirdTexel] = texels;
    const determinant = (secondTexel[1] - thirdTexel[1]) * (firstTexel[0] - thirdTexel[0]) + (thirdTexel[0] - secondTexel[0]) * (firstTexel[1] - thirdTexel[1]);
    if (Math.abs(determinant) < 1e-12) continue;
    const minimumColumn = Math.max(Math.floor(Math.min(firstTexel[0], secondTexel[0], thirdTexel[0])), 0);
    const maximumColumn = Math.min(Math.ceil(Math.max(firstTexel[0], secondTexel[0], thirdTexel[0])), resolution - 1);
    const minimumRow = Math.max(Math.floor(Math.min(firstTexel[1], secondTexel[1], thirdTexel[1])), 0);
    const maximumRow = Math.min(Math.ceil(Math.max(firstTexel[1], secondTexel[1], thirdTexel[1])), resolution - 1);
    for (let row = minimumRow; row <= maximumRow; row++) {
      for (let column = minimumColumn; column <= maximumColumn; column++) {
        const index = row * resolution + column;
        if (covered[index]) continue;
        const centerX = column + 0.5;
        const centerY = row + 0.5;
        const firstWeight = ((secondTexel[1] - thirdTexel[1]) * (centerX - thirdTexel[0]) + (thirdTexel[0] - secondTexel[0]) * (centerY - thirdTexel[1])) / determinant;
        const secondWeight = ((thirdTexel[1] - firstTexel[1]) * (centerX - thirdTexel[0]) + (firstTexel[0] - thirdTexel[0]) * (centerY - thirdTexel[1])) / determinant;
        const thirdWeight = 1 - firstWeight - secondWeight;
        if (firstWeight < -1e-9 || secondWeight < -1e-9 || thirdWeight < -1e-9) continue;
        for (let axis = 0; axis < 3; axis++) {
          positions[index * 3 + axis] = firstWeight * worldCorner[axis] + secondWeight * worldCorner[3 + axis] + thirdWeight * worldCorner[6 + axis];
          normals[index * 3 + axis] = faceNormal[axis];
        }
        covered[index] = 1;
      }
    }
  }
  return { positions, normals, covered };
}

function worldFaceNormal(worldCorner, vertexNormals, firstVertex, matrix) {
  const firstX = worldCorner[3] - worldCorner[0];
  const firstY = worldCorner[4] - worldCorner[1];
  const firstZ = worldCorner[5] - worldCorner[2];
  const secondX = worldCorner[6] - worldCorner[0];
  const secondY = worldCorner[7] - worldCorner[1];
  const secondZ = worldCorner[8] - worldCorner[2];
  const crossX = firstY * secondZ - firstZ * secondY;
  const crossY = firstZ * secondX - firstX * secondZ;
  const crossZ = firstX * secondY - firstY * secondX;
  const length = Math.hypot(crossX, crossY, crossZ) || 1;
  const authored = [vertexNormals[firstVertex * 3], vertexNormals[firstVertex * 3 + 1], vertexNormals[firstVertex * 3 + 2]];
  const transformedX = matrix[0] * authored[0] + matrix[4] * authored[1] + matrix[8] * authored[2];
  const transformedY = matrix[1] * authored[0] + matrix[5] * authored[1] + matrix[9] * authored[2];
  const transformedZ = matrix[2] * authored[0] + matrix[6] * authored[1] + matrix[10] * authored[2];
  const facing = crossX * transformedX + crossY * transformedY + crossZ * transformedZ < 0 ? -1 : 1;
  return [crossX / length * facing, crossY / length * facing, crossZ / length * facing];
}

/** Fills texels outside every chart from covered neighbours, so bilinear sampling at a chart edge reads real light. */
function dilate(radiance, covered, resolution) {
  for (let pass = 0; pass < DILATION_PASSES; pass++) {
    const additions = [];
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        if (covered[row * resolution + column]) continue;
        const sum = [0, 0, 0];
        let neighbours = 0;
        for (let rowShift = -1; rowShift <= 1; rowShift++) {
          for (let columnShift = -1; columnShift <= 1; columnShift++) {
            const neighbourRow = row + rowShift;
            const neighbourColumn = column + columnShift;
            if (neighbourRow < 0 || neighbourColumn < 0 || neighbourRow >= resolution || neighbourColumn >= resolution) continue;
            const neighbour = neighbourRow * resolution + neighbourColumn;
            if (!covered[neighbour]) continue;
            for (let channel = 0; channel < 3; channel++) sum[channel] += radiance[neighbour * 3 + channel];
            neighbours++;
          }
        }
        if (neighbours > 0) additions.push([row * resolution + column, sum.map(value => value / neighbours)]);
      }
    }
    for (const [index, value] of additions) {
      radiance.set(value, index * 3);
      covered[index] = 1;
    }
  }
}

function lightmapTexture(radiance, resolution, peak) {
  const bytes = new Uint8ClampedArray(resolution * resolution * 4);
  for (let texel = 0; texel < resolution * resolution; texel++) {
    for (let channel = 0; channel < 3; channel++) bytes[texel * 4 + channel] = linearToSrgbByte(radiance[texel * 3 + channel] / peak);
    bytes[texel * 4 + 3] = 255;
  }
  return { image: createImage(bytes, resolution, resolution), colorSpace: 'srgb', wrapS: LIGHT_MAP_CLAMP_TO_EDGE, wrapT: LIGHT_MAP_CLAMP_TO_EDGE, minFilter: LIGHT_MAP_LINEAR, magFilter: LIGHT_MAP_LINEAR };
}

function bakedPart(part, geometry, texture, peak) {
  return { ...part, geometry, material: { ...part.material, emission: peak, emissiveColor: [1, 1, 1], emissiveMap: texture } };
}

function lightMappedPart(part, geometry, texture, peak) {
  return { ...part, geometry, material: { ...part.material, lightMap: texture, lightMapScale: peak } };
}

/**
 * Bakes bounced light into the parts and returns new parts (the input is not changed) plus a report.
 * lighting: { pointLights: [{ position, color, intensity, radius, range }], keyColor, lightDirection }, the same shapes
 * the renderer takes, plus optional spotLights and areaLights in their renderer shapes.
 * options: maxResolution, texelsPerUnit, samples, bounces, maxSeconds (see BAKE_LIMITS). The time limit throws and
 * never truncates, so a bake that finishes always has the same bytes.
 */
export function bakeLightmaps(parts, lighting, options = {}) {
  const plan = planLightmaps(parts, lighting, options);
  return traceLightmaps(plan, plan.settings);
}

/**
 * Everything a bake decides before the first ray: validated options and lights, the unwrap of each bakeable part and the
 * parts that are skipped. It reads no clock to decide anything, so `estimateBake` of one plan is the same on every
 * machine. Pass the plan and the final settings to `traceLightmaps`.
 */
export function planLightmaps(parts, lighting, options = {}) {
  const settings = normalizeBakeOptions(options);
  const lights = normalizeLights(lighting);
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_BAKE_PARTS) throw new RangeError(`Light bake takes from 1 to ${MAX_BAKE_PARTS} parts.`);
  parts.forEach(validatePart);
  const triangleTotal = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  if (triangleTotal > MAX_BAKE_TRIANGLES) throw new RangeError(`Light bake takes at most ${MAX_BAKE_TRIANGLES} triangles in total.`);
  const started = performance.now();
  const unwrapCache = new Map();
  const secondSetCache = new Map();
  const entries = [];
  const skipped = [];
  parts.forEach((part, index) => {
    const reason = skipReason(part);
    if (reason) {
      skipped.push({ name: part.name, reason });
      return;
    }
    const slot = usesLightMapSlot(part.material);
    const cache = slot ? secondSetCache : unwrapCache;
    if (!cache.has(part.geometry)) cache.set(part.geometry, slot ? unwrapIntoSecondUvSet(part.geometry) : unwrapForLightmap(part.geometry));
    entries.push({ part, index, unwrapped: cache.get(part.geometry), area: worldTriangleArea(part), slot });
  });
  return { parts, lights, settings, started, entries, skipped };
}

/** Texels and ray work of a planned bake at the given settings, with no tracing. Ray work counts one bounce ray plus one shadow ray per light. */
export function estimateBake(plan, { samples, bounces, texelsPerUnit }) {
  const resolutionSettings = { texelsPerUnit, maxResolution: plan.settings.maxResolution };
  const texels = plan.entries.reduce((total, { area, unwrapped }) => {
    const resolution = lightmapResolution(area, unwrapped.utilization, resolutionSettings);
    return total + resolution * resolution;
  }, 0);
  const { lights } = plan;
  const raysPerHit = 1 + lights.pointLights.length + lights.spotLights.length + lights.areaLights.length + (lights.sun ? 1 : 0);
  return { texels, rayWork: texels * samples * bounces * raysPerHit };
}

/** Traces a plan with the given settings (samples, bounces, texelsPerUnit, maxSeconds) and returns the baked parts and the report. */
export function traceLightmaps(plan, tracedSettings) {
  const { parts, lights, started, skipped } = plan;
  const settings = { ...plan.settings, ...tracedSettings };
  const { texels: texelTotal, rayWork } = estimateBake(plan, settings);
  if (texelTotal > MAX_BAKE_TEXELS) throw new RangeError(`Light bake would use ${texelTotal} texels; the limit is ${MAX_BAKE_TEXELS}. Lower maxResolution or texelsPerUnit.`);
  if (rayWork > MAX_BAKE_RAY_WORK) throw new RangeError(`Light bake would trace about ${rayWork} rays; the limit is ${MAX_BAKE_RAY_WORK}. Lower samples, bounces or texelsPerUnit.`);
  const world = buildWorld(parts);
  const scale = sceneScale(world.positions);
  const offset = scale * 1e-4;
  const tracer = createTracer(world);
  const directIrradiance = createDirectIrradiance(tracer, withReach(lights, parts), offset, scale);
  const albedoOfPart = parts.map(part => diffuseAlbedo(part.material));
  const emissionOfPart = parts.map(part => emittedRadiance(part.material));
  const gather = createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples: settings.samples, bounces: settings.bounces });
  const baked = parts.slice();
  const partReports = [];
  const sum = [0, 0, 0];
  for (const { part, index, unwrapped, area, slot } of plan.entries) {
    const resolution = lightmapResolution(area, unwrapped.utilization, settings);
    const { positions, normals, covered } = rasterizeTexels(unwrapped.geometry, part.matrix, resolution);
    const radiance = new Float32Array(resolution * resolution * 3);
    const albedo = albedoOfPart[index];
    const point = [0, 0, 0];
    const normal = [0, 0, 0];
    let peak = 0;
    for (let texel = 0; texel < resolution * resolution; texel++) {
      if (!covered[texel]) continue;
      if (performance.now() - started > settings.maxSeconds * 1000) throw new Error(`Light bake passed maxSeconds (${settings.maxSeconds}).`);
      for (let axis = 0; axis < 3; axis++) {
        point[axis] = positions[texel * 3 + axis];
        normal[axis] = normals[texel * 3 + axis];
      }
      gather(point, normal, index * 1_000_003 + texel, sum);
      for (let channel = 0; channel < 3; channel++) {
        // The lightMap slot stores the light that arrives; the shader multiplies it by the live surface colour.
        radiance[texel * 3 + channel] = slot ? sum[channel] : sum[channel] * albedo[channel];
        peak = Math.max(peak, radiance[texel * 3 + channel]);
      }
    }
    partReports.push({ name: part.name, resolution, peak });
    if (peak <= 0) continue;
    dilate(radiance, covered, resolution);
    const texture = lightmapTexture(radiance, resolution, peak);
    baked[index] = (slot ? lightMappedPart : bakedPart)(part, unwrapped.geometry, texture, peak);
  }
  const report = { parts: partReports, skipped, texels: texelTotal, rayWork, seconds: (performance.now() - started) / 1000 };
  return { parts: baked, report };
}
