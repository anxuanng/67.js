// Frame time of a server hall with different numbers of point and area lights.
// node bench/lighting/frame-time.mjs [gpu|cpu] [--rounds=N]
import { constants, setPriority } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { MAX_POINT_LIGHTS, MAX_AREA_LIGHTS } from '../../src/light-limits.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_LOAD_TIMEOUT = 180000;
const backend = process.argv[2] === 'cpu' ? 'cpu' : 'gpu';
const roundsArgument = process.argv.find(argument => argument.startsWith('--rounds='));
const rounds = roundsArgument ? Number(roundsArgument.split('=')[1]) : 3;
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const VARIANTS = [
  { pointCount: 0, areaCount: 0 },
  { pointCount: 8, areaCount: 0 },
  { pointCount: 16, areaCount: 0 },
  { pointCount: 32, areaCount: 0 },
  { pointCount: 0, areaCount: 4 },
  { pointCount: 0, areaCount: 7 },
  { pointCount: 0, areaCount: 8 },
  { pointCount: 12, areaCount: 7 },
  { pointCount: 16, areaCount: 7 },
  { pointCount: 32, areaCount: 8 },
  { pointCount: 32, areaCount: 0, range: 6 },
];

// A light count above the renderer's limit throws, so a limit that is raised for a measurement widens the table by itself.
const supportedVariants = VARIANTS.filter(variant => variant.pointCount <= MAX_POINT_LIGHTS && variant.areaCount <= MAX_AREA_LIGHTS);

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(`${serverUrl}/bench/lighting/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
  await page.waitForFunction(() => window.measureLightCounts, null, { timeout: PAGE_LOAD_TIMEOUT });
  if (process.argv.includes('--each-light')) {
    const report = await page.evaluate(() => window.checkEachLightVisible({ pointCount: 12, areaCount: 7 }));
    const lights = Object.values(report.changedPixels).flat();
    console.log(JSON.stringify({ backend, ...report, everyLightVisible: report.glError === 0 && lights.every(count => count > 0) }, null, 1));
    await browser.close();
    await server.close();
    process.exit(0);
  }
  const samples = new Map();
  for (let round = 0; round < rounds; round++) {
    // Alternate the order so a drifting machine load does not favor one side.
    const order = round % 2 === 0 ? supportedVariants : [...supportedVariants].reverse();
    for (const variant of order) {
      const result = await page.evaluate(options => window.measureLightCounts(options), variant);
      const key = `${variant.pointCount} point, ${variant.areaCount} area${variant.range ? `, range ${variant.range}` : ''}`;
      if (!samples.has(key)) samples.set(key, { glError: result.glError, uniformVectors: result.uniformVectors, medians: [], image: result.image, variant });
      samples.get(key).medians.push(result.medianMilliseconds);
    }
  }
  const summary = {};
  for (const [key, entry] of samples) {
    const sorted = [...entry.medians].sort((first, second) => first - second);
    summary[key] = { medianMilliseconds: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)), rangeMilliseconds: [sorted[0], sorted.at(-1)].map(value => Number(value.toFixed(3))), glError: entry.glError };
  }
  const withLights = [...samples].find(([, entry]) => entry.variant.pointCount === 12 && entry.variant.areaCount === 7);
  if (withLights) {
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/lighting-hall-12-point-7-area.png', Buffer.from(withLights[1].image, 'base64'));
  }
  console.log(JSON.stringify({ backend, maxFragmentUniformVectors: [...samples.values()][0].uniformVectors, summary }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
