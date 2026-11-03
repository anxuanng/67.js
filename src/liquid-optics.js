// The liquid and foam optics a frame may set. Kept apart from the liquid pass so the recipe look can check them without the pass.
const DEFAULT_LIQUID = Object.freeze({ thickness: 0.5, ior: 1.33, refraction: 1, scattering: 1, foamOpacity: 0.55, foamSoftness: 1 });

export function resolveLiquidOptics(options = {}) {
  const optics = { ...DEFAULT_LIQUID, ...options };
  for (const [name, minimum, maximum] of [['thickness', 0, 100], ['ior', 1, 3], ['refraction', 0, 4], ['scattering', 0, 10], ['foamOpacity', 0, 1], ['foamSoftness', 0, 1]]) {
    const value = optics[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`liquid.${name} must be between ${minimum} and ${maximum}.`);
  }
  return optics;
}
