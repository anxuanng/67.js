// Measures the water shadow scene (scripts/water-shadow-scene.js) in Chrome and can draw a before and after picture.
//   bash ~/.agents/tools/gpu-lock.sh node scripts/measure-water-shadows.mjs [--preview out/349-preview.png --before <folder with src and scripts>]
// Without --preview it prints the shadow contrast of the bed at 0.2, 1 and 4 m for each preset, against exp(-absorption * depth).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export const WATER_DEPTHS = [0.2, 1, 4];
const PRESETS = { lake: { waterPreset: 'lake' }, sea: { waterPreset: 'sea' }, river: { waterPreset: 'river' } };
const CELL = { width: 213, height: 120 };

export async function openPage(root) {
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', ...(process.env.SOFTWARE_GL === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11'])] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  await page.route('**/water-shadow-page.html', route => route.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#222"></body>' }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/water-shadow-page.html`);
  return { page, close: async () => { await browser.close(); await server.close(); } };
}

/** Bed contrast and surface shadow numbers, drawn in the checkout at `root`. */
export async function measureWaterShadows(root = process.cwd()) {
  const { page, close } = await openPage(root);
  try {
    return await page.evaluate(async ({ depths, presets }) => {
      const scene = await import('/scripts/water-shadow-scene.js');
      const makeCanvas = (width, height) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.style.cssText = `width:${width}px;height:${height}px;display:block`;
        document.body.append(canvas);
        return canvas;
      };
      const canvas = makeCanvas(200, 120);
      const rows = [];
      for (const [name, water] of Object.entries(presets)) {
        for (const depth of depths) {
          const dry = scene.measureBed(canvas, depth, null);
          const wet = scene.measureBed(canvas, depth, water);
          const contrast = channel => (wet.lit[channel] - wet.shadowed[channel]) / (dry.lit[channel] - dry.shadowed[channel]);
          rows.push({ preset: name, depth, dry, wet, contrast: [0, 1, 2].map(contrast) });
        }
      }
      const surface = {};
      for (const [name, water] of Object.entries(presets)) surface[name] = scene.measureSurface(canvas, water);
      return { rows, surface };
    }, { depths: WATER_DEPTHS, presets: PRESETS });
  } finally {
    await close();
  }
}

// One side of the picture: three pool depths in each of two waters, and the opaque surface from a steep and a grazing view.
async function drawSide(root) {
  const { page, close } = await openPage(root);
  try {
    return await page.evaluate(async ({ depths, cell }) => {
      const scene = await import('/scripts/water-preview-scene.js');
      const assets = await scene.loadPreviewAssets('/out/assets');
      const cells = [];
      const capture = (drawer) => {
        const canvas = document.createElement('canvas');
        canvas.width = cell.width;
        canvas.height = cell.height;
        canvas.style.cssText = `width:${cell.width}px;height:${cell.height}px;display:block`;
        document.body.append(canvas);
        const renderer = drawer(canvas);
        cells.push(canvas.toDataURL('image/png'));
        renderer.dispose?.();
        canvas.remove();
      };
      for (const water of [{ waterPreset: 'lake' }, { waterPreset: 'river' }]) {
        for (const depth of depths) capture(canvas => scene.drawPreviewPool(canvas, assets, depth, water, { eye: [-4.5, 4, 5.5], target: [0.4, -depth * 0.5, 0] }));
      }
      for (const view of [{ eye: [1.5, 9, 3], target: [0, -0.05, 0.5] }, { eye: [4, 0.8, 6], target: [0, -0.05, 0.5] }]) {
        capture(canvas => scene.drawPreviewPool(canvas, assets, 1, { waterPreset: 'sea' }, view, 1));
      }
      return cells;
    }, { depths: WATER_DEPTHS, cell: CELL });
  } finally {
    await close();
  }
}

/** One large frame of the pool, for looking at a detail. */
export async function drawStill(root, outputPath, { depth, water, view }) {
  const { page, close } = await openPage(root);
  try {
    const dataUrl = await page.evaluate(async ({ depth, water, view }) => {
      const scene = await import('/scripts/water-preview-scene.js');
      const assets = await scene.loadPreviewAssets('/out/assets');
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      canvas.style.cssText = 'width:960px;height:540px;display:block';
      document.body.append(canvas);
      scene.drawPreviewPool(canvas, assets, depth, water, view);
      return canvas.toDataURL('image/png');
    }, { depth, water, view });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await close();
  }
}

async function composePreview(beforeCells, afterCells, outputPath) {
  const { page, close } = await openPage(process.cwd());
  try {
    const dataUrl = await page.evaluate(async ({ beforeCells, afterCells, cell }) => {
      const gap = 16;
      const label = 24;
      const sideWidth = cell.width * 3;
      const sideHeight = cell.height * 3;
      const canvas = document.createElement('canvas');
      canvas.width = sideWidth * 2 + gap;
      canvas.height = sideHeight + label;
      const context = canvas.getContext('2d');
      context.fillStyle = '#16181d';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = '14px sans-serif';
      context.fillStyle = '#e8eaf0';
      context.fillText('before (main). Rows: lake, river at 0.2 / 1 / 4 m; sea 1 m opaque, steep and grazing', 4, 16);
      context.fillText('after', sideWidth + gap + 4, 16);
      for (const [side, cells] of [[0, beforeCells], [1, afterCells]]) {
        for (let index = 0; index < cells.length; index++) {
          const image = new Image();
          image.src = cells[index];
          await image.decode();
          context.drawImage(image, side * (sideWidth + gap) + (index % 3) * cell.width, label + Math.floor(index / 3) * cell.height);
        }
      }
      return canvas.toDataURL('image/png');
    }, { beforeCells, afterCells, cell: CELL });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  const previewPath = option('--preview');
  const stillPath = option('--still');
  if (stillPath) {
    const depth = Number(option('--depth') ?? 1);
    await drawStill(option('--root') ?? process.cwd(), stillPath, { depth, water: { waterPreset: option('--preset') ?? 'lake' }, view: { eye: (option('--eye') ?? '-4.5,4,5.5').split(',').map(Number), target: (option('--target') ?? `0.4,${-depth * 0.5},0`).split(',').map(Number), up: option('--eye') ? [0, 0, -1] : [0, 1, 0] } });
    console.log(`wrote ${stillPath}`);
    process.exit(0);
  }
  if (previewPath) {
    const beforeFolder = option('--before');
    const [beforeCells, afterCells] = [await drawSide(beforeFolder), await drawSide(process.cwd())];
    await composePreview(beforeCells, afterCells, previewPath);
    console.log(`wrote ${previewPath}`);
  } else {
    const report = await measureWaterShadows(option('--root') ?? process.cwd());
    for (const row of report.rows) {
      console.log(row.preset, row.depth, 'contrast', row.contrast.map(value => value.toFixed(3)).join(' '));
    }
    for (const [preset, views] of Object.entries(report.surface)) {
      for (const [view, { lit, shadowed }] of Object.entries(views)) {
        console.log(preset, view, 'surface shadow darkening', lit.map((value, channel) => (1 - shadowed[channel] / value).toFixed(3)).join(' '));
      }
    }
  }
}
