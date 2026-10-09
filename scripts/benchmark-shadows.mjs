import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const variants = {
  before: execFileSync('git', ['show', `${process.argv[2] ?? '1d4f4d0'}:src/shaders.js`], { encoding: 'utf8', windowsHide: true }),
  after: await readFile('src/shaders.js', 'utf8'),
};
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const results = {};
try {
  for (const [name, source] of Object.entries(variants)) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('**/src/shaders.js*', route => route.fulfill({ contentType: 'application/javascript', body: source }));
    await page.route('**/shadow-benchmark.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:1280px;height:720px;display:block"></canvas>' }));
    await page.goto('http://127.0.0.1:5173/shadow-benchmark.html');
    results[name] = await page.evaluate(async () => {
      const { Renderer67 } = await import('/src/renderer.js');
      const { createFilmScenes, sampleFilm } = await import('/src/film.js');
      const scene = createFilmScenes().portrait;
      scene.animate(2.5);
      const renderer = new Renderer67(document.querySelector('canvas'), scene.parts, { world: true, ground: false, environment: scene.environment, shadowBounds: scene.shadowBounds, samples: 4, hdr: true, pixelRatio: 1, memoryBudgetMiB: 384 });
      const frame = { ...sampleFilm(162).camera, time: 2.5, effects: { grain: 0 } };
      const context = renderer.context;
      const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!timer) throw new Error('Native GPU timer unavailable');
      for (let index = 0; index < 10; index++) renderer.render(frame);
      const samples = [];
      for (let index = 0; index < 40; index++) {
        const query = context.createQuery();
        context.beginQuery(timer.TIME_ELAPSED_EXT, query);
        renderer.render(frame);
        context.endQuery(timer.TIME_ELAPSED_EXT);
        context.flush();
        const started = performance.now();
        while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
          if (performance.now() - started > 2000) throw new Error('GPU timer query timed out');
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        if (context.getParameter(timer.GPU_DISJOINT_EXT)) throw new Error('GPU timer disjoint');
        samples.push(context.getQueryParameter(query, context.QUERY_RESULT) / 1e6);
        context.deleteQuery(query);
      }
      const sorted = [...samples].sort((first, second) => first - second);
      const report = { medianMilliseconds: (sorted[19] + sorted[20]) / 2, p90Milliseconds: sorted[35], samples, glError: context.getError(), estimatedBytes: renderer.memoryPlan.estimatedBytes };
      renderer.dispose();
      return report;
    });
    await page.close();
  }
  await writeFile('artifacts/shadow-filter-benchmark.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { medianMilliseconds: result.medianMilliseconds, p90Milliseconds: result.p90Milliseconds, glError: result.glError, estimatedBytes: result.estimatedBytes }]))));
} finally {
  await browser.close();
}
