import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5179', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Scene smoke server did not start.')), 15000);
    server.stdout.on('data', (data) => {
      if (data.toString().includes('127.0.0.1:5179')) { clearTimeout(timeout); resolve(); }
    });
    server.on('error', reject);
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Scene server exited ${code}.`)); });
  });
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}), args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5179/nature.html');
  await page.waitForFunction(() => window.__nature?.renderer);
  assert.equal(await page.evaluate(() => window.__nature.state.paused), true);
  await page.screenshot({ path: 'artifacts/nature-wide.png' });
  await page.locator('#daylight').fill('0.25');
  await page.locator('#wind').fill('0.75');
  assert.equal(await page.evaluate(() => window.__nature.state.daylight), 0.25);
  assert.equal(await page.evaluate(() => window.__nature.state.wind), 0.75);
  await page.locator('#viewpoint').selectOption('1');
  await page.locator('#detail').selectOption('low');
  await page.waitForFunction(() => window.__nature.world.parts.length === 1526);
  await page.locator('#viewpoint').selectOption('0');
  await page.locator('#viewport').click({ position: { x: 720, y: 630 } });
  assert.ok(await page.evaluate(() => window.__nature.state.rippleTime >= 0));
  await page.locator('#viewport').focus();
  const natureAzimuth = await page.evaluate(() => window.__nature.state.azimuth);
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await page.evaluate(() => window.__nature.state.azimuth), natureAzimuth);
  const downloadReady = page.waitForEvent('download');
  await page.locator('#save-image').click();
  await (await downloadReady).saveAs('artifacts/nature-download.png');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: 'artifacts/nature-narrow.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:5179/film.html');
  await page.waitForFunction(() => window.__filmReady);
  async function filmPixels(time) {
    return page.evaluate((seconds) => {
      window.renderAt(seconds);
      const renderer = window.__film.renderer;
      const context = renderer.context;
      const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
      context.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      let checksum = 2166136261;
      for (const byte of pixels) checksum = Math.imul(checksum ^ byte, 16777619);
      return { checksum: checksum >>> 0, error: context.getError() };
    }, time);
  }
  const ignition = await filmPixels(22);
  await page.screenshot({ path: 'artifacts/film-wide.png' });
  await filmPixels(5.5);
  await filmPixels(29.5);
  assert.deepEqual(await filmPixels(22), ignition);
  assert.equal(ignition.error, 0);
  await page.locator('#film-time').fill('1');
  await page.getByRole('button', { name: 'Play film', exact: true }).click();
  await page.waitForFunction(() => window.__film.score.readyState >= 2 && window.__film.score.currentTime > 1.1);
  await page.getByRole('button', { name: 'Pause film', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__film.score.paused), true);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('#film-time').fill('29');
  await page.screenshot({ path: 'artifacts/film-narrow.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  const controls = await page.locator('.transport button, .transport a').evaluateAll((elements) => elements.map((element) => {
    const rectangle = element.getBoundingClientRect();
    return { left: rectangle.left, right: rectangle.right, bottom: rectangle.bottom };
  }));
  assert.ok(controls.every((control) => control.left >= 0 && control.right <= 320 && control.bottom <= 700));
  assert.deepEqual(errors, []);
  const result = { checks: 'Nature daylight, wind, viewpoints, detail, ripple, keyboard and PNG; deterministic film seeks, audio playback, mobile layout and reduced motion', errors };
  await writeFile('artifacts/scenes-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.kill();
}
