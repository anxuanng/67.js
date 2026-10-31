import { pointLightFalloff } from './ray-query.js';
import { buildTraceScene, SUN_ANGULAR_RADIUS } from './path-tracer-scene.js';
import { denoiseRadiance } from './path-tracer-denoise.js';
import {
  buildFrame, createSurface, environmentPdf, environmentRadiance, evaluateSurface, luminance, mirrorWeight, prepareSurface,
  roughnessToAlpha, sampleEnvironment, sampleGlass, sampleSurface,
} from './path-tracer-shading.js';

// Offline still renderer: unidirectional path tracing on the CPU with next-event estimation for every light, the
// environment map drawn by importance, and a wavelet denoiser. It reads the same parts, materials, lights and camera
// as the rasterizer. Same input gives the same bytes: random numbers come from a hash of pixel, sample and seed, and
// the clock only decides whether a render is allowed to finish.

export const PATH_TRACER_LIMITS = Object.freeze({
  width: Object.freeze({ minimum: 16, maximum: 4096, fallback: 960 }),
  height: Object.freeze({ minimum: 16, maximum: 4096, fallback: 540 }),
  samples: Object.freeze({ minimum: 1, maximum: 1024, fallback: 64 }),
  bounces: Object.freeze({ minimum: 1, maximum: 16, fallback: 8 }),
  maxSeconds: Object.freeze({ minimum: 1, maximum: 1800, fallback: 300 }),
  fireflyClamp: Object.freeze({ minimum: 1, maximum: 1000, fallback: 20 }),
  seed: Object.freeze({ minimum: 0, maximum: 2 ** 31 - 1, fallback: 0 }),
  threads: Object.freeze({ minimum: 1, maximum: 8, fallback: 4 }),
});
export const MAX_TRACE_PIXELS = 2_073_600;
export const MAX_TRACE_RAY_WORK = 4_000_000_000;
const ALPHA_STEP_LIMIT = 8;
const WORKER_BAND_ROWS = 8;
// Held in a constant so the bundler leaves the URL alone: the worker is its own package entry, built beside this file.
const WORKER_FILE = './path-tracer-worker.js';
const RUSSIAN_ROULETTE_START = 3;
const IGNORED_MAP_FIELDS = ['normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];

function boundedInteger(options, name) {
  const limit = PATH_TRACER_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (!Number.isInteger(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Path tracer ${name} must be an integer from ${limit.minimum} to ${limit.maximum}.`);
  }
  return value;
}

function boundedNumber(options, name) {
  const limit = PATH_TRACER_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Path tracer ${name} must be a number from ${limit.minimum} to ${limit.maximum}.`);
  }
  return value;
}

export function normalizePathTracerOptions(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('Path tracer options must be an object.');
  const result = {
    width: boundedInteger(options, 'width'),
    height: boundedInteger(options, 'height'),
    samples: boundedInteger(options, 'samples'),
    bounces: boundedInteger(options, 'bounces'),
    seed: boundedInteger(options, 'seed'),
    threads: boundedInteger(options, 'threads'),
    maxSeconds: boundedNumber(options, 'maxSeconds'),
    fireflyClamp: boundedNumber(options, 'fireflyClamp'),
    denoise: options.denoise ?? true,
  };
  if (typeof result.denoise !== 'boolean') throw new TypeError('Path tracer denoise must be a boolean.');
  if (result.width * result.height > MAX_TRACE_PIXELS) throw new RangeError(`A path trace takes at most ${MAX_TRACE_PIXELS} pixels.`);
  if (result.width * result.height * result.samples * (result.bounces + 1) > MAX_TRACE_RAY_WORK) throw new RangeError('This path trace would need too much ray work: lower the size, samples or bounces.');
  return result;
}

function finiteVector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new TypeError(`Path tracer camera ${name} must be three finite numbers.`);
  }
  return value;
}

