// One frame of the depth precision scene as a PNG, to look at where the far plane wins (issue #310).
//   node bench/reference/depth-precision-image.mjs <output.png> <distance> <gap in millimetres> <jitter 0-7> <reversed: 1|0> [gpu|cpu]
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const [outputPath, distance, gap, jitter, reversed, backend = 'gpu'] = process.argv.slice(2);

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.goto(`${serverUrl}/bench/reference/depth-precision.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.drawDepthCase, null, { timeout: 180000 });
  const dataUrl = await page.evaluate(([d, g, j, r]) => window.drawDepthCase(d, g, j, r), [Number(distance), Number(gap), Number(jitter), reversed === '1']);
  await writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
} finally {
  await browser.close();
  await server.close();
}
