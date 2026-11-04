// Measures how long each showcase world takes to show its first frame and its final frame, and the bytes fetched by then,
// in headless Chrome on a throttled or unthrottled link. It also saves the final 1280x720 frame as raw RGBA so two builds can
// be compared pixel for pixel with `--compare <a.rgba> <b.rgba>`.
//
//   node scripts/measure-showcase-load.mjs --origin http://127.0.0.1:4173 [--mbps 5] [--scenes port,airport,datacenter] [--runs 1] [--out directory --label name]
//   node scripts/measure-showcase-load.mjs --compare before.rgba after.rgba
//
// The first frame is the first instanced draw on the showcase canvas. The final frame is the first draw after the page reports
// every part of the world is in (builds without staged loading report it as soon as the world is on screen).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VIEWPORT = { width: 1280, height: 720 };
const FIRST_FRAME_MARKER = 'first-frame-drawn';

function parseArguments(argv) {
  const options = { origin: 'http://127.0.0.1:4173', mbps: 0, scenes: ['port', 'airport', 'datacenter'], runs: 1, out: null, label: 'build', compare: null, resources: false, timeoutSeconds: 180 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--origin') options.origin = argv[++index];
    else if (flag === '--mbps') options.mbps = Number(argv[++index]);
    else if (flag === '--scenes') options.scenes = argv[++index].split(',');
    else if (flag === '--runs') options.runs = Number(argv[++index]);
    else if (flag === '--out') options.out = argv[++index];
    else if (flag === '--label') options.label = argv[++index];
    else if (flag === '--resources') options.resources = true;
    else if (flag === '--timeout') options.timeoutSeconds = Number(argv[++index]);
    else if (flag === '--compare') options.compare = [argv[++index], argv[++index]];
    else throw new Error(`Unknown argument ${flag}.`);
  }
  return options;
}

function compareFrames([firstPath, secondPath]) {
  const first = readFileSync(firstPath);
  const second = readFileSync(secondPath);
  if (first.length !== second.length) throw new Error(`Frames differ in size: ${first.length} and ${second.length} bytes.`);
  let sum = 0;
  let maximum = 0;
  for (let index = 0; index < first.length; index++) {
    const difference = Math.abs(first[index] - second[index]);
    sum += difference;
    if (difference > maximum) maximum = difference;
  }
  console.log(JSON.stringify({ bytes: first.length, meanDifference: sum / first.length, maximumDifference: maximum }));
}

// Runs in the page before any script: stamps the first draw and the first draw after the world is complete.
function installFrameTimers(marker) {
  window.__loadTimes = { firstFrame: null, finalFrame: null };
  const drawInstanced = WebGL2RenderingContext.prototype.drawElementsInstanced;
  let completeSeen = false;
  WebGL2RenderingContext.prototype.drawElementsInstanced = function (...drawArguments) {
    const now = performance.now();
    if (window.__loadTimes.firstFrame === null && this.canvas.id === 'showcase-viewport') {
      window.__loadTimes.firstFrame = now;
      console.debug(marker);
    }
    if (completeSeen && window.__loadTimes.finalFrame === null) window.__loadTimes.finalFrame = now;
    return drawInstanced.apply(this, drawArguments);
  };
  const watch = () => {
    const showcase = window.__showcase;
    if (showcase && (showcase.complete === undefined || showcase.complete === true)) completeSeen = true;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

async function measureOnce(browser, options, sceneId) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (options.mbps > 0) {
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: options.mbps * 1e6 / 8, uploadThroughput: options.mbps * 1e6 / 8 });
  }
  let totalBytes = 0;
  const urlOfRequest = new Map();
  const bytesOfUrl = new Map();
  session.on('Network.requestWillBeSent', event => urlOfRequest.set(event.requestId, event.request.url));
  session.on('Network.dataReceived', event => {
    totalBytes += event.dataLength;
    const url = urlOfRequest.get(event.requestId) ?? event.requestId;
    bytesOfUrl.set(url, (bytesOfUrl.get(url) ?? 0) + event.dataLength);
  });
  await page.addInitScript(installFrameTimers, FIRST_FRAME_MARKER);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let bytesAtFirstFrame = 0;
  let resourcesAtFirstFrame = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.text() === FIRST_FRAME_MARKER) {
      bytesAtFirstFrame = totalBytes;
      resourcesAtFirstFrame = [...bytesOfUrl].map(([url, bytes]) => ({ url: url.replace(options.origin, ''), bytes }));
    }
  });
  await page.goto(`${options.origin}/showcase.html?scene=${sceneId}`, { waitUntil: 'commit' });
  let timedOut = false;
  try {
    await page.waitForFunction(() => window.__loadTimes?.finalFrame !== null && window.__loadTimes?.finalFrame !== undefined, null, { timeout: options.timeoutSeconds * 1000, polling: 50 });
  } catch {
    timedOut = true;
    errors.push(`no final frame; status: ${await page.evaluate(() => document.querySelector('#showcase-status')?.textContent)}`);
  }
  const times = await page.evaluate(() => ({ ...window.__loadTimes }));
  const memory = await page.evaluate(() => {
    const renderer = window.__showcase?.renderer;
    return renderer ? { textureMiB: Math.round(renderer.textureBytes / 1048576), geometryMiB: Math.round(renderer.geometryBytes / 1048576) } : null;
  });
  const result = {
    scene: sceneId,
    mbps: options.mbps,
    timedOut,
    memory,
    firstFrameSeconds: Number((times.firstFrame / 1000).toFixed(2)),
    finalFrameSeconds: times.finalFrame === null ? null : Number((times.finalFrame / 1000).toFixed(2)),
    megabytesAtFirstFrame: Number((bytesAtFirstFrame / 1e6).toFixed(2)),
    totalMegabytes: Number((totalBytes / 1e6).toFixed(2)),
    errors,
  };
  if (options.resources) result.resourcesAtFirstFrame = resourcesAtFirstFrame.sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  if (options.out && !timedOut) {
    const pixels = await page.evaluate(async () => {
      const showcase = window.__showcase;
      const canvasElement = document.querySelector('#showcase-viewport');
      canvasElement.style.cssText = 'width:1280px;height:720px;max-width:none;max-height:none;position:fixed;left:0;top:0;aspect-ratio:auto';
      window.dispatchEvent(new Event('resize'));
      showcase.draw();
      const canvas = document.querySelector('#showcase-viewport');
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const copyContext = copy.getContext('2d');
      copyContext.drawImage(canvas, 0, 0);
      const data = copyContext.getImageData(0, 0, copy.width, copy.height).data;
      let binary = '';
      const chunk = 0x8000;
      for (let offset = 0; offset < data.length; offset += chunk) binary += String.fromCharCode(...data.subarray(offset, offset + chunk));
      return { width: copy.width, height: copy.height, base64: btoa(binary) };
    });
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, `${sceneId}-${options.label}.rgba`), Buffer.from(pixels.base64, 'base64'));
    result.frame = `${pixels.width}x${pixels.height}`;
  }
  await context.close();
  return result;
}

const options = parseArguments(process.argv.slice(2));
if (options.compare) {
  compareFrames(options.compare);
} else {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  try {
    for (const sceneId of options.scenes) {
      for (let run = 0; run < options.runs; run++) console.log(JSON.stringify(await measureOnce(browser, options, sceneId)));
    }
  } finally {
    await browser.close();
  }
}
