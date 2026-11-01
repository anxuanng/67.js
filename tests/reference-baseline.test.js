import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const REFERENCE_DIRECTORY = new URL('../bench/reference/', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('baseline.json', REFERENCE_DIRECTORY), 'utf8'));
const EXPECTED_SCENES = ['brick-flat', 'brick-graph', 'brick-room', 'brushed-film', 'car-paint', 'character', 'dark-shaft', 'fog', 'foliage', 'glass', 'light-linking', 'lit-interior', 'long-street', 'material-spheres', 'megacity-dusk', 'metal', 'metal-room', 'mountain-valley', 'outdoor-hdri', 'spot-area', 'temple-hall'];
const EXPECTED_SCORES = ['cpu-vs-cycles', 'cpu-vs-eevee', 'eevee-vs-cycles', 'gpu-vs-cpu', 'gpu-vs-cycles', 'gpu-vs-eevee'];
const REGION_SCORES = ['region-eevee-vs-cycles', 'region-gpu-vs-cycles', 'region-gpu-vs-eevee', 'region-pixels'];
// Scenes that declare a brightRegion in scenes.js are also scored on the bright pixels of the Cycles image.
const REGION_SCENES = ['dark-shaft', 'temple-hall'];

test('the render baseline scores every scene with every renderer pair', () => {
  assert.match(baseline.blenderVersion, /^5\.2/);
  assert.deepEqual(Object.keys(baseline.scores).sort(), EXPECTED_SCENES);
  for (const [scene, scores] of Object.entries(baseline.scores)) {
    const expected = REGION_SCENES.includes(scene) ? [...EXPECTED_SCORES, ...REGION_SCORES].sort() : EXPECTED_SCORES;
    assert.deepEqual(Object.keys(scores).sort(), expected, scene);
    for (const [pair, score] of Object.entries(scores)) {
      assert.ok(score >= 0 && score <= 1, `${scene} ${pair} is ${score}`);
    }
  }
});

test('every baseline scene has its side by side image', () => {
  for (const scene of EXPECTED_SCENES) {
    assert.ok(existsSync(new URL(`images/${scene}.jpg`, REFERENCE_DIRECTORY)), `Missing image for ${scene}`);
  }
});

test('the baseline records real hardware and a software renderer, and no local paths', () => {
  assert.doesNotMatch(baseline.graphics.gpu, /swiftshader/i);
  assert.match(baseline.graphics.cpu, /swiftshader/i);
  assert.doesNotMatch(JSON.stringify(baseline), /[A-Z]:[\\/]Users/);
});
