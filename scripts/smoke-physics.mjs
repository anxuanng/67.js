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
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/physics-smoke.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:720px;display:block"></canvas>' }));
  await page.goto(`${base}/physics-smoke.html`);
  const report = await page.evaluate(async () => {
    const { Renderer67 } = await import('/src/renderer.js');
    const { box, sphere } = await import('/src/geometry.js');
    const { createPhysicsScene } = await import('/src/physics.js');
    const { mat4 } = await import('/node_modules/gl-matrix/esm/index.js');
    const bodies = [
      { name: 'floor', type: 'fixed', translation: [0, -0.25, 0] },
      { name: 'torso', translation: [0, 2.95, 0] },
      { name: 'pelvis', translation: [0, 2.35, 0] },
      { name: 'head', translation: [0, 3.65, 0] },
    ];
    const colliders = [
      { name: 'floor', body: 'floor', shape: 'cuboid', halfExtents: [4, 0.25, 4] },
      { name: 'torso', body: 'torso', shape: 'cuboid', halfExtents: [0.3, 0.45, 0.16], mass: 4 },
      { name: 'pelvis', body: 'pelvis', shape: 'cuboid', halfExtents: [0.26, 0.18, 0.16], mass: 3 },
      { name: 'head', body: 'head', shape: 'ball', radius: 0.23, mass: 1 },
    ];
    const joints = [
      { name: 'spine', type: 'spherical', bodyA: 'torso', bodyB: 'pelvis', anchorA: [0, -0.45, 0], anchorB: [0, 0.15, 0] },
      { name: 'neck', type: 'spherical', bodyA: 'torso', bodyB: 'head', anchorA: [0, 0.47, 0], anchorB: [0, -0.23, 0] },
    ];
    for (const side of [-1, 1]) {
      const limbDefinitions = [
        [`upperArm${side}`, [side * 0.48, 3, 0], 0.1, 0.25, 1],
        [`forearm${side}`, [side * 0.48, 2.35, 0], 0.1, 0.25, 1],
        [`thigh${side}`, [side * 0.18, 1.85, 0], 0.13, 0.3, 2],
        [`shin${side}`, [side * 0.18, 1.05, 0], 0.13, 0.3, 2],
      ];
      for (const [name, translation, radius, halfHeight, mass] of limbDefinitions) {
        bodies.push({ name, translation });
        colliders.push({ name, body: name, shape: 'capsule', radius, halfHeight, mass });
      }
      joints.push(
        { name: `shoulder${side}`, type: 'spherical', bodyA: 'torso', bodyB: `upperArm${side}`, anchorA: [side * 0.35, 0.3, 0], anchorB: [-side * 0.13, 0.25, 0] },
        { name: `elbow${side}`, type: 'revolute', bodyA: `upperArm${side}`, bodyB: `forearm${side}`, anchorA: [0, -0.35, 0], anchorB: [0, 0.3, 0], axis: [1, 0, 0] },
        { name: `hip${side}`, type: 'spherical', bodyA: 'pelvis', bodyB: `thigh${side}`, anchorA: [side * 0.18, -0.1, 0], anchorB: [0, 0.4, 0] },
        { name: `knee${side}`, type: 'revolute', bodyA: `thigh${side}`, bodyB: `shin${side}`, anchorA: [0, -0.4, 0], anchorB: [0, 0.4, 0], axis: [1, 0, 0] },
      );
    }
    const bakeStarted = performance.now();
    const physics = await createPhysicsScene({ bodies, colliders, joints, events: [{ tick: 0, body: 'torso', impulse: [1.2, 0, 0.4], torqueImpulse: [0.3, 0.2, 0.6] }] }, { frameCount: 241, solverIterations: 16, maxMemoryBytes: 32 * 1024 * 1024 });
    const bakeMilliseconds = performance.now() - bakeStarted;
    const meshes = { box: box(0.025, 2), sphere: sphere(32, 20) };
    const parts = colliders.map(collider => {
      const dimensions = collider.halfExtents?.map(value => value * 2) ?? [collider.radius, collider.radius + (collider.halfHeight ?? 0), collider.radius];
      return { name: collider.name, geometry: collider.shape === 'cuboid' ? meshes.box : meshes.sphere, matrix: mat4.fromScaling(mat4.create(), dimensions), material: { color: collider.name === 'floor' ? [0.12, 0.14, 0.16] : collider.name === 'head' ? [0.6, 0.35, 0.2] : [0.09, 0.32, 0.38], metallic: 0.1, roughness: 0.55 } };
    });
    const binding = physics.bindParts(parts.map(part => ({ body: part.name, part })));
    const matrices = parts.map(part => part.matrix);
    const canvas = document.querySelector('canvas');
    const renderer = new Renderer67(canvas, parts, { ground: false, samples: 4, hdr: true, pixelRatio: 1, memoryBudgetMiB: 128, shadowBounds: { extent: 5, eye: [-3, 6, 4], target: [0, 1, 0], near: 0.1, far: 20 } });
    const frame = { eye: [5, 3.8, 7], target: [0, 1.6, 0], fov: 42, time: 0, effects: { grain: 0 } };
    function render(time) {
      binding.apply(time);
      renderer.updateParts(parts);
      renderer.render(frame);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      renderer.context.readPixels(0, 0, canvas.width, canvas.height, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixels);
      let checksum = 2166136261;
      for (const value of pixels) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
      return { checksum, glError: renderer.context.getError(), pose: Array.from(physics.sample(time)) };
    }
    const upright = render(0);
    const uprightImage = canvas.toDataURL('image/png');
    const fallen = render(3);
    const fallenImage = canvas.toDataURL('image/png');
    const repeated = render(0);
    const retained = parts.every((part, index) => part.matrix === matrices[index]);
    const memory = renderer.memoryPlan;
    const physicsMemory = physics.memoryPlan;
    renderer.dispose();
    physics.dispose();
    return { upright, fallen, repeated, retained, disposed: physics.disposed, memory, physicsMemory, bakeMilliseconds, uprightImage, fallenImage };
  });
  assert.deepEqual(errors, []);
  assert.equal(report.upright.glError, 0);
  assert.equal(report.fallen.glError, 0);
  assert.deepEqual(report.upright, report.repeated);
  assert.notEqual(report.upright.checksum, report.fallen.checksum);
  assert.equal(report.retained, true);
  assert.equal(report.disposed, true);
  for (const state of ['upright', 'fallen']) {
    await writeFile(`artifacts/physics-${state}.png`, Buffer.from(report[`${state}Image`].split(',')[1], 'base64'));
    delete report[`${state}Image`];
  }
  await writeFile('artifacts/physics-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
