// Renders the reference scenes in 67js and Blender, then scores them: npm run reference
// --ambient-occlusion <strength> [--ambient-occlusion-radius <units>] turns occlusion on (off by default).
// --bake [<id>,<id>] [--bake-preset <name>] bakes bounced light into the named scenes (every scene when no ids follow) before 67js draws them;
// Blender still gets the plain scene.
// --probes [<id>,<id>] adds reflection probes (src/reflection-probes.js) to the named scenes, on top of --bake when both are given.
// --ambient <scale> multiplies the light the world gives every surface (0 removes it); with --skip-blender it measures what the world adds.
// --path-tracer [--samples <n>] [--noise-threshold <n>] [--scene <id>] draws the scenes with the offline path tracer (src/path-tracer.js) instead, keeps the
// Cycles renders of an earlier run, and scores them into path-tracer.json. Nothing in baseline.json or images/ changes.
// Use --score-only to score existing renders, --skip-blender to keep them, and --scene <id> for one scene.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// --khronos draws the Khronos sample assets in artifacts/khronos (Blender imports the same files) into their own work
// directory, and scores them into khronos.json. Nothing in baseline.json or images/<scene>.jpg changes.
// --cloth draws the cloth scenes (a pinned banner in wind, a sheet dropped on a ball) with 67js's solver and with a Blender
// cloth bake, and scores them into cloth.json the same way (the pixels the scene covers, with the sky left out).
const khronos = process.argv.includes('--khronos');
const cloth = process.argv.includes('--cloth');
// --grand draws the options for the grand scenes (grand-scenes.js, issue #168) and scores them into grand.json.
const grand = process.argv.includes('--grand');
const sceneSet = khronos ? 'khronos' : cloth ? 'cloth' : grand ? 'grand' : null;
const WORK_DIRECTORY = resolve(sceneSet ? `artifacts/reference-${sceneSet}` : 'artifacts/reference');
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
// --skip-cpu leaves out the SwiftShader render (very slow for the 9 million triangle scenes) and the scoring, which needs it.
const skipCpu = argumentsGiven.includes('--skip-cpu');
const sceneFlag = argumentsGiven.indexOf('--scene');
const occlusionFlag = argumentsGiven.indexOf('--ambient-occlusion');
const ambientOcclusion = occlusionFlag >= 0 ? Number(argumentsGiven[occlusionFlag + 1]) : 0;
const radiusFlag = argumentsGiven.indexOf('--ambient-occlusion-radius');
const ambientOcclusionRadius = radiusFlag >= 0 ? Number(argumentsGiven[radiusFlag + 1]) : 0.5;
const bakeFlag = argumentsGiven.indexOf('--bake');
const bakeValue = bakeFlag >= 0 ? argumentsGiven[bakeFlag + 1] : undefined;
const bakedSceneIds = bakeFlag >= 0 && bakeValue && !bakeValue.startsWith('--') ? bakeValue.split(',') : null;
// --sky-only <texelsPerUnit>,<samples> makes the --bake rows sky visibility alone (no light written) at that density.
const skyOnlyFlag = argumentsGiven.indexOf('--sky-only');
const [skyTexelsPerUnit, skySamples] = skyOnlyFlag >= 0 ? argumentsGiven[skyOnlyFlag + 1].split(',').map(Number) : [];
const skyOnlyOptions = skyOnlyFlag >= 0 ? { skyOnly: true, texelsPerUnit: skyTexelsPerUnit, samples: skySamples } : {};
// --bake-preset <draft|standard|fine> bakes the way a recipe does (`bake: { preset }`): the preset's own samples, bounces and
// texel density, scaled down to the preset's path work budget, and the scene's own `bakeOptions` are ignored. Needs --bake.
const bakePresetFlag = argumentsGiven.indexOf('--bake-preset');
const bakePreset = bakePresetFlag >= 0 ? argumentsGiven[bakePresetFlag + 1] : null;
const probesFlag =argumentsGiven.indexOf('--probes');
const probesValue = probesFlag >= 0 ? argumentsGiven[probesFlag + 1] : undefined;
const probedSceneIds = probesFlag >= 0 && probesValue && !probesValue.startsWith('--') ? probesValue.split(',') : null;
// --object-probes [<id>,<id>] gives each reflective part of the named scenes (every scene when no ids follow) a probe of its own (traceObjectProbes).
const objectProbesFlag = argumentsGiven.indexOf('--object-probes');
const objectProbesValue = objectProbesFlag >= 0 ? argumentsGiven[objectProbesFlag + 1] : undefined;
const objectProbeSceneIds = objectProbesFlag >= 0 && objectProbesValue && !objectProbesValue.startsWith('--') ? objectProbesValue.split(',') : null;
const cascadesFlag = argumentsGiven.indexOf('--cascades');
const cascades = cascadesFlag >= 0 ? Number(argumentsGiven[cascadesFlag + 1]) : 0;
const ambientFlag = argumentsGiven.indexOf('--ambient');
const ambient = ambientFlag >= 0 ? Number(argumentsGiven[ambientFlag + 1]) : null;
const pathTracerFlag = argumentsGiven.includes('--path-tracer');
const samplesFlag = argumentsGiven.indexOf('--samples');
const pathTracerSamples = samplesFlag >= 0 ? Number(argumentsGiven[samplesFlag + 1]) : 64;
const noiseThresholdFlag = argumentsGiven.indexOf('--noise-threshold');
const pathTracerNoiseThreshold = noiseThresholdFlag >= 0 ? Number(argumentsGiven[noiseThresholdFlag + 1]) : undefined;
const onlyScene = sceneFlag >= 0 ? argumentsGiven[sceneFlag + 1] : null;

