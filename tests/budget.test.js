import test from 'node:test';
import assert from 'node:assert/strict';
import { planRenderSize, RENDER_PRESETS } from '../src/budget.js';

test('high resolution render targets shrink before exceeding their memory budget', () => {
  const plan = planRenderSize({ width: 7680, height: 4320, samples: 4, memoryBudgetMiB: 128, geometryBytes: 20 * 1024 ** 2 });
  assert.ok(plan.reduced);
  assert.ok(plan.estimatedBytes <= 128 * 1024 ** 2);
  assert.ok(Math.abs(plan.width / plan.height - 16 / 9) < 0.003);
});

test('presets fit their budget and device texture limits', () => {
  for (const preset of Object.values(RENDER_PRESETS)) {
    const plan = planRenderSize({ ...preset, maximumSize: 1024 });
    assert.ok(plan.width <= 1024 && plan.height <= 1024);
    assert.ok(plan.estimatedBytes <= preset.memoryBudgetMiB * 1024 ** 2);
  }
});

test('invalid or impossible memory requests fail before allocation', () => {
  assert.throws(() => planRenderSize({ width: 0, height: 720 }));
  assert.throws(() => planRenderSize({ width: 1280, height: 720, geometryBytes: 300 * 1024 ** 2, memoryBudgetMiB: 128 }), /cannot hold/);
  assert.throws(() => planRenderSize({ width: Infinity, height: 720 }));
});
