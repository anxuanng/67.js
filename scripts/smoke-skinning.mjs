import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/skinning-smoke.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:640px;height:480px;display:block"></canvas>' }));
  await page.goto(`${base}/skinning-smoke.html`);
  const report = await page.evaluate(async () => {
    const { Renderer67 } = await import('/src/renderer.js');
    const { parseGltf } = await import('/src/gltf.js');
    const { skinnedStripAsset } = await import('/tests/fixtures/skinned-strip.js');
    const asset = await parseGltf(skinnedStripAsset());
    const canvas = document.querySelector('canvas');
    const renderer = new Renderer67(canvas, asset.parts, { samples: 4, pixelRatio: 1, memoryBudgetMiB: 96 });
    const palette = asset.parts[0].skin.jointMatrices;
    const record = renderer.skinTextures.get(asset.parts[0].skin);
    const influence = renderer.influenceTextures.get(asset.parts[0].geometry);
    const frame = { eye: [1, 3, 6], target: [1, 3, 0], fov: 40, time: 0, effects: { grain: 0 } };
    function sample(time) {
      asset.applyAnimation(time);
      renderer.updateParts(asset.parts);
      renderer.render(frame);
      const gl = renderer.context;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let checksum = 2166136261;
      for (const value of pixels) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
      return { checksum, palette: Array.from(palette), glError: gl.getError() };
    }
    const straight = sample(0);
    const bent = sample(2);
    const repeated = sample(0);
    let retained = true;
    for (let index = 0; index < 60; index++) {
      sample(index % 3);
      retained &&= asset.parts[0].skin.jointMatrices === palette && renderer.skinTextures.get(asset.parts[0].skin) === record && renderer.influenceTextures.get(asset.parts[0].geometry) === influence;
    }
    const memory = renderer.memoryPlan;
    const gpu = renderer.context.getParameter(renderer.context.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
    sample(2);
    const image = canvas.toDataURL('image/png');
    const gl = renderer.context;
    const texture = record.texture;
    const influenceTexture = influence.texture;
    renderer.dispose();
    const released = !gl.isTexture(texture) && !gl.isTexture(influenceTexture);
    asset.dispose();
    return { straight, bent, repeated, retained, released, memory, gpu, image };
  });
  assert.equal(report.straight.glError, 0);
  assert.equal(report.bent.glError, 0);
  assert.deepEqual(report.straight, report.repeated);
  assert.notEqual(report.straight.checksum, report.bent.checksum, 'GPU deformation did not change rendered pixels');
  assert.equal(report.retained, true);
  assert.equal(report.released, true);
  assert.deepEqual(errors, []);
  await writeFile('artifacts/skinning-gpu.png', Buffer.from(report.image.split(',')[1], 'base64'));
  delete report.image;
  await writeFile('artifacts/skinning-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
