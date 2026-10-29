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
${skinningShader}
${morphingShader}
void main() {
  mat4 deformation = skinTransform();
  vec4 world = instanceMatrix * deformation * vec4(morphedPosition(position), 1.0);
  world.xyz += assemblyOffset * assemblyAmount + assemblyDetailOffset * smoothstep(0.3, 1.0, assemblyAmount);
  if (instanceSurface.w == 4.0 || instanceSurface.w == 7.0) {
    world.x += sin(time * 1.2 + world.z * 0.31 + world.x * 0.17) * wind * 0.10 * max(position.y + 0.5, 0.0);
  }
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
  baseColor = instanceColor;
  textureUV = uv;
  vertexTint = vertexColor;
  emissionColor = instanceEmissive;
  surface = instanceSurface;
  shadowPosition = lightProjection * world;
  gl_Position = viewProjection * world;
}`;

export const depthVertexShader = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=2) in mat4 instanceMatrix;
layout(location=11) in vec3 assemblyOffset;
layout(location=12) in vec3 assemblyDetailOffset;
layout(location=13) in vec2 uv;
uniform mat4 lightProjection;
uniform float assemblyAmount;
out vec2 textureUV;
${skinningShader}
${morphingShader}
void main() {
  vec4 world = instanceMatrix * skinTransform() * vec4(morphedPosition(position), 1.0);
  world.xyz += assemblyOffset * assemblyAmount + assemblyDetailOffset * smoothstep(0.3, 1.0, assemblyAmount);
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
  float thickness = liquidOptics.x * mix(0.15, 1.0, facing);
  vec3 bent = refract(-viewDirection, normal, 1.0 / liquidOptics.y);
  vec4 projected = viewProjection * vec4(worldPosition + bent * thickness, 1.0);
  vec2 refracted = projected.w > 0.0 ? projected.xy / projected.w * 0.5 + 0.5 : screen;
  refracted = clamp(mix(screen, refracted, liquidOptics.z), vec2(0.001), vec2(0.999));
  vec3 behind = texture(sceneColor, refracted).rgb;
  // The material colour is what one metre of this liquid lets through.
  vec3 transmittance = pow(clamp(color, vec3(0.001), vec3(1.0)), vec3(thickness));
  float reflectance = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
  vec3 inScatter = color * (ambientLight(normal) + keyColor * max(dot(normal, light), 0.0) * 0.2) * liquidOptics.w * (1.0 - transmittance);
  vec3 reflection = environmentColor(reflect(-viewDirection, normal), roughness) * ambientIntensity;
  vec3 highlight = keyColor * specularLobe(normal, viewDirection, light, roughness);
  vec3 surfaceLight = inScatter * (1.0 - reflectance) + reflection * reflectance + highlight;
  surfaceLight = mix(surfaceLight, fogColor, fog);
  outputColor = vec4(behind * transmittance * (1.0 - reflectance) * (1.0 - fog) + displayed(surfaceLight), 1.0);
}`;

