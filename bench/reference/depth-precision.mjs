// Depth error of flush and near-flush planes, with the standard depth buffer and with reversed-Z (issue #310).
//   node bench/reference/depth-precision.mjs [gpu|cpu]
// Prints JSON: for each distance and gap, the share of pixels where the far plane wins, averaged over camera jitters.
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const backend = process.argv[2] ?? 'gpu';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  await page.goto(`${serverUrl}/bench/reference/depth-precision.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.measureDepthPrecision, null, { timeout: 180000 });
  const result = await page.evaluate(() => window.measureDepthPrecision());
  console.log(JSON.stringify({ backend, ...result }));
} finally {
  await browser.close();
  await server.close();
}
