import { MAX_MORPH_TARGETS } from './morph.js';
import { environmentLookupGlsl, environmentShadingGlsl } from './environment.js';
import { splatGlsl } from './splat-shader.js';

const morphingShader = `
uniform float morphEnabled;
uniform int morphVertexCount;
uniform int morphTargetCount;
uniform float morphWeights[${MAX_MORPH_TARGETS}];
uniform highp sampler2D morphTargets;
vec3 morphDelta(int target, int channel) {
  int index = (target * morphVertexCount + gl_VertexID) * 2 + channel;
  int width = textureSize(morphTargets, 0).x;
  return texelFetch(morphTargets, ivec2(index % width, index / width), 0).xyz;
}
vec3 morphedPosition(vec3 base) {
  if (morphEnabled < 0.5) return base;
  vec3 result = base;
  for (int target = 0; target < ${MAX_MORPH_TARGETS}; target++) {
    if (target >= morphTargetCount) break;
    if (morphWeights[target] != 0.0) result += morphDelta(target, 0) * morphWeights[target];
  }
  return result;
}
vec3 morphedNormal(vec3 base) {
  if (morphEnabled < 0.5) return base;
  vec3 result = base;
  for (int target = 0; target < ${MAX_MORPH_TARGETS}; target++) {
    if (target >= morphTargetCount) break;
    if (morphWeights[target] != 0.0) result += morphDelta(target, 1) * morphWeights[target];
  }
  float largest = max(max(abs(result.x), abs(result.y)), abs(result.z));
  return largest > 0.0 ? normalize(result / largest) : base;
}
`;

const skinningShader = `
uniform float skinEnabled;
uniform highp sampler2D skinInfluences;
uniform highp sampler2D jointPalette;
vec4 skinTexel(sampler2D source, int index) {
  int width = textureSize(source, 0).x;
  return texelFetch(source, ivec2(index % width, index / width), 0);
}
mat4 jointMatrix(int joint) {
  int offset = joint * 4;
  return mat4(skinTexel(jointPalette, offset), skinTexel(jointPalette, offset + 1),
    skinTexel(jointPalette, offset + 2), skinTexel(jointPalette, offset + 3));
}
mat4 skinTransform() {
  if (skinEnabled < 0.5) return mat4(1.0);
  ivec4 joints = ivec4(skinTexel(skinInfluences, gl_VertexID * 2));
  vec4 weights = skinTexel(skinInfluences, gl_VertexID * 2 + 1);
  return jointMatrix(joints.x) * weights.x + jointMatrix(joints.y) * weights.y
    + jointMatrix(joints.z) * weights.z + jointMatrix(joints.w) * weights.w;
}
`;

// Wind for the foliage (4) and grass (7) tags, shared by the colour and shadow vertex shaders so both
// move identically. It depends only on local position, the card's uv, world position and time.
// The slow sway grows with height and with distance from the model's vertical axis (branch tips swing
// more than the crown centre) but is capped, because bark never moves and leaves must stay near their twigs.
// uv.y is 1 at a leaf's base and 0 at its tip, which drives the faster flutter.
const windShader = `
// Grass bends by how far up the blade a vertex is (uv.y is 1 at the root), so it ignores terrain height.
// Gusts roll across the field as a travelling wave along the wind direction, like the rolling bands in a meadow.
vec3 grassWind(vec3 worldPoint, vec2 leafUv, float seconds, float strength) {
  float tip = clamp(1.0 - leafUv.y, 0.0, 1.0);
  float bendWeight = tip * tip;
  vec2 windDirection = vec2(0.94, 0.34);
  float along = dot(worldPoint.xz, windDirection);
  float gust = 0.5 + 0.5 * sin(along * 0.32 - seconds * 1.7 + 2.0 * sin(worldPoint.x * 0.05 - worldPoint.z * 0.04 + seconds * 0.23));
  float push = (0.3 + 0.7 * gust * gust) * strength;
  float flutter = sin(seconds * 4.7 + worldPoint.x * 2.3 + worldPoint.z * 1.9) * strength;
  vec2 offset = windDirection * (push * 0.42 + flutter * 0.05) + vec2(-windDirection.y, windDirection.x) * flutter * 0.04;
  return vec3(offset.x, -push * 0.14, offset.y) * bendWeight;
}

vec3 windOffset(vec3 localPosition, vec3 worldPoint, vec2 leafUv, float surfaceTag, float seconds, float strength) {
  // Grass without UVs (uv is (-1, -1)) has no blade coordinate, so it keeps the height-based sway below.
  if (surfaceTag == 7.0 && leafUv.x > -0.5) return grassWind(worldPoint, leafUv, seconds, strength);
  if (surfaceTag != 4.0 && surfaceTag != 7.0) return vec3(0.0);
  float heightReach = min(max(localPosition.y + 0.5, 0.0), 2.5);
  float branchReach = 1.0 + 0.3 * min(length(localPosition.xz), 3.0);
  float sway = sin(seconds * 1.2 + worldPoint.z * 0.31 + worldPoint.x * 0.17) * strength * 0.10 * heightReach * branchReach;
  float tip = clamp(1.0 - leafUv.y, 0.0, 1.0);
  float flutter = sin(seconds * 3.1 + worldPoint.x * 1.7 + worldPoint.z * 1.3 + localPosition.y * 2.0) * strength * 0.08 * tip;
  return vec3(sway + flutter, 0.0, flutter * 0.6);
}
`;

export const vertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in mat4 instanceMatrix;
layout(location=6) in mat3 instanceNormal;
layout(location=9) in vec3 instanceColor;
layout(location=10) in vec4 instanceSurface;
layout(location=11) in vec3 assemblyOffset;
layout(location=12) in vec3 assemblyDetailOffset;
layout(location=13) in vec2 uv;
layout(location=14) in vec3 vertexColor;
layout(location=15) in vec3 instanceEmissive;
uniform mat4 viewProjection;
uniform mat4 lightProjection;
uniform float time;
uniform float wind;
uniform float explosionProgress;
uniform vec3 explosionCenter;
uniform float assemblyAmount;
out vec3 worldPosition;
out vec3 worldNormal;
flat out vec3 baseColor;
flat out vec4 surface;
out vec4 shadowPosition;
out vec2 textureUV;
out vec3 vertexTint;
flat out vec3 emissionColor;
flat out float instanceOrdinal;
out vec3 boxPosition;
out vec3 boxNormal;
flat out mat3 boxNormalMatrix;
${skinningShader}
${morphingShader}
${windShader}
void main() {
  mat4 deformation = skinTransform();
  vec4 world = instanceMatrix * deformation * vec4(morphedPosition(position), 1.0);
  world.xyz += assemblyOffset * assemblyAmount + assemblyDetailOffset * smoothstep(0.3, 1.0, assemblyAmount);
  world.xyz += windOffset(position, world.xyz, uv, instanceSurface.w, time, wind);
  if (instanceSurface.w == 3.0) {
    world.y += sin(world.x * 1.4 + time * 0.8) * 0.025 + sin(world.z * 1.8 - time) * 0.02;
  }
  if (instanceSurface.w == 8.0 || instanceSurface.w == 9.0) {
    world.xyz = mix(explosionCenter, world.xyz, 0.03 + explosionProgress * 0.97);
  }
  worldPosition = world.xyz;
  vec3 localNormal = morphedNormal(normal);
  vec3 deformedNormal = skinEnabled > 0.5 ? transpose(inverse(mat3(deformation))) * localNormal : localNormal;
  worldNormal = normalize(instanceNormal * deformedNormal);
  // Metres along the object's own axes, so a pattern follows a moving node and is not stretched by its scale.
  boxPosition = morphedPosition(position) * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  boxNormal = deformedNormal;
  boxNormalMatrix = instanceNormal;
  baseColor = instanceColor;
  textureUV = uv;
  vertexTint = vertexColor;
  emissionColor = instanceEmissive;
  instanceOrdinal = float(gl_InstanceID);
  surface = instanceSurface;
  shadowPosition = lightProjection * world;
  gl_Position = viewProjection * world;
}`;

export const depthVertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=2) in mat4 instanceMatrix;
layout(location=10) in vec4 instanceSurface;
layout(location=11) in vec3 assemblyOffset;
layout(location=12) in vec3 assemblyDetailOffset;
layout(location=13) in vec2 uv;
uniform mat4 lightProjection;
uniform float assemblyAmount;
uniform float time;
uniform float wind;
out vec2 textureUV;
${skinningShader}
${morphingShader}
${windShader}
void main() {
  vec4 world = instanceMatrix * skinTransform() * vec4(morphedPosition(position), 1.0);
  world.xyz += assemblyOffset * assemblyAmount + assemblyDetailOffset * smoothstep(0.3, 1.0, assemblyAmount);
  // Same displacement as the colour pass, so shadows follow the swaying leaves.
  world.xyz += windOffset(position, world.xyz, uv, instanceSurface.w, time, wind);
  textureUV = uv;
  gl_Position = lightProjection * world;
}`;

