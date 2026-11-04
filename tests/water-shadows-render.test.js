import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { measureWaterShadows } from '../scripts/measure-water-shadows.mjs';
import { WATER_PRESETS } from '../src/world-material-shader.js';

// Draws the pool in Chrome, so it runs only when asked:
//   RENDER_TESTS=1 bash ~/.agents/tools/gpu-lock.sh node --test tests/water-shadows-render.test.js
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);

test('bed shadow contrast follows exp(-absorption * depth) within 10% for clear water, and the surface shadow stays faint', { skip: !enabled, timeout: 240000 }, async () => {
  const report = await measureWaterShadows();
  for (const row of report.rows.filter(candidate => candidate.preset === 'lake')) {
    row.contrast.forEach((measured, channel) => {
      const expected = Math.exp(-WATER_PRESETS.lake.absorption[channel] * row.depth);
      assert.ok(Math.abs(measured - expected) / expected < 0.1, `lake ${row.depth} m channel ${channel}: measured ${measured.toFixed(3)}, expected ${expected.toFixed(3)}`);
    });
  }
  const murky = report.rows.find(row => row.preset === 'river' && row.depth === 4);
  assert.ok(Math.max(...murky.contrast) < 0.05, 'a shadow on a murky bed 4 m down is gone');
  const surface = report.surface.lake;
  const darkening = view => Math.max(...surface[view].lit.map((value, channel) => 1 - surface[view].shadowed[channel] / value));
  assert.ok(darkening('grazing') < 0.01, 'the reflection at a grazing angle is not darkened by the shadow');
  assert.ok(darkening('steep') < 0.06, 'a shadow on the surface is faint');
});
