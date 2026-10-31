// Frame time of a reference scene with and without the light bake: node bench/reference/frame-time.mjs [scene-id] [gpu|cpu]
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_LOAD_TIMEOUT = 180000;
const [sceneId = 'lit-interior', backend = 'gpu'] = process.argv.slice(2);
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
  await page.waitForFunction(() => window.measureReferenceFrameTime, null, { timeout: PAGE_LOAD_TIMEOUT });
  const results = [];
  // Alternate the order so a drifting machine load does not favor one side.
  for (const bake of [false, true, false, true]) {
    results.push(await page.evaluate(([id, shouldBake]) => window.measureReferenceFrameTime(id, { bake: shouldBake }), [sceneId, bake]));
  }
  console.log(JSON.stringify({ sceneId, backend, results }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
