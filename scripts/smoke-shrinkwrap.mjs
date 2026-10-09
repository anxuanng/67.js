import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/shrinkwrap-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/shrinkwrap-smoke.html');
  const report = await page.evaluate(async () => {
    const { Renderer67, sphere, fitPerspectiveDistance, createMorphPose } = await import('/build/67.module.js');
    const { shrinkwrapGeometry } = await import('/build/shrinkwrap.js');
    const { createMeshQueryIndex, createMeshPairQuery } = await import('/build/mesh-query.js');
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const columns = 48;
    const rows = 32;
    for (let row = 0; row <= rows; row++) {
      for (let column = 0; column <= columns; column++) {
        positions.push((column / columns - 0.5) * 1.4, (row / rows - 0.5) * 0.9, 1.4);
        normals.push(0, 0, 1);
        uvs.push(column / columns, row / rows);
      }
    }
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const first = row * (columns + 1) + column;
        indices.push(first, first + 1, first + columns + 2, first, first + columns + 2, first + columns + 1);
      }
    }
    const source = { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
    const target = sphere(128, 80);
    const queryMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const targetIndex = createMeshQueryIndex(target);
    const sourceBefore = source.positions.slice();
    const cases = [{ name: 'before', geometry: source, stats: null }];
    for (const mode of ['nearest', 'project']) {
      const started = performance.now();
      const result = shrinkwrapGeometry(source, target, { mode, ...(mode === 'project' ? { direction: [0, 0, -1] } : {}), clearance: 0.003, maxDistance: 2 });
      const milliseconds = performance.now() - started;
      const wrappedIndex = createMeshQueryIndex(result.geometry);
      const surfaceRelation = createMeshPairQuery(targetIndex, wrappedIndex).evaluate(queryMatrix, queryMatrix);
      wrappedIndex.dispose();
      cases.push({ name: mode, ...result, milliseconds, surfaceRelation });
    }
    targetIndex.dispose();
    const projected = cases.find(entry => entry.name === 'project').geometry;
    const morph = createMorphPose(1);
    morph.weights[0] = 1;
    cases.push({ name: 'project-morph', stats: null, morph, geometry: {
      ...source,
      morphTargets: [{
        positions: Float32Array.from(source.positions, (value, index) => projected.positions[index] - value),
        normals: Float32Array.from(source.normals, (value, index) => projected.normals[index] - value),
      }],
    } });
    const canvas = document.querySelector('canvas');
    const camera = { eye: [2.6, 0.6, 3.8], target: [0, 0, 0.25], fov: 35 };
    const fitted = fitPerspectiveDistance({ minimum: [-1.2, -1.2, -1.2], maximum: [1.2, 1.2, 1.5] }, camera, canvas.clientWidth / canvas.clientHeight);
    const distance = Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis]));
    camera.eye = camera.eye.map((value, axis) => camera.target[axis] + (value - camera.target[axis]) * fitted / distance);
    const results = [];
    let projectedPixels;
    let gpu;
    for (const entry of cases) {
      const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const parts = [
        { name: 'Target', geometry: target, matrix, material: { color: [0.015, 0.22, 0.34], metallic: 0.3, roughness: 0.3, emission: 0 }, castShadow: false },
        { name: 'Wrap', geometry: entry.geometry, matrix, ...(entry.morph ? { morph: entry.morph } : {}),
          material: { color: [1, 0.18, 0.01], metallic: 0.05, roughness: 0.45, emission: 0 }, castShadow: false },
      ];
      const renderer = new Renderer67(canvas, parts, {
        world: true, ground: false, samples: 2, pixelRatio: 1, hdr: true, memoryBudgetMiB: 96,
        environment: { keyIntensity: 0.8, fillIntensity: 0.5, ambientIntensity: 0.4 },
      });
      function draw(time, morphWeight = time === 2 ? 0 : 1) {
        if (entry.morph) entry.morph.weights[0] = morphWeight;
        const angle = Math.sin(time) * 0.2;
        matrix[0] = Math.cos(angle);
        matrix[2] = -Math.sin(angle);
        matrix[8] = Math.sin(angle);
        matrix[10] = Math.cos(angle);
        renderer.updateParts(parts);
        renderer.render({ ...camera, time: 0, effects: { grain: 0, bloom: { strength: 0 } } });
        const context = renderer.context;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
        return { pixels, image: canvas.toDataURL('image/png'), glError: context.getError() };
      }
      const original = draw(0.4);
      const rendererInfo = renderer.context.getExtension('WEBGL_debug_renderer_info');
      gpu = rendererInfo ? renderer.context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : 'unavailable';
      if (entry.name === 'project') projectedPixels = original.pixels;
      let control;
      let morphChangedChannels;
      let morphEndpointDifference;
      if (entry.morph) {
        control = draw(0.4, 0);
        morphChangedChannels = original.pixels.reduce((total, value, index) => total + Number(value !== control.pixels[index]), 0);
        morphEndpointDifference = original.pixels.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - projectedPixels[index])), 0);
      }
      draw(2);
      const reverse = draw(0.4);
      let orangePixels = 0;
      for (let offset = 0; offset < original.pixels.length; offset += 4) {
        if (original.pixels[offset] > 80 && original.pixels[offset] > original.pixels[offset + 2] * 1.5) orangePixels++;
      }
      results.push({ name: entry.name, image: original.image, stats: entry.stats, milliseconds: entry.milliseconds,
        surfaceRelation: entry.surfaceRelation,
        replayExact: original.pixels.every((value, index) => value === reverse.pixels[index]),
        retainedMatrix: parts.every(part => part.matrix === matrix), glError: original.glError, reverseGlError: reverse.glError,
        retainedMorph: !entry.morph || parts[1].morph === entry.morph,
        controlImage: control?.image, morphChangedChannels, morphEndpointDifference,
        orangePixels, memory: renderer.memoryPlan });
      renderer.dispose();
    }
    return { vertices: source.positions.length / 3, triangles: source.indices.length / 3,
      targetVertices: target.positions.length / 3, targetTriangles: target.indices.length / 3,
      sourceUnchanged: source.positions.every((value, index) => value === sourceBefore[index]), gpu, results };
  });
  for (const result of report.results) {
    await writeFile(`artifacts/shrinkwrap-${result.name}-${width}x${height}.png`, Buffer.from(result.image.split(',')[1], 'base64'));
    delete result.image;
    if (result.controlImage) {
      await writeFile(`artifacts/shrinkwrap-${result.name}-start-${width}x${height}.png`, Buffer.from(result.controlImage.split(',')[1], 'base64'));
      delete result.controlImage;
      assert.ok(result.morphChangedChannels > 100);
      assert.ok(result.morphEndpointDifference <= 6);
    }
    assert.equal(result.glError, 0);
    assert.equal(result.reverseGlError, 0);
    assert.equal(result.replayExact, true);
    assert.equal(result.retainedMatrix, true);
    assert.equal(result.retainedMorph, true);
    assert.ok(result.orangePixels > 100);
    if (result.stats) assert.equal(result.stats.missedVertices, 0);
    if (result.surfaceRelation) assert.equal(result.surfaceRelation.kind, 'surface-disjoint');
  }
  await writeFile(`artifacts/shrinkwrap-${width}x${height}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.sourceUnchanged, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
