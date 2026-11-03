import assert from 'node:assert/strict';
import test from 'node:test';
import { frameDiagnostics } from '../src/frame-diagnostics.js';
import { resolveEffects } from '../src/effects.js';

test('ambient occlusion on a renderer without depth gets a named warning', () => {
  const problems = frameDiagnostics({ depth: false, effects: resolveEffects({ ambientOcclusion: 0.6 }) });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'ambient-occlusion-without-depth');
  assert.equal(problems[0].severity, 'warning');
  assert.match(problems[0].fix, /depth: true/);
});

const quietEffects = resolveEffects({});

test('a shadow eye 10 degrees or more off the light direction gets a named warning', () => {
  const lightDirection = [0, 1, 0];
  const twelveDegrees = 12 * Math.PI / 180;
  const shadowBounds = { target: [0, 0, 0], eye: [0, 50 * Math.cos(twelveDegrees), 50 * Math.sin(twelveDegrees)] };
  const problems = frameDiagnostics({ world: false, depth: true, effects: quietEffects, lightDirection, shadowBounds });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'shadow-light-direction-mismatch');
  assert.match(problems[0].message, /12 degrees/);
});

test('a shadow eye that follows the light, or no eye at all, is silent', () => {
  const lightDirection = [-3, 6, 4];
  const aligned = { target: [0, 0, 0], eye: [-6, 12, 8] };
  assert.deepEqual(frameDiagnostics({ world: false, depth: true, effects: quietEffects, lightDirection, shadowBounds: aligned }), []);
  assert.deepEqual(frameDiagnostics({ world: false, depth: true, effects: quietEffects, lightDirection, shadowBounds: { extent: 5 } }), []);
});

test('ambient occlusion with depth, or switched off, is silent', () => {
  assert.deepEqual(frameDiagnostics({ depth: true, effects: resolveEffects({ ambientOcclusion: 0.6 }) }), []);
  assert.deepEqual(frameDiagnostics({ depth: false, effects: resolveEffects({ ambientOcclusion: 0 }) }), []);
});
