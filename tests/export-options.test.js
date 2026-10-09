import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRenderOptions } from '../scripts/render-media.mjs';

test('motion portrait exports derive dimensions and duration without launching a browser', () => {
  const options = parseRenderOptions(['--scene', 'motion', '--kind', 'video', '--aspect', 'portrait', '--backend', 'cpu']);
  assert.equal(options.width, 360);
  assert.equal(options.height, 640);
  assert.equal(options.duration, 12);
  assert.equal(options.start, 0);
  assert.equal(options.audio, null);
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
  assert.equal(film.duration, 32);
  assert.equal(film.width, 1280);
  assert.equal(film.height, 720);
});

test('invalid export options fail before starting resources', () => {
  for (const args of [
    ['--aspect', 'diagonal'], ['--start', '-1'], ['--start', 'NaN'], ['--duration', '0'],
    ['--width', '0'], ['--backend', 'unknown'], ['--scene', 'unknown'], ['--encoder', 'unknown'],
    ['--unknown', 'value'], ['--aspect'], ['--kind', 'video', '--width', '101', '--height', '100'],
  ]) assert.throws(() => parseRenderOptions(args));
});

test('asset captures select a supplied file and avoid an automatic soundtrack', () => {
  const plan = parseRenderOptions(['--scene', 'assets', '--asset', 'model.glb']);
  assert.equal(plan.options.asset, 'model.glb');
  assert.equal(plan.audio, null);
  assert.equal(plan.time, 0);
  assert.throws(() => parseRenderOptions(['--scene', 'motion', '--asset', 'model.glb']));
});