// Only masked batches sample the base map, so shadows follow the cutout.
export const depthFragmentShader = `#version 300 es
precision highp float;
in vec2 textureUV;
uniform float alphaMasked;
uniform float alphaCutoff;
uniform float materialOpacity;
uniform float hasBaseMap;
uniform sampler2D baseMap;
void main() {
  if (alphaMasked < 0.5) return;
  float alpha = materialOpacity;
  if (hasBaseMap > 0.5) alpha *= texture(baseMap, textureUV).a;
  if (alpha < alphaCutoff) discard;
}
`;

export const benchmarkVertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=2) in mat4 instanceMatrix;
layout(location=9) in vec3 instanceColor;
uniform mat4 viewProjection;
out vec3 color;
${skinningShader}
${morphingShader}
void main() {
  color = instanceColor;
  gl_Position = viewProjection * instanceMatrix * skinTransform() * vec4(morphedPosition(position), 1.0);
}`;

export const benchmarkFragmentShader = `#version 300 es
precision highp float;
in vec3 color;
out vec4 outputColor;
void main() { outputColor = vec4(color, 1.0); }
`;

// Liquid and foam are drawn after the opaque scene, which is resolved into sceneColor first.
// Liquid: refraction through the scene, Beer-Lambert absorption over a convex-body thickness
// estimate, in-scattering, Fresnel environment reflection and a GGX key highlight.
// Foam: soft blended droplets whose alpha falls off toward their silhouettes.
export const liquidFragmentShader = `#version 300 es
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
flat in vec3 baseColor;
flat in vec4 surface;
in vec4 shadowPosition;
in vec2 textureUV;
in vec3 vertexTint;
flat in vec3 emissionColor;
uniform vec3 eye;
uniform mat4 viewProjection;
uniform sampler2D sceneColor;
uniform vec2 resolution;
uniform float exposure;
uniform float hdrEnabled;
uniform float worldMode;
uniform float daylight;
uniform vec3 lightDirection;
uniform vec3 keyColor;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
// x: thickness in metres, y: index of refraction, z: refraction strength, w: scattering
uniform vec4 liquidOptics;
// A transmissive PBR material: x: transmission, y: index of refraction, z: thickness in metres, w: attenuation distance
uniform vec4 glassState;
uniform vec3 glassTint;
// x: foam opacity, y: foam edge softness
uniform vec2 foamShape;
out vec4 outputColor;
const float PI = 3.14159265359;

vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}

${environmentLookupGlsl}
uniform float environmentEnabled;

vec3 environmentColor(vec3 direction, float roughness) {
  if (environmentEnabled > 0.5) return environmentRadiance(direction, roughness * environmentLevelMax);
  if (worldMode > 0.5) {
    vec3 zenith = vec3(0.20, 0.38, 0.52) * max(daylight, 0.08);
    return mix(fogColor * 0.75, zenith, smoothstep(-0.15, 0.7, direction.y));
  }
  vec3 color = mix(vec3(0.025, 0.035, 0.045), vec3(0.22, 0.25, 0.27), smoothstep(-0.3, 0.8, direction.y));
  float blur = roughness * 0.35;
  float key = smoothstep(0.80 - blur, 0.87, dot(direction, normalize(vec3(-3.0, 5.0, 4.0))));
  float rim = smoothstep(0.90 - blur, 0.97, dot(direction, normalize(vec3(4.0, 2.0, -3.0))));
  float strip = exp(-pow((direction.x + 0.6) / (0.035 + blur), 2.0)) * smoothstep(-0.1, 0.6, direction.y);
  return color + key * vec3(2.8, 2.2, 1.6) + rim * vec3(0.5, 1.6, 1.5) + strip * vec3(0.7);
}

float specularLobe(vec3 normal, vec3 viewDirection, vec3 light, float roughness) {
  float normalLight = max(dot(normal, light), 0.0);
  if (normalLight == 0.0) return 0.0;
  vec3 halfway = normalize(viewDirection + light);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float normalHalf = max(dot(normal, halfway), 0.0);
  float alpha = roughness * roughness;
  float denominator = normalHalf * normalHalf * (alpha * alpha - 1.0) + 1.0;
  float distribution = alpha * alpha / max(PI * denominator * denominator, 0.00001);
  float masking = pow(roughness + 1.0, 2.0) / 8.0;
  float geometry = normalView / (normalView * (1.0 - masking) + masking) * normalLight / (normalLight * (1.0 - masking) + masking);
  return distribution * geometry / max(4.0 * normalView * normalLight, 0.001) * normalLight;
}

vec3 ambientLight(vec3 normal) {
  vec3 studioAmbient = vec3(0.16, 0.20, 0.22) * (0.45 + 0.55 * max(normal.y, 0.0));
  vec3 worldAmbient = vec3(0.19, 0.25, 0.30) * max(daylight, 0.08) * (0.45 + 0.55 * max(normal.y, 0.0));
  return mix(studioAmbient, worldAmbient, worldMode) * ambientIntensity;
}

vec3 displayed(vec3 radiance) {
  return hdrEnabled > 0.5 ? clamp(radiance * exposure, vec3(0), vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2));
}

