import assert from 'node:assert/strict';
import test from 'node:test';

import { box, sphere } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { PATH_TRACER_JOB_LIMITS } from '../src/path-tracer-capabilities.js';
import {
  describeIgnoredFeatures, MAX_TRACE_PIXELS, normalizePathTracerOptions, PATH_TRACER_LIMITS, renderPathTracedImage, toneMapToRgba8,
} from '../src/path-tracer.js';
import { attachTracer, buildTraceScene } from '../src/path-tracer-scene.js';

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function surface(color, extra = {}) {
  return { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, color, ...extra };
}

const FLOOR_ALBEDO = 0.5;
const SUN_STRENGTH = 3;
const FLOOR_ONLY = [{ name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [40, 0.1, 40]), material: surface([FLOOR_ALBEDO, FLOOR_ALBEDO, FLOOR_ALBEDO], { roughness: 1 }) }];
const OVERHEAD_SUN = { keyColor: [SUN_STRENGTH, SUN_STRENGTH, SUN_STRENGTH], lightDirection: [0, 1, 0] };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const SMALL = { width: 32, height: 24, samples: 4, bounces: 3, threads: 1 };

function checkerScene() {
  return {
    parts: [
      ...FLOOR_ONLY,
      { name: 'ball', geometry: sphere(24, 16), matrix: placed([0, 0.6, 0], [0.6, 0.6, 0.6]), material: surface([0.8, 0.3, 0.2], { metallic: 0.5, clearcoat: 0.5 }) },
      { name: 'glass', geometry: sphere(24, 16), matrix: placed([1.2, 0.5, 0], [0.5, 0.5, 0.5]), material: surface([1, 1, 1], { transmission: 1, roughness: 0.05 }) },
    ],
    environment: {
      ...OVERHEAD_SUN,
      pointLights: [{ position: [0, 2, 1], color: [1, 1, 1], intensity: 4, radius: 0.1 }],
      map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.4) }),
    },
    camera: { eye: [0, 2, 5], target: [0, 0.5, 0], up: [0, 1, 0], fov: 40 },
  };
}

test('the job limits listed for agents match the limits the tracer enforces', () => {
  for (const name of ['samples', 'bounces', 'seed']) {
    assert.equal(PATH_TRACER_JOB_LIMITS[name].minimum, PATH_TRACER_LIMITS[name].minimum, name);
    assert.equal(PATH_TRACER_JOB_LIMITS[name].maximum, PATH_TRACER_LIMITS[name].maximum, name);
    assert.equal(PATH_TRACER_JOB_LIMITS[name].default, PATH_TRACER_LIMITS[name].fallback, name);
  }
  assert.ok(PATH_TRACER_JOB_LIMITS.maxSeconds.maximum <= PATH_TRACER_LIMITS.maxSeconds.maximum);
});

test('options are validated with their bounds', () => {
  assert.equal(normalizePathTracerOptions().samples, 64);
  assert.equal(normalizePathTracerOptions().width, 960);
  const refused = [
    { samples: 0 }, { samples: 1025 }, { samples: 1.5 }, { samples: Number.NaN }, { samples: '8' }, { bounces: 17 }, { bounces: 0 },
    { width: 4097 }, { width: 8 }, { height: -1 }, { seed: -1 }, { seed: 2 ** 31 }, { threads: 9 }, { threads: 0 },
    { maxSeconds: 0 }, { maxSeconds: 1801 }, { maxSeconds: Infinity }, { fireflyClamp: 0 }, { denoise: 'yes' },
    { width: 4096, height: 4096 },
    { width: 2000, height: 1000, samples: 1024, bounces: 16 },
  ];
  for (const options of refused) assert.throws(() => normalizePathTracerOptions(options), /Path tracer|too much|at most/, JSON.stringify(options));
  assert.throws(() => normalizePathTracerOptions(null), TypeError);
  assert.ok(MAX_TRACE_PIXELS >= 1920 * 1080);
});

test('hostile cameras and scenes are refused before any ray is traced', async () => {
  const { parts, environment } = checkerScene();
  const badCameras = [
    undefined,
    { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 40 },
    { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 0, 1], fov: 40 },
    { eye: [0, 0, Number.NaN], target: [0, 0, 0], up: [0, 1, 0], fov: 40 },
    { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 0 },
    { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 179 },
    { eye: [0, 0, 5, 1], target: [0, 0, 0], up: [0, 1, 0], fov: 40 },
  ];
  for (const camera of badCameras) await assert.rejects(renderPathTracedImage({ parts, environment, camera }, SMALL), /camera|Cannot read/i);
  const camera = checkerScene().camera;
  await assert.rejects(renderPathTracedImage({ parts: [], environment, camera }, SMALL), /1 to/);
  await assert.rejects(renderPathTracedImage({ parts: 'floor', environment, camera }, SMALL), /1 to/);
  const nonFinite = [{ ...parts[0], matrix: placed([Number.NaN, 0, 0], [1, 1, 1]) }];
  await assert.rejects(renderPathTracedImage({ parts: nonFinite, environment, camera }, SMALL), /finite/);
  const brokenIndices = [{ ...parts[0], geometry: { ...parts[0].geometry, indices: new Uint32Array([0, 1, 999999]) } }];
  await assert.rejects(renderPathTracedImage({ parts: brokenIndices, environment, camera }, SMALL), /index/i);
  const flooded = { ...environment, pointLights: Array.from({ length: 40 }, () => ({ position: [0, 2, 0], color: [1, 1, 1], intensity: 1 })) };
  await assert.rejects(renderPathTracedImage({ parts, environment: flooded, camera }, SMALL), /at most/);
});

