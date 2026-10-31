import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { AUDIO_FILE_PATTERN } from '../src/agent-scene-capabilities.js';

// Audio for render jobs: local files in one configured folder, chosen by plain file name. The agent never supplies a
// path, URL or ffmpeg argument; ffmpeg only receives the resolved path and a fixed protocol whitelist.

export const MAXIMUM_AUDIO_BYTES = 32 * 1024 ** 2;
const PROBE_TIMEOUT_MS = 30000;
// Every file is resampled to this rate: AAC adds one 1024-sample frame of delay, 21 ms here but 64 ms at 16 kHz.
const OUTPUT_SAMPLE_RATE = 48000;

/** Looks files up in `root`, refusing links and anything that resolves outside it. */
export function createAudioLibrary(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('Audio root must be an explicit absolute directory path.');
  return Object.freeze({
    async resolve(file) {
      if (typeof file !== 'string' || !AUDIO_FILE_PATTERN.test(file)) throw new TypeError('Audio file name is not allowed.');
      const path = join(root, file);
      const information = await lstat(path).catch(() => { throw new RangeError(`Audio file ${file} is not in the audio folder.`); });
      if (!information.isFile() || information.isSymbolicLink() || information.nlink > 1) throw new RangeError(`Audio file ${file} must be a regular file without links.`);
      if (information.size < 1 || information.size > MAXIMUM_AUDIO_BYTES) throw new RangeError(`Audio file ${file} must be 1 byte to ${MAXIMUM_AUDIO_BYTES} bytes.`);
      const rootReal = await realpath(root);
      if (!(await realpath(path)).startsWith(rootReal + sep)) throw new RangeError('Audio file resolves outside the audio folder.');
      return path;
    },
  });
}

/** Input arguments for the encoder: the file is read at `offset` seconds and may only be opened as a plain file. */
export function audioInputArguments(path, offsetSeconds) {
  return ['-protocol_whitelist', 'file', '-ss', String(offsetSeconds), '-i', path, '-ar', String(OUTPUT_SAMPLE_RATE)];
}

function parseSeconds(text) {
  const matches = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) throw new Error('ffmpeg reported no decoded duration.');
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/** Decodes one stream to nowhere and reads how long it ran: `audio` or `video`. Decoded length, not container metadata. */
export function measureStreamSeconds(executable, path, stream, { format } = {}) {
  const map = stream === 'audio' ? ['-map', '0:a:0', '-vn'] : ['-map', '0:v:0', '-an'];
  const argumentsValue = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', ...(format ? ['-f', format] : []), '-i', path, ...map, '-f', 'null', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsValue, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-16384); });
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg could not decode the ${stream} stream: ${diagnostics.slice(-300)}`));
      try { resolve(parseSeconds(diagnostics)); } catch (error) { reject(error); }
    });
  });
}
