// Mesh blend check for issue #478: before/after still, pixel identity against main, and the frame cost at 1080p.
//   node bench/reference/mesh-blend.mjs --main-root <dir with src/ of main, bench/reference/mesh-blend-harness.html, node_modules>
//        [--out <folder>] [--rounds <n>] [--frames <n>] [--skip-cost]
// Writes the PNGs and out/478-sheet.png (before, after, and a 2x crop of a seam) to the output folder.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const option = (name, fallback) => (argumentsGiven.includes(name) ? argumentsGiven[argumentsGiven.indexOf(name) + 1] : fallback);
const mainRoot = option('--main-root');
const output = resolve(option('--out', 'out'));
const rounds = Number(option('--rounds', 5));
const frames = Number(option('--frames', 120));
const WIDTH = 1920;
const HEIGHT = 1080;
const BROWSER_ARGUMENTS = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--use-angle=d3d11', '--enable-gpu'];

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(output, { recursive: true });

async function withPage(root, work) {
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'error' });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/bench/reference/mesh-blend-harness.html`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BROWSER_ARGUMENTS });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on('console', message => message.type() === 'error' && console.log('CONSOLE', message.text()));
    page.on('response', response => response.status() >= 400 && response.text().then(text => console.log('HTTP', response.status(), response.url(), text.slice(0, 700))));
    page.on('pageerror', error => console.log('PAGE ERROR', error.message));
    await page.goto(url, { timeout: 60000 });
    await page.waitForFunction(() => window.harnessReady, null, { timeout: 60000 });
    return await work(page);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function capture(page, scene, mode) {
  const info = await page.evaluate(options => window.setupScene(options), { scene, mode });
  if (info.glError !== 0 || info.width !== WIDTH || info.height !== HEIGHT) throw new Error(`${scene}/${mode}: ${JSON.stringify(info)}`);
  const png = Buffer.from((await page.evaluate(() => window.snapshot())).split(',')[1], 'base64');
  await page.evaluate(() => window.teardown());
  return png;
}

async function maxDifference(firstPng, secondPng) {
  const [first, second] = await Promise.all([firstPng, secondPng].map(png => sharp(png).raw().toBuffer()));
  let largest = 0;
  let differing = 0;
  for (let index = 0; index < first.length; index++) {
    const difference = Math.abs(first[index] - second[index]);
    if (difference > 0) differing++;
    if (difference > largest) largest = difference;
  }
  return { largest, differing };
}

const stills = {};
await withPage(resolve('.'), async page => {
  for (const [scene, mode] of [['nature', 'plain'], ['nature', 'installed'], ['nature', 'blend'], ['lit-box', 'plain'], ['lit-box', 'installed']]) {
    stills[`branch-${scene}-${mode}`] = await capture(page, scene, mode);
    await writeFile(`${output}/mesh-blend-${scene}-${mode}.png`, stills[`branch-${scene}-${mode}`]);
  }
});
if (mainRoot) {
  await withPage(resolve(mainRoot), async page => {
    for (const scene of ['nature', 'lit-box']) stills[`main-${scene}`] = await capture(page, scene, 'plain');
  });
  for (const scene of ['nature', 'lit-box']) {
    const plain = await maxDifference(stills[`main-${scene}`], stills[`branch-${scene}-plain`]);
    const installed = await maxDifference(stills[`main-${scene}`], stills[`branch-${scene}-installed`]);
    console.log(`${scene}: max difference from main, addon not loaded ${plain.largest} (${plain.differing} values), addon installed but no blend part ${installed.largest} (${installed.differing} values)`);
  }
}
const changed = await maxDifference(stills['branch-nature-plain'], stills['branch-nature-blend']);
console.log(`nature: blend on changes ${changed.differing} channel values (max ${changed.largest})`);

// The seam crop: the 480 x 270 window with the most changed pixels, found from the difference of the two stills.
const [offPixels, onPixels] = await Promise.all([stills['branch-nature-plain'], stills['branch-nature-blend']].map(png => sharp(png).ensureAlpha().raw().toBuffer()));
const BLOCK = 30;
const blockColumns = WIDTH / BLOCK;
const blockRows = HEIGHT / BLOCK;
const changedInBlock = new Array(blockColumns * blockRows).fill(0);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const offset = (y * WIDTH + x) * 4;
    if (Math.abs(offPixels[offset] - onPixels[offset]) + Math.abs(offPixels[offset + 1] - onPixels[offset + 1]) + Math.abs(offPixels[offset + 2] - onPixels[offset + 2]) > 6) {
      changedInBlock[Math.floor(y / BLOCK) * blockColumns + Math.floor(x / BLOCK)]++;
    }
  }
}
const cropWidth = 480;
const cropHeight = 270;
let bestCount = -1;
let cropLeft = 0;
let cropTop = 0;
for (let row = 0; row <= blockRows - cropHeight / BLOCK; row++) {
  for (let column = 0; column <= blockColumns - cropWidth / BLOCK; column++) {
    let count = 0;
    for (let rowOffset = 0; rowOffset < cropHeight / BLOCK; rowOffset++) {
      for (let columnOffset = 0; columnOffset < cropWidth / BLOCK; columnOffset++) count += changedInBlock[(row + rowOffset) * blockColumns + column + columnOffset];
    }
    if (count > bestCount) {
      bestCount = count;
      cropLeft = column * BLOCK;
      cropTop = row * BLOCK;
    }
  }
}
console.log();
const label = (text, width) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="44"><rect width="100%" height="100%" fill="#14161a"/><text x="14" y="30" font-family="Arial" font-size="24" fill="#f2f2f2">${text}</text></svg>`);
const half = 960;
const halfHeight = 540;
async function column(png, title, ratioWidth, ratioHeight, crop) {
  let image = sharp(png);
  if (crop) image = image.extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight });
  return image.resize(ratioWidth, ratioHeight, { kernel: crop ? 'nearest' : 'lanczos3' }).composite([]).toBuffer().then(buffer => ({ buffer, title }));
}
const tiles = await Promise.all([
  column(stills['branch-nature-plain'], 'Before (no blend)', half, halfHeight, false),
  column(stills['branch-nature-blend'], 'After (blend radius 0.18 m)', half, halfHeight, false),
  column(stills['branch-nature-plain'], 'Before, 2x crop of a seam', half, halfHeight, true),
  column(stills['branch-nature-blend'], 'After, 2x crop of the same seam', half, halfHeight, true),
]);
const composites = [];
tiles.forEach((tile, index) => {
  const left = (index % 2) * half;
  const top = Math.floor(index / 2) * (halfHeight + 44);
  composites.push({ input: label(tile.title, half), left, top }, { input: tile.buffer, left, top: top + 44 });
});
await sharp({ create: { width: half * 2, height: (halfHeight + 44) * 2, channels: 3, background: '#14161a' } }).composite(composites).png().toFile(`${output}/478-sheet.png`);
console.log(`sheet: ${resolve(output, '478-sheet.png')}`);

if (!argumentsGiven.includes('--skip-cost')) {
  const times = { off: [], on: [] };
  await withPage(resolve('.'), async page => {
    for (let round = 0; round < rounds; round++) {
      for (const [label2, mode] of round % 2 ? [['off', 'installed'], ['on', 'blend']] : [['on', 'blend'], ['off', 'installed']]) {
        await page.evaluate(options => window.setupScene(options), { scene: 'nature', mode });
        times[label2].push(...await page.evaluate(count => window.measureFrames(count), frames));
        await page.evaluate(() => window.teardown());
      }
    }
  });
  const middle = values => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];
  const off = middle(times.off);
  const on = middle(times.on);
  console.log(`1080p frame, ${rounds} rounds x ${frames} frames pooled: off ${off.toFixed(3)} ms, on ${on.toFixed(3)} ms, cost ${(on - off).toFixed(3)} ms`);
}
