// Calls Intel Open Image Denoise (OIDN, Apache-2.0) through its official `oidnDenoise` command line tool, with
// the colour, albedo and normal images the 67js path tracer already writes. The binary is not in this package:
// `npm run fetch` (fetch-oidn.mjs) downloads the official release into ./vendor, and OIDN_DENOISE_PATH points
// at another copy.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EXECUTABLE_NAME = process.platform === 'win32' ? 'oidnDenoise.exe' : 'oidnDenoise';

export const OIDN_VERSION = '2.5.1';

/** The path of the `oidnDenoise` tool, or null when none is installed. */
export function findOidnBinary() {
  const configured = process.env.OIDN_DENOISE_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  const vendored = join(PACKAGE_DIRECTORY, 'vendor', `oidn-${OIDN_VERSION}`, 'bin', EXECUTABLE_NAME);
  return existsSync(vendored) ? vendored : null;
}

/** Writes three-channel float pixels as a little-endian PFM, which stores its rows bottom to top. */
export function encodePfm(pixels, width, height) {
  const header = Buffer.from(`PF\n${width} ${height}\n-1.0\n`, 'latin1');
  const body = Buffer.alloc(width * height * 12);
  const rowFloats = width * 3;
  for (let row = 0; row < height; row++) {
    const source = pixels.subarray((height - 1 - row) * rowFloats, (height - row) * rowFloats);
    Buffer.from(source.buffer, source.byteOffset, source.byteLength).copy(body, row * rowFloats * 4);
  }
  return Buffer.concat([header, body]);
}

export function decodePfm(bytes, width, height) {
  let cursor = 0;
  const fields = [];
  while (fields.length < 4) {
    let end = cursor;
    while (bytes[end] > 32) end++;
    fields.push(bytes.toString('latin1', cursor, end));
    cursor = end + 1;
  }
  if (fields[0] !== 'PF' || Number(fields[1]) !== width || Number(fields[2]) !== height || Number(fields[3]) >= 0) {
    throw new Error('OIDN wrote a PFM that is not the expected little-endian colour image.');
  }
  const rowFloats = width * 3;
  const pixels = new Float32Array(rowFloats * height);
  for (let row = 0; row < height; row++) {
    const start = bytes.byteOffset + cursor + row * rowFloats * 4;
    const rowPixels = new Float32Array(bytes.buffer.slice(start, start + rowFloats * 4));
    pixels.set(rowPixels, (height - 1 - row) * rowFloats);
  }
  return pixels;
}

function runTool(binary, toolArguments) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, toolArguments, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`oidnDenoise exited with ${code}: ${errorText.trim().slice(0, 400)}`))));
  });
}

/**
 * Denoises one HDR image. `color`, `albedo` and `normal` are row-major Float32Arrays with three floats per pixel: the
 * linear radiance, the first-hit albedo and the unit first-hit normal. Resolves with a new Float32Array of the same
 * shape. `device` is "cpu" (the default: the result does not depend on a GPU, and the GPU stays free) or any name
 * `oidnDenoise --device` takes. Rejects when the tool is missing, so a caller can fall back.
 */
export async function denoiseWithOidn({ width, height, color, albedo, normal, device = 'cpu', quality = 'high', threads = 0, cleanAux = false }) {
  const binary = findOidnBinary();
  if (!binary) throw new Error('The oidnDenoise tool is not installed: run `npm run fetch` in the denoise package, or set OIDN_DENOISE_PATH.');
  const directory = await mkdtemp(join(tmpdir(), '67js-oidn-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'color.pfm'), encodePfm(color, width, height)),
      writeFile(join(directory, 'albedo.pfm'), encodePfm(albedo, width, height)),
      writeFile(join(directory, 'normal.pfm'), encodePfm(normal, width, height)),
    ]);
    await runTool(binary, [
      '--device', device, '--quality', quality, '--hdr', join(directory, 'color.pfm'), '--alb', join(directory, 'albedo.pfm'),
      '--nrm', join(directory, 'normal.pfm'), '--output', join(directory, 'out.pfm'), ...(cleanAux ? ['--clean_aux'] : []), ...(threads > 0 ? ['--threads', String(threads)] : []),
    ]);
    return decodePfm(await readFile(join(directory, 'out.pfm')), width, height);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
