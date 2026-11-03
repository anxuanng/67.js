// Runs the denoisers on the captures of denoise-capture.mjs and writes <method>.f32 beside them:
//   node bench/reference/denoise-compare.mjs [--directory artifacts/denoise] [--oidn-device cpu]
// Methods: none (the traced colour), wavelet (src/path-tracer-denoise.js) and oidn (packages/denoise-oidn, native
// Open Image Denoise). OIDN runs twice per capture and the two outputs are compared byte for byte.
// denoise-score.py then scores every method against Cycles.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { denoiseWithOidn, findOidnBinary } from '../../packages/denoise-oidn/index.mjs';
import { denoiseRadiance } from '../../src/path-tracer-denoise.js';

const WIDTH = 960;
const HEIGHT = 540;
const FEATURE_NAMES = ['color', 'albedo', 'normal', 'depth', 'variance'];

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rootDirectory = resolve(optionValue('--directory', 'artifacts/denoise'));
const oidnDevice = optionValue('--oidn-device', 'cpu');

async function readFloats(path) {
  const bytes = await readFile(path);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function writeFloats(path, values) {
  return writeFile(path, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}

async function timed(work) {
  const started = performance.now();
  const value = await work();
  return { value, seconds: (performance.now() - started) / 1000 };
}

function sameBytes(first, second) {
  return Buffer.compare(Buffer.from(first.buffer), Buffer.from(second.buffer)) === 0;
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
if (!findOidnBinary()) throw new Error('Run `npm run fetch` in packages/denoise-oidn first.');
const timings = {};
for (const sceneEntry of await readdir(rootDirectory, { withFileTypes: true })) {
  if (!sceneEntry.isDirectory()) continue;
  for (const sampleEntry of await readdir(`${rootDirectory}/${sceneEntry.name}`, { withFileTypes: true })) {
    if (!sampleEntry.isDirectory()) continue;
    const directory = `${rootDirectory}/${sceneEntry.name}/${sampleEntry.name}`;
    const features = {};
    for (const name of FEATURE_NAMES) features[name] = await readFloats(`${directory}/${name}.f32`);
    const inputs = { width: WIDTH, height: HEIGHT, ...features };
    const wavelet = await timed(() => denoiseRadiance(inputs));
    const oidn = await timed(() => denoiseWithOidn({ ...inputs, device: oidnDevice }));
    const oidnAgain = await denoiseWithOidn({ ...inputs, device: oidnDevice });
    const oidnClean = await timed(() => denoiseWithOidn({ ...inputs, device: oidnDevice, cleanAux: true }));
    await writeFloats(`${directory}/oidn-clean-aux.f32`, oidnClean.value);
    await writeFloats(`${directory}/none.f32`, features.color);
    await writeFloats(`${directory}/wavelet.f32`, wavelet.value);
    await writeFloats(`${directory}/oidn.f32`, oidn.value);
    const key = `${sceneEntry.name}/${sampleEntry.name}`;
    timings[key] = { waveletSeconds: Number(wavelet.seconds.toFixed(2)), oidnSeconds: Number(oidn.seconds.toFixed(2)), oidnDevice, oidnSameBytesTwice: sameBytes(oidn.value, oidnAgain) };
    console.log(key, JSON.stringify(timings[key]));
  }
}
await writeFile(`${rootDirectory}/timings.json`, JSON.stringify(timings, null, 1));
