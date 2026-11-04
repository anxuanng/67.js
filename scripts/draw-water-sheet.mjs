// Draws a labelled before and after sheet of the water shadow pool: a checkout of main beside this one, same cameras.
//   node scripts/draw-water-sheet.mjs --before <folder with src and scripts> [--output out/438-sheet.png]
// Rows: shallow clear water (lake, 0.2 m) and deep murky water (river, 4 m). Columns: main and this branch, each from an angle and from above.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openPage } from './measure-water-shadows.mjs';

const CELL = { width: 320, height: 180 };
const ROWS = [
  { label: 'shallow clear (lake, 0.2 m)', depth: 0.2, water: { waterPreset: 'lake' } },
  { label: 'deep murky (river, 4 m)', depth: 4, water: { waterPreset: 'river' } },
];
const VIEWS = [
  { label: 'angle' },
  { label: 'above' },
];

async function drawSide(root) {
  const { page, close } = await openPage(root);
  try {
    return await page.evaluate(async ({ rows, views, cell }) => {
      const scene = await import('/scripts/water-shadow-scene.js');
      const pictures = [];
      for (const row of rows) {
        for (const view of views) {
          const canvas = document.createElement('canvas');
          canvas.width = cell.width;
          canvas.height = cell.height;
          canvas.style.cssText = `width:${cell.width}px;height:${cell.height}px;display:block`;
          document.body.append(canvas);
          const camera = view.label === 'angle' ? { eye: [-5, 5, 6], target: [0.5, -row.depth, 0] } : { eye: [0, 12, 0], target: [0, 0, 0], up: [0, 0, -1] };
          const renderer = scene.drawPool(canvas, row.depth, row.water, camera);
          pictures.push(canvas.toDataURL('image/png'));
          renderer.dispose?.();
          canvas.remove();
        }
      }
      return pictures;
    }, { rows: ROWS, views: VIEWS, cell: CELL });
  } finally {
    await close();
  }
}

async function compose(sides, outputPath) {
  const { page, close } = await openPage(process.cwd());
  try {
    const dataUrl = await page.evaluate(async ({ sides, rows, views, cell }) => {
      const label = 22;
      const gap = 12;
      const columns = sides.length * views.length;
      const canvas = document.createElement('canvas');
      canvas.width = columns * cell.width + (sides.length - 1) * gap;
      canvas.height = rows.length * (cell.height + label);
      const context = canvas.getContext('2d');
      context.fillStyle = '#16181d';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.font = '13px sans-serif';
      context.fillStyle = '#e8eaf0';
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        for (let sideIndex = 0; sideIndex < sides.length; sideIndex++) {
          for (let viewIndex = 0; viewIndex < views.length; viewIndex++) {
            const x = (sideIndex * views.length + viewIndex) * cell.width + sideIndex * gap;
            const y = rowIndex * (cell.height + label);
            context.fillText(`${sides[sideIndex].name}, ${views[viewIndex].label}: ${rows[rowIndex].label}`, x + 4, y + 15);
            const image = new Image();
            image.src = sides[sideIndex].pictures[rowIndex * views.length + viewIndex];
            await image.decode();
            context.drawImage(image, x, y + label);
          }
        }
      }
      return canvas.toDataURL('image/png');
    }, { sides, rows: ROWS, views: VIEWS, cell: CELL });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await close();
  }
}

const option = name => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const beforeFolder = option('--before');
if (!beforeFolder) {
  throw new Error('--before <folder with src and scripts of main> is required.');
}
const outputPath = option('--output') ?? 'out/water-sheet.png';
const sides = [
  { name: 'main', pictures: await drawSide(beforeFolder) },
  { name: 'PR', pictures: await drawSide(process.cwd()) },
];
await compose(sides, outputPath);
console.log(`wrote ${outputPath}`);