test('the same scene and seed give the same bytes, and another seed does not', async () => {
  const first = await renderPathTracedImage(checkerScene(), SMALL);
  const second = await renderPathTracedImage(checkerScene(), SMALL);
  assert.deepEqual(first.rgba, second.rgba);
  assert.deepEqual(first.linear, second.linear);
  const other = await renderPathTracedImage(checkerScene(), { ...SMALL, seed: 7 });
  assert.notDeepEqual(first.rgba, other.rgba);
  assert.ok(first.linear.every(Number.isFinite));
  assert.equal(first.report.width, SMALL.width);
  assert.equal(first.report.threads, 1);
});

test('a floor lit by an overhead sun matches the diffuse closed form', async () => {
  const { linear } = await renderPathTracedImage(
    { parts: FLOOR_ONLY, environment: OVERHEAD_SUN, camera: LOOKING_DOWN },
    { width: 16, height: 16, samples: 32, bounces: 1, denoise: false, threads: 1 },
  );
  const centre = (8 * 16 + 8) * 3;
  // Radiance of a diffuse surface under irradiance E is albedo * E / pi, shrunk by the Fresnel share the specular lobe
  // takes (4 percent at normal incidence). That lobe adds F0 * D(0) / 4 * E, and a fully rough GGX has D(0) = 1 / pi.
  const expected = FLOOR_ALBEDO * (1 - 0.04) * SUN_STRENGTH / Math.PI + 0.04 / (4 * Math.PI) * SUN_STRENGTH;
  assert.ok(Math.abs(linear[centre] - expected) / expected < 0.05, `got ${linear[centre]}, expected near ${expected}`);
});

test('a block between the sun and the floor leaves a shadow', async () => {
  const blocker = { name: 'block', geometry: box(0, 1), matrix: placed([0, 1, 0], [2, 0.2, 2]), material: surface([0.5, 0.5, 0.5]) };
  // Sun from +x at 45 degrees: the block (x from -1 to 1, 1 m up) shades the floor from x = -2 to 0. Seen from above,
  // the floor at x = -1.5 is clear of the block's top and inside its shadow.
  const slantedSun = { keyColor: [3, 3, 3], lightDirection: [1, 1, 0] };
  const render = parts => renderPathTracedImage({ parts, environment: slantedSun, camera: { eye: [0, 8, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 } },
    { width: 16, height: 16, samples: 16, bounces: 1, denoise: false, threads: 1 });
  const lit = await render(FLOOR_ONLY);
  const shaded = await render([...FLOOR_ONLY, blocker]);
  const pixel = (8 * 16 + 2) * 3;
  assert.ok(lit.linear[pixel] > 0.2, `unshaded floor: ${lit.linear[pixel]}`);
  assert.ok(shaded.linear[pixel] < 0.01, `shaded floor: ${shaded.linear[pixel]}`);
});

test('a render that runs out of time throws and returns nothing', async () => {
  await assert.rejects(
    renderPathTracedImage(checkerScene(), { width: 256, height: 256, samples: 1024, bounces: 4, maxSeconds: 1, threads: 1 }),
    /1 second limit/,
  );
});

test('denoising keeps the mean of a noisy image and removes some of its noise', async () => {
  const scene = checkerScene();
  const options = { width: 48, height: 32, samples: 2, bounces: 3, threads: 1 };
  const noisy = await renderPathTracedImage(scene, { ...options, denoise: false });
  const clean = await renderPathTracedImage(scene, { ...options, denoise: true });
  const mean = buffer => buffer.reduce((sum, value) => sum + value, 0) / buffer.length;
  const roughness = buffer => {
    let total = 0;
    for (let index = 3; index < buffer.length; index++) total += Math.abs(buffer[index] - buffer[index - 3]);
    return total / buffer.length;
  };
  assert.ok(Math.abs(mean(clean.linear) - mean(noisy.linear)) / mean(noisy.linear) < 0.1);
  assert.ok(roughness(clean.linear) < roughness(noisy.linear));
  assert.ok(clean.linear.every(Number.isFinite));
});

test('the display transform matches the rasterizer post pass at known values', () => {
  const pixels = toneMapToRgba8(new Float32Array([0, 0, 0, 1, 1, 1]), 2, 1);
  assert.deepEqual([...pixels.slice(0, 4)], [0, 0, 0, 255]);
  // (1 * (2.51 + 0.03)) / (1 * (2.43 + 0.59) + 0.14) = 0.8038, then 0.8038 ^ (1 / 2.2) = 0.9055.
  assert.equal(pixels[4], Math.round(0.9055 * 255));
});

test('what the tracer does not draw is named in the report', () => {
  const notes = describeIgnoredFeatures(
    [{ material: { normalMap: {}, tag: 'liquid' } }, { material: { alphaMode: 'blend' } }],
    { volumeFog: { density: 1 } },
  );
  assert.ok(notes.some(note => note.includes('volumeFog')));
  assert.ok(notes.some(note => note.includes('normalMap')));
  assert.ok(notes.some(note => note.includes('liquid')));
  assert.ok(notes.some(note => note.includes('Blended')));
  assert.ok(notes.some(note => note.includes('environment map')));
});

test('a scene sent to a worker gets its ray query back from the arrays', () => {
  const { parts, environment } = checkerScene();
  const scene = buildTraceScene(parts, environment);
  const { tracer: _removed, ...sent } = scene;
  const revived = attachTracer(structuredClone(sent));
  const hit = revived.tracer.trace(0, 5, 0, 0, -1, 0, 100, false);
  assert.ok(hit.nearestTriangle >= 0);
});
