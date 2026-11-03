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

test('ambient occlusion with depth, or switched off, is silent', () => {
  assert.deepEqual(frameDiagnostics({ depth: true, effects: resolveEffects({ ambientOcclusion: 0.6 }) }), []);
  assert.deepEqual(frameDiagnostics({ depth: false, effects: resolveEffects({ ambientOcclusion: 0 }) }), []);
});
