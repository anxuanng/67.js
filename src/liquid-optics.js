// The liquid and foam optics a frame may set. Kept apart from the liquid pass so the recipe look can check them without the pass.
// Each entry is [default, minimum, maximum].
export const LIQUID_OPTICS = {
  thickness: [0.5, 0, 100],
  ior: [1.33, 1, 3],
  refraction: [1, 0, 4],
  scattering: [1, 0, 10],
  foamOpacity: [0.55, 0, 1],
  foamSoftness: [1, 0, 1],
};

export function resolveLiquidOptics(options = {}) {
  const optics = {};
  for (const name in LIQUID_OPTICS) {
    optics[name] = LIQUID_OPTICS[name][0];
  }
  Object.assign(optics, options);
  for (const name in LIQUID_OPTICS) {
    const [, minimum, maximum] = LIQUID_OPTICS[name];
    const value = optics[name];
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`liquid.${name} must be between ${minimum} and ${maximum}.`);
  }
  return optics;
}
