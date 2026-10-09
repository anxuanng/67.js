import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/blink-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: '<canvas style="width:540px;height:960px;display:block"></canvas>',
  }));
  await page.goto('http://127.0.0.1:5173/blink-smoke.html');
  const report = await page.evaluate(async () => {
    const { Renderer67 } = await import('/build/67.module.js');
    const { createFilmScenes } = await import('/build/film.js');
    const scene = createFilmScenes().portrait;
    const canvas = document.querySelector('canvas');
    const renderer = new Renderer67(canvas, scene.parts, {
      world: true, ground: false, environment: scene.environment,
      shadowBounds: scene.shadowBounds, samples: 2, pixelRatio: 1,
      hdr: true, memoryBudgetMiB: 128,
    });
    const frame = { eye: [0, 1.72, 0.72], target: [0, 1.7, 0], fov: 36, time: 0, effects: { grain: 0, bloom: { strength: 0 } } };
    function image(time, suppressBlink = false) {
      scene.animate(time);
      if (suppressBlink) {
        for (const part of scene.parts) if (part.morph) part.morph.weights.fill(0);
      }
      renderer.updateParts(scene.parts);
      renderer.render(frame);
      return canvas.toDataURL('image/png');
    }
    const open = image(0);
    const closed = image(1.92);
    const samePoseWithoutBlink = image(1.92, true);
    image(9);
    const repeated = image(1.92);
    const error = renderer.context.getError();
    const memory = renderer.memoryPlan;
    renderer.dispose();
    return { open, closed, samePoseWithoutBlink, repeated, error, memory };
  });
  assert.deepEqual(errors, []);
  assert.equal(report.error, 0);
  assert.notEqual(report.closed, report.samePoseWithoutBlink, 'Eyelid geometry must change pixels independently of head movement');
  assert.equal(report.closed, report.repeated);
  for (const name of ['open', 'closed']) {
    await writeFile(`artifacts/blink-${name}.png`, Buffer.from(report[name].split(',')[1], 'base64'));
  }
  console.log(JSON.stringify({ glError: report.error, repeatExact: true, independentBlinkPixels: true, memory: report.memory }));
} finally {
  await browser.close();
}
