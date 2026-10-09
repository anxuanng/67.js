import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { RENDER_PRESETS } from '../src/budget.js';

function argumentsFrom(values) {
  const result = {};
  const allowed = new Set(['kind', 'backend', 'scene', 'preset', 'width', 'height', 'fps', 'duration', 'time', 'memory', 'assembly', 'output', 'audio', 'encoder', 'start', 'aspect']);
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
  if (!preset || !['image', 'video', 'stills'].includes(kind) || !['gpu', 'cpu'].includes(backend) || !['film', 'nature', 'object', 'motion', 'view2d'].includes(scene) || !['landscape', 'portrait', 'square'].includes(aspect)) throw new Error('Unknown render kind, backend, scene, aspect or preset.');
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
  const duration = numberOption('duration', scene === 'motion' ? 12 : 32, 0.1, 120);
  const time = numberOption('time', 3, 0, 3600);
  const start = numberOption('start', 0, 0, 3600);
  const memory = numberOption('memory', preset.memoryBudgetMiB, 32, 1024);
  const assembly = numberOption('assembly', 0, 0, 1);
  const output = resolve(options.output ?? `artifacts/${scene}-${backend}.${kind === 'video' ? 'mp4' : 'png'}`);
  const encoderBackend = options.encoder ?? 'cpu';
  if (!['cpu', 'gpu'].includes(encoderBackend)) throw new Error('Encoder must be cpu or gpu.');
  const audio = options.audio ?? (scene === 'film' ? 'artifacts/critical-score.wav' : null);
  return { options, kind, backend, scene, presetName, preset, aspect, width, height, fps, duration, time, start, memory, assembly, output, encoderBackend, audio };
}

