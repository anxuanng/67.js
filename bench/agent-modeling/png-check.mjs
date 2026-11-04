// Checks that a file is a real PNG with content: a valid signature, at least the given size, and enough different pixels.
// Used by llms-only.mjs. Reads 8-bit RGB and RGBA, non-interlaced PNGs, which is what canvas.toDataURL produces.
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

export function decodePng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG: bad signature');
  let header = null;
  const dataChunks = [];
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9], interlace: body[12] };
    if (type === 'IDAT') dataChunks.push(body);
    offset += 12 + length;
  }
  if (!header) throw new Error('not a PNG: no IHDR');
  const channels = { 2: 3, 6: 4 }[header.colorType];
  if (!channels || header.bitDepth !== 8 || header.interlace !== 0) throw new Error(`unsupported PNG layout: colour type ${header.colorType}, ${header.bitDepth} bits`);
  const raw = inflateSync(Buffer.concat(dataChunks));
  const rowBytes = header.width * channels;
  const pixels = Buffer.alloc(rowBytes * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = raw[row * (rowBytes + 1)];
    for (let column = 0; column < rowBytes; column++) {
      const value = raw[row * (rowBytes + 1) + 1 + column];
      const left = column >= channels ? pixels[row * rowBytes + column - channels] : 0;
      const above = row > 0 ? pixels[(row - 1) * rowBytes + column] : 0;
      const upperLeft = row > 0 && column >= channels ? pixels[(row - 1) * rowBytes + column - channels] : 0;
      const predictor = [0, left, above, (left + above) >> 1, paeth(left, above, upperLeft)][filter];
      pixels[row * rowBytes + column] = (value + predictor) & 255;
    }
  }
  return { ...header, channels, pixels };
}

/** Returns { pass, detail } for a PNG at `path`. */
export async function checkPng(path, { minimumSide = 256, minimumBytes = 2000, minimumColours = 16, minimumDifferingShare = 0.02 } = {}) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return { pass: false, detail: 'the file does not exist' };
  }
  try {
    const image = decodePng(buffer);
    if (image.width < minimumSide || image.height < minimumSide) return { pass: false, detail: `too small: ${image.width}x${image.height}` };
    if (buffer.length < minimumBytes) return { pass: false, detail: `only ${buffer.length} bytes` };
    const colours = new Set();
    const corner = image.pixels.subarray(0, image.channels).toString('hex');
    let differing = 0;
    for (let index = 0; index < image.pixels.length; index += image.channels) {
      const colour = image.pixels.subarray(index, index + image.channels).toString('hex');
      colours.add(colour);
      if (colour !== corner) differing++;
    }
    const share = differing / (image.width * image.height);
    if (colours.size < minimumColours) return { pass: false, detail: `only ${colours.size} distinct colours` };
    if (share < minimumDifferingShare) return { pass: false, detail: `${(share * 100).toFixed(1)}% of pixels differ from the corner` };
    return { pass: true, detail: `${image.width}x${image.height}, ${colours.size} colours, ${(share * 100).toFixed(0)}% differ from the corner` };
  } catch (error) {
    return { pass: false, detail: error.message };
  }
}
