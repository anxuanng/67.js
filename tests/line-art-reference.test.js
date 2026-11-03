import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { verticalEdgeWidths, median, maskOverlap, dilate } from '../bench/reference/line-art-measure.mjs';

// A vertical line of the given width (in pixels, fractions allowed) centred at x, as a strength map.
function verticalLine(imageWidth, imageHeight, centreX, lineWidth) {
  const strength = new Float32Array(imageWidth * imageHeight);
  for (let row = 0; row < imageHeight; row++) {
    for (let column = 0; column < imageWidth; column++) {
      const overlap = Math.min(column + 1, centreX + lineWidth / 2) - Math.max(column, centreX - lineWidth / 2);
      strength[row * imageWidth + column] = Math.max(0, Math.min(1, overlap));
    }
  }
  return strength;
}

test('the width measure reads whole and fractional pixel widths of a vertical edge', () => {
  // Below 2 px no pixel is fully covered, so the strongest pixel under-reads the full line colour and the width reads high.
  for (const lineWidth of [2, 2.5, 4, 8]) {
    const widths = verticalEdgeWidths(verticalLine(200, 100, 100.3, lineWidth), 200, 100, { rowStep: 5 });
    assert.ok(Math.abs(median(widths) - lineWidth) < 0.05, `width ${lineWidth} measured ${median(widths)}`);
  }
});

test('the width measure skips diagonal edges', () => {
  const strength = new Float32Array(200 * 100);
  for (let row = 0; row < 100; row++) {
    for (let column = row; column < row + 3; column++) strength[row * 200 + column] = 1;
  }
  assert.equal(verticalEdgeWidths(strength, 200, 100, { rowStep: 5 }).length, 0);
});

test('mask overlap counts a line one pixel off only after dilation', () => {
  const first = new Uint8Array(20 * 4).map((value, index) => (index % 20 === 5 ? 1 : 0));
  const second = new Uint8Array(20 * 4).map((value, index) => (index % 20 === 6 ? 1 : 0));
  assert.equal(maskOverlap(first, second).iou, 0);
  assert.equal(maskOverlap(first, dilate(second, 20, 4, 1)).intersection, 4);
});

test('the reference scene is a valid recipe with real hard creases', async () => {
  const recipe = JSON.parse(await readFile(new URL('../bench/reference/line-art-scene.json', import.meta.url), 'utf8'));
  const withLines = { ...recipe, environment: { ...recipe.environment, lines: { width: 2 } } };
  await loadAgentSceneModules(withLines);
  const scene = createAgentScene(withLines);
  assert.equal(scene.environment.lines.width, 2);
  assert.equal(scene.parts.length, recipe.nodes.length);
  assert.equal(recipe.geometries.find(geometry => geometry.id === 'box').bevel, 0);
});
