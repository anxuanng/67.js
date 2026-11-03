import assert from 'node:assert/strict';
import test from 'node:test';

import { box, sphere } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { PATH_TRACER_CAPABILITIES } from '../src/path-tracer-capabilities.js';
import { createRandomWalk, resolveTraceSubsurface, singleScatterAlbedo, SUBSURFACE_WALK_STEPS, WALK_OUTCOME } from '../src/path-tracer-subsurface.js';

const IMAGE = { width: 24, height: 24, samples: 16, bounces: 4, denoise: false, threads: 1 };
const CAMERA = { eye: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 30 };

function placed(scale) {
  return new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
}

function ballScene(materialExtra) {
  return {
    parts: [{ name: 'ball', geometry: sphere(24, 16), matrix: placed(0.6), material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [1, 1, 1], ...materialExtra } }],
    environment: { map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(1) }) },
    camera: CAMERA,
  };
}

function meanRadiance(linear) {
  let sum = 0;
  for (const value of linear) sum += value;
  return sum / linear.length;
}

test('a weight of 0 or no block at all draws exactly the same pixels', async () => {
  const plain = await renderPathTracedImage(ballScene({ color: [0.7, 0.4, 0.3] }), IMAGE);
  const off = await renderPathTracedImage(ballScene({ color: [0.7, 0.4, 0.3], subsurface: { weight: 0, radius: [1, 0.2, 0.1], scale: 0.05 } }), IMAGE);
  assert.deepEqual(off.linear, plain.linear);
  assert.equal(resolveTraceSubsurface({ weight: 0 }), null);
  const on = await renderPathTracedImage(ballScene({ color: [0.7, 0.4, 0.3], subsurface: { weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 } }), IMAGE);
  assert.notDeepEqual(on.linear, plain.linear);
});

test('a walk that never reaches a surface stops after the step cap', () => {
  let queries = 0;
  const part = {};
  const walk = createRandomWalk({ surfaceOffset: 1e-5 }, { next: Math.random }, (scene, x, y, z, dx, dy, dz, hit) => {
    queries++;
    hit.material = part;
    hit.distance = 1e9;
    return true;
  });
  const subsurface = resolveTraceSubsurface({ weight: 1, radius: [1, 1, 1], scale: 0.01 });
  const exitHit = { material: null, distance: 0 };
  const outcome = walk(subsurface, [1, 1, 1], 0, 0, 0, [0, 0, 1], part, exitHit, new Float64Array(3).fill(1));
  assert.equal(outcome, WALK_OUTCOME.lost);
  assert.equal(queries, SUBSURFACE_WALK_STEPS + 1);
});

test('a card with nothing of its own behind the point is walked as thin', () => {
  const walk = createRandomWalk({ surfaceOffset: 1e-5 }, { next: Math.random }, () => false);
  const subsurface = resolveTraceSubsurface({ weight: 1, radius: [1, 1, 1], scale: 0.01 });
  const outcome = walk(subsurface, [1, 1, 1], 0, 0, 0, [0, 0, 1], {}, { material: null }, new Float64Array(3).fill(1));
  assert.equal(outcome, WALK_OUTCOME.thin);
});

test('the single scattering albedo maps 0 to 0 and 1 to 1 and grows between', () => {
  assert.ok(singleScatterAlbedo(0) < 1e-4);
  assert.ok(Math.abs(singleScatterAlbedo(1) - 1) < 1e-4);
  assert.ok(singleScatterAlbedo(0.5) > 0.5 && singleScatterAlbedo(0.5) < 1);
});

test('a white part under a uniform sky never returns more light than arrives', async () => {
  const sky = 1;
  const on = await renderPathTracedImage(ballScene({ subsurface: { weight: 1, radius: [1, 1, 1], scale: 0.05 } }), { ...IMAGE, samples: 32 });
  const off = await renderPathTracedImage(ballScene({}), { ...IMAGE, samples: 32 });
  assert.ok(on.linear.every(Number.isFinite));
  assert.ok(meanRadiance(on.linear) <= sky * 1.02, `mean ${meanRadiance(on.linear)}`);
  assert.ok(meanRadiance(on.linear) >= meanRadiance(off.linear) * 0.8, 'but most of the light still comes back');
});

test('a thin slab lit from behind glows with subsurface and stays dark without', async () => {
  const slab = materialExtra => ({
    parts: [{ name: 'slab', geometry: box(0, 1), matrix: new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1]), material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.2, 0.6, 0.1], ...materialExtra } }],
    environment: { keyColor: [4, 4, 4], lightDirection: [0, 0, -1] },
    camera: CAMERA,
  });
  const on = await renderPathTracedImage(slab({ subsurface: { weight: 1, radius: [1, 1, 1], scale: 0.01 } }), IMAGE);
  const off = await renderPathTracedImage(slab({}), IMAGE);
  assert.ok(meanRadiance(on.linear) > meanRadiance(off.linear) * 5, `${meanRadiance(on.linear)} against ${meanRadiance(off.linear)}`);
});

test('the capability list names subsurface as traced', () => {
  assert.match(PATH_TRACER_CAPABILITIES.traces, /subsurface/);
  assert.doesNotMatch(PATH_TRACER_CAPABILITIES.skips, /translucent leaves/);
});
