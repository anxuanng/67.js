// Fragment shader chunk for the splat ground material. It is spliced into the main fragment shader after terrainNoise.
// Texture arrays: unit 11 color (sRGB), unit 12 normal (linear), unit 13 roughness (red) and height (green), unit 14 weight mask.
export const splatGlsl = `
uniform float splatEnabled;
uniform highp sampler2DArray splatColor;
uniform highp sampler2DArray splatNormal;
uniform highp sampler2DArray splatPacked;
uniform sampler2D splatMask;
uniform vec4 splatLayer[4];
uniform vec4 splatTint[4];
uniform vec4 splatSlope[4];
uniform vec4 splatHeightRange[4];
uniform float splatMaskChannel[4];
uniform float splatMaskInvert[4];
uniform vec4 splatBlend;
uniform vec4 splatOptions;
uniform vec4 splatMaskBounds;
uniform vec4 splatVariation;

const mat2 SPLAT_ROTATION = mat2(0.8253, 0.5646, -0.5646, 0.8253);
const float SPLAT_SECOND_SCALE = 0.58;
const vec2 SPLAT_SECOND_OFFSET = vec2(0.37, 0.71);

struct SplatPlane {
  vec2 uv;
  vec2 dx;
  vec2 dy;
  vec3 tangent;
  vec3 bitangent;
  vec3 face;
};

float splatRange(float value, float minimum, float maximum, float softness) {
  float width = max(softness, 0.0001);
  return smoothstep(minimum - width, minimum + width, value) * (1.0 - smoothstep(maximum - width, maximum + width, value));
}

// Three octaves of value noise in [0, 1]; one octave alone shows its grid as soft blobs.
float splatOctaves(vec2 position) {
  return terrainNoise(position).x * 0.5 + terrainNoise(position * 2.03 + 7.1).x * 0.3 + terrainNoise(position * 4.11 + 13.7).x * 0.2;
}

// Brightness and hue drift at field (about 120 m), patch (20 m) and clump (3 m) scale. Texture detail averages
// out at a distance, so the clump octave grows with the pixel footprint and far ground does not read as one flat colour.
vec3 splatVariationTint(float footprint) {
  float amount = splatVariation.x;
  if (amount < 0.001) return vec3(1.0);
  float fieldScale = splatOctaves(worldPosition.xz * 0.008 + 3.7) - 0.5;
  float patchScale = splatOctaves(worldPosition.xz * 0.05 + 21.0) - 0.5;
  float clumpScale = splatOctaves(worldPosition.xz * 0.35 + 41.0) - 0.5;
  float distant = smoothstep(0.02, 0.2, footprint);
  float brightness = 1.0 + (fieldScale * 0.8 + patchScale * 0.9 + clumpScale * mix(0.35, 0.7, distant)) * amount;
  float dryness = smoothstep(0.4, 0.68, splatOctaves(worldPosition.xz * 0.02 + 11.0));
  float lush = smoothstep(0.48, 0.75, splatOctaves(worldPosition.xz * 0.04 + 57.0));
  vec3 hue = mix(vec3(1.0), vec3(1.3, 1.05, 0.55), dryness * 0.8);
  hue = mix(hue, vec3(0.72, 0.92, 0.8), lush * 0.7);
  return mix(vec3(1.0), hue, min(amount, 1.0)) * max(brightness, 0.35);
}

float splatMaskValue(int layerIndex) {
  float channel = splatMaskChannel[layerIndex];
  if (channel < -0.5) return 1.0;
  vec4 weights = vec4(vertexTint, 1.0);
  if (splatOptions.y > 0.5) {
    vec2 maskUv = (worldPosition.xz - splatMaskBounds.xy) / (splatMaskBounds.zw - splatMaskBounds.xy);
    weights = texture(splatMask, clamp(maskUv, 0.0, 1.0));
  }
  float value = channel < 0.5 ? weights.r : (channel < 1.5 ? weights.g : (channel < 2.5 ? weights.b : weights.a));
  return splatMaskInvert[layerIndex] > 0.5 ? 1.0 - value : value;
}

// Mixing two samples lowers contrast by this factor; dividing it back keeps the texture looking sharp.
float splatContrastDivisor(float blend) {
  return sqrt(blend * blend + (1.0 - blend) * (1.0 - blend));
}

vec4 splatTapTwoScale(highp sampler2DArray source, SplatPlane plane, float layer, float blend) {
  vec4 first = textureGrad(source, vec3(plane.uv, layer), plane.dx, plane.dy);
  if (blend < 0.003) return first;
  vec2 secondUv = SPLAT_ROTATION * plane.uv * SPLAT_SECOND_SCALE + SPLAT_SECOND_OFFSET;
  vec2 secondDx = SPLAT_ROTATION * plane.dx * SPLAT_SECOND_SCALE;
  vec2 secondDy = SPLAT_ROTATION * plane.dy * SPLAT_SECOND_SCALE;
  vec4 mixed = mix(first, textureGrad(source, vec3(secondUv, layer), secondDx, secondDy), blend);
  vec4 mean = textureLod(source, vec3(0.5, 0.5, layer), 12.0);
  return mean + (mixed - mean) / splatContrastDivisor(blend);
}

// The second sample is rotated, so its tangent-space normal must be rotated back before mixing.
vec3 splatNormalTwoScale(SplatPlane plane, float layer, float blend) {
  vec3 first = textureGrad(splatNormal, vec3(plane.uv, layer), plane.dx, plane.dy).xyz * 2.0 - 1.0;
  if (blend < 0.003) return first;
  vec2 secondUv = SPLAT_ROTATION * plane.uv * SPLAT_SECOND_SCALE + SPLAT_SECOND_OFFSET;
  vec2 secondDx = SPLAT_ROTATION * plane.dx * SPLAT_SECOND_SCALE;
  vec2 secondDy = SPLAT_ROTATION * plane.dy * SPLAT_SECOND_SCALE;
  vec3 second = textureGrad(splatNormal, vec3(secondUv, layer), secondDx, secondDy).xyz * 2.0 - 1.0;
  second.xy = second.xy * SPLAT_ROTATION;
  vec3 mixed = mix(first, second, blend);
  mixed.xy /= splatContrastDivisor(blend);
  return mixed;
}

SplatPlane splatPlane(vec2 worldCoordinates, vec2 worldDx, vec2 worldDy, float scale, vec3 tangent, vec3 bitangent, vec3 face) {
  return SplatPlane(worldCoordinates / scale, worldDx / scale, worldDy / scale, tangent, bitangent, face);
}

// Packed roughness (x) and height (y) of one layer, blended across the projections that cover this pixel.
vec2 splatPackedSample(int layerIndex, SplatPlane top, SplatPlane sideX, SplatPlane sideZ, vec3 projection, float blend) {
  float layer = float(layerIndex);
  vec2 result = vec2(0.0);
  if (projection.y > 0.002) result += splatTapTwoScale(splatPacked, top, layer, blend).xy * projection.y;
  if (projection.x > 0.002) result += splatTapTwoScale(splatPacked, sideX, layer, blend).xy * projection.x;
  if (projection.z > 0.002) result += splatTapTwoScale(splatPacked, sideZ, layer, blend).xy * projection.z;
  return result;
}

vec3 splatTilt(vec3 tangentNormal, SplatPlane plane, float strength) {
  return (plane.tangent * tangentNormal.x + plane.bitangent * tangentNormal.y) * strength;
}

// Color in xyz and the world-space tilt of the surface normal in the second vec3.
void splatColorSample(int layerIndex, SplatPlane top, SplatPlane sideX, SplatPlane sideZ, vec3 projection, float blend, out vec3 color, out vec3 tilt) {
  float layer = float(layerIndex);
  float strength = splatLayer[layerIndex].y;
  color = vec3(0.0);
  tilt = vec3(0.0);
  if (projection.y > 0.002) {
    color += splatTapTwoScale(splatColor, top, layer, blend).rgb * projection.y;
    tilt += splatTilt(splatNormalTwoScale(top, layer, blend), top, strength) * projection.y;
  }
  if (projection.x > 0.002) {
    color += splatTapTwoScale(splatColor, sideX, layer, blend).rgb * projection.x;
    tilt += splatTilt(splatNormalTwoScale(sideX, layer, blend), sideX, strength) * projection.x;
  }
  if (projection.z > 0.002) {
    color += splatTapTwoScale(splatColor, sideZ, layer, blend).rgb * projection.z;
    tilt += splatTilt(splatNormalTwoScale(sideZ, layer, blend), sideZ, strength) * projection.z;
  }
  color *= splatTint[layerIndex].rgb;
}

void applySplat(inout vec3 color, inout vec3 normal, inout float roughness, inout float cavity) {
  int layerCount = int(splatOptions.z);
  vec3 geometric = normal;
  float slope = degrees(acos(clamp(geometric.y, -1.0, 1.0)));
  float zSign = geometric.z < 0.0 ? -1.0 : 1.0;
  float xSign = geometric.x < 0.0 ? -1.0 : 1.0;
  // Image rows run downward, so a texture's v grows toward world -y on walls and toward +z seen from above.
  vec2 topCoordinates = worldPosition.xz;
  vec2 topDx = dFdx(worldPosition.xz);
  vec2 topDy = dFdy(worldPosition.xz);
  vec2 sideXCoordinates = vec2(-xSign * worldPosition.z, -worldPosition.y);
  vec2 sideXDx = vec2(-xSign * dFdx(worldPosition.z), -dFdx(worldPosition.y));
  vec2 sideXDy = vec2(-xSign * dFdy(worldPosition.z), -dFdy(worldPosition.y));
  vec2 sideZCoordinates = vec2(zSign * worldPosition.x, -worldPosition.y);
  vec2 sideZDx = vec2(zSign * dFdx(worldPosition.x), -dFdx(worldPosition.y));
  vec2 sideZDy = vec2(zSign * dFdy(worldPosition.x), -dFdy(worldPosition.y));
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 topTangent = vec3(1.0, 0.0, 0.0);
  vec3 topBitangent = vec3(0.0, 0.0, -1.0);
  vec3 sideXTangent = vec3(0.0, 0.0, -xSign);
  vec3 sideZTangent = vec3(zSign, 0.0, 0.0);
  vec3 sideUp = vec3(0.0, 1.0, 0.0);

  float lowFrequency = terrainNoise(worldPosition.xz * 0.045).x;
  float blend = splatOptions.x > 0.0 ? mix(0.5, lowFrequency, 0.7) : 0.0;
  vec3 variationTint = splatVariationTint(length(fwidth(worldPosition.xz)));
  // Real layer borders wander: jitter the slope and height the rules see, so a mud flat or rock band has a ragged edge.
  float edgeJitter = (splatOctaves(worldPosition.xz * 0.3 + 71.0) - 0.5) * 2.0 * splatVariation.y;
  float ruleSlope = slope + edgeJitter * 9.0;
  float ruleHeight = worldPosition.y + edgeJitter * 1.6;

  float weights[4] = float[4](0.0, 0.0, 0.0, 0.0);
  float covered = 0.0;
  for (int index = 0; index < 4; index++) {
    if (index >= layerCount) break;
    if (splatLayer[index].w < 0.5) continue;
    float weight = 1.0;
    if (splatSlope[index].w > 0.5) weight *= splatRange(ruleSlope, splatSlope[index].x, splatSlope[index].y, splatSlope[index].z);
    if (splatHeightRange[index].w > 0.5) weight *= splatRange(ruleHeight, splatHeightRange[index].x, splatHeightRange[index].y, splatHeightRange[index].z);
    weight *= splatMaskValue(index);
    weights[index] = weight;
    covered = max(covered, weight);
  }
  for (int index = 0; index < 4; index++) {
    if (index >= layerCount) break;
    if (splatLayer[index].w < 0.5) weights[index] = 1.0 - covered;
  }

  float triplanarAmount = smoothstep(splatBlend.z, splatBlend.w, slope);
  vec2 sideShare = pow(abs(geometric.xz), vec2(4.0));
  sideShare /= max(sideShare.x + sideShare.y, 0.0001);

  vec2 packedSamples[4] = vec2[4](vec2(0.5), vec2(0.5), vec2(0.5), vec2(0.5));
  vec3 projections[4] = vec3[4](vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 1.0, 0.0));
  float scores[4] = float[4](-1.0, -1.0, -1.0, -1.0);
  float highestScore = -1.0;
  for (int index = 0; index < 4; index++) {
    if (index >= layerCount) break;
    if (weights[index] < 0.002) continue;
    float scale = splatLayer[index].x;
    float tri = splatLayer[index].z > 0.5 ? triplanarAmount : 0.0;
    vec3 projection = vec3(tri * sideShare.x, 1.0 - tri, tri * sideShare.y);
    SplatPlane top = splatPlane(topCoordinates, topDx, topDy, scale, topTangent, topBitangent, up);
    SplatPlane sideX = splatPlane(sideXCoordinates, sideXDx, sideXDy, scale, sideXTangent, sideUp, vec3(xSign, 0.0, 0.0));
    SplatPlane sideZ = splatPlane(sideZCoordinates, sideZDx, sideZDy, scale, sideZTangent, sideUp, vec3(0.0, 0.0, zSign));
    projections[index] = projection;
    packedSamples[index] = splatPackedSample(index, top, sideX, sideZ, projection, blend);
    scores[index] = weights[index] + packedSamples[index].y * splatBlend.y;
    highestScore = max(highestScore, scores[index]);
  }

  float total = 0.0;
  for (int index = 0; index < 4; index++) {
    if (index >= layerCount) break;
    float weight = scores[index] < 0.0 ? 0.0 : max(scores[index] - (highestScore - splatBlend.x), 0.0) * step(0.002, weights[index]);
    weights[index] = weight;
    total += weight;
  }
  total = max(total, 0.0001);

  vec3 blendedColor = vec3(0.0);
  vec3 blendedTilt = vec3(0.0);
  float blendedRoughness = 0.0;
  float blendedHeight = 0.0;
  for (int index = 0; index < 4; index++) {
    if (index >= layerCount) break;
    float weight = weights[index] / total;
    if (weight < 0.004) continue;
    float scale = splatLayer[index].x;
    SplatPlane top = splatPlane(topCoordinates, topDx, topDy, scale, topTangent, topBitangent, up);
    SplatPlane sideX = splatPlane(sideXCoordinates, sideXDx, sideXDy, scale, sideXTangent, sideUp, vec3(xSign, 0.0, 0.0));
    SplatPlane sideZ = splatPlane(sideZCoordinates, sideZDx, sideZDy, scale, sideZTangent, sideUp, vec3(0.0, 0.0, zSign));
    vec3 layerColor;
    vec3 layerTilt;
    splatColorSample(index, top, sideX, sideZ, projections[index], blend, layerColor, layerTilt);
    blendedColor += layerColor * weight;
    blendedTilt += layerTilt * weight;
    blendedRoughness += packedSamples[index].x * weight;
    blendedHeight += packedSamples[index].y * weight;
  }

  color *= blendedColor * variationTint;
  normal = normalize(geometric + blendedTilt);
  roughness = blendedRoughness;
  cavity = mix(1.0, mix(0.55, 1.0, smoothstep(0.1, 0.85, blendedHeight)), splatOptions.w);
}
`;
