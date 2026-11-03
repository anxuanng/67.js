// Draws a 5,000-tree forest at a fixed camera with every tree at its full level and with impostor cards from level 3, in
// headless Chrome (SwiftShader unless `--gpu`), writes both pictures to artifacts/forest-pair and prints the triangle counts.
// Score the pair with: uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I scripts/flip-pair.py
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const port = 5188;
const useGpu = process.argv.includes('--gpu');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`The server exited ${code}.`)));
  });
  const args = useGpu ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
  browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  let result;
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    try {
      result = await page.evaluate(async () => {
        const { scatterVegetation, selectLevels, prepareImpostors } = await import('/src/vegetation.js');
        const { Renderer67 } = await import('/src/renderer.js');
        const side = Math.sqrt(5000 / 0.0035);
        const forest = scatterVegetation({ area: { minX: -side / 2, maxX: side / 2, minZ: -side / 2, maxZ: side / 2 }, density: 0.0035, mix: { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2 }, seed: 5 });
        const bake = prepareImpostors(forest.variants);
        const frame = { eye: [0, 4, -side / 2 + 20], target: [0, 12, 200], up: [0, 1, 0], fov: 45, near: 0.5, far: 1500, time: 1, wind: 0 };
        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 540;
        document.body.append(canvas);
        const draw = (view) => {
          const renderer = new Renderer67(canvas, view.parts, { ground: true, world: true, samples: 1, pixelRatio: 1 });
          renderer.render(frame);
          const picture = canvas.toDataURL('image/png');
          renderer.dispose?.();
          return picture;
        };
        const plainView = selectLevels(forest.instances, frame.eye, {});
        const cardView = selectLevels(forest.instances, frame.eye, { impostors: { from: 3 } });
        return {
          trees: forest.instances.length, bake,
          plainTriangles: plainView.triangles, cardTriangles: cardView.triangles, cards: cardView.impostors,
          pictures: { plain: draw(plainView), cards: draw(cardView) },
        };
      });
    } catch (error) {
      if (!/context was destroyed/.test(error.message)) throw error;
      await page.waitForLoadState('load');
    }
  }
  await mkdir('artifacts/forest-pair', { recursive: true });
  for (const [name, picture] of Object.entries(result.pictures)) await writeFile(`artifacts/forest-pair/${name}.png`, Buffer.from(picture.split(',')[1], 'base64'));
  delete result.pictures;
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.kill();
}