void main() {
  vec3 normal = normalize(worldNormal);
  if (!gl_FrontFacing) normal = -normal;
  vec3 viewDirection = normalize(eye - worldPosition);
  float facing = max(dot(normal, viewDirection), 0.0);
  vec3 light = normalize(lightDirection);
  vec3 color = baseColor * vertexTint;
  float fog = (1.0 - exp(-length(worldPosition - eye) * fogDensity)) * worldMode;

  if (surface.w == 12.0) {
    float alpha = foamShape.x * smoothstep(0.0, max(foamShape.y, 0.001), facing);
    if (alpha < 0.004) discard;
    float wrapped = max(dot(normal, light) * 0.5 + 0.5, 0.0);
    vec3 radiance = color * (ambientLight(normal) * 1.6 + keyColor * wrapped * 0.32);
    radiance = mix(radiance, fogColor, fog);
    outputColor = vec4(displayed(radiance), alpha);
    return;
  }

  float roughness = clamp(surface.y, 0.02, 1.0);
  vec2 screen = gl_FragCoord.xy / resolution;
  // A convex body is thickest where it faces the camera and thins to nothing at its silhouette.
  bool glass = glassState.x > 0.0;
  float indexOfRefraction = glass ? glassState.y : liquidOptics.y;
  float thickness = (glass ? glassState.z : liquidOptics.x) * mix(0.15, 1.0, facing);
  vec3 bent = refract(-viewDirection, normal, 1.0 / indexOfRefraction);
  vec4 projected = viewProjection * vec4(worldPosition + bent * thickness, 1.0);
  vec2 refracted = projected.w > 0.0 ? projected.xy / projected.w * 0.5 + 0.5 : screen;
  refracted = clamp(mix(screen, refracted, glass ? 1.0 : liquidOptics.z), vec2(0.001), vec2(0.999));
  vec3 behind = texture(sceneColor, refracted).rgb;
  // The material colour is what one metre of this liquid lets through.
  // For a PBR material the colour tints what passes through and the attenuation colour is what attenuationDistance metres let through.
  vec3 absorption = pow(clamp(glass ? glassTint : color, vec3(0.001), vec3(1.0)), vec3(glass ? thickness / glassState.w : thickness));
  vec3 transmittance = glass ? color * absorption : absorption;
  float surfaceReflectance = pow((indexOfRefraction - 1.0) / (indexOfRefraction + 1.0), 2.0);
  float reflectance = surfaceReflectance + (1.0 - surfaceReflectance) * pow(1.0 - facing, 5.0);
  vec3 inScatter = color * (ambientLight(normal) + keyColor * max(dot(normal, light), 0.0) * 0.2) * (glass ? 0.0 : liquidOptics.w) * (1.0 - transmittance);
  // The share of a PBR material that does not transmit is lit like a diffuse surface.
  vec3 diffuseShare = glass ? color * (1.0 - glassState.x) * (ambientLight(normal) + keyColor * max(dot(normal, light), 0.0) / PI) : vec3(0.0);
  vec3 reflection = environmentColor(reflect(-viewDirection, normal), roughness) * ambientIntensity;
  vec3 highlight = keyColor * specularLobe(normal, viewDirection, light, roughness);
  vec3 surfaceLight = (inScatter + diffuseShare) * (1.0 - reflectance) + reflection * reflectance + highlight;
  surfaceLight = mix(surfaceLight, fogColor, fog);
  float transmitted = glass ? glassState.x : 1.0;
  outputColor = vec4(behind * transmittance * transmitted * (1.0 - reflectance) * (1.0 - fog) + displayed(surfaceLight), 1.0);
}`;

function buildFragmentShader(featureDefines, featureCode) {
  return `#version 300 es
${featureDefines}
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
flat in vec3 baseColor;
flat in vec4 surface;
in vec4 shadowPosition;
in vec2 textureUV;
in vec3 vertexTint;
flat in vec3 emissionColor;
flat in float instanceOrdinal;
uniform vec3 eye;
uniform float renderPassMode;
uniform float renderPassDepthRange;
uniform float renderPassObjectBase;
uniform vec3 armorColor;
uniform vec2 armorSurface;
uniform float exposure;
uniform float inspection;
uniform float worldMode;
uniform float time;
uniform float daylight;
uniform vec3 lightDirection;
uniform int pointLightCount;
uniform vec4 pointLightPositions[8];
uniform vec4 pointLightColors[8];
uniform float pointLightRadii[8];
uniform float pointLightShadowTiles[8];
uniform int spotLightCount;
uniform vec4 spotLightPositions[8];
uniform vec4 spotLightColors[8];
uniform vec4 spotLightDirections[8];
uniform vec4 spotLightParameters[8];
uniform int areaLightCount;
uniform vec4 areaLightPositions[4];
uniform vec4 areaLightColors[4];
uniform vec4 areaLightNormals[4];
uniform vec4 areaLightTangents[4];
uniform sampler2D localShadowAtlas;
uniform mat4 localShadowMatrices[24];
uniform float localShadowTexelAngles[24];
uniform vec3 keyColor;
uniform float fillIntensity;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 waterRipple;
uniform float rippleTime;
uniform float explosionProgress;
uniform sampler2D shadowMap;
uniform sampler2D baseMap;
uniform float hasBaseMap;
uniform sampler2D normalMap;
uniform sampler2D metallicRoughnessMap;
uniform sampler2D occlusionMap;
uniform sampler2D emissiveMap;
uniform float hasNormalMap;
uniform float hasMetallicRoughnessMap;
uniform float hasOcclusionMap;
uniform float hasEmissiveMap;
uniform vec2 normalScale;
uniform float occlusionStrength;
in vec3 boxPosition;
in vec3 boxNormal;
flat in mat3 boxNormalMatrix;
uniform float boxMapScale;
uniform int boxMapAxis;
// Dielectric reflectance at normal incidence, clear coat (strength, roughness) and sheen (colour, roughness)
uniform vec3 materialDielectric;
uniform vec2 materialCoat;
uniform vec4 materialSheen;
uniform vec4 materialMoss;
uniform float hdrEnabled;
uniform float alphaMode;
uniform float alphaCutoff;
uniform float materialOpacity;
uniform float alphaToCoverage;
uniform float doubleSided;
out vec4 outputColor;
const float PI = 3.14159265359;

float terrainHash(vec2 position) {
  vec3 seed = fract(vec3(position.xyx) * 0.1031);
  seed += dot(seed, seed.yzx + 33.33);
  return fract((seed.x + seed.y) * seed.z);
}

// Value noise and its analytic gradient avoid extra texture fetches for sand relief.
vec3 terrainNoise(vec2 position) {
  vec2 cell = floor(position);
  vec2 fraction = fract(position);
  vec2 blend = fraction * fraction * (3.0 - 2.0 * fraction);
  vec2 derivative = 6.0 * fraction * (1.0 - fraction);
  float lowerLeft = terrainHash(cell);
  float lowerRight = terrainHash(cell + vec2(1.0, 0.0));
  float upperLeft = terrainHash(cell + vec2(0.0, 1.0));
  float upperRight = terrainHash(cell + vec2(1.0, 1.0));
  float lower = mix(lowerLeft, lowerRight, blend.x);
  float upper = mix(upperLeft, upperRight, blend.x);
  return vec3(mix(lower, upper, blend.y),
    mix(lowerRight - lowerLeft, upperRight - upperLeft, blend.y) * derivative.x,
    (upper - lower) * derivative.y);
}

vec3 fresnel(float cosine, vec3 reflectance) {
  return reflectance + (1.0 - reflectance) * pow(1.0 - cosine, 5.0);
}