async function renderBackend(backend, serverUrl, graphics) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.text().includes('GL_') && console.log('PAGE', message.text().slice(0, 200)));
    // Each scene gets a fresh page, so a large scene leaves no GL state or memory behind for the next one.
    const openHarness = async () => {
      await page.goto(`${serverUrl}/bench/reference/harness.html${sceneSet ? `?set=${sceneSet}` : ''}`, { timeout: PAGE_LOAD_TIMEOUT });
      await page.waitForFunction(() => window.renderReferenceScene, null, { timeout: PAGE_LOAD_TIMEOUT });
    };
    await openHarness();
    const sceneIds = await page.evaluate(() => window.referenceSceneIds);
    for (const id of sceneIds) {
      if (onlyScene && id !== onlyScene) continue;
      await openHarness();
      const started = performance.now();
      const describe = backend === 'gpu';
      const probesThisScene = probesFlag >= 0 && (probedSceneIds === null || probedSceneIds.includes(id));
      const bakesThisScene = bakeFlag >= 0 && (bakedSceneIds === null || bakedSceneIds.includes(id));
      // Object probes are opt in: a recipe does not place them yet, so the baseline scores what a user gets by default.
      const objectProbesThisScene = objectProbesFlag >= 0 && (objectProbeSceneIds === null || objectProbeSceneIds.includes(id));
      const probes = objectProbesThisScene ? 'objects' : probesThisScene;
      const bake = bakesThisScene ? { ...skyOnlyOptions, ...(bakePreset ? { preset: bakePreset } : {}) } : null;
      const result = await page.evaluate(([sceneId, shouldDescribe, ambientOcclusion, ambientOcclusionRadius, bakeOptions, cascadeCount, withProbes, ambientScale]) => window.renderReferenceScene(sceneId, { describe: shouldDescribe, ambientOcclusion, ambientOcclusionRadius, bake: bakeOptions, cascades: cascadeCount, probes: withProbes, ambient: ambientScale }), [id, describe, ambientOcclusion, ambientOcclusionRadius, bake, cascades, probes, ambient]);
      if (result.glError !== 0) throw new Error(`${id} on ${backend} gave WebGL error ${result.glError}.`);
      graphics[backend] = result.graphics;
      await writeFile(`${WORK_DIRECTORY}/${id}-${backend}.png`, Buffer.from(result.image, 'base64'));
      if (describe) await writeFile(`${WORK_DIRECTORY}/scenes/${id}.json`, JSON.stringify(result.description));
      if ((khronos || cloth) && describe) {
        const background = await page.evaluate(sceneId => window.renderReferenceScene(sceneId, { describe: false, backgroundOnly: true }), id);
        await writeFile(`${WORK_DIRECTORY}/${id}-background.png`, Buffer.from(background.image, 'base64'));
      }
      const bakeNote = result.bake?.report.refused ? `, bake REFUSED, drawn unbaked: ${result.bake.report.refused}` : result.bake ? `, bake ${result.bake.seconds.toFixed(1)} s, ${result.bake.report.texels} texels${result.bake.report.reduced ? ` (preset reduced to ${result.bake.report.used.samples} samples, ${result.bake.report.used.bounces} bounces, ${result.bake.report.used.texelsPerUnit} texels per unit)` : ''}` : '';
      const probeNote = result.probes ? `, probes ${result.probes.report.placed.length} on ${result.probes.report.partsWithProbe} parts` : '';
      console.log(`${id} on ${backend}: ${Math.round(performance.now() - started)} ms${bakeNote}${probeNote}`);
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
      const options = { width: WIDTH, height: HEIGHT, samples: pathTracerSamples, maxSeconds: 1800, ...(pathTracerNoiseThreshold === undefined ? {} : { noiseThreshold: pathTracerNoiseThreshold }) };
      const result = await page.evaluate(([sceneId, tracerOptions]) => window.renderReferencePathTraced(sceneId, tracerOptions), [id, options]);
      await writeFile(`${WORK_DIRECTORY}/${id}-pathtracer.png`, Buffer.from(result.image, 'base64'));
      timings[id] = { seconds: Number(result.report.seconds.toFixed(1)), samples: result.report.samples, averageSamples: Number(result.report.averageSamples.toFixed(1)), ignored: result.report.ignored };
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
    if (!skipCpu) await renderBackend('cpu', serverUrl, graphics);
  } finally {
    await server.close();
  }
  await writeFile(`${WORK_DIRECTORY}/graphics.json`, JSON.stringify(graphics, null, 1));
  if (!skipBlender) {
    const sceneArguments = onlyScene ? [onlyScene] : [];
    runChecked(BLENDER, ['-b', '--factory-startup', '--python', 'bench/reference/render-blender.py', '--', WORK_DIRECTORY, ...sceneArguments]);
  }
}

if ((!onlyScene && !skipCpu) || pathTracerFlag) {
  runChecked('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/score.py', WORK_DIRECTORY, OUTPUT_DIRECTORY, ...(pathTracerFlag ? ['--path-tracer'] : []), ...(sceneSet ? [`--${sceneSet}`] : []),
  ]);
}
else {
  // Scoring reads every scene in the work directory, so a run of one scene would mix new and old renders; it leaves the scores as they were.
  console.log('--scene renders one scene and does not score it. Run without --scene to rescore; the numbers in baseline.json are unchanged.');
}
