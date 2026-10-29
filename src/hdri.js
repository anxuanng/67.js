import { createEnvironmentMap, MAXIMUM_ENVIRONMENT_SIZE } from './environment.js';

const MAXIMUM_FILE_BYTES = 256 * 1024 ** 2;
const MINIMUM_RUN_LENGTH_WIDTH = 8;
const MAXIMUM_RUN_LENGTH_WIDTH = 32767;

function readLine(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  if (end >= bytes.length) throw new Error('Radiance HDR header is truncated.');
  const text = String.fromCharCode(...bytes.subarray(start, Math.min(end, start + 256)));
  return { text: text.replace(/\r$/, ''), next: end + 1 };
}

function parseHeader(bytes) {
  let line = readLine(bytes, 0);
  if (!line.text.startsWith('#?')) throw new Error('Not a Radiance HDR file: missing #? signature.');
  let formatFound = false;
  let position = line.next;
  for (;;) {
    line = readLine(bytes, position);
    position = line.next;
    if (line.text === '') break;
    if (line.text.startsWith('FORMAT=')) {
      if (line.text !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`Unsupported Radiance HDR format: ${line.text}.`);
      formatFound = true;
    }
  }
  if (!formatFound) throw new Error('Radiance HDR header has no FORMAT=32-bit_rle_rgbe line.');
  line = readLine(bytes, position);
  const resolution = /^-Y (\d+) \+X (\d+)$/.exec(line.text);
  if (!resolution) throw new Error('Unsupported Radiance HDR orientation. Only "-Y height +X width" is supported.');
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);
  if (width < 1 || height < 1 || width > MAXIMUM_ENVIRONMENT_SIZE || height > MAXIMUM_ENVIRONMENT_SIZE) throw new RangeError('Radiance HDR dimensions are outside the supported range.');
  return { width, height, dataStart: line.next };
}

function readRunLengthScanline(bytes, startPosition, width, scanline) {
  let position = startPosition + 4;
  for (let channel = 0; channel < 4; channel++) {
    let column = 0;
    while (column < width) {
      if (position >= bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
      const count = bytes[position++];
      const isRun = count > 128;
      const length = isRun ? count - 128 : count;
      if (length === 0 || column + length > width) throw new Error('Radiance HDR run length is invalid.');
      if (isRun) {
        if (position >= bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
        const value = bytes[position++];
        for (let index = 0; index < length; index++) scanline[(column + index) * 4 + channel] = value;
      } else {
        if (position + length > bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
        for (let index = 0; index < length; index++) scanline[(column + index) * 4 + channel] = bytes[position + index];
        position += length;
      }
      column += length;
    }
  }
  return position;
}

function startsRunLengthScanline(bytes, position, width) {
  return width >= MINIMUM_RUN_LENGTH_WIDTH && width <= MAXIMUM_RUN_LENGTH_WIDTH
    && bytes[position] === 2 && bytes[position + 1] === 2
    && ((bytes[position + 2] << 8) | bytes[position + 3]) === width;
}

// Parses Radiance RGBE (.hdr) data into linear RGB floats, top row first.
export function parseRadianceHdr(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length > MAXIMUM_FILE_BYTES) throw new RangeError('Radiance HDR file is larger than 256 MiB.');
  const { width, height, dataStart } = parseHeader(bytes);
  const data = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);
  let position = dataStart;
  for (let row = 0; row < height; row++) {
    if (startsRunLengthScanline(bytes, position, width)) {
      position = readRunLengthScanline(bytes, position, width, scanline);
    } else {
      if (position + width * 4 > bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
      scanline.set(bytes.subarray(position, position + width * 4));
      position += width * 4;
    }
    for (let column = 0; column < width; column++) {
      const exponent = scanline[column * 4 + 3];
      const target = (row * width + column) * 3;
      if (exponent === 0) continue;
      const scale = 2 ** (exponent - 136);
      data[target] = scanline[column * 4] * scale;
      data[target + 1] = scanline[column * 4 + 1] * scale;
      data[target + 2] = scanline[column * 4 + 2] * scale;
    }
  }
  return { width, height, data };
}

// Fetches a .hdr file (for example a 1k or 2k Poly Haven HDRI) and returns an environment map descriptor.
export async function loadHdri(url, { intensity, rotation, showBackground, backgroundBlur, signal, fetchImplementation = globalThis.fetch } = {}) {
  const response = await fetchImplementation(url, { signal });
  if (!response.ok) throw new Error(`HDRI download failed: HTTP ${response.status}.`);
  const parsed = parseRadianceHdr(await response.arrayBuffer());
  return createEnvironmentMap({ ...parsed, intensity, rotation, showBackground, backgroundBlur });
}

export { createEnvironmentMap };