float filteredShadow(vec2 coordinates, float receiverDepth, ivec2 dimensions) {
  vec2 pixel = coordinates * vec2(dimensions) - 0.5;
  ivec2 origin = ivec2(floor(pixel));
  vec2 blend = fract(pixel);
  ivec2 maximum = dimensions - 1;
  float lowerLeft = step(receiverDepth, texelFetch(shadowMap, clamp(origin, ivec2(0), maximum), 0).r);
  float lowerRight = step(receiverDepth, texelFetch(shadowMap, clamp(origin + ivec2(1, 0), ivec2(0), maximum), 0).r);
  float upperLeft = step(receiverDepth, texelFetch(shadowMap, clamp(origin + ivec2(0, 1), ivec2(0), maximum), 0).r);
  float upperRight = step(receiverDepth, texelFetch(shadowMap, clamp(origin + ivec2(1, 1), ivec2(0), maximum), 0).r);
  return mix(mix(lowerLeft, lowerRight, blend.x), mix(upperLeft, upperRight, blend.x), blend.y);
}

float shadowVisibility(vec3 normal) {
  vec3 projected = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  float bias = max(0.0006, 0.002 * (1.0 - dot(normal, normalize(lightDirection))));
  float visibility = 0.0;
  ivec2 dimensions = textureSize(shadowMap, 0);
  vec2 texel = 1.0 / vec2(dimensions);
  for (int row = -1; row <= 1; row++) {
    for (int column = -1; column <= 1; column++) {
      float comparison = filteredShadow(projected.xy + vec2(column, row) * texel * 2.5, projected.z - bias, dimensions);
      visibility += mix(0.18, 1.0, comparison);
    }
  }
  return visibility / 9.0;
}

// Atlas tiles are 512 texels square on a 4 x 4 grid. The receiver is pushed off its surface by about two shadow texels,
// which removes acne without a depth bias that grows with distance.
float localShadowVisibility(float tile, vec3 position, vec3 normal, float lightDistance) {
  int tileIndex = int(tile);
  vec3 shifted = position + normal * (lightDistance * localShadowTexelAngles[tileIndex] * 2.0);
  vec4 clip = localShadowMatrices[tileIndex] * vec4(shifted, 1.0);
  if (clip.w <= 0.0) return 1.0;
  vec3 projected = clip.xyz / clip.w * 0.5 + 0.5;
  if (projected.z > 1.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  ivec2 tileOrigin = ivec2(tileIndex % 4, tileIndex / 4) * 512;
  vec2 pixel = projected.xy * 512.0 - 0.5;
  ivec2 corner = ivec2(floor(pixel));
  vec2 blend = fract(pixel);
  float receiverDepth = projected.z - 0.00002;
  float lit[4];
  for (int tap = 0; tap < 4; tap++) {
    ivec2 texel = clamp(corner + ivec2(tap & 1, tap >> 1), ivec2(0), ivec2(511));
    lit[tap] = step(receiverDepth, texelFetch(localShadowAtlas, tileOrigin + texel, 0).r);
  }
  return mix(mix(lit[0], lit[1], blend.x), mix(lit[2], lit[3], blend.x), blend.y);
}

// Cube face of a point light's shadow, in the order +X, -X, +Y, -Y, +Z, -Z.
float pointShadowFace(vec3 fromLight) {
  vec3 magnitude = abs(fromLight);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) return fromLight.x < 0.0 ? 1.0 : 0.0;
  if (magnitude.y >= magnitude.z) return fromLight.y < 0.0 ? 3.0 : 2.0;
  return fromLight.z < 0.0 ? 5.0 : 4.0;
}

float localAttenuation(float distanceSquared, float range, float radius) {
  float cutoff = 1.0;
  if (range > 0.0) {
    float squaredRatio = distanceSquared / (range * range);
    float fade = max(1.0 - squaredRatio * squaredRatio, 0.0);
    cutoff = fade * fade;
  }
  return cutoff / max(distanceSquared, radius * radius);
}

vec3 studio(vec3 direction, float roughness) {
  vec3 color = mix(vec3(0.025, 0.035, 0.045), vec3(0.22, 0.25, 0.27), smoothstep(-0.3, 0.8, direction.y));
  float blur = roughness * 0.35;
  float key = smoothstep(0.80 - blur, 0.87, dot(direction, normalize(vec3(-3.0, 5.0, 4.0))));
  float rim = smoothstep(0.90 - blur, 0.97, dot(direction, normalize(vec3(4.0, 2.0, -3.0))));
  float strip = exp(-pow((direction.x + 0.6) / (0.035 + blur), 2.0)) * smoothstep(-0.1, 0.6, direction.y);
  return color + key * vec3(2.8, 2.2, 1.6) + rim * vec3(0.5, 1.6, 1.5) + strip * vec3(0.7);
}
${environmentLookupGlsl}
${environmentShadingGlsl}

${featureCode("declarations")}vec3 illuminate(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 radiance, vec3 color, float metallic, float roughness) {
  float normalLight = max(dot(normal, lightDirection), 0.0);
  if (normalLight == 0.0) return vec3(0);
  vec3 halfway = normalize(viewDirection + lightDirection);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float normalHalf = max(dot(normal, halfway), 0.0);
  float alpha = roughness * roughness;
  float denominator = normalHalf * normalHalf * (alpha * alpha - 1.0) + 1.0;
  float distribution = alpha * alpha / max(PI * denominator * denominator, 0.00001);
  float masking = pow(roughness + 1.0, 2.0) / 8.0;
  float geometry = normalView / (normalView * (1.0 - masking) + masking);
  geometry *= normalLight / (normalLight * (1.0 - masking) + masking);
  vec3 baseReflectance = mix(materialDielectric, color, metallic);
${featureCode("illuminateReflectance")}  vec3 reflectance = fresnel(max(dot(halfway, viewDirection), 0.0), baseReflectance);
  vec3 specular = distribution * geometry * reflectance / max(4.0 * normalView * normalLight, 0.001);
${featureCode("illuminateSpecular")}  vec3 diffuse = (1.0 - reflectance) * (1.0 - metallic) * color / PI;
  return (diffuse + specular) * radiance * normalLight;
}

vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}

// Box projection: three texture lookups along the object axes, blended by the normal, so a surface needs no UVs.
// Swapping two axes makes the texture's V direction, and with it a grain, run along the chosen axis.
vec3 boxAxisSwap(vec3 value) {
  if (boxMapAxis == 0) return value.yxz;
  if (boxMapAxis == 2) return value.xzy;
  return value;
}

vec3 boxWeights(vec3 direction) {
  vec3 weights = pow(abs(direction), vec3(8.0));
  return weights / max(weights.x + weights.y + weights.z, 1e-5);
}

vec4 sampleBox(sampler2D source) {
  vec3 coordinates = boxAxisSwap(boxPosition) * boxMapScale;
  vec3 weights = boxWeights(boxAxisSwap(normalize(boxNormal)));
  return texture(source, coordinates.zy) * weights.x + texture(source, coordinates.xz) * weights.y + texture(source, coordinates.xy) * weights.z;
}

