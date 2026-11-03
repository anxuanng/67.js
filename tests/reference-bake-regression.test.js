import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MARGIN, findRegressions } from '../bench/reference/compare-scores.mjs';

// Reads JSON files only; nothing here renders, so CI can run it. After `npm run reference -- --bake <ids> --skip-blender`
// the fresh results sit in artifacts/reference/bake.json, and the last test compares them with the stored ones.
const storedPath = fileURLToPath(new URL('../bench/reference/bake.json', import.meta.url));
const freshPath = fileURLToPath(new URL('../artifacts/reference/bake.json', import.meta.url));
const stored = JSON.parse(readFileSync(storedPath, 'utf8'));
const BAKED_ROOMS = ['brick-room', 'dark-shaft', 'lit-interior', 'metal-room', 'temple-hall'];

test('the stored bake scores hold every baked room, with no local paths', () => {
  assert.match(stored.blenderVersion, /^5\.2/);
  assert.deepEqual(Object.keys(stored.scores).sort(), BAKED_ROOMS);
  for (const [scene, scores] of Object.entries(stored.scores)) {
    for (const [name, score] of Object.entries(scores)) {
      assert.ok(score >= 0 && score <= 1, `${scene} ${name} is ${score}`);
    }
  }
  assert.doesNotMatch(JSON.stringify(stored), /[A-Z]:[\\/]Users/);
});

test('a score that gets worse by more than the margin is a regression, and noise inside it is not', () => {
  // The numbers of issue #160: lit-interior baked went from 0.1444 to 0.1915 and nothing failed.
  const before = { scores: { 'lit-interior': { 'gpu-vs-cycles': 0.1444, 'region-pixels': 0.1 }, 'brick-room': { 'gpu-vs-cycles': 0.1515 } } };
  const regressed = { scores: { 'lit-interior': { 'gpu-vs-cycles': 0.1915, 'region-pixels': 0.5 }, 'brick-room': { 'gpu-vs-cycles': 0.1515 + DEFAULT_MARGIN / 2 } } };
  assert.deepEqual(findRegressions(before, regressed), [{ scene: 'lit-interior', name: 'gpu-vs-cycles', stored: 0.1444, fresh: 0.1915 }]);
});

test('a better score, and a scene the fresh run did not draw, are not regressions', () => {
  const before = { scores: { a: { 'gpu-vs-cycles': 0.2 }, b: { 'gpu-vs-cycles': 0.2 } } };
  const fresh = { scores: { a: { 'gpu-vs-cycles': 0.1 } } };
  assert.deepEqual(findRegressions(before, fresh), []);
});

test('a fresh bake.json from a run has no score worse than the stored one by the margin', { skip: !existsSync(freshPath) && 'no fresh run in artifacts/reference' }, () => {
  const fresh = JSON.parse(readFileSync(freshPath, 'utf8'));
  assert.deepEqual(findRegressions(stored, fresh), []);
});
