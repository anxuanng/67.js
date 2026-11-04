const DEFAULT_MINIMUM = Object.freeze([-100, 0, -100]);
const DEFAULT_MAXIMUM = Object.freeze([100, 20, 100]);
const DEFAULT_COLOR = Object.freeze([0.8, 0.85, 0.9]);
const DEFAULT_AMBIENT = Object.freeze([0.03, 0.035, 0.04]);
const DEFAULT_DRIFT = Object.freeze([0.03, 0, 0]);

function finiteRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function vector(value, minimum, maximum, label) {
  if (value?.length !== 3) throw new TypeError(`${label} requires three components`);
  for (let axis = 0; axis < 3; axis++) finiteRange(value[axis], minimum, maximum, label);
  return value;
}

export function resolveVolumeFog(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('volumeFog must be an object');
  const density = finiteRange(input.density ?? 0, 0, 10, 'Volume density');
  const minimum = vector(input.minimum ?? DEFAULT_MINIMUM, -1e5, 1e5, 'Volume minimum');
  const maximum = vector(input.maximum ?? DEFAULT_MAXIMUM, -1e5, 1e5, 'Volume maximum');
  for (let axis = 0; axis < 3; axis++) {
    if (Math.fround(maximum[axis]) <= Math.fround(minimum[axis])) throw new RangeError('Volume bounds must remain ordered after Float32 rounding');
  }
  const color = vector(input.color ?? DEFAULT_COLOR, 0, 1, 'Volume color');
  const ambient = vector(input.ambient ?? DEFAULT_AMBIENT, 0, 10, 'Volume ambient');
  const drift = vector(input.drift ?? DEFAULT_DRIFT, -100, 100, 'Volume drift');
  const steps = finiteRange(input.steps ?? 16, 8, 48, 'Volume steps');
  if (!Number.isInteger(steps)) throw new RangeError('Volume steps must be an integer');
  const anisotropy = finiteRange(input.anisotropy ?? 0.3, -0.9, 0.9, 'Volume anisotropy');
  const noiseAmount = finiteRange(input.noiseAmount ?? 0.5, 0, 1, 'Volume noise amount');
  const noiseScale = finiteRange(input.noiseScale ?? 0.3, 0.001, 100, 'Volume noise scale');
  const maxDistance = finiteRange(input.maxDistance ?? 100, 0.01, 1e4, 'Volume maximum distance');
  const heightFalloff = finiteRange(input.heightFalloff ?? 0, 0, 1e5, 'Volume height falloff');
  const resolved = { density, minimum, maximum, color, ambient, drift, steps, anisotropy, noiseAmount, noiseScale, maxDistance, heightFalloff };
  // Left out when unset, so the renderer can derive it from the scene (volumeShadowAmbient).
  if (input.shadowAmbient !== undefined) {
    resolved.shadowAmbient = finiteRange(input.shadowAmbient, 0, 1, 'Volume shadow ambient');
  }
  return resolved;
}

const derivedShadowAmbients = new WeakMap();

/**
 * The share of the fog's ambient that survives in the sun's shadow. A set value wins. Otherwise it follows how open the sky is
 * from the middle of the fog: a closed room keeps 0.15, open ground under the sky keeps all of it.
 * `measureOpenness(parts, point)` is the `skyOpenness` option of the renderer (src/closed-room.js), kept out of the core
 * bundle; without it, or for a scene too large to test, the scene counts as enclosed. It runs once per scene and fog box.
 */
export function volumeShadowAmbient(volume, parts, measureOpenness) {
  if (volume.shadowAmbient !== undefined) {
    return volume.shadowAmbient;
  }
  const key = `${volume.minimum}|${volume.maximum}`;
  const cached = derivedShadowAmbients.get(parts);
  if (cached?.key === key) {
    return cached.value;
  }
  const centre = volume.minimum.map((low, axis) => (low + volume.maximum[axis]) / 2);
  const value = 0.15 + 0.85 * (measureOpenness?.(parts, centre) ?? 0);
  derivedShadowAmbients.set(parts, { key, value });
  return value;
}
