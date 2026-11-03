import { registerShaderFeatureCode } from './shaders.js';

// Shader code for the toon material option. It lives outside shaders.js so a scene without banded light never carries it:
// the renderer asks for the `toon` feature only when a part has `toon` above 0, or when the line art addon turns on a
// default for every material (line-art.js).
//
// toonLight turns the cosine of a light into steps. Each light the material receives is stepped on its own, so a
// scene with a sun and a lamp shows two sets of bands. `materialToon` is the step count of the material and
// `toonDefault` the count for a material that sets none; 0 in both leaves the smooth light. The edge between steps is
// 0.02 of the light range wide, which antialiases without derivatives (those are undefined in the light loops).

const TOON_SOFTNESS = '0.02';

const TOON_DECLARATIONS = `uniform float materialToon;
uniform float toonDefault;
float toonLight(float light) {
  float bands = materialToon > 0.0 ? materialToon : toonDefault;
  if (bands <= 0.0) return light;
  float scaled = clamp(light, 0.0, 1.0) * bands;
  float band = floor(scaled);
  return (band + smoothstep(0.0, ${TOON_SOFTNESS} * bands, scaled - band)) / bands;
}
`;

registerShaderFeatureCode('toon', Object.freeze({
  declarations: TOON_DECLARATIONS,
  illuminateReflectance: '  normalLight = toonLight(normalLight);\n',
}));
