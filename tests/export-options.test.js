import assert from 'node:assert/strict';
import test from 'node:test';
import { FILM_DURATION } from '../src/film.js';
import { parseRenderOptions, selectEncoderBackend } from '../scripts/render-media.mjs';

test('motion portrait exports derive dimensions and duration without launching a browser', () => {
  const options = parseRenderOptions(['--scene', 'motion', '--kind', 'video', '--aspect', 'portrait', '--backend', 'cpu']);
  assert.equal(options.width, 360);
  assert.equal(options.height, 640);
  assert.equal(options.duration, 12);
  assert.equal(options.start, 0);
  assert.equal(options.audio, null);
  assert.equal(options.encoderBackend, 'cpu');
});

test('square and explicit dimensions preserve their selected compositions', () => {
  const square = parseRenderOptions(['--aspect', 'square']);
  assert.equal(square.width, 720);
  assert.equal(square.height, 720);
  const explicit = parseRenderOptions(['--aspect', 'portrait', '--width', '800', '--height', '1200']);
  assert.equal(explicit.width, 800);
  assert.equal(explicit.height, 1200);
  const width = parseRenderOptions(['--aspect', 'portrait', '--width', '360']);
  assert.equal(width.height, 640);
  const height = parseRenderOptions(['--aspect', 'landscape', '--height', '540']);
  assert.equal(height.width, 960);
});

test('only film selects the original soundtrack automatically', () => {
  assert.equal(parseRenderOptions(['--scene', 'film']).audio, 'artifacts/critical-score.wav');
  for (const scene of ['object', 'nature', 'motion', 'view2d']) assert.equal(parseRenderOptions(['--scene', scene]).audio, null);
  assert.equal(parseRenderOptions(['--scene', 'motion', '--audio', 'my-score.wav']).audio, 'my-score.wav');
});

test('new options retain start offsets and legacy renderer presets', () => {
  const options = parseRenderOptions(['--scene', 'view2d', '--backend', 'cpu', '--start', '2.5', '--duration', '4']);
  assert.equal(options.scene, 'view2d');
  assert.equal(options.width, 640);
  assert.equal(options.height, 360);
  assert.equal(options.duration, 4);
  assert.equal(options.start, 2.5);
  const film = parseRenderOptions([]);
  assert.equal(film.scene, 'film');
  assert.equal(film.duration, FILM_DURATION);
  assert.equal(film.width, 1280);
  assert.equal(film.height, 720);
});

test('invalid export options fail before starting resources', () => {
  for (const args of [
    ['--aspect', 'diagonal'], ['--start', '-1'], ['--start', 'NaN'], ['--duration', '0'],
    ['--width', '0'], ['--backend', 'unknown'], ['--scene', 'unknown'], ['--encoder', 'unknown'], ['--duration', '241'],
    ['--unknown', 'value'], ['--aspect'], ['--kind', 'video', '--width', '101', '--height', '100'],
    ['--capture', 'webp'], ['--jpeg-quality', '0'], ['--jpeg-quality', '101'], ['--jpeg-quality', '94.5'], ['--jpeg-quality', 'NaN'],
  ]) assert.throws(() => parseRenderOptions(args));
});

test('video defaults to JPEG 95 and auto encoding while stills retain lossless PNG', () => {
  const video = parseRenderOptions(['--kind', 'video']);
  assert.equal(video.captureFormat, 'jpeg');
  assert.equal(video.jpegQuality, 95);
  assert.equal(video.encoderBackend, 'auto');
  assert.equal(parseRenderOptions([]).captureFormat, 'png');
  assert.equal(parseRenderOptions(['--kind', 'stills']).captureFormat, 'png');
  const losslessVideo = parseRenderOptions(['--kind', 'video', '--capture', 'png', '--encoder', 'cpu']);
  assert.equal(losslessVideo.captureFormat, 'png');
  assert.equal(losslessVideo.encoderBackend, 'cpu');
  const jpegImage = parseRenderOptions(['--capture', 'jpeg', '--jpeg-quality', '88']);
  assert.equal(jpegImage.jpegQuality, 88);
  assert.ok(jpegImage.output.endsWith('.jpg'));
});

test('encoder preflight probes hardware only when required and falls back only in auto mode', async () => {
  let probeCalls = 0;
  const available = async () => {
    probeCalls++;
    return { available: true };
  };
  const unavailable = async () => {
    probeCalls++;
    return { available: false, reason: 'driver unavailable' };
  };
  assert.equal(await selectEncoderBackend('cpu', unavailable), 'cpu');
  assert.equal(probeCalls, 0);
  assert.equal(await selectEncoderBackend('auto', available), 'gpu');
  assert.equal(await selectEncoderBackend('gpu', available), 'gpu');
  assert.equal(await selectEncoderBackend('auto', unavailable), 'cpu');
  await assert.rejects(selectEncoderBackend('gpu', unavailable), /NVENC is unavailable: driver unavailable/);
  assert.equal(probeCalls, 4);
  await assert.rejects(selectEncoderBackend('unknown', available), /Encoder must be/);
  assert.equal(probeCalls, 4);
});

test('full trailer exports accept the authored duration within the four-minute cap', () => {
  assert.equal(parseRenderOptions(['--kind', 'video', '--duration', '187']).duration, FILM_DURATION);
  assert.equal(parseRenderOptions(['--kind', 'video', '--duration', '240']).duration, 240);
});

test('asset captures select a supplied file and avoid an automatic soundtrack', () => {
  const plan = parseRenderOptions(['--scene', 'assets', '--asset', 'model.glb']);
  assert.equal(plan.options.asset, 'model.glb');
  assert.equal(plan.audio, null);
  assert.equal(plan.time, 0);
  assert.throws(() => parseRenderOptions(['--scene', 'motion', '--asset', 'model.glb']));
});
