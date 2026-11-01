// Renders the reference scenes in 67js and Blender, then scores them: npm run reference
// --ambient-occlusion <strength> [--ambient-occlusion-radius <units>] turns occlusion on (off by default).
// --bake [<id>,<id>] bakes bounced light into the named scenes (every scene when no ids follow) before 67js draws them;
// Blender still gets the plain scene.
// --path-tracer [--samples <n>] draws the scenes with the offline path tracer (src/path-tracer.js) instead, keeps the
// Cycles renders of an earlier run, and scores them into path-tracer.json. Nothing in baseline.json or images/ changes.
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
// This process runs below normal priority, so a busy machine takes the page load past Playwright's 30 second default
// (measured 22 s, against 5 s when idle). Load time does not affect any score.
const PAGE_LOAD_TIMEOUT = 180000;
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

const argumentsGiven = process.argv.slice(2);
const scoreOnly = argumentsGiven.includes('--score-only');
const skipBlender = argumentsGiven.includes('--skip-blender');
const sceneFlag = argumentsGiven.indexOf('--scene');
const occlusionFlag = argumentsGiven.indexOf('--ambient-occlusion');
const ambientOcclusion = occlusionFlag >= 0 ? Number(argumentsGiven[occlusionFlag + 1]) : 0;
const radiusFlag = argumentsGiven.indexOf('--ambient-occlusion-radius');
const ambientOcclusionRadius = radiusFlag >= 0 ? Number(argumentsGiven[radiusFlag + 1]) : 0.5;
const bakeFlag = argumentsGiven.indexOf('--bake');
const bakeValue = bakeFlag >= 0 ? argumentsGiven[bakeFlag + 1] : undefined;
const bakedSceneIds = bakeFlag >= 0 && bakeValue && !bakeValue.startsWith('--') ? bakeValue.split(',') : null;
const cascadesFlag = argumentsGiven.indexOf('--cascades');
const cascades = cascadesFlag >= 0 ? Number(argumentsGiven[cascadesFlag + 1]) : 0;
const pathTracerFlag = argumentsGiven.includes('--path-tracer');
const samplesFlag = argumentsGiven.indexOf('--samples');
const pathTracerSamples = samplesFlag >= 0 ? Number(argumentsGiven[samplesFlag + 1]) : 64;
const onlyScene = sceneFlag >= 0 ? argumentsGiven[sceneFlag + 1] : null;

async function renderBackend(backend, serverUrl, graphics) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.text().includes('GL_') && console.log('PAGE', message.text().slice(0, 200)));
    await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
    await page.waitForFunction(() => window.renderReferenceScene, null, { timeout: PAGE_LOAD_TIMEOUT });
    const sceneIds = await page.evaluate(() => window.referenceSceneIds);
    for (const id of sceneIds) {
      if (onlyScene && id !== onlyScene) continue;
      const started = performance.now();
      const describe = backend === 'gpu';
      const bake = bakeFlag >= 0 && (bakedSceneIds === null || bakedSceneIds.includes(id)) ? {} : null;
      const result = await page.evaluate(([sceneId, shouldDescribe, ambientOcclusion, ambientOcclusionRadius, bakeOptions, cascadeCount]) => window.renderReferenceScene(sceneId, { describe: shouldDescribe, ambientOcclusion, ambientOcclusionRadius, bake: bakeOptions, cascades: cascadeCount }), [id, describe, ambientOcclusion, ambientOcclusionRadius, bake, cascades]);
      if (result.glError !== 0) throw new Error(`${id} on ${backend} gave WebGL error ${result.glError}.`);
      graphics[backend] = result.graphics;
      await writeFile(`${WORK_DIRECTORY}/${id}-${backend}.png`, Buffer.from(result.image, 'base64'));
      if (describe) await writeFile(`${WORK_DIRECTORY}/scenes/${id}.json`, JSON.stringify(result.description));
      const bakeNote = result.bake ? `, bake ${result.bake.seconds.toFixed(1)} s, ${result.bake.report.texels} texels` : '';
      console.log(`${id} on ${backend}: ${Math.round(performance.now() - started)} ms${bakeNote}`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    await browser.close();
  }
}

async function renderPathTracerScenes(serverUrl) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS.cpu });
  const timings = {};
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.setDefaultTimeout(0);
    await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
    await page.waitForFunction(() => window.renderReferencePathTraced, null, { timeout: PAGE_LOAD_TIMEOUT });
    const sceneIds = await page.evaluate(() => window.referenceSceneIds);
    for (const id of sceneIds) {
      if (onlyScene && id !== onlyScene) continue;
      const options = { width: WIDTH, height: HEIGHT, samples: pathTracerSamples, maxSeconds: 1800 };
      const result = await page.evaluate(([sceneId, tracerOptions]) => window.renderReferencePathTraced(sceneId, tracerOptions), [id, options]);
      await writeFile(`${WORK_DIRECTORY}/${id}-pathtracer.png`, Buffer.from(result.image, 'base64'));
      timings[id] = { seconds: Number(result.report.seconds.toFixed(1)), samples: result.report.samples, ignored: result.report.ignored };
      console.log(`${id} path traced: ${timings[id].seconds} s at ${timings[id].samples} samples`);
    }
  } finally {
    await browser.close();
  }
  await writeFile(`${WORK_DIRECTORY}/pathtracer-timings.json`, JSON.stringify(timings, null, 1));
}

function runChecked(command, commandArguments) {
  const result = spawnSync(command, commandArguments, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = result.stdout.split('\n').filter(line => !/^(Fra:|Saved:|Time:|\s*$)/.test(line));
  console.log(lines.slice(-30).join('\n'));
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(`${WORK_DIRECTORY}/scenes`, { recursive: true });

if (pathTracerFlag && !scoreOnly) {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  try {
    await renderPathTracerScenes(`http://127.0.0.1:${server.httpServer.address().port}`);
  } finally {
    await server.close();
  }
}

if (!scoreOnly && !pathTracerFlag) {
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

if (!onlyScene || pathTracerFlag) {
  runChecked('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/score.py', WORK_DIRECTORY, OUTPUT_DIRECTORY, ...(pathTracerFlag ? ['--path-tracer'] : []),
  ]);
}
