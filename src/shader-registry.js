// Tables that addons fill on import, kept apart from shaders.js and renderer.js so an addon can register without
// pulling either into its bundle, and a scene without the addon pays only for the empty slots.

/** Value of `material.tag` in the instance data; the vegetation addon adds `impostor`. */
export const materialTags = { armor: 1, floor: 2, water: 3, foliage: 4, terrain: 5, grass: 7, fire: 8, smoke: 9, unlit: 10, liquid: 11, foam: 12 };

/**
 * GLSL the vegetation addon splices into the shaders: `declarations`, `colorHook` and `normalHook` in the colour vertex
 * shader, `depthHook` in the shadow vertex shader and `alphaCoverage` in the fragment shader's surfaceAlpha.
 */
export const addonGlsl = { declarations: '', colorHook: '', normalHook: '', depthHook: '', alphaCoverage: '' };

export function registerAddonGlsl(slots) {
  Object.assign(addonGlsl, slots);
}
