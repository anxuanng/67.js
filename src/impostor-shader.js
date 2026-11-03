// GLSL for the `impostor` material tag: one camera-facing card per tree that shows the nearest baked view.
// The card is a quad with corners (+-radius, centerHeight +- radius, 0) and uv (0..1, 0 at the top), built by
// vegetation-impostors.js; the shader recovers radius and center height from any one corner, so the card needs no
// extra attribute. The same function runs in the colour and shadow vertex shaders: in the shadow pass the "eye" is
// the light, so the card shows the tree as the sun sees it.

import { materialTags, registerAddonGlsl } from './shader-registry.js';

/** Frames per side of the hemi-octahedral atlas (the atlas holds this many squared views). */
export const IMPOSTOR_FRAMES = 8;
/** The value of `material.tag === 'impostor'` in the instance data. */
export const IMPOSTOR_TAG = 13;

export const impostorShader = `
// Hemi-octahedral cell of a direction in the tree's own frame; the upper hemisphere fills the square.
vec2 impostorCell(vec3 localDirection) {
  vec3 folded = vec3(localDirection.x, max(localDirection.y, 0.0), localDirection.z);
  folded /= max(abs(folded.x) + folded.y + abs(folded.z), 0.00001);
  vec2 square = vec2(folded.x + folded.z, folded.x - folded.z) * 0.5 + 0.5;
  return clamp(floor(square * ${IMPOSTOR_FRAMES}.0), 0.0, ${IMPOSTOR_FRAMES - 1}.0);
}

// Returns the world position of this corner and the atlas uv of the nearest view. clipMatrix is the matrix of the pass
// (camera or light); the eye is where it projects to w = 0, or for an orthographic pass a direction.
vec3 impostorCard(vec3 localPosition, vec2 corner, mat4 modelMatrix, mat4 clipMatrix, float seconds, float strength, out vec2 atlasUv, out vec3 cardNormal) {
  vec2 side = vec2(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0);
  float radius = abs(localPosition.x);
  float centerHeight = localPosition.y - side.y * radius;
  vec3 center = (modelMatrix * vec4(0.0, centerHeight, 0.0, 1.0)).xyz;
  vec4 apex = inverse(clipMatrix) * vec4(0.0, 0.0, 1.0, 0.0);
  vec3 toEye = normalize(abs(apex.w) > 0.000001 ? apex.xyz / apex.w - center : -apex.xyz);
  vec3 right = cross(vec3(0.0, 1.0, 0.0), toEye);
  float rightLength = length(right);
  right = rightLength > 0.001 ? right / rightLength : vec3(1.0, 0.0, 0.0);
  vec3 cardUp = cross(toEye, right);
  cardNormal = toEye;
  float scale = length(modelMatrix[0].xyz);
  vec3 localDirection = normalize(transpose(mat3(modelMatrix)) * toEye);
  atlasUv = (impostorCell(localDirection) + corner) / ${IMPOSTOR_FRAMES}.0;
  float heightFraction = side.y * 0.5 + 0.5;
  float sway = sin(seconds * 1.2 + center.z * 0.31 + center.x * 0.17) * strength * 0.05 * radius * heightFraction * heightFraction;
  return center + (right * (side.x * radius + sway) + cardUp * side.y * radius) * scale;
}
`;

// The hooks sit in main() of the colour and shadow vertex shaders (shaders.js); importing this module installs them.
materialTags.impostor = IMPOSTOR_TAG;

// A fade carries its coverage in the opacity: 1 plus the coverage for the outgoing side, 2 plus it for the incoming side.
const ALPHA_COVERAGE = `  if (materialOpacity > 1.0) {
    float biased = materialOpacity - 1.0;
    bool incoming = biased > 1.0;
    float coverage = incoming ? biased - 1.0 : biased;
    float threshold = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (textureAlpha < alphaCutoff || (incoming ? coverage < 1.0 - threshold : coverage <= threshold)) discard;
    return 1.0;
  }
`;

registerAddonGlsl({
  alphaCoverage: ALPHA_COVERAGE,
  declarations: impostorShader,
  colorHook: `  vec3 impostorNormal = vec3(0.0, 1.0, 0.0);
  bool isImpostor = instanceSurface.w == ${IMPOSTOR_TAG}.0;
  if (isImpostor) {
    vec2 atlasUv;
    world.xyz = impostorCard(position, uv, instanceMatrix, viewProjection, time, wind, atlasUv, impostorNormal);
    uv = atlasUv;
  }
`,
  normalHook: `  if (isImpostor) worldNormal = impostorNormal;
`,
  depthHook: `  if (instanceSurface.w == ${IMPOSTOR_TAG}.0) {
    vec3 lightFacing;
    world.xyz = impostorCard(position, uv, instanceMatrix, lightProjection, time, wind, shadowUv, lightFacing);
  }
`,
});
