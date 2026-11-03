// A raw video frame must match the PNG seek of the same time. Both come from SwiftShader, so no GPU is needed (issue #301).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderMedia } from './render-media.mjs';

const MINIMUM_PSNR_DECIBELS = 30;
const FPS = 12;
const FRAME_INDEX = 6;
const ffmpeg = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.local/bin/ffmpeg.exe') : 'ffmpeg';
const directory = await mkdtemp(join(tmpdir(), 'capture-parity-'));
try {
  const videoPath = join(directory, 'clip.mp4');
  const stillPath = join(directory, 'seek.png');
  const decodedPath = join(directory, 'decoded.png');
  const common = ['--scene', 'film', '--backend', 'cpu', '--preset', 'cpu'];
  await renderMedia([...common, '--kind', 'video', '--capture', 'raw', '--duration', '1', '--output', videoPath]);
  await renderMedia([...common, '--kind', 'image', '--time', String(FRAME_INDEX / FPS), '--output', stillPath]);
  const decode = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
    '-vf', `select=eq(n\\,${FRAME_INDEX})`, '-frames:v', '1', decodedPath]);
  assert.equal(decode.status, 0, String(decode.stderr));
  const compare = spawnSync(ffmpeg, ['-hide_banner', '-i', decodedPath, '-i', stillPath, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const decibels = Number(/average:(\S+)/.exec(compare.stderr)?.[1]);
  assert.ok(decibels >= MINIMUM_PSNR_DECIBELS, `the raw frame matches its PNG seek at ${decibels} dB, below ${MINIMUM_PSNR_DECIBELS} dB`);
  console.log(`raw capture parity ok: ${decibels.toFixed(1)} dB`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
