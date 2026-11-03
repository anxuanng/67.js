// Draws the sea at several roughnesses, before and after the rough-water reflection (issue #331), as one picture:
//   bash ~/.agents/tools/gpu-lock.sh node scripts/measure-water-roughness.mjs --before <checkout without the fix> --preview out/331-preview.png
// The checkout given to --before needs scripts/water-roughness-scene.js copied in, and both need out/assets (see water-preview-scene.js).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openPage } from './measure-water-shadows.mjs';

const ROUGHNESSES = [0.05, 0.1, 0.13, 0.2, 0.35];
const CELL = { width: 640, height: 360 };
const VIEW = { eye: [-2.5, 0.9, 6], target: [0.2, 0.55, 0] };

async function drawSide(root) {
  const { page, close } = await openPage(root);
  try {
    return await page.evaluate(async ({ roughnesses, cell, view }) => {
      const scene = await import('/scripts/water-roughness-scene.js');
      const preview = await import('/scripts/water-preview-scene.js');
      const assets = await preview.loadPreviewAssets('/out/assets');
      const cells = [];
      for (const roughness of roughnesses) {
        const canvas = document.createElement('canvas');
        canvas.width = cell.width;
        canvas.height = cell.height;
        canvas.style.cssText = `width:${cell.width}px;height:${cell.height}px;display:block`;
        document.body.append(canvas);
        const drawn = scene.drawRoughSea(canvas, assets, roughness, view);
        cells.push({ roughness, placed: drawn.placed, image: canvas.toDataURL('image/png') });
        drawn.dispose();
        canvas.remove();
      }
      return cells;
    }, { roughnesses: ROUGHNESSES, cell: CELL, view: VIEW });
  } finally {
    await close();
  }
}

async function composePreview(rows, outputPath) {
  const { page, close } = await openPage(process.cwd());
  try {
    const dataUrl = await page.evaluate(async ({ rows, cell }) => {
      const label = 26;
      const canvas = document.createElement('canvas');
      canvas.width = cell.width * rows[0].cells.length;
      canvas.height = (cell.height + label) * rows.length;
      const context = canvas.getContext('2d');
      context.fillStyle = '#16181d';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = '16px sans-serif';
      context.fillStyle = '#e8eaf0';
      for (let row = 0; row < rows.length; row++) {
        const top = row * (cell.height + label);
        for (let column = 0; column < rows[row].cells.length; column++) {
          const entry = rows[row].cells[column];
          const image = new Image();
          image.src = entry.image;
          await image.decode();
          context.drawImage(image, column * cell.width, top + label);
          context.fillText(`${rows[row].title}, roughness ${entry.roughness}${entry.placed ? '' : ' (no mirror pass)'}`, column * cell.width + 6, top + 18);
        }
      }
      return canvas.toDataURL('image/png');
    }, { rows, cell: CELL });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await close();
  }
}

const option = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const previewPath = option('--preview');
const beforeRoot = option('--before');
if (!previewPath || !beforeRoot) {
  throw new Error('usage: measure-water-roughness.mjs --before <checkout> --preview <png>');
}
const rows = [{ title: 'before', cells: await drawSide(beforeRoot) }, { title: 'after', cells: await drawSide(process.cwd()) }];
await composePreview(rows, previewPath);
console.log(`wrote ${previewPath}`);
