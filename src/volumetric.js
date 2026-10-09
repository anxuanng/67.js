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
  return { density, minimum, maximum, color, ambient, drift, steps, anisotropy, noiseAmount, noiseScale, maxDistance };
}
