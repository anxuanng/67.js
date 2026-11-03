import { registerShaderFeatureCode } from './shader-registry.js';

// Wind for the foliage (4) and grass (7) tags, shared by the colour and shadow vertex shaders so both
// move identically. It depends only on local position, the card's uv, world position and time.
// The slow sway grows with height and with distance from the model's vertical axis (branch tips swing
// more than the crown centre) but is capped, because bark never moves and leaves must stay near their twigs.
// uv.y is 1 at a leaf's base and 0 at its tip, which drives the faster flutter.

// The GLSL of the world materials: water, foliage, grass, terrain, moss, fire and smoke. A renderer with a part of one of those
// tags (or with moss) needs this module; any other renderer never carries it. shaders.js splices each block at its slot:
// worldFunctions (the noise and moss masks), worldSurface (the surface changes), worldLight (extra light), worldAfterEmission
// (water's reflection) and worldFinal (fire and smoke, which replace the lit colour). Other optional features can use the
// same slots, or stub them out in shaders.js, to leave their code out of renderers that do not draw them.
export const worldMaterialSlots = {
  // Spliced into the colour and shadow vertex shaders by shaders.js.
  worldVertexWind: `
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
`,
  worldFunctions: `float terrainHash(vec2 position) {
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
`,
  worldMossFunction: `// Moss is its own material over the base, not a tint: fully rough, a soft sheen at grazing angles and light that wraps
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

`,
  worldSurface: `  if (TAG_WATER) {
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
`,
  worldLight: `  if (CANOPY_TAG) radiance += color * max(dot(-normal, normalize(lightDirection)), 0.0) * 0.3 * keyResponse * visibility;
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
`,
  worldAfterEmission: `  if (TAG_WATER) {
    float reflectivity = 0.20 + 0.65 * pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    vec3 reflection = mix(vec3(0.12, 0.24, 0.28), vec3(0.40, 0.63, 0.78), clamp(reflect(-viewDirection, normal).y, 0.0, 1.0));
    radiance = mix(radiance * 0.6, reflection * daylight * ambientIntensity, reflectivity);
    radiance += vec3(1.0, 0.85, 0.55) * pow(max(dot(reflect(-normalize(lightDirection), normal), viewDirection), 0.0), 220.0) * 2.0 * keyResponse;
  }
`,
  worldFinal: `  if (TAG_FIRE) {
    float turbulence = sin(worldPosition.x * 3.0 + time * 4.0) * sin(worldPosition.y * 4.2 - time * 3.0) * sin(worldPosition.z * 3.7);
    float heat = pow(clamp(0.55 + turbulence * 0.5 - explosionProgress * 0.12, 0.0, 1.0), 3.0);
    radiance = mix(vec3(0.22, 0.003, 0.0002), vec3(8.0, 2.8, 0.15), heat) * max(0.2, surface.z * 0.10);
  }
  if (TAG_SMOKE) {
    float turbulence = sin(worldPosition.x * 2.0 + time) * sin(worldPosition.y * 3.3 - time * 0.6);
    radiance = color * (0.22 + turbulence * 0.12) + vec3(0.35, 0.05, 0.005) * max(0.0, 1.0 - explosionProgress) * max(0.0, -normal.y);
  }
`,
};

registerShaderFeatureCode('worldMaterials', worldMaterialSlots);
