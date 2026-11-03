// Runs the Gaussian splat benchmark in Chrome and prints one JSON line per case; pictures go to artifacts/gaussian-splats/.
//   node bench/gaussian-splats/fetch-sample.mjs          (once, for the millipede sample)
//   bash ~/.agents/tools/gpu-lock.sh node bench/gaussian-splats/run.mjs [gpu|cpu] [engine67|three|all] [case name filter]
// gpu uses the machine's graphics card, cpu uses SwiftShader (software). Frame times are the median of 60 frames with a camera
// that moves every frame ("orbit": a sort each frame) and 60 with a still camera (no sort). A one-pixel readPixels ends each timed frame.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [backend = 'gpu', engines = 'engine67', onlyCase = ''] = process.argv.slice(2);
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const SWIFTSHADER_FRAMES = 6;
const outputDirectory = resolve('artifacts/gaussian-splats');

const ENGINE67_CASES = [
  { name: 'part-only', source: 'synthetic', withSplats: false },
  { name: 'millipede-behind-part', source: 'millipede', count: 200000 },
  { name: 'millipede-alone', source: 'millipede', count: 200000, withPart: false },
  { name: 'millipede-alone-sdr', source: 'millipede', count: 200000, withPart: false, hdr: false },
  { name: 'millipede-behind-part-sdr', source: 'millipede', count: 200000, hdr: false },
  { name: 'synthetic-100k', source: 'synthetic', count: 100000 },
  { name: 'synthetic-1m', source: 'synthetic', count: 1000000 },
];
const THREE_CASES = [
  { name: 'three-millipede', source: 'millipede' },
  { name: 'three-synthetic-100k', source: 'synthetic', count: 100000 },
  { name: 'three-synthetic-1m', source: 'synthetic', count: 1000000 },
];

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });

async function runCases(pagePath, cases) {
  for (const { name, ...options } of cases.filter(entry => entry.name.includes(onlyCase))) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', error => console.log('PAGE ERROR', error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('CONSOLE', message.text()); });
    try {
      await page.goto(`${serverUrl}/bench/gaussian-splats/${pagePath}`, { timeout: 180000 });
      await page.waitForFunction(() => window.harnessReady, null, { timeout: 180000 });
      const frames = backend === 'cpu' ? SWIFTSHADER_FRAMES : 60;
      const { image, ...measurements } = await page.evaluate(parameters => window.runCase(parameters), { frames, ...options });
      if (image) await writeFile(`${outputDirectory}/${backend}-${name}.png`, Buffer.from(image, 'base64'));
      console.log(JSON.stringify({ name, backend, ...measurements }));
    } catch (error) {
      console.log(JSON.stringify({ name, backend, error: error.message.split('\n')[0] }));
    } finally {
      await page.close();
    }
  }
}

try {
  if (engines === 'engine67' || engines === 'all') await runCases('harness.html', ENGINE67_CASES);
  if (engines === 'three' || engines === 'all') await runCases('three.html', THREE_CASES);
} finally {
  await browser.close();
  await server.close();
}
