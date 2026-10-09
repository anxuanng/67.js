import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_PRESETS, resolveEffects } from '../src/effects.js';

test('neutral effects preserve the existing image by default', () => {
  assert.deepEqual(resolveEffects(), EFFECT_PRESETS.neutral);
});

test('partial bloom settings retain defaults without changing caller data', () => {
  const settings = { bloom: { strength: 0.4 } };
  const resolved = resolveEffects(settings);
  assert.equal(resolved.bloom.threshold, 1);
  assert.equal(resolved.bloom.strength, 0.4);
  assert.deepEqual(settings, { bloom: { strength: 0.4 } });
  for (const preset of Object.values(EFFECT_PRESETS)) assert.deepEqual(resolveEffects(preset), preset);
});

test('nonfinite or out-of-range effects fail before GPU uniforms are changed', () => {
  for (const settings of [{ saturation: Infinity }, { contrast: 0 }, { temperature: 2 }, { grain: -1 }, { bloom: { radius: NaN } }, { bloom: false }, null]) {
    assert.throws(() => resolveEffects(settings));
  }
});
