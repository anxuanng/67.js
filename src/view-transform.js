import { LOOK_NAMES, VIEW_TRANSFORM_NAMES } from './view-transform-names.js';

// Display transforms and look LUTs as plain functions, shared by the path tracer, the tests and the GLSL in
// view-transform-shader.js (which prints the constants below, so the three cannot drift apart).
// - aces is the Narkowicz fit the rasterizer has always used, applied per channel.
// - agx is Blender 5.2's AgX (the sRGB view of its OCIO config: E-Gamut log2 between -12.47393 and 4.026069 EV, a per-channel
//   sigmoid, a 2.4 power, a matrix back to Rec.709) as a fit of AgX_Base_sRGB.cube, not the 57-point LUT itself. The
//   older Filament/three.js polynomial put 0.18 grey 0.04 above Blender (0.501 against 0.461).
// - neutral is the Khronos PBR Neutral tone mapper: base colours below 0.76 pass unchanged.
// All three take linear sRGB and return display-linear sRGB in 0 to 1; the caller encodes with a power of 1 / 2.2.

const rowsToColumns = rows => rows[0].map((_, column) => rows.map(row => row[column]));

/**
 * Matrices as columns, as GLSL writes them. inset takes linear Rec.709 to the space the log and the sigmoid work in; outset
 * takes the linearised sigmoid output back to Rec.709. Rows sum to 1, so grey stays grey. Both were fitted to the LUT, and
 * the sigmoid to its grey diagonal. From the pivot (0.18 grey) it rises by scale * v / (1 + v ** power) ** (1 / power)
 * with v = slope * distance / scale, and falls the same way with the toe's own scale and power.
 */
export const AGX_CONSTANTS = Object.freeze({
  inset: rowsToColumns([[0.57215, 0.33216, 0.09569], [0.12368, 0.74091, 0.13541], [0.09814, 0.19729, 0.70457]]),
  outset: rowsToColumns([[1.84762, -0.70741, -0.14021], [-0.2341, 1.3225, -0.0884], [-0.19713, -0.30062, 1.49775]]),
  minimumEv: -12.47393,
  maximumEv: 4.026069,
  pivot: [0.60608, 0.48834],
  slope: 2.39013,
  toe: { scale: 0.56474, power: 1.50159 },
  shoulder: { scale: 0.70613, power: 1.53357 },
  encodingPower: 2.4,
});
export const NEUTRAL_CONSTANTS = Object.freeze({ startCompression: 0.8 - 0.04, desaturation: 0.15 });

function multiply(columns, vector) {
  const result = [0, 0, 0];
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) result[row] += columns[column][row] * vector[column];
  }
  return result;
}

const clampUnit = value => Math.min(1, Math.max(0, value));

/** The rasterizer's ACES fit for one channel. */
export function acesChannel(value) {
  const color = Math.max(value, 0);
  return clampUnit((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14));
}

function agxSigmoidSide(distance, side) {
  const scaled = distance / side.scale;
  return side.scale * scaled / (1 + scaled ** side.power) ** (1 / side.power);
}

function agxCurve(value) {
  const { pivot, slope, toe, shoulder } = AGX_CONSTANTS;
  const distance = slope * (value - pivot[0]);
  return pivot[1] + (distance >= 0 ? agxSigmoidSide(distance, shoulder) : -agxSigmoidSide(-distance, toe));
}

export function agxColor(rgb) {
  const { inset, outset, minimumEv, maximumEv, encodingPower } = AGX_CONSTANTS;
  const linear = multiply(inset, rgb).map(channel => {
    const logged = (Math.log2(Math.max(channel, 1e-10)) - minimumEv) / (maximumEv - minimumEv);
    return Math.max(0, agxCurve(clampUnit(logged))) ** encodingPower;
  });
  return multiply(outset, linear).map(clampUnit);
}

export function neutralColor(rgb) {
  const { startCompression, desaturation } = NEUTRAL_CONSTANTS;
  const lowest = Math.min(...rgb);
  const offset = lowest < 0.08 ? lowest - 6.25 * lowest * lowest : 0.04;
  const shifted = rgb.map(channel => channel - offset);
  const peak = Math.max(...shifted);
  if (peak < startCompression) return shifted.map(clampUnit);
  const distance = 1 - startCompression;
  const newPeak = 1 - distance * distance / (peak + distance - startCompression);
  const mix = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return shifted.map(channel => clampUnit(channel * newPeak / peak * (1 - mix) + newPeak * mix));
}

/** Linear sRGB in, display transform out, still linear: the part before the 1 / 2.2 power. */
export function applyViewTransform(name, rgb) {
  if (name === 'agx') return agxColor(rgb);
  if (name === 'neutral') return neutralColor(rgb);
  if (name === 'aces' || name === undefined) return rgb.map(acesChannel);
  throw new RangeError(`viewTransform must be one of ${VIEW_TRANSFORM_NAMES.join(', ')}.`);
}

