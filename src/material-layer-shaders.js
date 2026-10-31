import { registerShaderFeatureCode } from './shaders.js';

// Shader code for the anisotropy and iridescence material layers. It lives outside shaders.js so that a scene that
// uses neither layer never downloads it: the renderer asks for it only when a part uses a layer, and importing this
// module (or loading it through loadAgentSceneModules or the glTF loader) registers it.
// The GLSL has no comments, because comments ship to every page:
// - anisotropyStrength, anisotropyTangent, anisotropyBitangent, iridescenceWeight and iridescentReflectance are the
//   per-pixel state main sets once and every light reads; clearCoatLayer zeroes it because the coat is plain.
// - anisotropicSpecular is anisotropic GGX with height-correlated visibility as in KHR_materials_anisotropy (rougher
//   along the tangent), including the 1 / (4 N.L N.V) term. setAnisotropyFrame takes the UV tangent, or rings the
//   world up axis without UVs, and turns it about the normal. Image-based light is looked up along a normal bent
//   toward the grain (Filament).
// - filmReflectance is thin-film interference after Belcour and Barla 2017, as three.js uses it for
//   KHR_materials_iridescence; filmReflectanceAtNormal turns the film's Fresnel at this view angle back into the
//   reflectance at normal incidence that a Schlick curve needs.

const ANISOTROPY_DECLARATIONS = `uniform vec2 materialAnisotropy;
float anisotropyStrength = 0.0;
vec3 anisotropyTangent = vec3(1.0, 0.0, 0.0);
vec3 anisotropyBitangent = vec3(0.0, 0.0, 1.0);
float anisotropicSpecular(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 halfway, float alpha) {
  float alphaTangent = mix(alpha, 1.0, anisotropyStrength * anisotropyStrength);
  float alphaBitangent = alpha;
  float normalLight = max(dot(normal, lightDirection), 0.0001);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float normalHalf = max(dot(normal, halfway), 0.0);
  float tangentHalf = dot(anisotropyTangent, halfway) / alphaTangent;
  float bitangentHalf = dot(anisotropyBitangent, halfway) / alphaBitangent;
  float shape = tangentHalf * tangentHalf + bitangentHalf * bitangentHalf + normalHalf * normalHalf;
  float distribution = 1.0 / (PI * alphaTangent * alphaBitangent * shape * shape);
  vec3 viewScaled = vec3(alphaTangent * dot(anisotropyTangent, viewDirection), alphaBitangent * dot(anisotropyBitangent, viewDirection), normalView);
  vec3 lightScaled = vec3(alphaTangent * dot(anisotropyTangent, lightDirection), alphaBitangent * dot(anisotropyBitangent, lightDirection), normalLight);
  float visibility = 0.5 / max(normalLight * length(viewScaled) + normalView * length(lightScaled), 0.00001);
  return distribution * visibility;
}

void setAnisotropyFrame(vec3 normal) {
  vec3 tangent = vec3(0.0);
  vec2 uvX = dFdx(textureUV);
  vec2 uvY = dFdy(textureUV);
  float uvScale = max(max(abs(uvX.x), abs(uvX.y)), max(abs(uvY.x), abs(uvY.y)));
  if (uvScale > 0.0) {
    uvX /= uvScale;
    uvY /= uvScale;
    float determinant = uvX.x * uvY.y - uvX.y * uvY.x;
    if (determinant != 0.0) tangent = (dFdx(worldPosition) * uvY.y - dFdy(worldPosition) * uvX.y) / determinant;
  }
  tangent -= normal * dot(normal, tangent);
  float tangentScale = max(max(abs(tangent.x), abs(tangent.y)), abs(tangent.z));
  if (tangentScale == 0.0) {
    vec3 ringAxis = abs(normal.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    tangent = cross(ringAxis, normal);
    tangentScale = 1.0;
  }
  tangent = normalize(tangent / tangentScale);
  vec3 bitangent = cross(normal, tangent);
  anisotropyTangent = tangent * cos(materialAnisotropy.y) + bitangent * sin(materialAnisotropy.y);
  anisotropyBitangent = cross(normal, anisotropyTangent);
}

`;

const ANISOTROPY_ILLUMINATE_SPECULAR = `  if (anisotropyStrength > 0.0) specular = anisotropicSpecular(normal, viewDirection, lightDirection, halfway, max(alpha, 0.002)) * reflectance;
`;

const ANISOTROPY_COAT_RESET = `  anisotropyStrength = 0.0;
`;

const ANISOTROPY_MAIN_SETUP = `  if (materialAnisotropy.x > 0.0) {
    anisotropyStrength = materialAnisotropy.x;
    setAnisotropyFrame(normal);
    vec3 grainSide = cross(anisotropyBitangent, viewDirection);
    vec3 grainNormal = cross(grainSide, anisotropyBitangent);
    specularNormal = normalize(mix(normal, grainNormal, anisotropyStrength * clamp(5.0 * roughness, 0.0, 1.0)));
  }
`;

