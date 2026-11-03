// Draws reference scenes with the rasterizer only, no Blender and no scoring: node bench/reference/raster-only.mjs <out-directory> <gpu|cpu> <scene-id>,<scene-id>
// For looking at a change before the Cycles queue has a turn. Each scene lands in <out-directory>/<scene-id>-<backend>.png.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [outputDirectory, backend = 'cpu', sceneList = 'subsurface'] = process.argv.slice(2);
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  for (const sceneId of sceneList.split(',')) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
    await page.waitForFunction(() => window.renderReferenceScene, null, { timeout: 180000 });
    const result = await page.evaluate(id => window.renderReferenceScene(id, { describe: false }), sceneId);
    await writeFile(`${outputDirectory}/${sceneId}-${backend}.png`, Buffer.from(result.image, 'base64'));
    console.log(`${sceneId}: glError ${result.glError}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
