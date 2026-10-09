import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${process.argv[2] ?? 'http://127.0.0.1:5173'}/modeling.html`);
  await page.waitForFunction(() => window.__scene?.renderer || window.__modelingError);
  assert.equal(await page.evaluate(() => window.__modelingError), undefined);
  await page.locator('#modeling-play').click();
  assert.equal(await page.locator('#modeling-play').getAttribute('aria-pressed'), 'false');
  const report = await page.evaluate(() => {
    const { scene, renderer, renderAt } = window.__scene;
    const sample = time => {
      renderAt(time);
      const gl = renderer.context;
      const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
      gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let checksum = 2166136261;
      for (const value of pixels) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
      return { checksum, matrices: scene.parts.map(part => Array.from(part.matrix)), error: gl.getError() };
    };
    const first = sample(1);
    const next = sample(6);
    const repeated = sample(1);
    const root = scene.graph.getNode('Lantern assembly');
    root.localMatrix[12] = 0.25;
    const moved = sample(1);
    root.localMatrix[12] = 0;
    renderAt(1);
    return { first, next, repeated, moved, draws: renderer.batches.length, parts: scene.parts.length, memory: renderer.memoryPlan };
  });
  assert.deepEqual(report.first, report.repeated, 'Backward seek changed a deterministic frame');
  assert.notDeepEqual(report.first.matrices, report.next.matrices);
  assert.notEqual(report.first.checksum, report.next.checksum, 'Animated gears did not change pixels');
  assert.notEqual(report.first.checksum, report.moved.checksum, 'Parent transform did not change pixels');
  assert.equal(report.first.error, 0);
  assert.equal(report.next.error, 0);
  assert.equal(report.moved.error, 0);
  const canvas = page.locator('#modeling-canvas');
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('+');
  await page.screenshot({ path: 'artifacts/modeling-desktop.png' });
  const downloadReady = page.waitForEvent('download');
  await page.locator('#modeling-save').click();
  const download = await downloadReady;
  await download.saveAs('artifacts/modeling-saved.png');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: `artifacts/modeling-mobile-${width}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${width}`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => window.__scene?.renderer);
  assert.equal(await page.locator('#modeling-play').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Text resizing caused horizontal overflow');
  await page.evaluate(() => window.__scene.renderer.context.getExtension('WEBGL_lose_context').loseContext());
  await page.waitForFunction(() => window.__modelingError === 'Graphics context lost');
  assert.equal(await page.locator('#modeling-play').isDisabled(), true);
  assert.match(await page.locator('#modeling-notice').innerText(), /Reload/);
  assert.deepEqual(errors, []);
  for (const sample of ['first', 'next', 'repeated', 'moved']) delete report[sample].matrices;
  await writeFile('artifacts/modeling-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
