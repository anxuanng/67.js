import { mat4 } from 'gl-matrix';
import { createLightingState, updateLightingState, MAX_POINT_LIGHTS } from './lighting.js';
import { resolveEffects } from './effects.js';
import { resolveVolumeFog } from './volumetric.js';

const ENVIRONMENT_FIELDS = [
  'world', 'lightDirection', 'keyColor', 'keyIntensity', 'fillIntensity', 'ambientIntensity',
  'daylight', 'pointLights', 'skyTop', 'skyBottom', 'fogColor', 'fogDensity', 'volumeFog',
];
const EFFECT_FIELDS = ['exposure', 'saturation', 'contrast', 'temperature', 'vignette', 'grain', 'bloom'];
const SHADOW_FIELDS = ['target', 'extent', 'distance', 'near', 'far'];
const POINT_LIGHT_FIELDS = ['position', 'color', 'intensity', 'radius', 'range'];
const VOLUME_VECTOR_FIELDS = ['minimum', 'maximum', 'color', 'ambient', 'drift'];
const VOLUME_NUMBER_FIELDS = ['density', 'steps', 'anisotropy', 'noiseAmount', 'noiseScale', 'maxDistance'];
const BLOOM_FIELDS = ['strength', 'threshold', 'radius'];

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain JSON object.`);
  }
}

function knownKeys(value, fields, label) {
  plainObject(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      throw new TypeError(`Unknown ${label} field: ${String(key)}.`);
    }
  }
}

// Domain resolvers accept ordinary values. Copy descriptors first so accessors never execute.
function copiedJson(input, depth = 0, ancestors = new Set()) {
  if (depth > 32) {
    throw new RangeError('Look JSON nesting exceeds 32 levels.');
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isFinite(Math.fround(input))) {
      throw new TypeError('Look JSON numbers must be finite Float32 values.');
    }
    return input;
  }
  if (!input || typeof input !== 'object' || ancestors.has(input)) {
    throw new TypeError('Look must contain acyclic plain JSON data.');
  }
  const array = Array.isArray(input);
  if (array && (Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_POINT_LIGHTS)) {
    throw new TypeError(`Look JSON arrays must be ordinary arrays with at most ${MAX_POINT_LIGHTS} entries.`);
  }
  if (!array) {
    plainObject(input, 'Look');
  }
  ancestors.add(input);
  const result = array ? [] : {};
  for (const key of Reflect.ownKeys(input)) {
    if (array && key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || key === '__proto__') {
      throw new TypeError('Look JSON keys must be ordinary strings.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Look JSON accessors and hidden fields are unsupported.');
    }
    if (array && key !== String(result.length)) {
      throw new TypeError('Look JSON arrays must be dense without extra fields.');
    }
    result[key] = copiedJson(descriptor.value, depth + 1, ancestors);
  }
  if (array && result.length !== input.length) {
    throw new TypeError('Look JSON arrays cannot contain trailing holes.');
  }
  ancestors.delete(input);
  return result;
}

function numberInRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) ||
      value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a finite Float32 number within ${minimum} and ${maximum}.`);
  }
  return value;
}

