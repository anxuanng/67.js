// Frame time of a reference scene: plain, with the light bake, with reflection probes, and with both.
// node bench/reference/frame-time.mjs [scene-id] [gpu|cpu] [--grand] [--floor-sky=<strength> [--floor-sky-rooms]] [--no-floor-sky] [--sun-bounce=<n>]
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_LOAD_TIMEOUT = 180000;
const [sceneId = 'lit-interior', backend = 'gpu'] = process.argv.slice(2);
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const floorSkyArgument = process.argv.find(argument => argument.startsWith('--floor-sky='));
  const sunBounceArgument = process.argv.find(argument => argument.startsWith('--sun-bounce='));
  const harnessQuery = [sunBounceArgument ? `sunBounce=${sunBounceArgument.split('=')[1]}` : null, process.argv.includes('--grand') ? 'set=grand' : null, floorSkyArgument ? `floorSky=${floorSkyArgument.split('=')[1]}` : null, process.argv.includes('--floor-sky-rooms') ? 'floorSkyRooms=1' : process.argv.includes('--no-floor-sky') ? 'floorSky=0' : null].filter(Boolean).join('&');
  await page.goto(`${serverUrl}/bench/reference/harness.html${harnessQuery ? `?${harnessQuery}` : ''}`, { timeout: PAGE_LOAD_TIMEOUT });
  await page.waitForFunction(() => window.measureReferenceFrameTime, null, { timeout: PAGE_LOAD_TIMEOUT });
  const results = [];
  // Alternate the order so a drifting machine load does not favor one side. --cascades measures one map and three
  // cascades, each with a still camera and with a camera that moves every frame.
  // --plain measures only the plain frame, for scenes with more parts than the light bake takes.
  // --objects measures the plain frame against the frame with one probe for each reflective part.
  // --water measures a frame without water reflection, with the planar one and with the screen-space one.
  // --bake-cost measures the plain frame against the frame with the scene's light bake. --glow-mips measures the frame with the fog's
  // glow mip chain generated every frame against the same frame with the generation skipped. --repetitions=N sets the rounds (3 by default).
  const repetitionsArgument = process.argv.find(argument => argument.startsWith('--repetitions='));
  const rounds = Array.from({ length: repetitionsArgument ? Number(repetitionsArgument.split('=')[1]) : 3 }, (_, index) => index + 1);
  const variants = process.argv.includes('--bake-cost')
    ? rounds.flatMap(round => (round % 2 ? [false, true] : [true, false]).map(bake => ({ bake, probes: false })))
    : process.argv.includes('--glow-mips')
    ? rounds.flatMap(round => (round % 2 ? [true, false] : [false, true]).map(glowMipChain => ({ bake: false, probes: false, glowMipChain })))
    : process.argv.includes('--water')
    ? [1, 2, 3].flatMap(round => (round % 2 ? ['off', 'planar', 'ssr'] : ['ssr', 'planar', 'off']).map(water => ({ bake: false, probes: false, water: water === 'off' ? false : water })))
    : process.argv.includes('--plain')
    ? [1, 2, 3].map(() => ({ bake: false, probes: false }))
    : process.argv.includes('--objects')
    ? [1, 2, 3].flatMap(round => (round % 2 ? [false, 'objects'] : ['objects', false]).map(probes => ({ bake: false, probes })))
    : process.argv.includes('--cascades')
    ? [0, 3, 0, 3].flatMap(cascades => [false, true].map(orbit => ({ bake: false, cascades, orbit })))
    : [1, 2, 3].flatMap(round => (round % 2 ? [[false, false], [true, false], [true, true], [false, true]] : [[false, true], [true, true], [true, false], [false, false]]).map(([bake, probes]) => ({ bake, probes })));
  for (const variant of variants) {
    results.push({ ...variant, ...(await page.evaluate(([id, options]) => window.measureReferenceFrameTime(id, options), [sceneId, variant])) });
  }
  const medianOf = values => values.sort((first, second) => first - second)[Math.floor(values.length / 2)];
  const summary = {};
  for (const result of results) {
    const key = process.argv.includes('--glow-mips') ? (result.glowMipChain ? 'mips generated' : 'mips skipped') : process.argv.includes('--water') ? (result.water || 'off') : result.baked ? (result.probes ? 'bake+probes' : 'bake') : (result.probes ? 'probes' : 'plain');
    (summary[key] ??= []).push(result.medianMilliseconds);
  }
  const medianByVariant = Object.fromEntries(Object.entries(summary).map(([key, values]) => [key, Number(medianOf(values).toFixed(3))]));
  const rangeByVariant = Object.fromEntries(Object.entries(summary).map(([key, values]) => [key, [Math.min(...values), Math.max(...values)].map(value => Number(value.toFixed(3)))]));
  console.log(JSON.stringify({ sceneId, backend, medianMillisecondsByVariant: medianByVariant, rangeMillisecondsByVariant: rangeByVariant, results }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
