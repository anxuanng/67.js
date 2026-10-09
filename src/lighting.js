export const MAX_POINT_LIGHTS = 8;

function numberInRange(value, minimum, maximum, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function vectorInRange(value, minimum, maximum, name) {
  if (value?.length !== 3) throw new TypeError(`${name} must have three components`);
  for (let axis = 0; axis < 3; axis++) numberInRange(value[axis], minimum, maximum, name);
  return value;
}

export function createLightingState() {
  return {
    positions: new Float32Array(MAX_POINT_LIGHTS * 4),
    colors: new Float32Array(MAX_POINT_LIGHTS * 4),
    radii: new Float32Array(MAX_POINT_LIGHTS),
    keyColor: new Float32Array(3),
    pointCount: 0,
    fillIntensity: 1,
    ambientIntensity: 1,
  };
}

// Preflight before publishing so malformed later lights cannot corrupt retained uniforms.
export function updateLightingState(state, environment, { world = false } = {}) {
  const pointLights = environment.pointLights ?? [];
  if (!Array.isArray(pointLights) || pointLights.length > MAX_POINT_LIGHTS) {
    throw new RangeError(`pointLights must be an array of at most ${MAX_POINT_LIGHTS} lights`);
  }
  const keyIntensity = numberInRange(environment.keyIntensity ?? 1, 0, 100, 'Key intensity');
  const fillIntensity = numberInRange(environment.fillIntensity ?? 1, 0, 100, 'Fill intensity');
  const ambientIntensity = numberInRange(environment.ambientIntensity ?? 1, 0, 100, 'Ambient intensity');
  const daylight = numberInRange(environment.daylight ?? 1, 0, 100, 'Daylight');
  const keyColor = environment.keyColor ?? (world ? [3.7 * daylight, 3.4 * daylight, 2.9 * daylight] : [5.2, 4.7, 4.1]);
  vectorInRange(keyColor, 0, 1000, 'Key color');
  for (const light of pointLights) {
    if (!light || typeof light !== 'object' || Array.isArray(light)) throw new TypeError('Point light must be an object');
    vectorInRange(light.position, -1e6, 1e6, 'Point light position');
    vectorInRange(light.color ?? [1, 1, 1], 0, 1, 'Point light color');
    numberInRange(light.intensity ?? 1, 0, 1e5, 'Point light intensity');
    numberInRange(light.radius ?? 0.05, 0.001, 1e6, 'Point light radius');
    const range = light.range ?? 0;
    numberInRange(range, 0, 1e6, 'Point light range');
    if (range !== 0 && range < 0.001) throw new RangeError('Point light range must be zero or at least 0.001');
  }
  state.positions.fill(0);
  state.colors.fill(0);
  state.radii.fill(0);
  for (let index = 0; index < pointLights.length; index++) {
    const light = pointLights[index];
    state.positions.set(light.position, index * 4);
    state.positions[index * 4 + 3] = light.range ?? 0;
    state.colors.set(light.color ?? [1, 1, 1], index * 4);
    state.colors[index * 4 + 3] = light.intensity ?? 1;
    state.radii[index] = light.radius ?? 0.05;
  }
  for (let axis = 0; axis < 3; axis++) state.keyColor[axis] = keyColor[axis] * keyIntensity;
  state.pointCount = pointLights.length;
  state.fillIntensity = fillIntensity;
  state.ambientIntensity = ambientIntensity;
  return state;
}
