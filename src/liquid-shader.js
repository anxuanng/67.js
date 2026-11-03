import { environmentLookupGlsl } from './environment-shading.js';
import { registerShaderFeatureCode } from './shaders.js';
import { drawLiquidPass } from './liquid-renderer.js';

// Importing this module registers the liquid and foam shader. A renderer with a transmissive, liquid or foam part
// needs it; any other renderer never carries it.
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

registerShaderFeatureCode('liquid', { fragment: liquidFragmentShader, draw: drawLiquidPass });