// Whiteout blend of the three tangent-space normals, done in object space and then moved to world space.
vec3 boxMappedNormal(vec3 normal) {
  vec3 coordinates = boxAxisSwap(boxPosition) * boxMapScale;
  vec3 objectNormal = boxAxisSwap(normalize(boxNormal));
  vec3 weights = boxWeights(objectNormal);
  vec3 sampleX = texture(normalMap, coordinates.zy).xyz * 2.0 - 1.0;
  vec3 sampleY = texture(normalMap, coordinates.xz).xyz * 2.0 - 1.0;
  vec3 sampleZ = texture(normalMap, coordinates.xy).xyz * 2.0 - 1.0;
  vec3 blendX = vec3(sampleX.xy * normalScale + objectNormal.zy, abs(sampleX.z) * objectNormal.x);
  vec3 blendY = vec3(sampleY.xy * normalScale + objectNormal.xz, abs(sampleY.z) * objectNormal.y);
  vec3 blendZ = vec3(sampleZ.xy * normalScale + objectNormal.xy, abs(sampleZ.z) * objectNormal.z);
  vec3 blended = blendX.zyx * weights.x + blendY.xzy * weights.y + blendZ * weights.z;
  vec3 world = normalize(boxNormalMatrix * boxAxisSwap(blended));
  return dot(world, normal) < 0.0 ? -world : world;
}

vec3 mappedNormal(vec3 normal) {
  vec3 positionX = dFdx(worldPosition);
  vec3 positionY = dFdy(worldPosition);
  vec2 uvX = dFdx(textureUV);
  vec2 uvY = dFdy(textureUV);
  float uvScale = max(max(abs(uvX.x), abs(uvX.y)), max(abs(uvY.x), abs(uvY.y)));
  if (uvScale == 0.0) return normal;
  uvX /= uvScale;
  uvY /= uvScale;
  float determinant = uvX.x * uvY.y - uvX.y * uvY.x;
  // Degenerate UVs have no tangent basis and retain the geometric normal.
  if (abs(determinant) < 1e-7) return normal;
  vec3 tangent = (positionX * uvY.y - positionY * uvX.y) / determinant;
  vec3 bitangent = (positionY * uvX.x - positionX * uvY.x) / determinant;
  tangent -= normal * dot(normal, tangent);
  float tangentScale = max(max(abs(tangent.x), abs(tangent.y)), abs(tangent.z));
  if (tangentScale == 0.0) return normal;
  tangent /= tangentScale;
  tangent = normalize(tangent);
  float handedness = dot(cross(normal, tangent), bitangent) < 0.0 ? -1.0 : 1.0;
  bitangent = normalize(cross(normal, tangent)) * handedness;
  vec3 sampled = texture(normalMap, textureUV).xyz * 2.0 - 1.0;
  sampled.xy *= normalScale;
  vec3 mapped = mat3(tangent, bitangent, normal) * sampled;
  return dot(mapped, mapped) > 1e-12 ? normalize(mapped) : normal;
}

${splatGlsl}

// Moss is its own material over the base, not a tint: fully rough, a soft sheen at grazing angles and light that wraps
// through it. Two masks, as in offline moss shading: a sharp one decides where moss is shaded, and a blurred one lifts
// it into cushions, so its relief never turns into needles. Coverage favours up-facing surfaces.
void mossMasks(vec3 normal, float amount, out float sharpMask, out float softMask) {
  float facing = smoothstep(0.1, 0.7, normal.y);
  vec2 position = worldPosition.xz * 6.0 + worldPosition.y * vec2(2.3, -1.7);
  float patches = terrainNoise(position).x * 0.6 + terrainNoise(position * 2.7 + 5.1).x * 0.4;
  float threshold = 1.0 - amount;
  sharpMask = facing * smoothstep(threshold - 0.035, threshold + 0.035, patches);
  softMask = facing * smoothstep(threshold - 0.22, threshold + 0.18, patches);
}

// Opaque draws 1, mask resolves to a cutout (smooth coverage with MSAA) and blend keeps the fraction.
float surfaceAlpha(float textureAlpha) {
  if (!USES_ALPHA_MODE) return 1.0;
  float alpha = materialOpacity * textureAlpha;
  if (alphaMode > 1.5) return alpha;
  if (alphaToCoverage > 0.5) {
    float softness = max(fwidth(alpha), 0.0001);
    alpha = clamp((alpha - alphaCutoff) / softness + 0.5, 0.0, 1.0);
    if (alpha <= 0.0) discard;
    return alpha;
  }
  if (alpha < alphaCutoff) discard;
  return 1.0;
}

vec3 surroundingsColor(vec3 direction, float roughness) {
  if (environmentEnabled > 0.5) return environmentRadiance(direction, roughness * environmentLevelMax);
  if (worldMode > 0.5) return mix(fogColor * 0.8, vec3(0.20, 0.38, 0.52) * 1.6, smoothstep(-0.15, 0.7, direction.y)) * 0.5 * daylight;
  return studio(direction, roughness);
}

// Clear coat: a second dielectric specular lobe over the base. Light that reflects off it never reaches the base.
// Passing 0.04 as the colour of a fully metallic surface gives the lobe's own reflectance and no diffuse part.
vec3 clearCoatLayer(vec3 baseRadiance, vec3 normal, vec3 viewDirection, float visibility) {
  float roughness = clamp(materialCoat.y, 0.075, 1.0);
${featureCode("coatReset")}  float coatFresnel = fresnel(max(dot(normal, viewDirection), 0.001), vec3(0.04)).x * materialCoat.x;
  vec3 mirror = surroundingsColor(reflect(-viewDirection, normal), roughness) * coatFresnel * ambientIntensity;
  vec3 highlight = illuminate(normal, viewDirection, normalize(lightDirection), keyColor * visibility, vec3(0.04), 1.0, roughness);
  return baseRadiance * (1.0 - coatFresnel) + mirror + highlight * materialCoat.x;
}

// Sheen: the Charlie distribution with the Neubelt visibility term (KHR_materials_sheen), plus a rim of ambient light.
vec3 sheenLayer(vec3 baseRadiance, vec3 normal, vec3 viewDirection, float visibility) {
  float roughness = clamp(materialSheen.w, 0.07, 1.0);
  float inverseAlpha = 1.0 / (roughness * roughness);
  vec3 lightVector = normalize(lightDirection);
  vec3 halfway = normalize(viewDirection + lightVector);
  float normalLight = max(dot(normal, lightVector), 0.0);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float sine = sqrt(max(1.0 - pow(max(dot(normal, halfway), 0.0), 2.0), 0.0));
  float distribution = (2.0 + inverseAlpha) * pow(sine, inverseAlpha) / (2.0 * PI);
  float visibilityTerm = 1.0 / (4.0 * (normalLight + normalView - normalLight * normalView));
  vec3 keyTerm = materialSheen.rgb * distribution * visibilityTerm * normalLight * keyColor * visibility;
  vec3 ambientTerm = environmentEnabled > 0.5 ? environmentDiffuse(normal) : mix(vec3(0.16, 0.20, 0.22), vec3(0.19, 0.25, 0.30) * max(daylight, 0.08), worldMode);
  vec3 rimTerm = materialSheen.rgb * ambientTerm * pow(1.0 - normalView, 3.0) * ambientIntensity;
  float shadowedBase = 1.0 - 0.2 * max(materialSheen.r, max(materialSheen.g, materialSheen.b));
  return baseRadiance * shadowedBase + keyTerm + rimTerm;
}

