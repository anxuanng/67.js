import { registerShaderFeatureCode } from './shaders.js';
import { ALL_LIGHTS_MASK } from './material-layers.js';

// Light linking: a light can be limited to the parts it lights, as Blender's receiver collection does. A part carries
// a bit mask in `material.lightMask`; the shader skips a light whose bit is clear. The code lives here, not in the
// renderer, so a scene without linking never downloads it and its shader has no mask test.
// Bit 0 is the sun (the key light), bits 1 to 8 the point lights, 9 to 16 the spot lights and 17 to 20 the area lights,
// in the order of the environment lists. Linking changes what a light adds, not what it shadows: a part that a light
// does not reach still blocks that light for the others. The path tracer and the light bake ignore linking.
// The GLSL has no comments, because comments ship to every page.

export const SUN_BIT = 0;
export const POINT_FIRST_BIT = 1;
export const SPOT_FIRST_BIT = 9;
export const AREA_FIRST_BIT = 17;

registerShaderFeatureCode('lightLinking', {
  declarations: `uniform int lightLinkMask;
bool lightLinked(int bit) {
  return ((lightLinkMask >> bit) & 1) != 0;
}
`,
  linkSun: ' * float(lightLinked(0))',
  linkPoint: '    if (!lightLinked(1 + index)) continue;\n',
  linkSpot: '      if (!lightLinked(9 + index)) continue;\n',
  linkArea: '      if (!lightLinked(17 + index)) continue;\n',
});

const LIGHT_LISTS = [['pointLights', POINT_FIRST_BIT], ['spotLights', SPOT_FIRST_BIT], ['areaLights', AREA_FIRST_BIT]];

function affectedNames(affects, label) {
  if (affects === undefined) return null;
  if (!Array.isArray(affects) || affects.some(name => typeof name !== 'string')) {
    throw new TypeError(`${label} affects must be a list of part names`);
  }
  return new Set(affects);
}

/** The light mask of one part, from [bit, names] pairs where names is null for "every part". */
export function lightMaskFor(partName, links) {
  let mask = 0;
  for (const [bit, names] of links) {
    if (names === null || names.has(partName)) mask |= 1 << bit;
  }
  return mask;
}

function collectLinks(environment) {
  const links = [[SUN_BIT, affectedNames(environment.keyAffects, 'environment keyAffects')]];
  for (const [field, firstBit] of LIGHT_LISTS) {
    (environment[field] ?? []).forEach((light, index) => links.push([firstBit + index, affectedNames(light.affects, `${field}[${index}]`)]));
  }
  return links;
}

/**
 * Parts with the light masks that the lights' `affects` lists ask for: a light with `affects: ['name', ...]` lights only
 * those parts, a light without it lights every part. `environment.keyAffects` does the same for the sun. A part that
 * every light reaches is returned unchanged, so a scene without links keeps its batches.
 */
export function applyLightLinks(parts, environment) {
  const links = collectLinks(environment);
  if (links.every(([, names]) => names === null)) return parts;
  return parts.map((part) => {
    const mask = lightMaskFor(part.name, links);
    return mask === ALL_LIGHTS_MASK ? part : { ...part, material: { ...part.material, lightMask: mask } };
  });
}
