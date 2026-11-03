// Times a lit frame of a large sea with dense terrain and many small parts, with the water reflection off and on, and counts
// what the mirror pass draws. GPU time comes from a native timer query, so run it through the GPU lock:
//   bash ~/.agents/tools/gpu-lock.sh node scripts/benchmark-water-reflection.mjs [--width 1920] [--height 1080] [--parts 20000]
// The draw counts (calls, instances, triangles in the mirror pass) do not need the GPU and stay valid when the lock is busy.
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const argument = (name, fallback) => {
  const position = process.argv.indexOf(`--${name}`);
  return position === -1 ? fallback : Number(process.argv[position + 1]);
};
const width = argument('width', 1920);
const height = argument('height', 1080);
const smallPartCount = argument('parts', 20000);
const SAMPLES = argument('samples', 20);

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('**/water-benchmark.html', route => route.fulfill({ contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>` }));
  await page.goto(`${serverUrl}/water-benchmark.html`);
  const results = await page.evaluate(async ({ smallPartCount, samples }) => {
    const { Renderer67 } = await import('/src/renderer.js');
    const { box } = await import('/src/geometry.js');
    const { createTerrain } = await import('/src/terrain.js');
    const { applyWaterReflection, attachWaterReflection } = await import('/src/water-reflection.js');
    const canvas = document.querySelector('canvas');

    const terrain = createTerrain({ size: 900, resolution: 128, chunks: 8, levels: 1, height: (x, z) => 22 * Math.sin(x * 0.009) * Math.cos(z * 0.011) + 9 * Math.sin(x * 0.03 + z * 0.02) - 4 });
    const pebble = box(0.05, 2);
    let seed = 12345;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const smallParts = [];
    for (let index = 0; index < smallPartCount; index++) {
      const x = (random() - 0.5) * 850;
      const z = (random() - 0.5) * 850;
      const size = 0.4 + random() * 1.2;
      const y = terrain.heightAt(x, z) + size / 2;
      smallParts.push({ name: `pebble-${index}`, geometry: pebble, matrix: new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, x, y, z, 1]), material: { tag: 'surface', color: [0.4, 0.38, 0.34], metallic: 0, roughness: 0.8, emission: 0 } });
    }
    const sea = { name: 'sea', geometry: box(0, 1), matrix: new Float32Array([4000, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4000, 0, 0, -0.5, 0, 1]), material: { tag: 'surface', color: [0.02, 0.06, 0.1], metallic: 0, roughness: 0.04, emission: 0 } };
    const marked = applyWaterReflection([...terrain.parts, ...smallParts, sea]);
    const renderer = new Renderer67(canvas, marked.parts, { hdr: true, depth: true, world: true, ground: false, pixelRatio: 1, samples: 4 });
    const context = renderer.context;
    const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!timer) throw new Error('Native GPU timer unavailable');

    // Draw counts per phase: the prototype wrapper sees both the lit frame and the mirror frame.
    const phases = { main: { calls: 0, instances: 0, triangles: 0 }, mirror: { calls: 0, instances: 0, triangles: 0 } };
    let phase = 'main';
    const originalDraw = context.drawElementsInstanced.bind(context);
    context.drawElementsInstanced = (mode, count, type, offset, instances) => {
      const tally = phases[phase];
      tally.calls++;
      tally.instances += instances;
      tally.triangles += (count / 3) * instances;
      originalDraw(mode, count, type, offset, instances);
    };
    const prototypeRender = Renderer67.prototype.render;
    Renderer67.prototype.render = function (frame) {
      const previous = phase;
      phase = frame.reflectionTarget ? 'mirror' : 'main';
      try {
        return prototypeRender.call(this, frame);
      } finally {
        phase = previous;
      }
    };

    const frame = { eye: [0, 70, 380], target: [0, 0, 0], time: 1 };
    async function measure(label, reflect, options = {}) {
      const detachNow = reflect ? attachWaterReflection(renderer, marked.surface, options) : () => {};
      for (const tally of Object.values(phases)) Object.assign(tally, { calls: 0, instances: 0, triangles: 0 });
      for (let index = 0; index < 4; index++) renderer.render({ ...frame, time: 1 + index * 0.001 });
      const timings = [];
      for (let index = 0; index < samples; index++) {
        for (const tally of Object.values(phases)) Object.assign(tally, { calls: 0, instances: 0, triangles: 0 });
        const query = context.createQuery();
        context.beginQuery(timer.TIME_ELAPSED_EXT, query);
        // The camera moves a little each frame, so the mirror image is redrawn, as in a film.
        renderer.render({ ...frame, eye: [index * 0.2, 70, 380], time: 1 + index * 0.01 });
        context.endQuery(timer.TIME_ELAPSED_EXT);
        context.flush();
        const started = performance.now();
        while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
          if (performance.now() - started > 5000) throw new Error('GPU query timed out');
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        if (context.getParameter(timer.GPU_DISJOINT_EXT)) throw new Error('Disjoint GPU timer');
        timings.push(context.getQueryParameter(query, context.QUERY_RESULT) / 1e6);
        context.deleteQuery(query);
      }
      timings.sort((first, second) => first - second);
      const output = { label, medianMilliseconds: timings[Math.floor(timings.length / 2)], minimumMilliseconds: timings[0], maximumMilliseconds: timings[timings.length - 1], mirrorDraw: { ...phases.mirror }, mainDraw: { ...phases.main }, glError: context.getError() };
      detachNow();
      return output;
    }
    const report = { canvas: [canvas.width, canvas.height], terrainVertices: terrain.parts.reduce((sum, part) => sum + part.geometry.positions.length / 3, 0), smallParts: smallPartCount };
    report.reflectionOff = await measure('off', false);
    report.reflectionOn = await measure('on', true);
    return report;
  }, { smallPartCount, samples: SAMPLES });
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await server.close();
}
