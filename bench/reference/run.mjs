// Renders the reference scenes in 67.js and Blender, then scores them: npm run reference
// Use --score-only to score existing renders, --skip-blender to keep them, and --scene <id> for one scene.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WORK_DIRECTORY = resolve('artifacts/reference');
const OUTPUT_DIRECTORY = resolve('bench/reference');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const WIDTH = 960;
const HEIGHT = 540;
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

const argumentsGiven = process.argv.slice(2);
const scoreOnly = argumentsGiven.includes('--score-only');
const skipBlender = argumentsGiven.includes('--skip-blender');
const sceneFlag = argumentsGiven.indexOf('--scene');
const onlyScene = sceneFlag >= 0 ? argumentsGiven[sceneFlag + 1] : null;

async function renderBackend(backend, serverUrl, graphics) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${serverUrl}/bench/reference/harness.html`);
    await page.waitForFunction(() => window.renderReferenceScene);
    const sceneIds = await page.evaluate(() => window.referenceSceneIds);
    for (const id of sceneIds) {
      if (onlyScene && id !== onlyScene) continue;
      const started = performance.now();
      const describe = backend === 'gpu';
      const result = await page.evaluate(([sceneId, shouldDescribe]) => window.renderReferenceScene(sceneId, { describe: shouldDescribe }), [id, describe]);
      if (result.glError !== 0) throw new Error(`${id} on ${backend} gave WebGL error ${result.glError}.`);
      graphics[backend] = result.graphics;
      await writeFile(`${WORK_DIRECTORY}/${id}-${backend}.png`, Buffer.from(result.image, 'base64'));
      if (describe) await writeFile(`${WORK_DIRECTORY}/scenes/${id}.json`, JSON.stringify(result.description));
      console.log(`${id} on ${backend}: ${Math.round(performance.now() - started)} ms`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await browser.close();
  }
}

function runChecked(command, commandArguments) {
  const result = spawnSync(command, commandArguments, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = result.stdout.split('\n').filter(line => !/^(Fra:|Saved:|Time:|\s*$)/.test(line));
  console.log(lines.slice(-30).join('\n'));
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(`${WORK_DIRECTORY}/scenes`, { recursive: true });

if (!scoreOnly) {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  const graphics = {};
  try {
    const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
    await renderBackend('gpu', serverUrl, graphics);
    await renderBackend('cpu', serverUrl, graphics);
  } finally {
    await server.close();
  }
  await writeFile(`${WORK_DIRECTORY}/graphics.json`, JSON.stringify(graphics, null, 1));
  if (!skipBlender) {
    const sceneArguments = onlyScene ? [onlyScene] : [];
    runChecked(BLENDER, ['-b', '--factory-startup', '--python', 'bench/reference/render-blender.py', '--', WORK_DIRECTORY, ...sceneArguments]);
  }
}

if (!onlyScene) {
  runChecked('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/score.py', WORK_DIRECTORY, OUTPUT_DIRECTORY,
  ]);
}