function createCamera(camera, width, height) {
  const eye = finiteVector(camera.eye, 'eye');
  const target = finiteVector(camera.target, 'target');
  const up = finiteVector(camera.up ?? [0, 1, 0], 'up');
  if (typeof camera.fov !== 'number' || !(camera.fov > 1 && camera.fov < 170)) throw new RangeError('Path tracer camera fov must be between 1 and 170 degrees.');
  const forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const forwardLength = Math.hypot(...forward);
  if (forwardLength === 0) throw new RangeError('Path tracer camera eye and target must differ.');
  for (let axis = 0; axis < 3; axis++) forward[axis] /= forwardLength;
  const right = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]];
  const rightLength = Math.hypot(...right);
  if (rightLength === 0) throw new RangeError('Path tracer camera up must not be parallel to its view.');
  for (let axis = 0; axis < 3; axis++) right[axis] /= rightLength;
  const above = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const halfHeight = Math.tan(camera.fov * Math.PI / 360);
  return { eye, forward, right, above, halfHeight, halfWidth: halfHeight * width / height };
}

// ---- Random numbers ----

function createRandom() {
  let state = 1;
  return {
    reset(pixel, sample, seed) {
      let mixed = Math.imul(pixel + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(sample + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(seed + 0x165667b1, 0x27d4eb2f);
      mixed = Math.imul(mixed ^ (mixed >>> 15), 0x2c1b3c6d);
      mixed = Math.imul(mixed ^ (mixed >>> 12), 0x297a2d39);
      mixed ^= mixed >>> 15;
      state = mixed === 0 ? 1 : mixed;
    },
    // PCG (RXS-M-XS): successive values are independent enough for light and lobe choices that share one path.
    next() {
      state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
      const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
      return (((word >>> 22) ^ word) >>> 0) / 4294967296;
    },
  };
}

// ---- Hits ----

function createHit() {
  return {
    distance: 0, material: null,
    point: new Float64Array(3), normal: new Float64Array(3), color: new Float64Array(3),
    texel: new Float64Array(4),
  };
}

function sampleTexture(texture, u, v, out) {
  const { width, height, data, colorLookup, repeat } = texture;
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const shareX = x - left;
  const shareY = y - top;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  for (let corner = 0; corner < 4; corner++) {
    let column = left + (corner & 1);
    let row = top + (corner >> 1);
    column = repeat ? ((column % width) + width) % width : Math.max(0, Math.min(width - 1, column));
    row = repeat ? ((row % height) + height) % height : Math.max(0, Math.min(height - 1, row));
    const weight = ((corner & 1) ? shareX : 1 - shareX) * ((corner >> 1) ? shareY : 1 - shareY);
    const base = (row * width + column) * 4;
    for (let channel = 0; channel < 3; channel++) out[channel] += weight * (colorLookup ? colorLookup[data[base + channel]] : data[base + channel] / 255);
    out[3] += weight * data[base + 3] / 255;
  }
}

const CORNER_VERTICES = new Uint32Array(3);
const CORNER_WEIGHTS = new Float64Array(3);

/** Interpolates the surface at a hit: position, facing-corrected normal is left to the caller, colour and alpha. */
function fillHit(scene, triangleId, originX, originY, originZ, directionX, directionY, directionZ, distance, hit) {
  const { positions, normals, uvs, colors, indices } = scene;
  const first = indices[triangleId * 3];
  const second = indices[triangleId * 3 + 1];
  const third = indices[triangleId * 3 + 2];
  hit.distance = distance;
  hit.point[0] = originX + directionX * distance;
  hit.point[1] = originY + directionY * distance;
  hit.point[2] = originZ + directionZ * distance;
  const edgeOneX = positions[second * 3] - positions[first * 3];
  const edgeOneY = positions[second * 3 + 1] - positions[first * 3 + 1];
  const edgeOneZ = positions[second * 3 + 2] - positions[first * 3 + 2];
  const edgeTwoX = positions[third * 3] - positions[first * 3];
  const edgeTwoY = positions[third * 3 + 1] - positions[first * 3 + 1];
  const edgeTwoZ = positions[third * 3 + 2] - positions[first * 3 + 2];
  const offsetX = hit.point[0] - positions[first * 3];
  const offsetY = hit.point[1] - positions[first * 3 + 1];
  const offsetZ = hit.point[2] - positions[first * 3 + 2];
  const oneOne = edgeOneX * edgeOneX + edgeOneY * edgeOneY + edgeOneZ * edgeOneZ;
  const oneTwo = edgeOneX * edgeTwoX + edgeOneY * edgeTwoY + edgeOneZ * edgeTwoZ;
  const twoTwo = edgeTwoX * edgeTwoX + edgeTwoY * edgeTwoY + edgeTwoZ * edgeTwoZ;
  const offsetOne = offsetX * edgeOneX + offsetY * edgeOneY + offsetZ * edgeOneZ;
  const offsetTwo = offsetX * edgeTwoX + offsetY * edgeTwoY + offsetZ * edgeTwoZ;
  const denominator = oneOne * twoTwo - oneTwo * oneTwo || 1;
  const secondWeight = (twoTwo * offsetOne - oneTwo * offsetTwo) / denominator;
  const thirdWeight = (oneOne * offsetTwo - oneTwo * offsetOne) / denominator;
  const firstWeight = 1 - secondWeight - thirdWeight;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let u = 0;
  let v = 0;
  CORNER_VERTICES[0] = first;
  CORNER_VERTICES[1] = second;
  CORNER_VERTICES[2] = third;
  CORNER_WEIGHTS[0] = firstWeight;
  CORNER_WEIGHTS[1] = secondWeight;
  CORNER_WEIGHTS[2] = thirdWeight;
  for (let corner = 0; corner < 3; corner++) {
    const vertex = CORNER_VERTICES[corner];
    const weight = CORNER_WEIGHTS[corner];
    normalX += weight * normals[vertex * 3];
    normalY += weight * normals[vertex * 3 + 1];
    normalZ += weight * normals[vertex * 3 + 2];
    red += weight * colors[vertex * 3];
    green += weight * colors[vertex * 3 + 1];
    blue += weight * colors[vertex * 3 + 2];
    u += weight * uvs[vertex * 2];
    v += weight * uvs[vertex * 2 + 1];
  }
  const length = Math.hypot(normalX, normalY, normalZ) || 1;
  hit.normal[0] = normalX / length;
  hit.normal[1] = normalY / length;
  hit.normal[2] = normalZ / length;
  const material = scene.materials[scene.triangleMaterial[triangleId]];
  hit.material = material;
  let alpha = 1;
  hit.color[0] = material.color[0] * red;
  hit.color[1] = material.color[1] * green;
  hit.color[2] = material.color[2] * blue;
  if (material.texture) {
    sampleTexture(material.texture, u, v, hit.texel);
    hit.color[0] *= hit.texel[0];
    hit.color[1] *= hit.texel[1];
    hit.color[2] *= hit.texel[2];
    alpha = hit.texel[3];
  }
  return alpha;
}

/** The nearest solid hit along a ray, stepping through the transparent texels of cutout materials. */
function intersect(scene, originX, originY, originZ, directionX, directionY, directionZ, hit) {
  let startX = originX;
  let startY = originY;
  let startZ = originZ;
  let travelled = 0;
  for (let attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    const found = scene.tracer.trace(startX, startY, startZ, directionX, directionY, directionZ, scene.farDistance, false);
    if (found.nearestTriangle < 0) return false;
    const alpha = fillHit(scene, found.nearestTriangle, startX, startY, startZ, directionX, directionY, directionZ, found.nearestDistance, hit);
    if (hit.material.alphaCutoff === 0 || alpha >= hit.material.alphaCutoff) {
      hit.distance += travelled;
      return true;
    }
    const advance = found.nearestDistance + scene.surfaceOffset;
    travelled += advance;
    startX += directionX * advance;
    startY += directionY * advance;
    startZ += directionZ * advance;
  }
  return false;
}

function occluded(scene, originX, originY, originZ, directionX, directionY, directionZ, limit, hit) {
  let startX = originX;
  let startY = originY;
  let startZ = originZ;
  let remaining = limit;
  for (let attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    const found = scene.tracer.trace(startX, startY, startZ, directionX, directionY, directionZ, remaining, true);
    if (found.nearestTriangle < 0) return false;
    const alpha = fillHit(scene, found.nearestTriangle, startX, startY, startZ, directionX, directionY, directionZ, found.nearestDistance, hit);
    if (hit.material.alphaCutoff === 0 || alpha >= hit.material.alphaCutoff) return true;
    const advance = found.nearestDistance + scene.surfaceOffset;
    remaining -= advance;
    if (remaining <= 0) return false;
    startX += directionX * advance;
    startY += directionY * advance;
    startZ += directionZ * advance;
  }
  return true;
}

// ---- One path ----

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function createPathTracer(scene, options) {
  const surface = createSurface();
  const hit = createHit();
  const shadowHit = createHit();
  const throughput = new Float64Array(3);
  const radiance = new Float64Array(3);
  const direction = new Float64Array(3);
  const lightDirection = new Float64Array(3);
  const lightRadiance = new Float64Array(3);
  const sky = new Float64Array(3);
  const sunFrame = new Float64Array(9);
  const mirror = new Float64Array(3);
  const normal = new Float64Array(3);
  const features = { albedo: new Float64Array(3), normal: new Float64Array(3), depth: 0 };
  const random = createRandom();
  const { lights, environment } = scene;
  if (lights.sun) buildFrame(lights.sun.direction, sunFrame);
  const sunCosineMax = Math.cos(SUN_ANGULAR_RADIUS);

  function addRadiance(depth, red, green, blue) {
    let clampedRed = red;
    let clampedGreen = green;
    let clampedBlue = blue;
    if (depth > 0) {
      const peak = Math.max(red, green, blue);
      if (peak > options.fireflyClamp) {
        const scale = options.fireflyClamp / peak;
        clampedRed *= scale;
        clampedGreen *= scale;
        clampedBlue *= scale;
      }
    }
    radiance[0] += clampedRed;
    radiance[1] += clampedGreen;
    radiance[2] += clampedBlue;
  }

  /** Adds the light from one sampled direction: surface value, cosine, shadow ray. `weight` carries MIS and sampling. */
  function addDirect(depth, normal, distance, weight) {
    const cosine = normal[0] * lightDirection[0] + normal[1] * lightDirection[1] + normal[2] * lightDirection[2];
    if (cosine <= 0) return;
    evaluateSurface(surface, lightDirection[0], lightDirection[1], lightDirection[2]);
    const value = surface.value;
    if (value[0] + value[1] + value[2] <= 0) return;
    const originX = hit.point[0] + normal[0] * scene.surfaceOffset;
    const originY = hit.point[1] + normal[1] * scene.surfaceOffset;
    const originZ = hit.point[2] + normal[2] * scene.surfaceOffset;
    if (occluded(scene, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, shadowHit)) return;
    const scale = cosine * weight(surface);
    addRadiance(
      depth,
      throughput[0] * value[0] * lightRadiance[0] * scale,
      throughput[1] * value[1] * lightRadiance[1] * scale,
      throughput[2] * value[2] * lightRadiance[2] * scale,
    );
  }

  const fullWeight = () => 1;

  function sampleSun(depth, normal) {
    const cosineTheta = 1 - random.next() * (1 - sunCosineMax);
    const sineTheta = Math.sqrt(Math.max(0, 1 - cosineTheta * cosineTheta));
    const phi = 2 * Math.PI * random.next();
    const across = sineTheta * Math.cos(phi);
    const along = sineTheta * Math.sin(phi);
    for (let axis = 0; axis < 3; axis++) lightDirection[axis] = sunFrame[axis] * across + sunFrame[3 + axis] * along + sunFrame[6 + axis] * cosineTheta;
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = lights.sun.color[channel];
    addDirect(depth, normal, scene.farDistance, fullWeight);
  }

  function aimAt(targetX, targetY, targetZ) {
    const deltaX = targetX - hit.point[0];
    const deltaY = targetY - hit.point[1];
    const deltaZ = targetZ - hit.point[2];
    const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    const distance = Math.sqrt(distanceSquared);
    lightDirection[0] = deltaX / distance;
    lightDirection[1] = deltaY / distance;
    lightDirection[2] = deltaZ / distance;
    return { distance, distanceSquared };
  }

  function randomOnSphere(radius, out) {
    const height = 2 * random.next() - 1;
    const angle = 2 * Math.PI * random.next();
    const ring = Math.sqrt(1 - height * height);
    out[0] = radius * ring * Math.cos(angle);
    out[1] = radius * height;
    out[2] = radius * ring * Math.sin(angle);
  }

  const jitter = new Float64Array(3);

  function samplePointLight(depth, normal, light) {
    randomOnSphere(light.radius, jitter);
    const { distance, distanceSquared } = aimAt(light.position[0] + jitter[0], light.position[1] + jitter[1], light.position[2] + jitter[2]);
    if (distance < 1e-6) return;
    const strength = light.intensity * pointLightFalloff(distanceSquared, light);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  function sampleSpotLight(depth, normal, light) {
    randomOnSphere(light.radius, jitter);
    const { distance, distanceSquared } = aimAt(light.position[0] + jitter[0], light.position[1] + jitter[1], light.position[2] + jitter[2]);
    if (distance < 1e-6) return;
    const axisCosine = -(light.direction[0] * lightDirection[0] + light.direction[1] * lightDirection[1] + light.direction[2] * lightDirection[2]);
    const inside = axisCosine - light.cosineHalfAngle;
    if (inside <= 0) return;
    const mask = light.blend > 0 && inside < light.blend ? smoothstep(inside / light.blend) : 1;
    const strength = light.intensity * pointLightFalloff(distanceSquared, light) * mask;
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  function sampleAreaLight(depth, normal, light) {
    const across = (random.next() - 0.5) * light.width;
    const along = (random.next() - 0.5) * light.height;
    const pointX = light.position[0] + light.across[0] * across + light.along[0] * along;
    const pointY = light.position[1] + light.across[1] * across + light.along[1] * along;
    const pointZ = light.position[2] + light.across[2] * across + light.along[2] * along;
    const { distance, distanceSquared } = aimAt(pointX, pointY, pointZ);
    if (distance < 1e-6) return;
    const emitCosine = -(light.normal[0] * lightDirection[0] + light.normal[1] * lightDirection[1] + light.normal[2] * lightDirection[2]);
    if (emitCosine <= 0) return;
    const strength = light.intensity * emitCosine / distanceSquared;
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  let environmentSampledPdf = 0;
  const environmentWeight = candidate => {
    const total = environmentSampledPdf * environmentSampledPdf + candidate.pdf * candidate.pdf;
    return environmentSampledPdf * environmentSampledPdf / total / environmentSampledPdf;
  };

  function sampleEnvironmentLight(depth, normal) {
    environmentSampledPdf = sampleEnvironment(environment, random.next(), random.next(), random.next(), random.next(), lightDirection);
    if (!(environmentSampledPdf > 0)) return;
    environmentRadiance(environment, lightDirection[0], lightDirection[1], lightDirection[2], lightRadiance);
    addDirect(depth, normal, scene.farDistance, environmentWeight);
  }

  function addLights(depth, normal) {
    if (lights.sun) sampleSun(depth, normal);
    for (const light of lights.points) samplePointLight(depth, normal, light);
    for (const light of lights.spots) sampleSpotLight(depth, normal, light);
    for (const light of lights.areas) sampleAreaLight(depth, normal, light);
    if (environment) sampleEnvironmentLight(depth, normal);
  }

  function addEscape(depth, previousPdf, afterMirror) {
    if (!environment) return;
    environmentRadiance(environment, direction[0], direction[1], direction[2], sky);
    let weight = 1;
    if (!afterMirror) {
      const environmentSide = environmentPdf(environment, direction[0], direction[1], direction[2]);
      weight = previousPdf * previousPdf / (previousPdf * previousPdf + environmentSide * environmentSide);
    }
    addRadiance(depth, throughput[0] * sky[0] * weight, throughput[1] * sky[1] * weight, throughput[2] * sky[2] * weight);
  }

  function recordFeatures(normal, isGlass) {
    features.albedo[0] = isGlass ? 1 : hit.color[0];
    features.albedo[1] = isGlass ? 1 : hit.color[1];
    features.albedo[2] = isGlass ? 1 : hit.color[2];
    features.normal[0] = normal[0];
    features.normal[1] = normal[1];
    features.normal[2] = normal[2];
    features.depth = hit.distance;
  }

  /** Follows one camera ray. Leaves the radiance in `radiance` and the first-hit features in `features`. */
  function trace(originX, originY, originZ, directionX, directionY, directionZ, pixel, sample) {
    random.reset(pixel, sample, options.seed);
    radiance[0] = 0;
    radiance[1] = 0;
    radiance[2] = 0;
    throughput[0] = 1;
    throughput[1] = 1;
    throughput[2] = 1;
    features.albedo.fill(1);
    // A ray that finds nothing has the sky as its feature: one fixed normal and depth, so the filter treats sky as one surface.
    features.normal[0] = 0;
    features.normal[1] = 0;
    features.normal[2] = 1;
    features.depth = 0;
    direction[0] = directionX;
    direction[1] = directionY;
    direction[2] = directionZ;
    let positionX = originX;
    let positionY = originY;
    let positionZ = originZ;
    let previousPdf = 0;
    let afterMirror = true;
    for (let depth = 0; depth <= options.bounces; depth++) {
      if (!intersect(scene, positionX, positionY, positionZ, direction[0], direction[1], direction[2], hit)) {
        addEscape(depth, previousPdf, afterMirror);
        break;
      }
      const material = hit.material;
      const entering = hit.normal[0] * direction[0] + hit.normal[1] * direction[1] + hit.normal[2] * direction[2] < 0;
      const facing = entering ? 1 : -1;
      normal[0] = hit.normal[0] * facing;
      normal[1] = hit.normal[1] * facing;
      normal[2] = hit.normal[2] * facing;
      const isGlass = material.transmission > 0 && random.next() < material.transmission;
      if (depth === 0) recordFeatures(normal, isGlass);
      addRadiance(depth, throughput[0] * material.emission[0], throughput[1] * material.emission[1], throughput[2] * material.emission[2]);
      const viewX = -direction[0];
      const viewY = -direction[1];
      const viewZ = -direction[2];
      if (isGlass) {
        const alpha = roughnessToAlpha(material.roughness);
        if (!sampleGlass(normal, viewX, viewY, viewZ, entering, material.ior, alpha, random.next(), random.next(), random.next(), direction)) break;
        const refracted = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2] < 0;
        if (refracted) {
          throughput[0] *= hit.color[0];
          throughput[1] *= hit.color[1];
          throughput[2] *= hit.color[2];
        }
        afterMirror = true;
      } else {
        prepareSurface(surface, material, hit.color, normal, viewX, viewY, viewZ);
        addLights(depth, normal);
        const lobeUnit = random.next();
        const isMirror = sampleSurface(surface, lobeUnit, random.next(), random.next(), direction);
        const cosine = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
        if (cosine <= 0) break;
        if (isMirror) {
          mirrorWeight(surface, mirror);
          for (let channel = 0; channel < 3; channel++) throughput[channel] *= mirror[channel];
          afterMirror = true;
        } else {
          evaluateSurface(surface, direction[0], direction[1], direction[2]);
          if (!(surface.pdf > 0)) break;
          for (let channel = 0; channel < 3; channel++) throughput[channel] *= surface.value[channel] * cosine / surface.pdf;
          previousPdf = surface.pdf;
          afterMirror = false;
        }
      }
      positionX = hit.point[0] + direction[0] * scene.surfaceOffset;
      positionY = hit.point[1] + direction[1] * scene.surfaceOffset;
      positionZ = hit.point[2] + direction[2] * scene.surfaceOffset;
      if (depth >= RUSSIAN_ROULETTE_START) {
        const survival = Math.min(0.95, Math.max(0.05, Math.max(throughput[0], throughput[1], throughput[2])));
        if (random.next() >= survival) break;
        for (let channel = 0; channel < 3; channel++) throughput[channel] /= survival;
      }
    }
  }

  return { trace, radiance, features };
}

// ---- Image ----

function toneMap(linear) {
  const color = Math.max(linear, 0);
  const mapped = Math.min(1, Math.max(0, (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14)));
  return mapped ** (1 / 2.2);
}

/** The display transform of the rasterizer's post pass (filmic curve and gamma 2.2) applied to linear pixels. */
export function toneMapToRgba8(linear, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = Math.round(toneMap(linear[pixel * 3 + channel]) * 255);
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}

/** Names what this scene asks for that the path tracer does not draw, so a result never claims more than it traced. */
export function describeIgnoredFeatures(parts, environment) {
  const notes = new Set();
  if (environment?.volumeFog) notes.add('volumeFog is not traced.');
  if (!environment?.map) notes.add('There is no environment map, so the sky is black and only the lights shine.');
  for (const part of parts) {
    const material = part.material ?? {};
    for (const field of IGNORED_MAP_FIELDS) if (material[field]) notes.add(`${field} is ignored.`);
    if (material.tag && material.tag !== 'surface') notes.add(`${material.tag} materials are traced as plain surfaces.`);
    if (material.alphaMode === 'blend') notes.add('Blended transparency is traced as opaque.');
  }
  return [...notes];
}

/**
 * Renders rows `rowStart` up to `rowEnd` and returns their buffers (colour, albedo, normal, depth, variance), row
 * major from the band's first row. A pixel's random numbers depend only on its place in the whole image, so bands
 * can be drawn in any order, on any thread, and give the same pixels.
 */
export function renderBand(scene, camera, options, rowStart, rowEnd, shouldStop = () => {}) {
  const tracer = createPathTracer(scene, options);
  const { width, height, samples } = options;
  const pixelCount = (rowEnd - rowStart) * width;
  const color = new Float32Array(pixelCount * 3);
  const albedo = new Float32Array(pixelCount * 3);
  const normal = new Float32Array(pixelCount * 3);
  const depth = new Float32Array(pixelCount);
  const variance = new Float32Array(pixelCount);
  for (let row = rowStart; row < rowEnd; row++) {
    shouldStop();
    for (let column = 0; column < width; column++) {
      const pixel = row * width + column;
      const slot = (row - rowStart) * width + column;
      let sumLuminance = 0;
      let sumLuminanceSquares = 0;
      for (let sample = 0; sample < samples; sample++) {
        const jitterX = hashJitter(pixel, sample, options.seed, 1);
        const jitterY = hashJitter(pixel, sample, options.seed, 2);
        const screenX = ((column + jitterX) / width * 2 - 1) * camera.halfWidth;
        const screenY = (1 - (row + jitterY) / height * 2) * camera.halfHeight;
        const directionX = camera.forward[0] + camera.right[0] * screenX + camera.above[0] * screenY;
        const directionY = camera.forward[1] + camera.right[1] * screenX + camera.above[1] * screenY;
        const directionZ = camera.forward[2] + camera.right[2] * screenX + camera.above[2] * screenY;
        const length = Math.hypot(directionX, directionY, directionZ);
        tracer.trace(camera.eye[0], camera.eye[1], camera.eye[2], directionX / length, directionY / length, directionZ / length, pixel, sample);
        const { radiance, features } = tracer;
        const sampleLuminance = luminance(radiance[0], radiance[1], radiance[2]);
        sumLuminance += sampleLuminance;
        sumLuminanceSquares += sampleLuminance * sampleLuminance;
        for (let channel = 0; channel < 3; channel++) {
          color[slot * 3 + channel] += radiance[channel];
          albedo[slot * 3 + channel] += features.albedo[channel];
          normal[slot * 3 + channel] += features.normal[channel];
        }
        depth[slot] += features.depth;
      }
      for (let channel = 0; channel < 3; channel++) {
        color[slot * 3 + channel] /= samples;
        albedo[slot * 3 + channel] /= samples;
        normal[slot * 3 + channel] /= samples;
      }
      depth[slot] /= samples;
      const meanLuminance = sumLuminance / samples;
      variance[slot] = Math.max(0, sumLuminanceSquares / samples - meanLuminance * meanLuminance) / Math.max(samples - 1, 1);
    }
  }
  return { color, albedo, normal, depth, variance };
}

function hashJitter(pixel, sample, seed, dimension) {
  let mixed = Math.imul(pixel ^ 0x51ed270b, 0x9e3779b1) ^ Math.imul(sample + dimension * 0x632be5ab, 0x85ebca6b) ^ Math.imul(seed + 0x1b873593, 0xc2b2ae35);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) / 4294967296;
}

function normalizeNormals(normal, pixelCount) {
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const length = Math.hypot(normal[pixel * 3], normal[pixel * 3 + 1], normal[pixel * 3 + 2]);
    if (length === 0) continue;
    for (let axis = 0; axis < 3; axis++) normal[pixel * 3 + axis] /= length;
  }
}

function copyBand(buffers, band, rowStart, width) {
  const pixelOffset = rowStart * width;
  for (const name of ['color', 'albedo', 'normal']) buffers[name].set(band[name], pixelOffset * 3);
  for (const name of ['depth', 'variance']) buffers[name].set(band[name], pixelOffset);
}

/** Draws bands on a pool of module workers, handing the next band to whichever worker finishes first. */
function renderBandsInWorkers(scene, camera, options, buffers, shouldStop) {
  const bandCount = Math.ceil(options.height / WORKER_BAND_ROWS);
  const workerCount = Math.min(options.threads, bandCount);
  const workers = [];
  const { tracer: _tracer, ...transferableScene } = scene;
  return new Promise((resolve, reject) => {
    let nextBand = 0;
    let finishedBands = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(clock);
      for (const worker of workers) worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    const clock = setInterval(() => {
      try {
        shouldStop();
      } catch (error) {
        finish(error);
      }
    }, 250);
    const assign = (worker) => {
      if (nextBand >= bandCount) return;
      const rowStart = nextBand * WORKER_BAND_ROWS;
      nextBand++;
      worker.postMessage({ type: 'band', rowStart, rowEnd: Math.min(rowStart + WORKER_BAND_ROWS, options.height) });
    };
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL(WORKER_FILE, import.meta.url), { type: 'module' });
      workers.push(worker);
      worker.onerror = (event) => finish(new Error(`Path tracer worker failed: ${event.message}`));
      worker.onmessage = (event) => {
        if (event.data.type === 'ready') {
          assign(worker);
          return;
        }
        copyBand(buffers, event.data.band, event.data.rowStart, options.width);
        finishedBands++;
        if (finishedBands === bandCount) finish();
        else assign(worker);
      };
      worker.postMessage({ type: 'scene', scene: transferableScene, camera, options });
    }
  });
}

