import { layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

// Water bodies. A material with the water tag can carry `absorption` (RGB per metre: how fast each colour fades going down) and
// `turbidity` (0 clear to 1 murky: how much light the water scatters into shadows). The largest flat water part of a scene sets
// the water level. Every surface below it is dimmed by Beer-Lambert absorption of the column above it, and its shadows are lifted
// by in-scatter and widened with depth times turbidity (worldVisibility below). Absorption folds the way down and the way back up
// into one coefficient, so a bed `depth` metres down keeps exp(-absorption * depth) of its light.
/** Water the way people name it: where the light goes and how far a shadow stays sharp. */
export const WATER_PRESETS = Object.freeze({
  lake: Object.freeze({ absorption: Object.freeze([0.35, 0.07, 0.04]), turbidity: 0.02 }),
  sea: Object.freeze({ absorption: Object.freeze([0.4, 0.06, 0.02]), turbidity: 0.1 }),
  river: Object.freeze({ absorption: Object.freeze([0.8, 0.9, 1.6]), turbidity: 0.75 }),
});
export const WATER_DEFAULT_PRESET = 'lake';
export const WATER_MAXIMUM_ABSORPTION = 20;
// A water part counts as one level when it is this flat: thickness against its wider side.
const WATER_MAXIMUM_THICKNESS_RATIO = 0.02;

/** Resolves a material's water fields: an explicit absorption or turbidity beats the preset, which beats the default lake. */
export function resolveWaterMaterial({ waterPreset, absorption, turbidity } = {}) {
  const preset = waterPreset ?? WATER_DEFAULT_PRESET;
  if (!Object.hasOwn(WATER_PRESETS, preset)) {
    throw new RangeError(`waterPreset must be one of ${Object.keys(WATER_PRESETS).join(', ')}.`);
  }
  const resolvedAbsorption = absorption ?? WATER_PRESETS[preset].absorption;
  const absorptionValid = Array.isArray(resolvedAbsorption) && resolvedAbsorption.length === 3
    && resolvedAbsorption.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= WATER_MAXIMUM_ABSORPTION);
  if (!absorptionValid) {
    throw new RangeError(`absorption must be three numbers from 0 to ${WATER_MAXIMUM_ABSORPTION} (per metre).`);
  }
  const resolvedTurbidity = turbidity ?? WATER_PRESETS[preset].turbidity;
  if (!Number.isFinite(resolvedTurbidity) || resolvedTurbidity < 0 || resolvedTurbidity > 1) {
    throw new RangeError('turbidity must be within zero and one.');
  }
  return { waterPreset: preset, absorption: [...resolvedAbsorption], turbidity: resolvedTurbidity };
}

function partBounds(part) {
  const { positions } = part.geometry;
  const { matrix } = part;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { minimum, maximum };
}

const boundsCache = new WeakMap();

// A part's bounds are read again only when its matrix changed.
function cachedBounds(part) {
  const cached = boundsCache.get(part);
  if (cached && cached.matrix.every((value, index) => value === part.matrix[index])) {
    return cached.bounds;
  }
  const bounds = partBounds(part);
  boundsCache.set(part, { matrix: Float32Array.from(part.matrix), bounds });
  return bounds;
}

/**
 * The water body of a set of parts, or null: the largest flat part with the water tag sets the level (its top) and the optics.
 * A water mesh that is not flat (a stream following the terrain) has no single level, so it sets none.
 */
export function findWaterBody(parts) {
  let best = null;
  for (const part of parts) {
    if (part.material.tag !== 'water') {
      continue;
    }
    const { minimum, maximum } = cachedBounds(part);
    const wider = Math.max(maximum[0] - minimum[0], maximum[2] - minimum[2]);
    const footprint = (maximum[0] - minimum[0]) * (maximum[2] - minimum[2]);
    const flat = wider > 0 && maximum[1] - minimum[1] <= wider * WATER_MAXIMUM_THICKNESS_RATIO;
    if (flat && (!best || footprint > best.footprint)) {
      best = { footprint, level: maximum[1], material: part.material };
    }
  }
  if (!best) {
    return null;
  }
  const { absorption, turbidity } = resolveWaterMaterial(best.material);
  return { level: best.level, absorption, turbidity };
}

const waterLocations = new WeakMap();

