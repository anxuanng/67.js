import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config',
  'scripts/render-vite.config.mjs', '--host', '127.0.0.1', '--port', '5194', '--strictPort'],
  { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Film blink server did not start.')), 15000);
    server.stdout.on('data', bytes => {
      if (bytes.toString().includes('127.0.0.1:5194')) { clearTimeout(timer); resolve(); }
    });
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Film blink server exited ${code}.`)); });
  });
  browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/blink-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: '<canvas style="width:540px;height:960px;display:block"></canvas>',
  }));
  await page.goto('http://127.0.0.1:5194/blink-smoke.html');
  const report = await page.evaluate(async () => {
    const { Renderer67 } = await import('/src/renderer.js');
    const { createFilmScenes } = await import('/src/film.js');
    const scene = createFilmScenes().portrait;
    const canvas = document.querySelector('canvas');
    const renderer = new Renderer67(canvas, scene.parts, {
      world: true, ground: false, environment: scene.environment,
      shadowBounds: scene.shadowBounds, samples: 2, pixelRatio: 1,
      hdr: true, memoryBudgetMiB: 128,
    });
    const frame = { eye: [0, 1.72, 0.88], target: [0, 1.7, 0], fov: 36, time: 0, effects: { grain: 0, bloom: { strength: 0 } } };
    function image(time, suppressBlink = false) {
      scene.animate(time);
      if (suppressBlink) {
        for (const part of scene.parts) if (part.morph) part.morph.weights[0] = 0;
      }
      renderer.updateParts(scene.parts);
      renderer.render(frame);
      return canvas.toDataURL('image/png');
    }
    const open = image(17.4);
    const closed = image(17.65);
    const samePoseWithoutBlink = image(17.65, true);
    image(9);
    const repeated = image(17.65);
    const debug = renderer.context.getExtension('WEBGL_debug_renderer_info');
    const graphics = renderer.context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : renderer.context.RENDERER);
    const error = renderer.context.getError();
    const memory = renderer.memoryPlan;
    renderer.dispose();
    return { open, closed, samePoseWithoutBlink, repeated, error, memory, graphics };
  });
  assert.deepEqual(errors, []);
  assert.equal(report.error, 0);
  assert.match(report.graphics, /swiftshader/i);
  assert.notEqual(report.closed, report.samePoseWithoutBlink, 'Eyelid geometry must change pixels independently of head movement');
  assert.equal(report.closed, report.repeated);
  for (const name of ['open', 'closed']) {
    await writeFile(`artifacts/blink-${name}.png`, Buffer.from(report[name].split(',')[1], 'base64'));
  }
  const metrics = { glError: report.error, repeatExact: true, independentBlinkPixels: true,
    graphics: report.graphics, memory: report.memory, openTime: 17.4, closedTime: 17.65 };
  await writeFile('artifacts/film-blink-proof.json', JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} finally {
  await browser?.close();
  server.kill();
}
