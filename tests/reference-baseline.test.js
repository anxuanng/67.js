import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const REFERENCE_DIRECTORY = new URL('../bench/reference/', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('baseline.json', REFERENCE_DIRECTORY), 'utf8'));
const EXPECTED_SCENES = ['brick-flat', 'brick-graph', 'brick-room', 'brushed-film', 'car-paint', 'character', 'dark-shaft', 'fog', 'fog-room', 'fog-valley', 'foliage', 'glass', 'light-linking', 'lit-interior', 'long-street', 'material-spheres', 'megacity-dusk', 'metal', 'metal-room', 'mountain-valley', 'outdoor-hdri', 'spot-area', 'subsurface', 'subsurface-off', 'temple-hall'];
const EXPECTED_SCORES = ['cpu-vs-cycles', 'cpu-vs-eevee', 'eevee-vs-cycles', 'gpu-vs-cpu', 'gpu-vs-cycles', 'gpu-vs-eevee'];
const REGION_SCORES = ['region-eevee-vs-cycles', 'region-gpu-vs-cycles', 'region-gpu-vs-eevee', 'region-pixels'];
// Scenes that declare a brightRegion in scenes.js are also scored on the bright pixels of the Cycles image.
const REGION_SCENES = ['dark-shaft', 'fog-room', 'temple-hall'];

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

test('the water of the megacity scenes stands above the ground box, not in the same plane', () => {
  // Cycles resolves two surfaces in one plane at random per ray, which dimmed the river to about a third of a mirror (#232).
  const source = readFileSync(new URL('grand-scenes.js', REFERENCE_DIRECTORY), 'utf8');
  const topOf = (name, thickness) => {
    const match = source.match(new RegExp(`part\\('${name}', UNIT_BOX, \\[[^,]+, (-?[\\d.]+), `));
    assert.ok(match, `${name} is declared in grand-scenes.js`);
    return Number((Number(match[1]) + thickness / 2).toFixed(3));
  };
  const groundTop = topOf('city-ground', 2);
  assert.ok(topOf('river', 1.4) > groundTop, 'the river top is above the ground top');
  assert.ok(topOf('bay', 1.4) > groundTop, 'the bay top is above the ground top');
});
