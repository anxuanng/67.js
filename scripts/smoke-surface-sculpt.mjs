import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/surface-sculpt-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/surface-sculpt-smoke.html');
  const report = await page.evaluate(async () => {
    const { Renderer67, sphere, fitPerspectiveDistance } = await import('/build/67.module.js');
    const { createSurfacePatch } = await import('/build/surface.js');
    const { sculptGeometry } = await import('/build/sculpt.js');
    const canvas = document.querySelector('canvas');
    const camera = { eye: [1.45, 0.55, 3.9], target: [0, 0, 0], fov: 35 };
    if (canvas.clientWidth < canvas.clientHeight) {
      const fitted = fitPerspectiveDistance({ minimum: [-1.35, -1.35, -1.35], maximum: [1.35, 1.35, 1.35] }, camera, canvas.clientWidth / canvas.clientHeight);
      const originalDistance = Math.hypot(...camera.eye);
      camera.eye = camera.eye.map(value => value * fitted / originalDistance);
    }
    const base = sphere(64, 40);
    const strokes = [
      { type: 'inflate', center: [-0.48, 0.3, 0.82], radius: 0.58, strength: 0.3 },
      { type: 'displace', center: [0.3, -0.25, 0.9], radius: 0.5, strength: -0.22, direction: [0, 0, 1] },
      { type: 'smooth', center: [0, 0, 1], radius: 1, strength: 0.2 },
    ];
    const started = performance.now();
    const sculpted = sculptGeometry(base, strokes);
    const sculptMilliseconds = performance.now() - started;
    const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const blue = { color: [0.015, 0.22, 0.34], metallic: 0.3, roughness: 0.3, emission: 0 };
    const orange = { color: [1, 0.18, 0.01], metallic: 0.05, roughness: 0.6, emission: 0 };
    const patchTarget = { geometry: base, material: blue };
    const patchStart = performance.now();
    const patch = createSurfacePatch(patchTarget, { position: [0, 0, 0.88], size: [1.1, 0.7, 0.5], clearance: 0.001 });
    const patchMilliseconds = performance.now() - patchStart;
    const flat = {
      positions: new Float32Array([-0.55, -0.35, 0.93, 0.55, -0.35, 0.93, 0.55, 0.35, 0.93, -0.55, 0.35, 0.93]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const cases = [
      { name: 'flat-penetration', base, patch: flat },
      { name: 'conforming-patch', base, patch },
      { name: 'sculpted', base: sculpted },
    ];
    const results = [];
    for (const entry of cases) {
      const matrix = identity();
      const parts = [{ name: 'Surface', geometry: entry.base, matrix, material: blue, castShadow: false }];
      if (entry.patch) parts.push({ name: 'Badge', geometry: entry.patch, matrix, material: orange, castShadow: false });
      const renderer = new Renderer67(canvas, parts, {
        world: true, ground: false, samples: 2, pixelRatio: 1, hdr: true, memoryBudgetMiB: 96,
        environment: { keyIntensity: 0.8, fillIntensity: 0.5, ambientIntensity: 0.4 },
      });
      function draw(time) {
        const angle = Math.sin(time) * 0.25;
        matrix[0] = Math.cos(angle);
        matrix[2] = -Math.sin(angle);
        matrix[8] = Math.sin(angle);
        matrix[10] = Math.cos(angle);
        renderer.updateParts(parts);
        renderer.render({ ...camera, time: 0,
          effects: { grain: 0, bloom: { strength: 0 } } });
        const context = renderer.context;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return { pixels, image: canvas.toDataURL('image/png'), error: context.getError() };
      }
      const original = draw(0.35);
      draw(2);
      const reverse = draw(0.35);
      const replayExact = original.pixels.every((value, index) => value === reverse.pixels[index]);
      let orangePixels = 0;
      for (let offset = 0; offset < original.pixels.length; offset += 4) {
        if (original.pixels[offset] > original.pixels[offset + 2] * 1.5 && original.pixels[offset] > 80) orangePixels++;
      }
      const context = renderer.context;
      const info = context.getExtension('WEBGL_debug_renderer_info');
      results.push({ name: entry.name, image: original.image, replayExact, retainedMatrix: parts.every(part => part.matrix === matrix),
        orangePixels, glError: reverse.error, originalGlError: original.error, memory: renderer.memoryPlan,
        gpu: info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unavailable' });
      renderer.dispose();
    }
    return { sourceVertices: base.positions.length / 3, sourceTriangles: base.indices.length / 3,
      patchVertices: patch.positions.length / 3, patchTriangles: patch.indices.length / 3,
      sculptMilliseconds, patchMilliseconds, results };
  });
  for (const result of report.results) {
    await writeFile(`artifacts/surface-${result.name}-${width}x${height}.png`, Buffer.from(result.image.split(',')[1], 'base64'));
    delete result.image;
    assert.equal(result.glError, 0);
    assert.equal(result.originalGlError, 0);
    assert.equal(result.replayExact, true);
    assert.equal(result.retainedMatrix, true);
  }
  assert.deepEqual(errors, []);
  assert.ok(report.results[1].orangePixels > report.results[0].orangePixels * 1.5, 'Conforming badge must cover its middle instead of disappearing inside the sphere.');
  await writeFile(`artifacts/surface-sculpt-${width}x${height}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
