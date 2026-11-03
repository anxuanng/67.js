// Draws reference scenes with the path tracer and keeps the untouched noisy output with its feature images, so every
// denoiser in denoise-compare.mjs sees the same pixels:
//   node bench/reference/denoise-capture.mjs [--scenes a,b] [--samples 8,16,32,64] [--threads 6] [--directory artifacts/denoise]
// Needs Chrome (CHROME_PATH) and writes <directory>/<scene>/<samples>/{color,albedo,normal,depth,variance}.f32 plus report.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WIDTH = 960;
const HEIGHT = 540;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_LOAD_TIMEOUT = 180000;

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sceneIds = optionValue('--scenes', 'brick-graph,character,material-spheres,outdoor-hdri,metal,glass').split(',');
const sampleCounts = optionValue('--samples', '8,16,32,64').split(',').map(Number);
const threads = Number(optionValue('--threads', '6'));
const outputDirectory = resolve(optionValue('--directory', 'artifacts/denoise'));

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.setDefaultTimeout(0);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench/reference/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
  await page.waitForFunction(() => window.renderReferencePathTracedFeatures, null, { timeout: PAGE_LOAD_TIMEOUT });
  for (const sceneId of sceneIds) {
    for (const samples of sampleCounts) {
      const options = { width: WIDTH, height: HEIGHT, samples, threads, maxSeconds: 1800 };
      const result = await page.evaluate(([id, tracerOptions]) => window.renderReferencePathTracedFeatures(id, tracerOptions), [sceneId, options]);
      const directory = `${outputDirectory}/${sceneId}/${samples}`;
      await mkdir(directory, { recursive: true });
      for (const [name, base64] of Object.entries(result.features)) await writeFile(`${directory}/${name}.f32`, Buffer.from(base64, 'base64'));
      await writeFile(`${directory}/report.json`, JSON.stringify(result.report, null, 1));
      console.log(`${sceneId} at ${samples} samples: ${result.report.seconds.toFixed(1)} s traced`);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