function bindWaterBody(renderer) {
  if (!renderer.shaderFeatures?.has('water')) {
    return;
  }
  const context = renderer.context;
  let locations = waterLocations.get(renderer);
  if (locations?.program !== renderer.program) {
    locations = { program: renderer.program, body: context.getUniformLocation(renderer.program, 'waterBody'), absorption: context.getUniformLocation(renderer.program, 'waterAbsorption') };
    waterLocations.set(renderer, locations);
  }
  const waterParts = renderer.batches.flatMap(batch => (batch.parts[0].material.tag === 'water' ? batch.parts : []));
  const body = findWaterBody(waterParts);
  // The mirror and the render passes skip the underwater look: the mirror is clipped above the water, a pass reads raw surface data.
  const active = Boolean(body) && !renderer.renderingPass && !renderer.mirrorCulling;
  context.uniform4f(locations.body, active ? body.level : 0, active ? body.turbidity : 0, active ? 1 : 0, 0);
  context.uniform3f(locations.absorption, ...(active ? body.absorption : [0, 0, 0]));
}

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState) => {
  previousBind?.(renderer, mapState);
  bindWaterBody(renderer);
};

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
  // The water body (level, turbidity, 1 when a flat water part sets one) and its absorption per metre, sent by bindWaterBody.
  // Shadow of a surface under murky water: the classic shadow map read over a wider disc. A cascaded map is read through
  // its own macro and keeps its filter.
  declarations: `uniform vec4 waterBody;
uniform vec3 waterAbsorption;
#ifndef shadowVisibility
float softShadowVisibility(vec3 normal, float radiusTexels) {
  vec3 projected = shadowPosition.xyz / shadowPosition.w * 0.5 + 0.5;
  if (projected.z > 1.0 || projected.z < 0.0 || any(lessThan(projected.xy, vec2(0.0))) || any(greaterThan(projected.xy, vec2(1.0)))) return 1.0;
  float cosine = max(dot(normal, normalize(lightDirection)), 0.05);
  float bias = shadowBiasPerSlope * clamp(sqrt(1.0 - cosine * cosine) / cosine, 0.25, 4.0);
  vec2 texel = 1.0 / vec2(textureSize(shadowMap, 0));
  float lit = 0.0;
  for (int tap = 0; tap < 12; tap++) {
    float angle = float(tap) * 2.39996;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / 12.0) * radiusTexels;
    lit += texture(shadowMap, vec3(projected.xy + offset * texel, projected.z - bias));
  }
  return lit / 12.0;
}
#endif
// Sunlight under water: in-scatter lifts the shadow (the water scatters light into it) and widens its edge, both with
// turbidity times the depth of the column above the surface.
float underwaterVisibility(float visibility, vec3 normal, float depth) {
  float scattering = waterBody.y * depth;
  float filtered = visibility;
#ifndef shadowVisibility
  if (scattering > 0.03) filtered = softShadowVisibility(normal, 1.5 + min(scattering * 6.0, 8.0));
#endif
  return mix(filtered, 1.0, (1.0 - exp(-scattering * 1.2)) * 0.9);
}
`,
  worldVisibility: `  float waterDepth = 0.0;
  vec3 waterTransmittance = vec3(1.0);
  if (TAG_WATER) {
    // Only the light that enters the water and comes back is shadowed, and most of what the eye sees comes from deeper than
    // the shadow reaches, so a shadow on the surface is faint. The reflection mixed in later never sees the shadow.
    visibility = mix(visibility, 1.0, 0.7 + 0.2 * waterBody.y);
  } else if (waterBody.z > 0.5 && worldPosition.y < waterBody.x) {
    waterDepth = waterBody.x - worldPosition.y;
    waterTransmittance = exp(-waterAbsorption * waterDepth);
    visibility = underwaterVisibility(visibility, normal, waterDepth);
  }
`,
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
  worldAfterEmission: `  if (waterDepth > 0.0) {
    // The bed's light reaches the eye through the column, dimmed; murky water adds the daylight it scattered toward the eye.
    vec3 scatteredLight = (keyColor * max(normalize(lightDirection).y, 0.0) * 0.1 + vec3(0.04) * ambientIntensity) * exp(-waterAbsorption * 1.5);
    radiance = radiance * waterTransmittance + scatteredLight * (vec3(1.0) - waterTransmittance) * waterBody.y;
  }
  if (TAG_WATER) {
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
