import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';
import { validateSubsurface, subsurfaceUniformValues } from './subsurface-limits.js';

// Shader code for the material `subsurface` block (skin, wax, leaves). It lives outside shaders.js so a scene without a
// subsurface part never downloads or compiles it: the renderer asks for the `subsurface` feature only when a part has a
// subsurface weight above 0, and importing this module (or loading it through loadAgentSceneModules) registers it.
// The GLSL has no comments, because comments ship to every page. What it does:
// - The base lighting is untouched. Subsurface adds a correction on top, scaled by the weight, so weight 0 is today's picture.
// - Per colour channel the sun's diffuse light is wrapped past the terminator by a width that grows with the mean free path
//   (radius times scale, metres): (n.l + w) / (1 + w)^2, which keeps the total diffuse energy of a Lambert surface. Red
//   travels furthest, so the shadow edge turns red on skin.
// - Light that reaches a surface from behind passes through the part. Its thickness along the sun comes from four to five
//   comparison fetches of the sun shadow map at growing depths (the map only answers lit or shadowed), and each channel keeps
//   exp(-thickness / mean free path). A thin leaf has thickness near 0 and glows when the sun is behind it; a head blocks it.
//   max(n.l) of the back face (BACK_TRANSLUCENCY) is the light that leaves a thin part on the side the camera sees.
// - Only the sun is treated; point, spot and area lights keep their plain diffuse.

const REFERENCE_LENGTH = '0.1';
const BACK_TRANSLUCENCY = '1.0';

const SUBSURFACE_DECLARATIONS = `uniform vec4 materialSubsurface;
uniform vec3 materialSubsurfaceColor;
uniform mat4 lightProjection;
`;

const SUBSURFACE_LIBRARIES = `float sunThickness(float reference) {
  vec3 projected = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 0.0;
  float unit = reference * abs(lightProjection[2][2]) * 0.5;
  float depth = projected.z - shadowBiasPerSlope;
  float thickness = 0.0;
  thickness += (1.0 - texture(shadowMap, vec3(projected.xy, depth - 0.25 * unit))) * 0.25;
  thickness += (1.0 - texture(shadowMap, vec3(projected.xy, depth - 0.5 * unit))) * 0.25;
  thickness += (1.0 - texture(shadowMap, vec3(projected.xy, depth - unit))) * 0.5;
  thickness += (1.0 - texture(shadowMap, vec3(projected.xy, depth - 2.0 * unit)));
  thickness += (1.0 - texture(shadowMap, vec3(projected.xy, depth - 4.0 * unit))) * 2.0;
  return thickness * reference;
}

vec3 subsurfaceLight(vec3 normal, vec3 baseColor, float visibility) {
  vec3 mean = materialSubsurface.yzw;
  vec3 tint = materialSubsurfaceColor.x < 0.0 ? baseColor : materialSubsurfaceColor;
  float facing = dot(normal, normalize(lightDirection));
  vec3 wrap = mean / (mean + ${REFERENCE_LENGTH});
  vec3 spread = max((facing + wrap) / ((1.0 + wrap) * (1.0 + wrap)), 0.0) + max(-facing, 0.0) * ${BACK_TRANSLUCENCY};
  float thickness = visibility < 1.0 ? sunThickness(max(mean.x, max(mean.y, mean.z))) : 0.0;
  vec3 reach = max(vec3(visibility), exp(-thickness / max(mean, vec3(0.0001))));
  vec3 gained = tint * reach * spread - baseColor * visibility * max(facing, 0.0);
  return materialSubsurface.x * gained * keyColor / PI;
}
`;

const SUBSURFACE_LIGHT = `  if (materialSubsurface.x > 0.0) radiance = max(radiance + (1.0 - metallic) * subsurfaceLight(normal, color, visibility), vec3(0.0));
`;

registerShaderFeatureCode('subsurface', Object.freeze({
  declarations: SUBSURFACE_DECLARATIONS,
  libraries: SUBSURFACE_LIBRARIES,
  worldLight: SUBSURFACE_LIGHT,
}));

const LAYER_STATE_SUBSURFACE = 23;
const NO_SUBSURFACE = [0, 0, 0, 0, -1, -1, -1];
const valuesOfState = new Map();

// The renderer batches by the block's JSON (material-layers.js); the numbers come from parsing it once per distinct block.
function uniformValuesOf(state) {
  if (!valuesOfState.has(state)) {
    const block = JSON.parse(state);
    validateSubsurface(block);
    valuesOfState.set(state, subsurfaceUniformValues(block));
  }
  return valuesOfState.get(state);
}

/** Checks a recipe material's subsurface block and returns a copy. Called by createAgentScene once this module is loaded. */
export function copySubsurface(block, tag) {
  validateSubsurface(block, tag);
  return structuredClone(block);
}

function uniformOf(renderer, name) {
  renderer.uniforms[name] ??= renderer.context.getUniformLocation(renderer.program, name);
  return renderer.uniforms[name];
}

// Other optional features also bind per batch, so this keeps whatever was registered first.
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  if (!renderer.shaderFeatures?.has('subsurface')) return;
  const context = renderer.context;
  const state = layerState[LAYER_STATE_SUBSURFACE];
  const [weight, red, green, blue, colorRed, colorGreen, colorBlue] = state ? uniformValuesOf(state) : NO_SUBSURFACE;
  context.uniform4f(uniformOf(renderer, 'materialSubsurface'), weight, red, green, blue);
  context.uniform3f(uniformOf(renderer, 'materialSubsurfaceColor'), colorRed, colorGreen, colorBlue);
};