function vectorInRange(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} needs three JSON numbers.`);
  }
  return value.map(component => numberInRange(component, minimum, maximum, label));
}

function fallback(value, defaultValue) {
  return value === undefined ? defaultValue : value;
}

function directionFrom(value) {
  const direction = vectorInRange(value, -1e6, 1e6, 'lightDirection');
  const length = Math.hypot(...direction);
  if (length < 1e-6) {
    throw new RangeError('lightDirection length must be at least 0.000001.');
  }
  return { direction, unitDirection: direction.map(component => component / length) };
}

function volumeFogFrom(input = {}) {
  knownKeys(input, [...VOLUME_VECTOR_FIELDS, ...VOLUME_NUMBER_FIELDS], 'volumeFog');
  for (const field of VOLUME_VECTOR_FIELDS) {
    if (Object.hasOwn(input, field)) {
      vectorInRange(input[field], -1e5, 1e5, `volumeFog.${field}`);
    }
  }
  for (const field of VOLUME_NUMBER_FIELDS) {
    if (Object.hasOwn(input, field)) {
      numberInRange(input[field], -Number.MAX_VALUE, Number.MAX_VALUE, `volumeFog.${field}`);
    }
  }
  return copiedJson(resolveVolumeFog(input));
}

function environmentFrom(input = {}) {
  knownKeys(input, ENVIRONMENT_FIELDS, 'environment');
  const world = fallback(input.world, false);
  if (typeof world !== 'boolean') {
    throw new TypeError('environment.world must be boolean.');
  }
  const pointLights = fallback(input.pointLights, []);
  if (!Array.isArray(pointLights) || pointLights.length > MAX_POINT_LIGHTS) {
    throw new RangeError(`pointLights must contain at most ${MAX_POINT_LIGHTS} lights.`);
  }
  const environment = {
    world,
    lightDirection: directionFrom(fallback(input.lightDirection, [-3, 6, 4])).direction,
    keyColor: vectorInRange(fallback(input.keyColor, [5.2, 4.7, 4.1]), 0, 1000, 'keyColor'),
    keyIntensity: numberInRange(fallback(input.keyIntensity, 1), 0, 100, 'keyIntensity'),
    fillIntensity: numberInRange(fallback(input.fillIntensity, 1), 0, 100, 'fillIntensity'),
    ambientIntensity: numberInRange(fallback(input.ambientIntensity, 1), 0, 100, 'ambientIntensity'),
    daylight: numberInRange(fallback(input.daylight, 1), 0, 100, 'daylight'),
    pointLights: pointLights.map(light => {
      knownKeys(light, POINT_LIGHT_FIELDS, 'point light');
      const range = numberInRange(fallback(light.range, 0), 0, 1e6, 'point light range');
      if (range !== 0 && range < 0.001) {
        throw new RangeError('Point light range must be zero or at least 0.001.');
      }
      return {
        position: vectorInRange(light.position, -1e6, 1e6, 'point light position'),
        color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'point light color'),
        intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'point light intensity'),
        radius: numberInRange(fallback(light.radius, 0.05), 0.001, 1e6, 'point light radius'),
        range,
      };
    }),
    skyTop: vectorInRange(fallback(input.skyTop, [0.2, 0.38, 0.52]), 0, 1, 'skyTop'),
    skyBottom: vectorInRange(fallback(input.skyBottom, [0.62, 0.7, 0.67]), 0, 1, 'skyBottom'),
    fogColor: vectorInRange(fallback(input.fogColor, [0.35, 0.43, 0.43]), 0, 1, 'fogColor'),
    fogDensity: numberInRange(fallback(input.fogDensity, 0.006), 0, 10, 'fogDensity'),
    volumeFog: volumeFogFrom(input.volumeFog),
  };
  updateLightingState(createLightingState(), environment, { world });
  return environment;
}

function effectsFrom(input = {}) {
  knownKeys(input, EFFECT_FIELDS, 'effects');
  for (const field of EFFECT_FIELDS) {
    if (field !== 'bloom' && Object.hasOwn(input, field)) {
      numberInRange(input[field], -Number.MAX_VALUE, Number.MAX_VALUE, `effects.${field}`);
    }
  }
  const bloom = fallback(input.bloom, {});
  knownKeys(bloom, BLOOM_FIELDS, 'bloom');
  for (const field of BLOOM_FIELDS) {
    if (Object.hasOwn(bloom, field)) {
      numberInRange(bloom[field], -Number.MAX_VALUE, Number.MAX_VALUE, `bloom.${field}`);
    }
  }
  const resolved = resolveEffects({ ...input, bloom: { strength: 0.12, threshold: 1, radius: 1, ...bloom } });
  return { ...resolved, exposure: numberInRange(fallback(input.exposure, 1), 0.01, 16, 'exposure') };
}

function shadowFrom(input = {}) {
  knownKeys(input, SHADOW_FIELDS, 'shadow');
  const shadow = {
    target: vectorInRange(fallback(input.target, [0, 1, 0]), -1e6, 1e6, 'shadow target'),
    extent: numberInRange(fallback(input.extent, 3.5), 0.01, 1e5, 'shadow extent'),
    distance: numberInRange(fallback(input.distance, 8), 0.01, 1e6, 'shadow distance'),
    near: numberInRange(fallback(input.near, 0.1), 0.001, 1e6, 'shadow near'),
    far: numberInRange(fallback(input.far, 15), 0.001, 1e6, 'shadow far'),
  };
  if (Math.fround(shadow.near) >= Math.fround(shadow.far)) {
    throw new RangeError('Shadow needs near < far at Float32 precision.');
  }
  return shadow;
}

function shadowBoundsFrom(shadow, direction) {
  const { unitDirection } = directionFrom(direction);
  const eye = shadow.target.map((component, axis) => component + unitDirection[axis] * shadow.distance);
  if (!eye.every(component => Number.isFinite(Math.fround(component))) ||
      eye.every((component, axis) => Math.fround(component) === Math.fround(shadow.target[axis]))) {
    throw new RangeError('Shadow eye and target must remain finite and distinguishable at Float32 precision.');
  }
  const up = Math.abs(unitDirection[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const view = mat4.lookAt(mat4.create(), eye, shadow.target, up);
  const projection = mat4.ortho(mat4.create(), -shadow.extent, shadow.extent, -shadow.extent, shadow.extent, shadow.near, shadow.far);
  const combined = mat4.multiply(mat4.create(), projection, view);
  for (const matrix of [view, projection, combined]) {
    const determinant = mat4.determinant(matrix);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError('Shadow view, projection, and combined matrices must remain finite and nonsingular at Float32 precision.');
    }
  }
  return { eye, target: [...shadow.target], up, extent: shadow.extent, near: shadow.near, far: shadow.far };
}

/** Derive a detached directional shadow projector from validated ordinary JSON. */
export function resolveAgentShadow(inputShadow = {}, inputDirection = [-3, 6, 4]) {
  const shadow = shadowFrom(copiedJson(inputShadow));
  const direction = copiedJson(inputDirection);
  return shadowBoundsFrom(shadow, direction);
}

/** Normalize the complete look without mutating caller input or sharing default arrays. */
export function normalizeAgentLook(input = {}) {
  knownKeys(input, ['environment', 'effects', 'shadow'], 'look');
  const copied = copiedJson(input);
  const environment = environmentFrom(copied.environment);
  const effects = effectsFrom(copied.effects);
  const shadow = shadowFrom(copied.shadow);
  shadowBoundsFrom(shadow, environment.lightDirection);
  return { environment, effects, shadow };
}
