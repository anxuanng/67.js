import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { measureWaterShadows } from '../scripts/measure-water-shadows.mjs';
import { WATER_PRESETS } from '../src/world-material-shader.js';

// Draws the pool in Chrome, so it runs only when asked:
//   RENDER_TESTS=1 bash ~/.agents/tools/gpu-lock.sh node --test tests/water-shadows-render.test.js
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);

test('bed shadow contrast follows the eye and refracted sun legs within 10% (or 0.05) for clear water, never goes negative, and the surface shadow stays faint', { skip: !enabled, timeout: 240000 }, async () => {
  const report = await measureWaterShadows();
  for (const row of report.rows.filter(candidate => candidate.preset === 'lake')) {
    row.contrast.forEach((measured, channel) => {
      // The eye's leg is vertical and the sun's leg is the refracted ray, depth / cos(theta_t), with the sun 0.6 off the vertical per metre up and n = 1.33.
      const sineAir = 0.6 / Math.hypot(0.6, 1);
      const cosineWater = Math.sqrt(1 - (sineAir / 1.33) ** 2);
      const expected = Math.exp(-WATER_PRESETS.lake.absorption[channel] * row.depth * (1 + 1 / cosineWater));
      assert.ok(Math.abs(measured - expected) <= Math.max(0.1 * expected, 0.05), `lake ${row.depth} m channel ${channel}: measured ${measured.toFixed(3)}, expected ${expected.toFixed(3)}`);
    });
  }
  for (const row of report.rows) {
    assert.ok(Math.min(...row.contrast) >= 0, `${row.preset} ${row.depth} m: the shadow never inverts (${row.contrast.map(value => value.toFixed(3)).join(', ')})`);
  }
  // Cycles keeps about a quarter of the contrast on a murky bed 4 m down (bench/reference/README.md), where Beer-Lambert alone would leave none.
  const murky = report.rows.find(row => row.preset === 'river' && row.depth === 4);
  assert.ok(murky.contrast.every(value => value > 0.1 && value < 0.35), 'a shadow on a murky bed 4 m down keeps a floor of contrast');
  const surface = report.surface.lake;
  const darkening = view => Math.max(...surface[view].lit.map((value, channel) => 1 - surface[view].shadowed[channel] / value));
  assert.ok(darkening('grazing') < 0.01, 'the reflection at a grazing angle is not darkened by the shadow');
  assert.ok(darkening('steep') < 0.06, 'a shadow on the surface is faint');
});