// Raw data for a render pass: modes are 1 albedo, 2 normal, 3 emission, 4 depth, 5 object ID. Depth packs 16 bits
// into red and green, object IDs pack 24 bits into red, green and blue. Nothing here is tone mapped or graded.
vec3 renderPassValue(vec3 color, vec3 normal, vec3 emission) {
  if (renderPassMode < 1.5) return clamp(color, 0.0, 1.0);
  if (renderPassMode < 2.5) return normal * 0.5 + 0.5;
  if (renderPassMode < 3.5) return clamp(emission, 0.0, 1.0);
  if (renderPassMode < 4.5) {
    float steps = floor(clamp(length(worldPosition - eye) / renderPassDepthRange, 0.0, 1.0) * 65535.0 + 0.5);
    float high = floor(steps / 256.0);
    return vec3(high, steps - high * 256.0, 0.0) / 255.0;
  }
  float identifier = renderPassObjectBase + instanceOrdinal + 1.0;
  float high = floor(identifier / 65536.0);
  float middle = floor((identifier - high * 65536.0) / 256.0);
  return vec3(identifier - high * 65536.0 - middle * 256.0, middle, high) / 255.0;
}

void main() {
  vec3 normal = normalize(worldNormal);
  // Foliage and grass cards are single-sided geometry whose shading normal already leans toward the
  // canopy, so the back face keeps it instead of flipping to point into the crown.
  bool canopyShaded = CANOPY_TAG;
  if (doubleSided > 0.5 && !gl_FrontFacing && !canopyShaded) normal = -normal;
  if (USES_NORMAL_MAP) normal = boxMapScale > 0.0 ? boxMappedNormal(normal) : mappedNormal(normal);
  vec3 viewDirection = normalize(eye - worldPosition);
  vec3 color = mix(baseColor, armorColor, step(0.5, surface.w) * (1.0 - step(1.5, surface.w)));
  if (!USES_SPLAT) color *= vertexTint;
  float textureAlpha = 1.0;
  if (USES_BASE_MAP) {
    vec4 sampledBase = boxMapScale > 0.0 ? sampleBox(baseMap) : texture(baseMap, textureUV);
    color *= sampledBase.rgb;
    textureAlpha = sampledBase.a;
  }
  float alpha = surfaceAlpha(textureAlpha);
  vec3 emission = emissionColor * surface.z;
  if (USES_EMISSIVE_MAP) emission *= (boxMapScale > 0.0 ? sampleBox(emissiveMap) : texture(emissiveMap, textureUV)).rgb;
  if (USES_RENDER_PASS) {
    outputColor = vec4(renderPassValue(color, normal, emission), 1.0);
    return;
  }
  if (TAG_UNLIT) {
    vec3 radiance = color * exposure + emission;
    outputColor = vec4(hdrEnabled > 0.5 ? radiance : pow(max(radiance, vec3(0)), vec3(1.0 / 2.2)), alpha);
    return;
  }
  float metallic = surface.x;
  float roughness = clamp(surface.y, 0.075, 1.0);
  if (surface.w > 0.5 && surface.w < 1.5) {
    metallic = armorSurface.x;
    roughness = armorSurface.y;
  }
  if (USES_METALLIC_ROUGHNESS_MAP) {
    vec4 sampled = boxMapScale > 0.0 ? sampleBox(metallicRoughnessMap) : texture(metallicRoughnessMap, textureUV);
    metallic *= sampled.b;
    roughness *= sampled.g;
  }
  float splatCavity = 1.0;
  if (USES_SPLAT) applySplat(color, normal, roughness, splatCavity);
  roughness = clamp(roughness, 0.075, 1.0);
  vec3 normalChange = max(abs(dFdx(normal)), abs(dFdy(normal)));
  roughness = clamp(sqrt(roughness * roughness + dot(normalChange, normalChange) * 0.3), 0.075, 1.0);
  if (TAG_WATER) {
    normal = normalize(vec3(-cos(worldPosition.x * 1.4 + time * 0.8) * 0.035, 1.0, -cos(worldPosition.z * 1.8 - time) * 0.036));
    float radius = length(worldPosition.xz - waterRipple.xz);
    float age = time - rippleTime;
    float wave = sin(radius * 11.0 - age * 8.0) * exp(-abs(radius - age * 1.4) * 1.5) * exp(-age * 0.7) * step(0.0, age);
    normal.xz += normalize(worldPosition.xz - waterRipple.xz + 0.001) * wave * 0.07;
    normal = normalize(normal);
    color = mix(color, vec3(0.10, 0.23, 0.25), pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0));
    roughness = 0.16;
  }
  if (CANOPY_TAG) {
    float leaves = sin(worldPosition.x * 13.0 + sin(worldPosition.y * 9.0)) * sin(worldPosition.z * 11.0 - worldPosition.y * 5.0);
    color *= 0.78 + leaves * 0.16;
    normal = normalize(normal + vec3(sin(worldPosition.z * 12.0), sin(worldPosition.x * 9.0), cos(worldPosition.y * 11.0)) * 0.06);
  }
  if (TAG_TERRAIN) {
    vec2 terrainPosition = worldPosition.xz + worldPosition.y * vec2(0.31, 0.43);
    float footprint = max(fwidth(terrainPosition.x), fwidth(terrainPosition.y));
    vec3 broad = terrainNoise(terrainPosition * 0.32);
    vec3 ridges = terrainNoise(terrainPosition * 3.2 + vec2(5.2, 11.7));
    vec3 grains = terrainNoise(terrainPosition * 32.0 + vec2(17.1, 4.3));
    float ridgeWeight = 1.0 - smoothstep(0.25, 0.8, footprint * 3.2);
    float grainWeight = 1.0 - smoothstep(0.2, 0.7, footprint * 32.0);
    float ridgeColor = 1.0 - abs(ridges.x * 2.0 - 1.0);
    color *= 0.82 + broad.x * 0.26 + (ridgeColor - 0.5) * 0.12 * ridgeWeight + (grains.x - 0.5) * 0.1 * grainWeight;
    vec2 relief = ridges.yz * 0.08 * ridgeWeight + grains.yz * 0.11 * grainWeight;
    vec3 perturbation = vec3(-relief.x, 0.0, -relief.y);
    normal = normalize(normal + perturbation - normal * dot(perturbation, normal));
    roughness = clamp(roughness + (grains.x - 0.5) * 0.06 * grainWeight, 0.075, 1.0);
  }
  float mossCover = 0.0;
  vec3 mossTone = vec3(0.0);
  if (USES_MOSS) {
    float mossSoft;
    mossMasks(normal, materialMoss.x, mossCover, mossSoft);
    float mossFootprint = length(fwidth(worldPosition));
    vec3 cushion = terrainNoise(worldPosition.xz * 40.0 + worldPosition.y * 13.0);
    float cushionDetail = 1.0 - smoothstep(0.004, 0.03, mossFootprint);
    vec3 cushionTilt = vec3(-cushion.y, 0.0, -cushion.z) * 0.07 * mossSoft * cushionDetail;
    normal = normalize(normal + cushionTilt - normal * dot(cushionTilt, normal));
    mossTone = materialMoss.yzw * (0.7 + 0.6 * cushion.x);
    color = mix(color, mossTone, mossCover);
    roughness = mix(roughness, 1.0, mossCover);
    metallic = mix(metallic, 0.0, mossCover);
  }
  vec3 specularNormal = normal;
  vec3 baseReflectance = mix(materialDielectric, color, metallic);
