import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const output = resolve(process.argv[2] ?? 'artifacts/critical-score.wav');
const sampleRate = 48000;
const duration = 32;
const frameCount = sampleRate * duration;
const data = Buffer.alloc(44 + frameCount * 4);
data.write('RIFF', 0);
data.writeUInt32LE(data.length - 8, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22);
data.writeUInt32LE(sampleRate, 24);
data.writeUInt32LE(sampleRate * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(frameCount * 4, 40);
let seed = 67;
let filteredNoise = 0;
let peak = 0;
let energy = 0;
for (let index = 0; index < frameCount; index++) {
  const time = index / sampleRate;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const noise = seed / 4294967296 * 2 - 1;
  filteredNoise += (noise - filteredNoise) * 0.03;
  const fade = Math.min(1, time / 1.5) * Math.min(1, (duration - time) / 2);
  const tension = Math.min(1, time / 19);
  let value = Math.sin(time * Math.PI * 2 * 55) * 0.05;
  value += Math.sin(time * Math.PI * 2 * 82.4069 + Math.sin(time * 0.6) * 0.1) * 0.035;
  value += Math.sin(time * Math.PI * 2 * 110) * 0.024;
  value += Math.sin(time * Math.PI * 2 * 164.8138) * 0.012;
  const beatInterval = time < 13.5 ? 1 : 0.5;
  const beatAge = time % beatInterval;
  const pulse = Math.sin(beatAge * Math.PI * 2 * (48 + tension * 6)) * Math.exp(-beatAge * 13);
  if (time < 19) value += pulse * (0.025 + tension * 0.11);
  const ignitionAge = time - 19;
  if (ignitionAge >= 0) {
    value += Math.sin(ignitionAge * Math.PI * 2 * (30 + 20 * Math.exp(-ignitionAge * 2))) * Math.exp(-ignitionAge * 0.9) * 0.32;
    value += filteredNoise * Math.exp(-ignitionAge * 0.4) * 0.65;
  }
  value += filteredNoise * 0.03 * tension;
  value = Math.tanh(value * 1.9) * fade * 0.85;
  const right = value + Math.sin(time * Math.PI * 2 * 110.14) * 0.012 * fade;
  peak = Math.max(peak, Math.abs(value), Math.abs(right));
  energy += value * value + right * right;
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right)) * 32767), 46 + index * 4);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, data);
console.log(JSON.stringify({ duration, sampleRate, channels: 2, peakDbfs: 20 * Math.log10(peak), rmsDbfs: 20 * Math.log10(Math.sqrt(energy / (frameCount * 2))), provenance: 'Original deterministic synthesized score. No samples or movie audio.' }, null, 2));