/**
 * Renders one still. `scene` is `{ parts, environment, camera }` as the rasterizer takes them. Resolves with the linear
 * pixels, the tone-mapped RGBA bytes, and a report. Rejects, and returns nothing, when `maxSeconds` runs out.
 * `threads` above 1 uses module workers where the platform has them; the pixels are the same either way.
 */
export async function renderPathTracedImage({ parts, environment = {}, camera }, rawOptions = {}) {
  const options = normalizePathTracerOptions(rawOptions);
  const started = performance.now();
  const shouldStop = () => {
    if ((performance.now() - started) / 1000 > options.maxSeconds) throw new Error(`The path trace passed its ${options.maxSeconds} second limit and was stopped.`);
  };
  const { width, height } = options;
  const view = createCamera(camera, width, height);
  const scene = buildTraceScene(parts, environment);
  const pixelCount = width * height;
  const buffers = {
    color: new Float32Array(pixelCount * 3), albedo: new Float32Array(pixelCount * 3), normal: new Float32Array(pixelCount * 3),
    depth: new Float32Array(pixelCount), variance: new Float32Array(pixelCount),
  };
  const threads = typeof Worker === 'function' ? options.threads : 1;
  if (threads > 1) {
    await renderBandsInWorkers(scene, view, { ...options, threads }, buffers, shouldStop);
  } else {
    copyBand(buffers, renderBand(scene, view, options, 0, height, shouldStop), 0, width);
  }
  shouldStop();
  const tracedSeconds = (performance.now() - started) / 1000;
  normalizeNormals(buffers.normal, pixelCount);
  const linear = options.denoise ? denoiseRadiance({ width, height, ...buffers }) : buffers.color;
  return {
    width, height, linear, rgba: toneMapToRgba8(linear, width, height),
    report: {
      width, height, samples: options.samples, bounces: options.bounces, seed: options.seed, denoised: options.denoise, threads,
      triangles: scene.indices.length / 3, tracedSeconds, seconds: (performance.now() - started) / 1000,
      ignored: describeIgnoredFeatures(parts, environment),
    },
  };
}