registerShaderFeatureCode('anisotropy', Object.freeze({
  declarations: ANISOTROPY_DECLARATIONS,
  illuminateSpecular: ANISOTROPY_ILLUMINATE_SPECULAR,
  coatReset: ANISOTROPY_COAT_RESET,
  mainSetup: ANISOTROPY_MAIN_SETUP,
}));

const IRIDESCENCE_DECLARATIONS = `uniform vec3 materialIridescence;
float iridescenceWeight = 0.0;
vec3 iridescentReflectance = vec3(0.04);

vec3 filmSensitivity(float pathDifference, vec3 phaseShift) {
  float phase = 2.0 * PI * pathDifference * 1.0e-9;
  vec3 amplitude = vec3(5.4856e-13, 4.4201e-13, 5.2481e-13);
  vec3 position = vec3(1.6810e+06, 1.7953e+06, 2.2084e+06);
  vec3 variance = vec3(4.3278e+09, 9.3046e+09, 6.6121e+09);
  vec3 xyz = amplitude * sqrt(2.0 * PI * variance) * cos(position * phase + phaseShift) * exp(-phase * phase * variance);
  xyz.x += 9.7470e-14 * sqrt(2.0 * PI * 4.5282e+09) * cos(2.2399e+06 * phase + phaseShift.x) * exp(-4.5282e+09 * phase * phase);
  xyz /= 1.0685e-7;
  mat3 xyzToLinearRgb = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
  return xyzToLinearRgb * xyz;
}

vec3 filmReflectance(float filmIor, float cosineView, float thickness, vec3 baseReflectance) {
  float outsideIor = 1.0;
  float filmIndex = mix(outsideIor, filmIor, smoothstep(0.0, 0.03, thickness));
  float sineFilmSquared = pow(outsideIor / filmIndex, 2.0) * (1.0 - cosineView * cosineView);
  if (sineFilmSquared > 1.0) return vec3(1.0);
  float cosineFilm = sqrt(1.0 - sineFilmSquared);
  float topNormal = pow((filmIndex - outsideIor) / (filmIndex + outsideIor), 2.0);
  float topFresnel = topNormal + (1.0 - topNormal) * pow(1.0 - cosineView, 5.0);
  float topTransmission = 1.0 - topFresnel;
  float topPhase = filmIndex < outsideIor ? PI : 0.0;
  vec3 clampedBase = clamp(baseReflectance, 0.0, 0.9999);
  vec3 baseIor = (1.0 + sqrt(clampedBase)) / (1.0 - sqrt(clampedBase));
  vec3 bottomNormal = pow((baseIor - filmIndex) / (baseIor + filmIndex), vec3(2.0));
  vec3 bottomFresnel = bottomNormal + (1.0 - bottomNormal) * pow(1.0 - cosineFilm, 5.0);
  vec3 bottomPhase = vec3(baseIor.x < filmIndex ? PI : 0.0, baseIor.y < filmIndex ? PI : 0.0, baseIor.z < filmIndex ? PI : 0.0);
  float pathDifference = 2.0 * filmIndex * thickness * cosineFilm;
  vec3 phase = vec3(PI - topPhase) + bottomPhase;
  vec3 roundTrip = clamp(topFresnel * bottomFresnel, 1e-5, 0.9999);
  vec3 roundTripRoot = sqrt(roundTrip);
  vec3 multiple = topTransmission * topTransmission * bottomFresnel / (vec3(1.0) - roundTrip);
  vec3 total = topFresnel + multiple;
  vec3 term = multiple - topTransmission;
  for (int order = 1; order <= 2; order++) {
    term *= roundTripRoot;
    total += term * 2.0 * filmSensitivity(float(order) * pathDifference, float(order) * phase);
  }
  return max(total, vec3(0.0));
}

vec3 filmReflectanceAtNormal(vec3 filmFresnel, float cosineView) {
  float power = clamp(pow(1.0 - cosineView, 5.0), 0.0, 0.9999);
  return clamp((filmFresnel - power) / (1.0 - power), 0.0, 1.0);
}

`;

const IRIDESCENCE_ILLUMINATE_REFLECTANCE = `  baseReflectance = mix(baseReflectance, iridescentReflectance, iridescenceWeight);
`;

const IRIDESCENCE_COAT_RESET = `  iridescenceWeight = 0.0;
`;

const IRIDESCENCE_MAIN_SETUP = `  if (materialIridescence.x > 0.0) {
    float cosineView = clamp(dot(normal, viewDirection), 0.001, 1.0);
    vec3 filmFresnel = filmReflectance(materialIridescence.y, cosineView, materialIridescence.z, baseReflectance);
    iridescentReflectance = filmReflectanceAtNormal(filmFresnel, cosineView);
    iridescenceWeight = materialIridescence.x;
    baseReflectance = mix(baseReflectance, iridescentReflectance, iridescenceWeight);
  }
`;

registerShaderFeatureCode('iridescence', Object.freeze({
  declarations: IRIDESCENCE_DECLARATIONS,
  illuminateReflectance: IRIDESCENCE_ILLUMINATE_REFLECTANCE,
  coatReset: IRIDESCENCE_COAT_RESET,
  mainSetup: IRIDESCENCE_MAIN_SETUP,
}));