export const fragmentShader = `#version 300 es
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

vec3 illuminate(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 radiance, vec3 color, float metallic, float roughness) {
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
  vec3 reflectance = fresnel(max(dot(halfway, viewDirection), 0.0), mix(vec3(0.04), color, metallic));
  vec3 specular = distribution * geometry * reflectance / max(4.0 * normalView * normalLight, 0.001);
  vec3 diffuse = (1.0 - reflectance) * (1.0 - metallic) * color / PI;
  return (diffuse + specular) * radiance * normalLight;
}

vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
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

// Opaque draws 1, mask resolves to a cutout (smooth coverage with MSAA) and blend keeps the fraction.
float surfaceAlpha(float textureAlpha) {
  if (alphaMode < 0.5) return 1.0;
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

void main() {
  vec3 normal = normalize(worldNormal);
  if (doubleSided > 0.5 && !gl_FrontFacing) normal = -normal;
  if (hasNormalMap > 0.5) normal = mappedNormal(normal);
  vec3 viewDirection = normalize(eye - worldPosition);
  vec3 color = mix(baseColor, armorColor, step(0.5, surface.w) * (1.0 - step(1.5, surface.w)));
  if (splatEnabled < 0.5) color *= vertexTint;
  float textureAlpha = 1.0;
  if (hasBaseMap > 0.5) {
    vec4 sampledBase = texture(baseMap, textureUV);
    color *= sampledBase.rgb;
    textureAlpha = sampledBase.a;
  }
  float alpha = surfaceAlpha(textureAlpha);
  vec3 emission = emissionColor * surface.z;
  if (hasEmissiveMap > 0.5) emission *= texture(emissiveMap, textureUV).rgb;
  if (surface.w == 10.0) {
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
  if (hasMetallicRoughnessMap > 0.5) {
    vec4 sampled = texture(metallicRoughnessMap, textureUV);
    metallic *= sampled.b;
    roughness *= sampled.g;
  }
  float splatCavity = 1.0;
  if (splatEnabled > 0.5) applySplat(color, normal, roughness, splatCavity);
  roughness = clamp(roughness, 0.075, 1.0);
  vec3 normalChange = max(abs(dFdx(normal)), abs(dFdy(normal)));
  roughness = clamp(sqrt(roughness * roughness + dot(normalChange, normalChange) * 0.3), 0.075, 1.0);
  if (surface.w == 3.0) {
    normal = normalize(vec3(-cos(worldPosition.x * 1.4 + time * 0.8) * 0.035, 1.0, -cos(worldPosition.z * 1.8 - time) * 0.036));
    float radius = length(worldPosition.xz - waterRipple.xz);
    float age = time - rippleTime;
    float wave = sin(radius * 11.0 - age * 8.0) * exp(-abs(radius - age * 1.4) * 1.5) * exp(-age * 0.7) * step(0.0, age);
    normal.xz += normalize(worldPosition.xz - waterRipple.xz + 0.001) * wave * 0.07;
    normal = normalize(normal);
    color = mix(color, vec3(0.10, 0.23, 0.25), pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0));
    roughness = 0.16;
  }
  if (surface.w == 4.0 || surface.w == 7.0) {
    float leaves = sin(worldPosition.x * 13.0 + sin(worldPosition.y * 9.0)) * sin(worldPosition.z * 11.0 - worldPosition.y * 5.0);
    color *= 0.78 + leaves * 0.16;
    normal = normalize(normal + vec3(sin(worldPosition.z * 12.0), sin(worldPosition.x * 9.0), cos(worldPosition.y * 11.0)) * 0.06);
  }
  if (surface.w == 5.0) {
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
  float visibility = shadowVisibility(normal);
  vec3 radiance = illuminate(normal, viewDirection, normalize(lightDirection), keyColor * visibility, color, metallic, roughness);
  radiance += illuminate(normal, viewDirection, normalize(vec3(4.0, 2.0, -3.0)), mix(vec3(0.8, 2.0, 1.8), vec3(0.12, 0.17, 0.20) * daylight, worldMode) * fillIntensity, color, metallic, roughness);
  radiance += illuminate(normal, viewDirection, normalize(vec3(1.0, 2.0, 5.0)), vec3(0.6, 0.7, 0.8) * mix(1.0, 0.25 * daylight, worldMode) * fillIntensity, color, metallic, roughness);
  for (int index = 0; index < 8; index++) {
    if (index >= pointLightCount) break;
    vec3 offset = pointLightPositions[index].xyz - worldPosition;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared < 1e-12 || pointLightColors[index].w == 0.0) continue;
    float range = pointLightPositions[index].w;
    float cutoff = 1.0;
    if (range > 0.0) {
      float squaredRatio = distanceSquared / (range * range);
      float fade = max(1.0 - squaredRatio * squaredRatio, 0.0);
      cutoff = fade * fade;
    }
    if (cutoff == 0.0) continue;
    float radius = pointLightRadii[index];
    float attenuation = cutoff / max(distanceSquared, radius * radius);
    vec3 lightRadiance = pointLightColors[index].rgb * pointLightColors[index].w * attenuation;
    radiance += illuminate(normal, viewDirection, offset * inversesqrt(distanceSquared), lightRadiance, color, metallic, roughness);
  }
  vec3 reflectance = fresnel(max(dot(normal, viewDirection), 0.0), mix(vec3(0.04), color, metallic));
  float occlusion = 1.0;
  if (hasOcclusionMap > 0.5) occlusion = mix(1.0, texture(occlusionMap, textureUV).r, occlusionStrength);
  occlusion *= splatCavity;
  if (environmentEnabled > 0.5) {
    radiance += environmentLighting(normal, viewDirection, color, metallic, roughness, occlusion, ambientIntensity);
  } else {
    // Outdoors the surroundings are sky and haze; reflecting the studio softboxes there lit grazing leaves white and cyan.
    vec3 reflected = reflect(-viewDirection, normal);
    vec3 surroundings = worldMode > 0.5 ? mix(fogColor * 0.8, vec3(0.20, 0.38, 0.52) * 1.6, smoothstep(-0.15, 0.7, reflected.y)) : studio(reflected, roughness);
    radiance += surroundings * reflectance * (1.0 - roughness * 0.55) * mix(1.0, 0.5 * daylight, worldMode) * occlusion * ambientIntensity;
    radiance += color * (1.0 - metallic) * mix(vec3(0.16, 0.20, 0.22), vec3(0.19, 0.25, 0.30) * max(daylight, 0.08), worldMode) * (0.45 + 0.55 * max(normal.y, 0.0)) * occlusion * ambientIntensity;
  }
  vec3 keyResponse = keyColor / mix(vec3(5.2, 4.7, 4.1), vec3(3.7, 3.4, 2.9), worldMode);
  keyResponse *= mix(daylight, 1.0, worldMode);
  if (surface.w == 4.0 || surface.w == 7.0) radiance += color * max(dot(-normal, normalize(lightDirection)), 0.0) * 0.3 * keyResponse;
  radiance += emission;
  if (surface.w == 3.0) {
    float reflectivity = 0.20 + 0.65 * pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    vec3 reflection = mix(vec3(0.12, 0.24, 0.28), vec3(0.40, 0.63, 0.78), clamp(reflect(-viewDirection, normal).y, 0.0, 1.0));
    radiance = mix(radiance * 0.6, reflection * daylight * ambientIntensity, reflectivity);
    radiance += vec3(1.0, 0.85, 0.55) * pow(max(dot(reflect(-normalize(lightDirection), normal), viewDirection), 0.0), 220.0) * 2.0 * keyResponse;
  }
  if (surface.w == 2.0) {
    float contact = 1.0 - 0.45 * exp(-dot(worldPosition.xz, worldPosition.xz) * 1.4);
    radiance = vec3(0.034, 0.041, 0.046) * (0.4 + visibility * 0.6) * contact;
    float fog = 1.0 - exp(-length(worldPosition.xz) * 0.05);
    radiance = mix(radiance, vec3(0.018, 0.022, 0.026), fog);
  }
  if (surface.w == 8.0) {
    float turbulence = sin(worldPosition.x * 3.0 + time * 4.0) * sin(worldPosition.y * 4.2 - time * 3.0) * sin(worldPosition.z * 3.7);
    float heat = pow(clamp(0.55 + turbulence * 0.5 - explosionProgress * 0.12, 0.0, 1.0), 3.0);
    radiance = mix(vec3(0.22, 0.003, 0.0002), vec3(8.0, 2.8, 0.15), heat) * max(0.2, surface.z * 0.10);
  }
  if (surface.w == 9.0) {
    float turbulence = sin(worldPosition.x * 2.0 + time) * sin(worldPosition.y * 3.3 - time * 0.6);
    radiance = color * (0.22 + turbulence * 0.12) + vec3(0.35, 0.05, 0.005) * max(0.0, 1.0 - explosionProgress) * max(0.0, -normal.y);
  }
  float fog = 1.0 - exp(-length(worldPosition - eye) * fogDensity);
  radiance = mix(radiance, fogColor, fog * worldMode);
  if (inspection > 0.5) radiance = normal * 0.5 + 0.5;
  outputColor = vec4(hdrEnabled > 0.5 ? clamp(radiance * exposure, vec3(0), vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2)), alpha);
  if (surface.w == 2.0 && inspection < 0.5) {
    float distanceFade = exp(-length(worldPosition.xz) * 0.08);
    float contact = 1.0 - 0.1 * exp(-dot(worldPosition.xz, worldPosition.xz) * 1.4);
    vec3 floorColor = mix(vec3(0.145, 0.162, 0.177), vec3(0.17, 0.19, 0.205), distanceFade);
    vec3 result = floorColor * (0.72 + 0.28 * visibility) * contact;
    outputColor = vec4(hdrEnabled > 0.5 ? pow(result, vec3(2.2)) : result, 1.0);
  }
}`;
