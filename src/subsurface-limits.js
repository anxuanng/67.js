// The ranges, defaults and checks of the material `subsurface` block. Plain data, kept out of material-layers.js so a
// renderer without subsurface parts does not carry them: the MCP server, the recipe code and the subsurface addon share them.
//
// The block mirrors Blender's Principled BSDF (Subsurface Weight, Radius, Scale). radius is the mean free path of red,
// green and blue in units of scale, and scale is metres. A missing color means the base color, as in Blender 4 and later.

const UNIT = Object.freeze([0, 1]);

export const SUBSURFACE_DEFAULTS = Object.freeze({ weight: 0, radius: Object.freeze([1, 0.2, 0.1]), scale: 0.05 });
export const SUBSURFACE_RANGES = Object.freeze({ weight: UNIT, radius: Object.freeze([0, 100]), scale: Object.freeze([0, 10]), color: UNIT });

function describeRange([minimum, maximum]) {
  return `between ${minimum} and ${maximum}`;
}

function checkTriple(label, value) {
  const [minimum, maximum] = SUBSURFACE_RANGES[label];
  const isTriple = Array.isArray(value) && value.length === 3 && value.every(component => typeof component === 'number' && Number.isFinite(component) && component >= minimum && component <= maximum);
  if (!isTriple) throw new RangeError(`subsurface.${label} must be three numbers ${describeRange(SUBSURFACE_RANGES[label])}. Pass [red, green, blue].`);
}

/** Throws for a subsurface block that is not an object with the known fields inside their ranges, or sits on a non-surface material. */
export function validateSubsurface(block, tag = 'surface') {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) throw new TypeError('subsurface must be an object: { weight, radius, scale, color }.');
  for (const key of Object.keys(block)) {
    if (!(key in SUBSURFACE_RANGES)) throw new RangeError(`Unknown subsurface field ${key}. Use weight, radius, scale or color.`);
  }
  for (const field of ['weight', 'scale']) {
    const value = block[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < SUBSURFACE_RANGES[field][0] || value > SUBSURFACE_RANGES[field][1]) {
      throw new RangeError(`subsurface.${field} must be ${describeRange(SUBSURFACE_RANGES[field])}, got ${value}.`);
    }
  }
  if (block.radius !== undefined) checkTriple('radius', block.radius);
  if (block.color !== undefined) checkTriple('color', block.color);
  if ((block.weight ?? 0) > 0 && tag !== 'surface' && tag !== 'gltf') {
    throw new RangeError(`subsurface needs a standard PBR material tag, got ${tag}. Use the surface tag.`);
  }
}

/**
 * The seven numbers a shader needs: weight, the mean free path in metres (radius times scale) for red, green and blue,
 * and the color, whose red is -1 for the base color.
 */
export function subsurfaceUniformValues(block) {
  const { weight = SUBSURFACE_DEFAULTS.weight, radius = SUBSURFACE_DEFAULTS.radius, scale = SUBSURFACE_DEFAULTS.scale, color = [-1, -1, -1] } = block;
  return [weight, ...radius.map(channel => channel * scale), ...color];
}
