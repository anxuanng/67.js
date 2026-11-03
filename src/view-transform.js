import { LOOK_NAMES, VIEW_TRANSFORM_NAMES } from './view-transform-names.js';

// Display transforms and look LUTs as plain functions, shared by the path tracer, the tests and the GLSL in
// view-transform-shader.js (which prints the constants below, so the three cannot drift apart).
// - aces is the Narkowicz fit the rasterizer has always used, applied per channel.
// - agx follows Blender's AgX through the Filament port that three.js ships: Rec.2020 inset, log2 between -12.47393 and
//   4.026069 EV, a polynomial for the default contrast, outset, then a 2.2 power back to linear sRGB.
// - neutral is the Khronos PBR Neutral tone mapper: base colours below 0.76 pass unchanged.
// All three take linear sRGB and return linear sRGB in 0 to 1; the caller encodes with a power of 1 / 2.2.

/** Columns of each matrix, as GLSL writes them. */
export const AGX_CONSTANTS = Object.freeze({
  toRec2020: [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]],
  fromRec2020: [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]],
  inset: [[0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]],
  outset: [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]],
  minimumEv: -12.47393,
  maximumEv: 4.026069,
  contrast: [15.5, -40.14, 31.96, -6.868, 0.4298, 0.1191, -0.00232],
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

function agxContrast(value) {
  const [sixth, fifth, fourth, third, second, first, zeroth] = AGX_CONSTANTS.contrast;
  const square = value * value;
  const quartic = square * square;
  return sixth * quartic * square + fifth * quartic * value + fourth * quartic + third * square * value + second * square + first * value + zeroth;
}

export function agxColor(rgb) {
  const { toRec2020, fromRec2020, inset, outset, minimumEv, maximumEv } = AGX_CONSTANTS;
  const encoded = multiply(inset, multiply(toRec2020, rgb)).map(channel => {
    const logged = (Math.log2(Math.max(channel, 1e-10)) - minimumEv) / (maximumEv - minimumEv);
    return agxContrast(clampUnit(logged));
  });
  const linear = multiply(outset, encoded).map(channel => Math.max(0, channel) ** 2.2);
  return multiply(fromRec2020, linear).map(clampUnit);
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