export async function renderMedia(values = process.argv.slice(2)) {
  const plan = parseRenderOptions(values);
  const { options, kind, backend, scene, presetName, preset, aspect, width, height, fps, time, start, memory, assembly, output, encoderBackend } = plan;
  let duration = plan.duration;
  await mkdir(dirname(output), { recursive: true });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const ffmpeg = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.local/bin/ffmpeg.exe') : 'ffmpeg';
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/render-vite.config.mjs', '--host', '127.0.0.1', '--port', '5181', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  let browser;
  let encoder;
  let encoderError = '';
  let peakNodeBytes = 0;
  let peakBrowserHeap = 0;
  let peakEstimatedRenderBytes = 0;
  let maximumPendingFrames = 0;
  let firstFrameBytes = 0;
  let actualRenderSize;
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
    const sceneDuration = await page.evaluate(() => window.__scene?.duration ?? (window.__film ? 32 : null));
    if (Number.isFinite(sceneDuration) && sceneDuration > 0) {
      if (start >= sceneDuration) throw new Error('Start time must precede the end of the scene.');
      if (options.duration === undefined) duration = Math.min(120, sceneDuration - start);
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
      renderer.samples = samples;
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
      await page.evaluate((value) => {
        if (window.__scene) window.__scene.renderAt(value);
        else if (window.renderAt) window.renderAt(value);
        else window.__nature.renderAt(value);
      }, seconds);
      const rendererPlan = await page.evaluate(() => {
        const renderer = window.__scene?.renderer ?? window.__film?.renderer ?? window.__nature?.renderer ?? window.__studio?.renderer;
        const glError = renderer.context.getError();
        if (glError !== 0) throw new Error(`WebGL render error ${glError}.`);
        return renderer.memoryPlan;
      });
      peakEstimatedRenderBytes = Math.max(peakEstimatedRenderBytes, rendererPlan.estimatedBytes);
      actualRenderSize = { width: rendererPlan.width, height: rendererPlan.height, reduced: rendererPlan.reduced };
      if (rendererPlan.estimatedBytes > memory * 1024 ** 2) throw new Error('Render target exceeded the configured memory budget.');
      const nodeBytes = process.memoryUsage().rss;
      peakNodeBytes = Math.max(peakNodeBytes, nodeBytes);
      if (nodeBytes > 512 * 1024 ** 2) throw new Error('Capture process exceeded 512 MiB. Export stopped before buffering more frames.');
    };
    async function capture(seconds) {
      await render(seconds);
      const image = await page.screenshot({ type: 'png', animations: 'disabled' });
      if (!firstFrameBytes) firstFrameBytes = image.byteLength;
      return image;
    }
    if (kind === 'video') {
      const audioPath = plan.audio ? resolve(plan.audio) : null;
      if (options.audio && !existsSync(audioPath)) throw new Error('The selected audio file was not found.');
      const audioArguments = audioPath && existsSync(audioPath) ? ['-ss', String(start), '-i', audioPath] : [];
      const codecArguments = encoderBackend === 'gpu' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '20'] : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2'];
      const encodingArguments = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'png', '-i', 'pipe:0', ...audioArguments, ...codecArguments, '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', ...(audioArguments.length ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []), output];
      encoder = spawn(ffmpeg, encodingArguments, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      encoder.stderr.on('data', (data) => { encoderError += data.toString(); });
      encoder.on('error', (error) => { encoderError += error.message; });
      encoder.stdin.on('error', (error) => { encoderError += error.message; });
      const finished = once(encoder, 'close');
      const frameCount = Math.ceil(duration * fps);
      for (let frame = 0; frame < frameCount; frame++) {
        const image = await capture(start + frame / fps);
        maximumPendingFrames = Math.max(maximumPendingFrames, 1);
        if (encoder.exitCode !== null) throw new Error(`Video encoder stopped: ${encoderError}`);
        if (!encoder.stdin.write(image)) await once(encoder.stdin, 'drain');
        if (frame % 48 === 0) {
          const { usedSize } = await session.send('Runtime.getHeapUsage');
          peakBrowserHeap = Math.max(peakBrowserHeap, usedSize);
          if (usedSize > 256 * 1024 ** 2) throw new Error('Browser JavaScript heap exceeded 256 MiB. Export stopped.');
          const message = `Rendered ${frame + 1}/${frameCount} frames`;
          console.log(message);
        }
      }
      encoder.stdin.end();
      const [exitCode] = await finished;
      if (exitCode !== 0) throw new Error(`Video encoding failed: ${encoderError}`);
    } else if (kind === 'stills') {
      const stillTimes = scene === 'film' && start === 0 && options.duration === undefined
        ? [2.5, 7.5, 11.5, 15, 18, 22, 25, 29.5]
        : Array.from({ length: 8 }, (_, index) => start + duration * (index + 0.5) / 8);
      for (const seconds of stillTimes) {
        const image = await capture(seconds);
        await writeFile(resolve(dirname(output), `frame-${seconds.toFixed(1)}.png`), image);
      }
    } else {
      await writeFile(output, await capture(time));
    }
    if (errors.length) throw new Error(`Browser render errors: ${errors.join('; ')}`);
    const graphics = await page.evaluate(() => {
      const renderer = window.__scene?.renderer ?? window.__film?.renderer ?? window.__nature?.renderer ?? window.__studio?.renderer;
      const context = renderer.context;
      const extension = context.getExtension('WEBGL_debug_renderer_info');
      return { gpu: extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable', samples: renderer.samples, glError: context.getError() };
    });
    if (graphics.glError !== 0) throw new Error(`WebGL render error ${graphics.glError}.`);
    if (backend === 'cpu' && !graphics.gpu.toLowerCase().includes('swiftshader')) throw new Error('CPU backend did not select SwiftShader.');
    const report = { scene, kind, backend, preset: presetName, aspect, start, encoder: kind === 'video' ? encoderBackend : null, assembly: scene === 'object' ? assembly : null, width, height, actualRenderSize, fps, duration: kind === 'video' ? duration : null, memoryBudgetMiB: memory, peakEstimatedRenderBytes, peakNodeBytes, peakBrowserHeap, maximumPendingFrames, firstFrameBytes, elapsedSeconds: (performance.now() - started) / 1000, graphics, output: basename(output), errors };
    await writeFile(`${output}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (encoder && encoder.exitCode === null) encoder.kill();
    await browser?.close();
    server.kill();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await renderMedia();
