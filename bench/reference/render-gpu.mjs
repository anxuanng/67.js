// Draws chosen reference scenes with 67js on the GPU only, into a directory of your choice, with measurement switches. No Blender, no scoring.
//   node bench/reference/render-gpu.mjs <output directory> <scene id>,<scene id> [--ambient <scale>] [--fill <scale>] [--key <scale>]
//     [--ambient-occlusion <strength>] [--ambient-occlusion-radius <units>] [--standard-depth] [--cpu]
// Files are <output directory>/<scene id>-gpu.png, the names measure-depth.py and score.py read. Used to find what makes shadows light (issue #197).
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDTH = 960;
const HEIGHT = 540;
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneIds = argumentsGiven[1].split(',');
// Ids of the grand options end in -a, -b or -c and live in their own scene set.
const setOf = id => (/-[abc]$/.test(id) ? 'grand' : null);
const waterIndex = argumentsGiven.indexOf('--water');
const waterOption = waterIndex >= 0 ? argumentsGiven[waterIndex + 1] : null;
const standardDepth = argumentsGiven.includes('--standard-depth');

function numberAfter(flag) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? Number(argumentsGiven[index + 1]) : null;
}

const options = {
  ambient: numberAfter('--ambient'),
  fill: numberAfter('--fill'),
  key: numberAfter('--key'),
  ambientOcclusion: numberAfter('--ambient-occlusion') ?? 0,
  ambientOcclusionRadius: numberAfter('--ambient-occlusion-radius') ?? 0.5,
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', ...(argumentsGiven.includes('--cpu') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  for (const id of sceneIds) {
    await page.goto(`${serverUrl}/bench/reference/harness.html?${[setOf(id) ? `set=${setOf(id)}` : '', waterOption ? `water=${waterOption}` : '', standardDepth ? 'reversedDepth=off' : ''].filter(Boolean).join('&')}`, { timeout: 180000 });
    await page.waitForFunction(() => window.renderReferenceScene, null, { timeout: 180000 });
    const result = await page.evaluate(([sceneId, renderOptions]) => window.renderReferenceScene(sceneId, { describe: false, ...renderOptions }), [id, options]);
    if (result.glError !== 0) throw new Error(`${id} gave WebGL error ${result.glError}.`);
    await writeFile(`${outputDirectory}/${id}-gpu.png`, Buffer.from(result.image, 'base64'));
    console.log(`${id} drawn`);
  }
} finally {
  await browser.close();
  await server.close();
}
