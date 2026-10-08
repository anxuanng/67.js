import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const artifactDirectory = new URL('../artifacts/', import.meta.url);
await mkdir(artifactDirectory, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5178', '--strictPort'], { cwd: new URL('..', import.meta.url), windowsHide: true, stdio: 'pipe' });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vite did not start.')), 15000);
    server.stdout.on('data', (data) => {
      if (data.toString().includes('127.0.0.1:5178')) { clearTimeout(timeout); resolve(); }
    });
    server.on('error', reject);
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Vite exited ${code}`)); });
  });
  const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ headless: true, ...(existsSync(chromePath) ? { executablePath: chromePath } : {}), args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:5178');
  await page.waitForFunction(() => window.__studio?.renderer && document.querySelector('#cpu').textContent.includes('ms CPU'));
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', artifactDirectory)) });
  const graphics = await page.evaluate(() => {
    const renderer = window.__studio.renderer;
    const context = renderer.context;
    const extension = context.getExtension('WEBGL_debug_renderer_info');
    return { parts: renderer.partCount, triangles: renderer.triangles, calls: renderer.batches.length, glError: context.getError(), gpu: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable' };
  });
  assert.equal(graphics.parts, 325);
  assert.equal(graphics.calls, 10);
  assert.equal(graphics.glError, 0);
  await page.getByRole('button', { name: 'Ceramic finish' }).click();
  assert.equal(await page.locator('#finish-name').textContent(), 'Ceramic');
  await page.screenshot({ path: fileURLToPath(new URL('ceramic.png', artifactDirectory)) });
  await page.getByRole('button', { name: 'Titanium finish' }).click();
  await page.locator('#viewport').focus();
  const initialAzimuth = await page.evaluate(() => window.__studio.state.azimuth);
  await page.keyboard.press('ArrowRight');
  assert.ok(await page.evaluate((initial) => window.__studio.state.azimuth > initial, initialAzimuth));
  await page.getByRole('button', { name: 'Reset view' }).click();
  assert.equal(await page.evaluate(() => window.__studio.state.azimuth), initialAzimuth);
  await page.getByRole('button', { name: 'Surface normals' }).click();
  assert.equal(await page.evaluate(() => window.__studio.state.inspection), true);
  await page.getByRole('button', { name: 'Surface normals' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GLB' }).click();
  const download = await downloadPromise;
  await download.saveAs(fileURLToPath(new URL('specimen.glb', artifactDirectory)));
  await page.getByRole('button', { name: 'Measure performance' }).click();
  await page.waitForFunction(() => window.__benchmarkReport, null, { timeout: 90000 });
  const report = await page.evaluate(() => window.__benchmarkReport);
  assert.equal(report.results.length, 4);
  assert.deepEqual(report.results.map((result) => result.calls), [10, 326, 10, 326]);
  assert.ok(report.results.every((result) => result.pixelAgreement > 0.999), JSON.stringify(report.results));
  await page.getByRole('button', { name: 'Back to model' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: fileURLToPath(new URL('mobile.png', artifactDirectory)) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: fileURLToPath(new URL('narrow.png', artifactDirectory)) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  const visibleControls = await page.locator('button:not([hidden])').evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility()).map((button) => {
    const rectangle = button.getBoundingClientRect();
    return { name: button.getAttribute('aria-label') || button.textContent, left: rectangle.left, right: rectangle.right, width: rectangle.width, height: rectangle.height };
  }));
  assert.ok(visibleControls.every((button) => button.left >= 0 && button.right <= 320 && button.width >= 24 && button.height >= 24), JSON.stringify(visibleControls));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Graphite finish' }).click();
  assert.equal(await page.locator('#finish-name').textContent(), 'Graphite');
  await page.getByRole('button', { name: 'Auto orbit' }).click();
  const orbitStart = await page.evaluate(() => window.__studio.state.azimuth);
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate((initial) => window.__studio.state.azimuth > initial, orbitStart));
  await page.getByRole('button', { name: 'Auto orbit' }).click();
  await page.evaluate(() => {
    window.__lostExtension = window.__studio.renderer.context.getExtension('WEBGL_lose_context');
    window.__lostExtension.loseContext();
  });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('context lost'));
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__lostExtension.restoreContext());
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('Graphics restored'));
  assert.equal(await page.evaluate(() => window.__studio.renderer.context.getError()), 0);
  const lostContextErrors = errors.filter((message) => !message.includes('CONTEXT_LOST_WEBGL'));
  assert.deepEqual(lostContextErrors, []);
  await writeFile(new URL('benchmark.json', artifactDirectory), JSON.stringify({ graphics, ...report, errors: lostContextErrors }, null, 2));
  console.log(JSON.stringify({ graphics, benchmark: report.results, checks: 'Desktop, mobile, finishes, keyboard orbit, reset, normals, GLB download, auto orbit, context loss passed' }, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