${featureCode("mainSetup")}  float visibility = shadowVisibility(normal);
  vec3 radiance = illuminate(normal, viewDirection, normalize(lightDirection), keyColor * visibility, color, metallic, roughness);
  radiance += illuminate(normal, viewDirection, normalize(vec3(4.0, 2.0, -3.0)), mix(vec3(0.8, 2.0, 1.8), vec3(0.12, 0.17, 0.20) * daylight, worldMode) * fillIntensity, color, metallic, roughness);
  radiance += illuminate(normal, viewDirection, normalize(vec3(1.0, 2.0, 5.0)), vec3(0.6, 0.7, 0.8) * mix(1.0, 0.25 * daylight, worldMode) * fillIntensity, color, metallic, roughness);
  for (int index = 0; index < 8; index++) {
    if (index >= pointLightCount) break;
    vec3 offset = pointLightPositions[index].xyz - worldPosition;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared < 1e-12 || pointLightColors[index].w == 0.0) continue;
    float attenuation = localAttenuation(distanceSquared, pointLightPositions[index].w, pointLightRadii[index]);
    if (attenuation == 0.0) continue;
    vec3 lightRadiance = pointLightColors[index].rgb * pointLightColors[index].w * attenuation;
    if (USES_LOCAL_SHADOWS && pointLightShadowTiles[index] >= 0.0) {
      float tile = pointLightShadowTiles[index] + pointShadowFace(-offset);
      lightRadiance *= localShadowVisibility(tile, worldPosition, normal, sqrt(distanceSquared));
    }
    radiance += illuminate(normal, viewDirection, offset * inversesqrt(distanceSquared), lightRadiance, color, metallic, roughness);
  }
  if (USES_SPOT_LIGHTS) {
    for (int index = 0; index < 8; index++) {
      if (index >= spotLightCount) break;
      vec3 offset = spotLightPositions[index].xyz - worldPosition;
      float distanceSquared = dot(offset, offset);
      if (distanceSquared < 1e-12 || spotLightColors[index].w == 0.0) continue;
      vec3 toLight = offset * inversesqrt(distanceSquared);
      float coneCosine = dot(-toLight, spotLightDirections[index].xyz);
      // The same cone mask as Blender: smoothstep between the outer and inner cosines.
      float cone = smoothstep(spotLightDirections[index].w, spotLightParameters[index].y, coneCosine);
      float attenuation = localAttenuation(distanceSquared, spotLightPositions[index].w, spotLightParameters[index].x) * cone;
      if (attenuation == 0.0) continue;
      vec3 lightRadiance = spotLightColors[index].rgb * spotLightColors[index].w * attenuation;
      if (USES_LOCAL_SHADOWS && spotLightParameters[index].z >= 0.0) {
        lightRadiance *= localShadowVisibility(spotLightParameters[index].z, worldPosition, normal, sqrt(distanceSquared));
      }
      radiance += illuminate(normal, viewDirection, toLight, lightRadiance, color, metallic, roughness);
    }
  }
  if (USES_AREA_LIGHTS) {
    for (int index = 0; index < 4; index++) {
      if (index >= areaLightCount) break;
      vec3 lightNormal = areaLightNormals[index].xyz;
      vec3 widthAxis = areaLightTangents[index].xyz;
      vec3 heightAxis = cross(lightNormal, widthAxis);
      vec2 halfSize = vec2(areaLightNormals[index].w, areaLightTangents[index].w) * 0.5;
      vec3 fromCenter = worldPosition - areaLightPositions[index].xyz;
      // Representative point: the closest point of the rectangle stands in for the whole source.
      vec3 closest = areaLightPositions[index].xyz
        + widthAxis * clamp(dot(fromCenter, widthAxis), -halfSize.x, halfSize.x)
        + heightAxis * clamp(dot(fromCenter, heightAxis), -halfSize.y, halfSize.y);
      vec3 offset = closest - worldPosition;
      float distanceSquared = dot(offset, offset);
      vec3 toLight = offset * inversesqrt(max(distanceSquared, 1e-12));
      float emission = max(dot(-toLight, lightNormal), 0.0);
      float area = 4.0 * halfSize.x * halfSize.y;
      // Adding area / pi keeps the term finite at the surface and matches a disc source on its axis.
      float attenuation = emission / (distanceSquared + area / PI);
      vec3 lightRadiance = areaLightColors[index].rgb * areaLightColors[index].w * attenuation;
      radiance += illuminate(normal, viewDirection, toLight, lightRadiance, color, metallic, roughness);
    }
  }
  vec3 reflectance = fresnel(max(dot(normal, viewDirection), 0.0), baseReflectance);
  float occlusion = 1.0;
  if (USES_OCCLUSION_MAP) occlusion = mix(1.0, texture(occlusionMap, textureUV).r, occlusionStrength);
  occlusion *= splatCavity;
  // Leaf and grass cards keep a faint sheen; full sky reflection washed grazing cards grey-blue.
  float skyReflection = canopyShaded ? 0.3 : 1.0;
  if (environmentEnabled > 0.5) {
    radiance += environmentLighting(normal, specularNormal, baseReflectance, viewDirection, color, metallic, roughness, occlusion, ambientIntensity, skyReflection);
  } else {
    // Outdoors the surroundings are sky and haze; reflecting the studio softboxes there lit grazing leaves white and cyan.
    vec3 reflected = reflect(-viewDirection, specularNormal);
    vec3 surroundings = worldMode > 0.5 ? mix(fogColor * 0.8, vec3(0.20, 0.38, 0.52) * 1.6, smoothstep(-0.15, 0.7, reflected.y)) : studio(reflected, roughness);
    radiance += surroundings * reflectance * skyReflection * (1.0 - roughness * 0.55) * mix(1.0, 0.5 * daylight, worldMode) * occlusion * ambientIntensity;
    radiance += color * (1.0 - metallic) * mix(vec3(0.16, 0.20, 0.22), vec3(0.19, 0.25, 0.30) * max(daylight, 0.08), worldMode) * (0.45 + 0.55 * max(normal.y, 0.0)) * occlusion * ambientIntensity;
  }
  vec3 keyResponse = keyColor / mix(vec3(5.2, 4.7, 4.1), vec3(3.7, 3.4, 2.9), worldMode);
  keyResponse *= mix(daylight, 1.0, worldMode);
  if (CANOPY_TAG) radiance += color * max(dot(-normal, normalize(lightDirection)), 0.0) * 0.3 * keyResponse;
  if (mossCover > 0.001) {
    float sheen = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    float wrap = max(dot(normal, normalize(lightDirection)) + 0.5, 0.0) / 1.5;
    radiance += mossTone * (sheen * 0.8 + wrap * 0.35) * keyResponse * visibility * mossCover;
  }
  if (TAG_GRASS) {
    // Sun through thin blades: they glow yellow-green when the camera looks toward the light, most at the thin tips
    // (uv.y runs 1 at the root to 0 at the tip; grass without UVs gets a middle value).
    float towardSun = pow(max(dot(-viewDirection, normalize(lightDirection)), 0.0), 3.0);
    float thinness = textureUV.x > -0.5 ? 1.0 - textureUV.y * 0.8 : 0.6;
    radiance += color * vec3(1.1, 1.25, 0.55) * towardSun * thinness * 1.4 * keyResponse * visibility;
  }
  if (materialSheen.rgb != vec3(0.0)) radiance = sheenLayer(radiance, normal, viewDirection, visibility);
  if (materialCoat.x > 0.0) radiance = clearCoatLayer(radiance, normal, viewDirection, visibility);
  radiance += emission;
  if (TAG_WATER) {
    float reflectivity = 0.20 + 0.65 * pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    vec3 reflection = mix(vec3(0.12, 0.24, 0.28), vec3(0.40, 0.63, 0.78), clamp(reflect(-viewDirection, normal).y, 0.0, 1.0));
    radiance = mix(radiance * 0.6, reflection * daylight * ambientIntensity, reflectivity);
    radiance += vec3(1.0, 0.85, 0.55) * pow(max(dot(reflect(-normalize(lightDirection), normal), viewDirection), 0.0), 220.0) * 2.0 * keyResponse;
  }
  if (TAG_FLOOR) {
    float contact = 1.0 - 0.45 * exp(-dot(worldPosition.xz, worldPosition.xz) * 1.4);
    radiance = vec3(0.034, 0.041, 0.046) * (0.4 + visibility * 0.6) * contact;
    float fog = 1.0 - exp(-length(worldPosition.xz) * 0.05);
    radiance = mix(radiance, vec3(0.018, 0.022, 0.026), fog);
  }
  if (TAG_FIRE) {
    float turbulence = sin(worldPosition.x * 3.0 + time * 4.0) * sin(worldPosition.y * 4.2 - time * 3.0) * sin(worldPosition.z * 3.7);
    float heat = pow(clamp(0.55 + turbulence * 0.5 - explosionProgress * 0.12, 0.0, 1.0), 3.0);
    radiance = mix(vec3(0.22, 0.003, 0.0002), vec3(8.0, 2.8, 0.15), heat) * max(0.2, surface.z * 0.10);
  }
  if (TAG_SMOKE) {
    float turbulence = sin(worldPosition.x * 2.0 + time) * sin(worldPosition.y * 3.3 - time * 0.6);
    radiance = color * (0.22 + turbulence * 0.12) + vec3(0.35, 0.05, 0.005) * max(0.0, 1.0 - explosionProgress) * max(0.0, -normal.y);
  }
  float fog = 1.0 - exp(-length(worldPosition - eye) * fogDensity);
  radiance = mix(radiance, fogColor, fog * worldMode);
  if (inspection > 0.5) radiance = normal * 0.5 + 0.5;
  outputColor = vec4(hdrEnabled > 0.5 ? clamp(radiance * exposure, vec3(0), vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2)), alpha);
  if (TAG_FLOOR && inspection < 0.5) {
    float distanceFade = exp(-length(worldPosition.xz) * 0.08);
    float contact = 1.0 - 0.1 * exp(-dot(worldPosition.xz, worldPosition.xz) * 1.4);
    vec3 floorColor = mix(vec3(0.145, 0.162, 0.177), vec3(0.17, 0.19, 0.205), distanceFade);
    vec3 result = floorColor * (0.72 + 0.28 * visibility) * contact;
    outputColor = vec4(hdrEnabled > 0.5 ? pow(result, vec3(2.2)) : result, 1.0);
  }
}`;
}

// Every feature the main fragment shader can leave out, with the GLSL condition that turns it on. A feature that a scene
// never uses becomes the constant `false`, so the driver drops its code instead of compiling and branching over it.
const SHADER_FEATURE_CONDITIONS = {
  normalMap: ['USES_NORMAL_MAP', 'hasNormalMap > 0.5'],
  baseMap: ['USES_BASE_MAP', 'hasBaseMap > 0.5'],
  metallicRoughnessMap: ['USES_METALLIC_ROUGHNESS_MAP', 'hasMetallicRoughnessMap > 0.5'],
  occlusionMap: ['USES_OCCLUSION_MAP', 'hasOcclusionMap > 0.5'],
  emissiveMap: ['USES_EMISSIVE_MAP', 'hasEmissiveMap > 0.5'],
  splat: ['USES_SPLAT', 'splatEnabled > 0.5'],
  moss: ['USES_MOSS', 'materialMoss.x > 0.0'],
  alphaMode: ['USES_ALPHA_MODE', 'alphaMode > 0.5'],
  floor: ['TAG_FLOOR', 'surface.w == 2.0'],
  water: ['TAG_WATER', 'surface.w == 3.0'],
  foliage: ['TAG_FOLIAGE', 'surface.w == 4.0'],
  terrain: ['TAG_TERRAIN', 'surface.w == 5.0'],
  grass: ['TAG_GRASS', 'surface.w == 7.0'],
  fire: ['TAG_FIRE', 'surface.w == 8.0'],
  smoke: ['TAG_SMOKE', 'surface.w == 9.0'],
  unlit: ['TAG_UNLIT', 'surface.w == 10.0'],
  spotLights: ['USES_SPOT_LIGHTS', 'spotLightCount > 0'],
  areaLights: ['USES_AREA_LIGHTS', 'areaLightCount > 0'],
  localShadows: ['USES_LOCAL_SHADOWS', 'true'],
  renderPass: ['USES_RENDER_PASS', 'renderPassMode > 0.5'],
};

// A feature that is not in the list above has its GLSL in another module, so a scene that never uses it does not carry
// it. That module calls registerShaderFeatureCode on import, with blocks of GLSL that createFragmentShader splices in:
// declarations, illuminateReflectance, illuminateSpecular, coatReset and mainSetup, each ending in a newline.
const registeredFeatureCode = new Map();

/** Register the GLSL of an optional feature. Called by the module that holds it, on import. */
export function registerShaderFeatureCode(feature, slots) {
  registeredFeatureCode.set(feature, slots);
}

function requireFeatureCode(feature) {
  const slots = registeredFeatureCode.get(feature);
  if (!slots) {
    throw new Error(`The ${feature} layer needs its shader code: add import '@codepawlhq/67js/addons/material-layer-shaders' (a recipe: await loadAgentSceneModules(recipe)).`);
  }
  return slots;
}

function featureCodeSplicer(features) {
  const codes = features.filter(feature => !(feature in SHADER_FEATURE_CONDITIONS)).map(requireFeatureCode);
  return slot => codes.map(code => code[slot] ?? '').join('');
}

export const SHADER_FEATURES = Object.freeze(Object.keys(SHADER_FEATURE_CONDITIONS));

/** The fragment shader for a set of features. A feature with separate code throws until its module is imported. */
export function createFragmentShader(features = SHADER_FEATURES) {
  const enabled = new Set(features);
  const lines = Object.entries(SHADER_FEATURE_CONDITIONS).map(([feature, [macro, condition]]) => `#define ${macro} ${enabled.has(feature) ? `(${condition})` : 'false'}`);
  lines.push('#define CANOPY_TAG (TAG_FOLIAGE || TAG_GRASS)');
  return buildFragmentShader(lines.join('\n'), featureCodeSplicer([...enabled]));
}

export const fragmentShader = createFragmentShader();
