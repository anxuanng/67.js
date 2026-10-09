export const EFFECT_PRESETS = Object.freeze({
  neutral: Object.freeze({ saturation: 1, contrast: 1, temperature: 0, vignette: 0, grain: 0, bloom: Object.freeze({ strength: 0, threshold: 1, radius: 1 }) }),
  cinematic: Object.freeze({ saturation: 0.88, contrast: 1.08, temperature: 0.08, vignette: 0.16, grain: 0.012, bloom: Object.freeze({ strength: 0.25, threshold: 1, radius: 1.5 }) }),
  vivid: Object.freeze({ saturation: 1.15, contrast: 1.03, temperature: 0, vignette: 0.06, grain: 0, bloom: Object.freeze({ strength: 0.3, threshold: 0.9, radius: 1.2 }) }),
});

function numberInRange(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

export function resolveEffects(effects = {}) {
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) throw new Error('Effects must be an object.');
  const bloom = effects.bloom ?? {};
  if (!bloom || typeof bloom !== 'object' || Array.isArray(bloom)) throw new Error('Bloom must be an object.');
  return {
    saturation: numberInRange(effects.saturation, 1, 0, 2, 'Saturation'),
    contrast: numberInRange(effects.contrast, 1, 0.1, 2, 'Contrast'),
    temperature: numberInRange(effects.temperature, 0, -1, 1, 'Temperature'),
    vignette: numberInRange(effects.vignette, 0, 0, 1, 'Vignette'),
    grain: numberInRange(effects.grain, 0, 0, 0.1, 'Grain'),
    bloom: {
      strength: numberInRange(bloom.strength, 0, 0, 2, 'Bloom strength'),
      threshold: numberInRange(bloom.threshold, 1, 0, 10, 'Bloom threshold'),
      radius: numberInRange(bloom.radius, 1, 0.1, 4, 'Bloom radius'),
    },
  };
}
