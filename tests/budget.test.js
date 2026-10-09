import test from 'node:test';
import assert from 'node:assert/strict';
import { planRenderSize, RENDER_PRESETS, estimateFrameBytes, estimateTextureBytes } from '../src/budget.js';

test('high resolution render targets shrink before exceeding their memory budget', () => {
  const plan = planRenderSize({ width: 7680, height: 4320, samples: 4, memoryBudgetMiB: 128, geometryBytes: 20 * 1024 ** 2 });
  assert.ok(plan.reduced);
  assert.ok(plan.estimatedBytes <= 128 * 1024 ** 2);
  assert.ok(Math.abs(plan.width / plan.height - 16 / 9) < 0.003);
});

test('HDR, two half-resolution bloom targets and cached texture mipmaps fit inside the budget', () => {
  const textureBytes = estimateTextureBytes(2048, 2048);
  assert.equal(textureBytes, 22369620);
  assert.equal(estimateTextureBytes(3, 5), 72);
  assert.equal(estimateTextureBytes(3, 5, { mipmaps: false }), 60);
  const plan = planRenderSize({ width: 7681, height: 4321, hdr: true, bloom: true, textureBytes, samples: 4, memoryBudgetMiB: 128 });
  assert.ok(plan.reduced);
  assert.ok(plan.estimatedBytes <= 128 * 1024 ** 2);
  assert.equal(plan.estimatedBytes, estimateFrameBytes(plan.width, plan.height, 4, 2048, { hdr: true, bloom: true }) + textureBytes);
  assert.ok(estimateFrameBytes(100, 101, 4, 0, { hdr: true, bloom: true }) > estimateFrameBytes(100, 101, 4, 0));
  assert.throws(() => planRenderSize({ width: 640, height: 360, textureBytes: 200 * 1024 ** 2, memoryBudgetMiB: 128 }), /cannot hold/);
  assert.throws(() => estimateTextureBytes(-1, 32), /positive/);
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

test('resolved depth adds exactly four bytes per pixel and participates in resolution reduction', () => {
  assert.equal(estimateFrameBytes(540, 960, 4, 2048, { hdr: true, depth: true }) - estimateFrameBytes(540, 960, 4, 2048, { hdr: true }), 540 * 960 * 4);
  const options = { width: 7680, height: 4320, hdr: true, bloom: true, samples: 4, memoryBudgetMiB: 64 };
  const ordinary = planRenderSize(options);
  const resolved = planRenderSize({ ...options, depth: true });
  assert.ok(resolved.width < ordinary.width);
  assert.equal(resolved.estimatedBytes, estimateFrameBytes(resolved.width, resolved.height, 4, 2048, { hdr: true, bloom: true, depth: true }));
  assert.ok(resolved.estimatedBytes <= 64 * 1024 ** 2);
});