// ---- Looks ----

export const MAXIMUM_LOOK_SIZE = 65;
const MAXIMUM_LOOK_TEXT = 16 * 1024 * 1024;

/** A look is { size, data }: size cubed RGB triples in 0 to 1, red varying fastest, applied to display-encoded colour. */
export function parseCube(text) {
  if (typeof text !== 'string' || text.length > MAXIMUM_LOOK_TEXT) throw new RangeError('A .cube look must be text of at most 16 MiB.');
  let size = 0;
  let domainMinimum = [0, 0, 0];
  let domainMaximum = [1, 1, 1];
  const values = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (line === '' || line.startsWith('TITLE')) continue;
    const [keyword, ...rest] = line.split(/\s+/);
    if (keyword === 'LUT_3D_SIZE') size = Number(rest[0]);
    else if (keyword === 'LUT_1D_SIZE') throw new RangeError('Only 3D .cube looks are supported (LUT_3D_SIZE).');
    else if (keyword === 'DOMAIN_MIN') domainMinimum = rest.map(Number);
    else if (keyword === 'DOMAIN_MAX') domainMaximum = rest.map(Number);
    else if (/^[-+0-9.]/.test(keyword)) values.push(Number(keyword), Number(rest[0]), Number(rest[1]));
    else throw new RangeError(`Unknown .cube line: ${keyword}`);
  }
  if (!Number.isInteger(size) || size < 2 || size > MAXIMUM_LOOK_SIZE) throw new RangeError(`LUT_3D_SIZE must be an integer from 2 to ${MAXIMUM_LOOK_SIZE}.`);
  if (values.length !== size ** 3 * 3 || values.some(value => !Number.isFinite(value))) throw new RangeError(`A ${size}x${size}x${size} .cube look needs ${size ** 3} finite RGB rows.`);
  const data = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const channel = index % 3;
    const range = domainMaximum[channel] - domainMinimum[channel];
    data[index] = clampUnit((values[index] - domainMinimum[channel]) / (range || 1));
  }
  return { size, data };
}

function lookFromFunction(size, grade) {
  const data = new Float32Array(size ** 3 * 3);
  let offset = 0;
  for (let blue = 0; blue < size; blue++) {
    for (let green = 0; green < size; green++) {
      for (let red = 0; red < size; red++) {
        data.set(grade([red / (size - 1), green / (size - 1), blue / (size - 1)]).map(clampUnit), offset);
        offset += 3;
      }
    }
  }
  return { size, data };
}

const smooth = value => value * value * (3 - 2 * value);
const NAMED_LOOK_GRADES = {
  warm: ([red, green, blue]) => [red * 1.06 + 0.01, green, blue * 0.92],
  cool: ([red, green, blue]) => [red * 0.93, green, blue * 1.07 + 0.01],
  contrast: color => color.map(channel => channel * 0.5 + smooth(channel) * 0.5),
  faded: color => {
    const gray = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
    return color.map(channel => 0.06 + 0.88 * (channel * 0.85 + gray * 0.15));
  },
};

/** One of the LOOK_NAMES, as a 17-point look. */
export function namedLook(name) {
  if (!LOOK_NAMES.includes(name)) throw new RangeError(`look must be one of ${LOOK_NAMES.join(', ')}.`);
  return lookFromFunction(17, NAMED_LOOK_GRADES[name]);
}

/** Trilinear lookup of a display-encoded colour, as the GPU filters the 3D texture. */
export function sampleLook(look, rgb) {
  const { size, data } = look;
  const position = rgb.map(channel => clampUnit(channel) * (size - 1));
  const base = position.map(value => Math.min(Math.floor(value), size - 2));
  const result = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const offsets = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    let weight = 1;
    for (let axis = 0; axis < 3; axis++) {
      const fraction = position[axis] - base[axis];
      weight *= offsets[axis] ? fraction : 1 - fraction;
    }
    const index = ((base[2] + offsets[2]) * size * size + (base[1] + offsets[1]) * size + base[0] + offsets[0]) * 3;
    for (let channel = 0; channel < 3; channel++) result[channel] += data[index + channel] * weight;
  }
  return result;
}

/** Linear radiance to the display-encoded colour in 0 to 1 that the rasterizer's frame holds for it. */
export function displayColor(rgb, { viewTransform = 'aces', look = null } = {}) {
  const encoded = applyViewTransform(viewTransform, rgb).map(channel => channel ** (1 / 2.2));
  return look ? sampleLook(look, encoded) : encoded;
}
