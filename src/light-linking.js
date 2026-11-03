import { registerShaderFeatureCode } from './shaders.js';
import { ALL_LIGHTS_MASK } from './material-layers.js';
import { SUN_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, AREA_FIRST_BIT } from './light-link-bits.js';

// Light linking: a light can be limited to the parts it lights, as Blender's receiver collection does. A part carries
// a bit mask in `material.lightMask`; the shader skips a light whose bit is clear. The code lives here, not in the
// renderer, so a scene without linking never downloads it and its shader has no mask test.
// Bit 0 is the sun (the key light), bits 1 to 8 the point lights, 9 to 16 the spot lights and 17 to 20 the area lights,
// in the order of the environment lists. Linking changes what a light adds, not what it shadows: a part that a light
// does not reach still blocks that light for the others. The path tracer and the light bake honour it too.
// The GLSL has no comments, because comments ship to every page.

export { SUN_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, AREA_FIRST_BIT };

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
 * The light mask of each part, in order, or null when no light is limited (every part keeps all lights). A light with
 * `affects: ['name', ...]` lights only those parts, a light without it lights every part; `environment.keyAffects` does
 * the same for the sun.
 */
export function lightMasksFor(parts, environment) {
  const links = collectLinks(environment);
  if (links.every(([, names]) => names === null)) return null;
  return parts.map(part => lightMaskFor(part.name, links));
}

/**
 * Parts with the light masks that the lights' `affects` lists ask for. A part that every light reaches is returned
 * unchanged, so a scene without links keeps its batches.
 */
export function applyLightLinks(parts, environment) {
  const masks = lightMasksFor(parts, environment);
  if (masks === null) return parts;
  return parts.map((part, index) => (masks[index] === ALL_LIGHTS_MASK ? part : { ...part, material: { ...part.material, lightMask: masks[index] } }));
}

/**
 * Names in a light's `affects` list that are not nodes of the recipe, as "where: name" strings. A linked light lights
 * only those nodes, so a misspelled name would silently darken a part; the caller fails with the next action instead.
 */
export function unknownLightLinkNames(environment, nodes) {
  const known = new Set(nodes.map(node => node.id));
  const lists = [['environment.keyAffects', environment.keyAffects]];
  for (const field of ['pointLights', 'spotLights', 'areaLights']) {
    (environment[field] ?? []).forEach((light, index) => lists.push([`${field}[${index}].affects`, light.affects]));
  }
  return lists.flatMap(([where, names]) => (names ?? []).filter(name => !known.has(name)).map(name => `${where}: ${name}`));
}
