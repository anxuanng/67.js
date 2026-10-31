import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { FILM_DURATION } from '../src/film.js';
import { RENDER_PRESETS } from '../src/budget.js';
import { createFrameEncoder } from './frame-encoder.mjs';

function argumentsFrom(values) {
  const result = {};
  const allowed = new Set(['kind', 'backend', 'scene', 'preset', 'width', 'height', 'fps', 'duration', 'time', 'memory', 'assembly', 'output', 'audio', 'encoder', 'start', 'aspect', 'asset', 'capture', 'jpeg-quality']);
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index].startsWith('--') || values[index + 1] === undefined) throw new Error('Every option needs a value.');
    const name = values[index].slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown render option: ${name}`);
    result[name] = values[index + 1];
  }
  return result;
}

export function parseRenderOptions(values) {
  const options = argumentsFrom(values);
  const kind = options.kind ?? 'image';
  const backend = options.backend ?? 'gpu';
  const scene = options.scene ?? 'film';
  const presetName = options.preset ?? (backend === 'cpu' ? 'cpu' : 'balanced');
  const preset = RENDER_PRESETS[presetName];
  const aspect = options.aspect ?? 'landscape';
  if (!preset || !['image', 'video', 'stills'].includes(kind) || !['gpu', 'cpu'].includes(backend) || !['film', 'nature', 'object', 'motion', 'view2d', 'assets', 'modeling'].includes(scene) || !['landscape', 'portrait', 'square'].includes(aspect)) throw new Error('Unknown render kind, backend, scene, aspect or preset.');
  if (options.asset && scene !== 'assets') throw new Error('The asset file option requires --scene assets.');
  const numberOption = (name, fallback, minimum, maximum) => {
    const value = Number(options[name] ?? fallback);
    if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
    return value;
  };
  const shorter = Math.min(preset.width, preset.height);
  const longer = Math.max(preset.width, preset.height);
  const ratio = aspect === 'portrait' ? 9 / 16 : aspect === 'square' ? 1 : 16 / 9;
  let defaultWidth = aspect === 'landscape' ? longer : shorter;
  let defaultHeight = aspect === 'portrait' ? longer : shorter;
  if (options.width !== undefined && options.height === undefined) defaultHeight = Number(options.width) / ratio;
  if (options.height !== undefined && options.width === undefined) defaultWidth = Number(options.height) * ratio;
  const width = Math.round(numberOption('width', defaultWidth, 64, 4096));
  const height = Math.round(numberOption('height', defaultHeight, 64, 4096));
  if (kind === 'video' && (width % 2 || height % 2)) throw new Error('Video dimensions must be even for yuv420p output.');
  const fps = numberOption('fps', preset.fps, 1, 60);
  const duration = numberOption('duration', scene === 'film' ? FILM_DURATION : ['motion', 'modeling'].includes(scene) ? 12 : 32, 0.1, 240);
  const time = numberOption('time', scene === 'assets' ? 0 : 3, 0, 3600);
  const start = numberOption('start', 0, 0, 3600);
  const memory = numberOption('memory', preset.memoryBudgetMiB, 32, 1024);
  const assembly = numberOption('assembly', 0, 0, 1);
  const captureFormat = options.capture ?? (kind === 'video' ? 'jpeg' : 'png');
  if (!['jpeg', 'png'].includes(captureFormat)) throw new Error('Capture must be jpeg or png.');
  const jpegQuality = numberOption('jpeg-quality', 95, 1, 100);
  if (!Number.isInteger(jpegQuality)) throw new Error('JPEG quality must be an integer.');
  const output = resolve(options.output ?? `artifacts/${scene}-${backend}.${kind === 'video' ? 'mp4' : captureFormat === 'jpeg' ? 'jpg' : 'png'}`);
  const encoderBackend = options.encoder ?? (backend === 'cpu' ? 'cpu' : 'auto');
  if (!['auto', 'cpu', 'gpu'].includes(encoderBackend)) throw new Error('Encoder must be auto, cpu or gpu.');
  const audio = options.audio ?? (scene === 'film' ? 'artifacts/critical-score.wav' : null);
  return { options, kind, backend, scene, presetName, preset, aspect, width, height, fps, duration, time, start, memory, assembly, output, encoderBackend, audio, captureFormat, jpegQuality };
}

export async function selectEncoderBackend(requested, probe) {
  if (!['auto', 'cpu', 'gpu'].includes(requested)) throw new Error('Encoder must be auto, cpu or gpu.');
  if (requested === 'cpu') return 'cpu';
  const result = await probe();
  if (result.available) return 'gpu';
  if (requested === 'gpu') throw new Error(`NVENC is unavailable: ${result.reason || 'availability probe failed'}`);
  return 'cpu';
}

function probeNvenc(ffmpeg) {
  return new Promise((resolveProbe) => {
    const probe = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:r=1', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      probe.kill();
    }, 5000);
    probe.stderr.on('data', data => {
      tail = (tail + data.toString()).slice(-8192);
    });
    probe.on('error', error => {
      clearTimeout(timeout);
      resolveProbe({ available: false, reason: error.message });
    });
    probe.on('close', code => {
      clearTimeout(timeout);
      resolveProbe({ available: code === 0 && !timedOut, reason: timedOut ? 'probe timed out after 5 seconds' : tail.trim() || `probe exited ${code}` });
    });
  });
}

export async function renderMedia(values = process.argv.slice(2)) {
  const plan = parseRenderOptions(values);
  const { options, kind, backend, scene, presetName, preset, aspect, width, height, fps, time, start, memory, assembly, output, captureFormat, jpegQuality } = plan;
  let duration = plan.duration;
  if (options.asset) {
    const details = await stat(resolve(options.asset));
    if (!details.isFile() || details.size > 32 * 1024 ** 2) throw new Error('Asset capture requires a GLB file of at most 32 MiB.');
  }
  await mkdir(dirname(output), { recursive: true });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const ffmpeg = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.local/bin/ffmpeg.exe') : 'ffmpeg';
  const encoderBackend = kind === 'video' ? await selectEncoderBackend(plan.encoderBackend, () => probeNvenc(ffmpeg)) : null;
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/render-vite.config.mjs', '--host', '127.0.0.1', '--port', '5181', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  let browser;
  let encoder;
  let peakNodeBytes = 0;
  let peakBrowserHeap = 0;
  let peakEstimatedRenderBytes = 0;
  let maximumPendingFrames = 0;
  let firstFrameBytes = 0;
  let actualRenderSize;
  let capturedFrames = 0;
  const stageTimings = { renderSeconds: 0, captureSeconds: 0, encoderBackpressureSeconds: 0, encoderFinishSeconds: 0 };
  const started = performance.now();
  try {
    await new Promise((resolveStarted, reject) => {
      const timeout = setTimeout(() => reject(new Error('Render server did not start.')), 15000);
      server.stdout.on('data', (data) => {
        if (data.toString().includes('127.0.0.1:5181')) { clearTimeout(timeout); resolveStarted(); }
      });
      server.on('error', reject);
      server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Render server exited ${code}.`)); });
    });
    const args = ['--enable-webgl', '--ignore-gpu-blocklist'];
    if (backend === 'cpu') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}), args });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const route = scene === 'object' ? 'object.html' : `${scene}.html`;
    const query = new URLSearchParams({ export: '1', width: String(width), height: String(height), aspect, memory: String(memory), samples: String(backend === 'cpu' ? 1 : preset.samples) });
    await page.goto(`http://127.0.0.1:5181/${route}?${query}`);
    await page.waitForFunction((mode) => window.__scene?.renderer || (mode === 'film' ? window.__filmReady : mode === 'nature' ? window.__nature?.renderer : mode === 'object' ? window.__studio?.renderer : false), scene, { timeout: 60000 });
    if (options.asset) {
      await page.locator('#file').setInputFiles(resolve(options.asset));
      await page.waitForFunction(() => document.querySelector('#notice').hidden || document.querySelector('#notice').textContent.startsWith('⚠'));
      const failure = await page.locator('#notice').evaluate(element => element.hidden ? null : element.textContent);
      if (failure) throw new Error(`Asset import failed: ${failure}`);
    }
    const sceneDuration = await page.evaluate(() => window.__scene?.duration ?? window.__film?.duration);
    if (Number.isFinite(sceneDuration) && sceneDuration > 0) {
      if (start >= sceneDuration) throw new Error('Start time must precede the end of the scene.');
      if (options.duration === undefined) duration = Math.min(240, sceneDuration - start);
      else if (kind === 'video' && start + duration > sceneDuration + 1e-8) throw new Error('The requested video extends beyond the scene duration.');
      if (kind === 'image' && time > sceneDuration) throw new Error('Image time exceeds the scene duration.');
    }
    if (scene !== 'film') await page.evaluate(({ memory, width, height, samples, scene, assembly }) => {
      const canvas = document.querySelector('canvas');
      canvas.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
      document.querySelectorAll('body > *, main > *').forEach((element) => {
        if (element === canvas || element.contains(canvas)) return;
        element.hidden = true;
        element.style.setProperty('display', 'none', 'important');
      });
      window.__scene?.pause?.();
      const renderer = window.__scene?.renderer ?? (scene === 'object' ? window.__studio.renderer : window.__nature.renderer);
      renderer.memoryBudgetMiB = memory;
      renderer.pixelRatio = 1;
      renderer.resize();
      if (window.__scene) return;
      if (scene === 'object') {
        window.__studio.state.exporting = true;
        window.__studio.state.assembly = assembly;
        renderer.projection[8] = 0;
        window.renderAt = () => renderer.render(window.__studio.camera());
      } else window.renderAt = (time) => window.__nature.renderAt(time);
    }, { memory, width, height, samples: backend === 'cpu' ? 1 : preset.samples, scene, assembly });
    const session = await page.context().newCDPSession(page);
    const render = async (seconds) => {
      if (errors.length) throw new Error(`Browser render errors: ${errors.join('; ')}`);
      const renderStarted = performance.now();
      const rendererPlan = await page.evaluate((value) => {
        if (window.__scene) window.__scene.renderAt(value);
        else if (window.renderAt) window.renderAt(value);
        else window.__nature.renderAt(value);
        const renderer = window.__scene?.renderer ?? window.__film?.renderer ?? window.__nature?.renderer ?? window.__studio?.renderer;
        const glError = renderer.context.getError();
        if (glError !== 0) throw new Error(`WebGL render error ${glError}.`);
        return renderer.memoryPlan;
      }, seconds);
      stageTimings.renderSeconds += (performance.now() - renderStarted) / 1000;
      peakEstimatedRenderBytes = Math.max(peakEstimatedRenderBytes, rendererPlan.estimatedBytes);
      actualRenderSize = { width: rendererPlan.width, height: rendererPlan.height, reduced: rendererPlan.reduced };
      if (rendererPlan.estimatedBytes > memory * 1024 ** 2) throw new Error('Render target exceeded the configured memory budget.');
      const nodeBytes = process.memoryUsage().rss;
      peakNodeBytes = Math.max(peakNodeBytes, nodeBytes);
      if (nodeBytes > 512 * 1024 ** 2) throw new Error('Capture process exceeded 512 MiB. Export stopped before buffering more frames.');
    };
    async function capture(seconds) {
      await render(seconds);
      const captureStarted = performance.now();
      const screenshot = await session.send('Page.captureScreenshot', {
        format: captureFormat,
        fromSurface: true,
        ...(captureFormat === 'jpeg' ? { quality: jpegQuality } : { optimizeForSpeed: true }),
      });
      const image = Buffer.from(screenshot.data, 'base64');
      stageTimings.captureSeconds += (performance.now() - captureStarted) / 1000;
      capturedFrames++;
      if (!firstFrameBytes) firstFrameBytes = image.byteLength;
      return image;
    }
    if (kind === 'video') {
      const audioPath = plan.audio ? resolve(plan.audio) : null;
      if (options.audio && !existsSync(audioPath)) throw new Error('The selected audio file was not found.');
      const audioArguments = audioPath && existsSync(audioPath) ? ['-ss', String(start), '-i', audioPath] : [];
      encoder = createFrameEncoder({ executable: ffmpeg, output, fps, format: captureFormat,
        backend: encoderBackend, audioArguments, maximumFrameBytes: 64 * 1024 * 1024,
        maximumOutputBytes: Number.MAX_SAFE_INTEGER });
      const frameCount = Math.ceil(duration * fps);
      const captureSequenceStarted = performance.now();
      for (let frame = 0; frame < frameCount; frame++) {
        const image = await capture(start + frame / fps);
        maximumPendingFrames = Math.max(maximumPendingFrames, 1);
        await encoder.writeFrame(image);
        stageTimings.encoderBackpressureSeconds = encoder.metrics.backpressureSeconds;
        if (frame % 48 === 0) {
          const { usedSize } = await session.send('Runtime.getHeapUsage');
          peakBrowserHeap = Math.max(peakBrowserHeap, usedSize);
          if (usedSize > 256 * 1024 ** 2) throw new Error('Browser JavaScript heap exceeded 256 MiB. Export stopped.');
          const elapsed = (performance.now() - captureSequenceStarted) / 1000;
          const effectiveFps = (frame + 1) / elapsed;
          const remainingSeconds = (frameCount - frame - 1) / effectiveFps;
          const message = `Rendered ${frame + 1}/${frameCount} frames | ${effectiveFps.toFixed(1)} fps | ${(effectiveFps / fps).toFixed(2)}x | ETA ${Math.ceil(remainingSeconds)}s`;
          console.log(message);
        }
      }
      const encoding = await encoder.finish();
      stageTimings.encoderFinishSeconds = encoding.finishSeconds;
    } else if (kind === 'stills') {
      const stillTimes = scene === 'film' && start === 0 && options.duration === undefined
        ? [23, 49, 59, 101, 114, 149, 158, 182]
        : Array.from({ length: 8 }, (_, index) => start + duration * (index + 0.5) / 8);
      for (const seconds of stillTimes) {
        const image = await capture(seconds);
        await writeFile(resolve(dirname(output), `frame-${seconds.toFixed(1)}.${captureFormat === 'jpeg' ? 'jpg' : 'png'}`), image);
      }
    } else {
      await writeFile(output, await capture(time));
    }
    if (errors.length) throw new Error(`Browser render errors: ${errors.join('; ')}`);
    const graphics = await page.evaluate(() => {
      const renderer = window.__scene?.renderer ?? window.__film?.renderer ?? window.__nature?.renderer ?? window.__studio?.renderer;
      const context = renderer.context;
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      return { gpu: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable', samples: renderer.capabilities?.samples ?? renderer.samples, capabilities: renderer.capabilities, glError: context.getError() };
    });
    if (graphics.glError !== 0) throw new Error(`WebGL render error ${graphics.glError}.`);
    if (backend === 'cpu' && !graphics.gpu.toLowerCase().includes('swiftshader')) throw new Error('CPU backend did not select SwiftShader.');
    const elapsedSeconds = (performance.now() - started) / 1000;
    const report = { scene, kind, backend, preset: presetName, aspect, start, encoder: encoderBackend, requestedEncoder: kind === 'video' ? plan.encoderBackend : null, captureFormat, jpegQuality: captureFormat === 'jpeg' ? jpegQuality : null, capturedFrames, stageTimings, effectiveFPS: capturedFrames / elapsedSeconds, speedRatio: kind === 'video' ? capturedFrames / fps / elapsedSeconds : null, assembly: scene === 'object' ? assembly : null, width, height, actualRenderSize, fps, duration: kind === 'video' ? duration : null, memoryBudgetMiB: memory, peakEstimatedRenderBytes, peakNodeBytes, peakBrowserHeap, maximumPendingFrames, firstFrameBytes, elapsedSeconds, graphics, output: basename(output), errors };
    await writeFile(`${output}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      await encoder?.close();
    } finally {
      try { await browser?.close(); }
      finally { server.kill(); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await renderMedia();
