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
  await page.route('**/mesh-query-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/mesh-query-smoke.html');
  const report = await page.evaluate(async () => {
    const { Renderer67, box, cylinder, createAnimationClip, createAnimationPlayer, fitPerspectiveDistance } = await import('/build/67.module.js');
    const { createMeshQueryIndex, createMeshPairQuery } = await import('/build/mesh-query.js');
    const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const geometry = box(0);
    const firstIndex = createMeshQueryIndex(geometry, { solid: true });
    const secondIndex = createMeshQueryIndex(geometry, { solid: true });
    const query = createMeshPairQuery(firstIndex, secondIndex, { mode: 'closed-solids' });
    const outerMatrix = identity();
    outerMatrix[0] = outerMatrix[5] = outerMatrix[10] = 4;
    const inner = { name: 'Inner', geometry, matrix: identity(), material: { color: [0.03, 0.5, 0.28], metallic: 0.15, roughness: 0.3, emission: 0 }, castShadow: false };
    const retainedMatrix = inner.matrix;
    const parts = [inner];
    const beam = cylinder(12, 0, 1);
    for (let axis = 0; axis < 3; axis++) {
      for (const firstSide of [-2, 2]) {
        for (const secondSide of [-2, 2]) {
          const matrix = identity();
          const radius = 0.035;
          if (axis === 0) matrix.set([0, -radius, 0, 0, 4, 0, 0, 0, 0, 0, radius, 0, 0, firstSide, secondSide, 1]);
          if (axis === 1) matrix.set([radius, 0, 0, 0, 0, 4, 0, 0, 0, 0, radius, 0, firstSide, 0, secondSide, 1]);
          if (axis === 2) matrix.set([radius, 0, 0, 0, 0, 0, 4, 0, 0, -radius, 0, 0, firstSide, secondSide, 0, 1]);
          parts.push({ name: `Boundary ${axis} ${firstSide} ${secondSide}`, geometry: beam, matrix,
            material: { color: [0.06, 0.15, 0.23], metallic: 0.3, roughness: 0.35, emission: 0 }, castShadow: false });
        }
      }
    }
    const player = createAnimationPlayer(createAnimationClip({ duration: 2, tracks: [{
      target: 'Inner', property: 'translation', keyframes: [
        { time: 0, value: [0, 0, 0] }, { time: 1, value: [2, 0, 0] }, { time: 2, value: [4.5, 0, 0] },
      ],
    }] }), parts);
    const canvas = document.querySelector('canvas');
    const camera = { eye: [7, 5, 10], target: [1.25, 0, 0], fov: 44 };
    const fitted = fitPerspectiveDistance({ minimum: [-2.1, -2.1, -2.1], maximum: [5.1, 2.1, 2.1] }, camera, canvas.clientWidth / canvas.clientHeight);
    const originalDistance = Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis]));
    camera.eye = camera.eye.map((value, axis) => camera.target[axis] + (value - camera.target[axis]) * fitted / originalDistance);
    const renderer = new Renderer67(canvas, parts, {
      world: true, ground: false, samples: 2, pixelRatio: 1, hdr: true, memoryBudgetMiB: 96,
      environment: { keyIntensity: 0.8, fillIntensity: 0.5, ambientIntensity: 0.4 },
    });
    function draw(time) {
      player.apply(time);
      const result = query.evaluate(outerMatrix, inner.matrix);
      inner.material.color = time === 0 ? [0.03, 0.5, 0.28] : time === 1 ? [1, 0.3, 0.02] : [0.13, 0.3, 0.85];
      renderer.updateParts(parts);
      renderer.render({ ...camera, time: 0, effects: { grain: 0, bloom: { strength: 0 } } });
      const context = renderer.context;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      return { time, result, pixels, image: canvas.toDataURL('image/png'), glError: context.getError() };
    }
    const results = [draw(0), draw(1), draw(2)];
    const reverse = draw(0);
    const replayExact = results[0].pixels.every((value, index) => value === reverse.pixels[index]);
    const rayHit = firstIndex.raycast(outerMatrix, { origin: [0.2, 0.3, 6], direction: [0, 0, -1], maxDistance: 10 });
    const context = renderer.context;
    const info = context.getExtension('WEBGL_debug_renderer_info');
    const gpu = info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unavailable';
    renderer.dispose();
    firstIndex.dispose();
    secondIndex.dispose();
    return { results: results.map(({ pixels, ...result }) => result), replayExact,
      retainedMatrix: inner.matrix === retainedMatrix, rayHit, gpu, reverseGlError: reverse.glError };
  });
  for (const result of report.results) {
    await writeFile(`artifacts/mesh-query-${result.time}-${width}x${height}.png`, Buffer.from(result.image.split(',')[1], 'base64'));
    delete result.image;
    assert.equal(result.glError, 0);
  }
  await writeFile(`artifacts/mesh-query-${width}x${height}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(report.replayExact, true);
  assert.equal(report.retainedMatrix, true);
  assert.equal(report.reverseGlError, 0);
  assert.equal(report.results[0].result.kind, 'contained');
  assert.equal(report.results[1].result.kind, 'surface-intersection');
  assert.equal(report.results[2].result.kind, 'separate');
  assert.ok(Math.abs(report.rayHit.distance - 4) < 1e-6);
} finally {
  await browser.close();
}
