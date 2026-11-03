// The GLSL slots that the impostor card fills into the vertex shaders. They live apart from shaders.js so that the
// vegetation addon can register its code without pulling every shader into its bundle.

export const impostorGlsl = { declarations: '', colorHook: '', normalHook: '', depthHook: '' };

/** Register the GLSL of the impostor card: declarations, colorHook and normalHook (colour pass), depthHook (shadow pass). */
export function registerImpostorShaderCode(slots) {
  Object.assign(impostorGlsl, slots);
}
