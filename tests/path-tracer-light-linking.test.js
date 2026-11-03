import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { box, sphere } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { SUN_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, AREA_FIRST_BIT } from '../src/light-link-bits.js';
import { describeIgnoredFeatures, renderPathTracedImage } from '../src/path-tracer.js';

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function surface(color, extra = {}) {
  return { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, color, ...extra };
}

const EVERY_BIT = -1;
const without = (...bits) => bits.reduce((mask, bit) => mask & ~(1 << bit), EVERY_BIT);

// A scene with no linking at all. Its pixels were hashed on the code before the path tracer read light masks, so a
// change that shifts an unlinked scene shows up here.
function unlinkedScene(extraMaterial = {}) {
  return {
    parts: [
      { name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [40, 0.1, 40]), material: surface([0.5, 0.5, 0.5], { roughness: 1, ...extraMaterial }) },
      { name: 'ball', geometry: sphere(24, 16), matrix: placed([0, 0.6, 0], [0.6, 0.6, 0.6]), material: surface([0.8, 0.3, 0.2], { metallic: 0.5, clearcoat: 0.5, ...extraMaterial }) },
    ],
    environment: {
      keyColor: [3, 3, 3],
      lightDirection: [0, 1, 0],
      pointLights: [{ position: [0, 2, 1], color: [1, 1, 1], intensity: 4, radius: 0.1 }],
      map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.4) }),
    },
    camera: { eye: [0, 2, 5], target: [0, 0.5, 0], up: [0, 1, 0], fov: 40 },
  };
}

const SMALL = { width: 32, height: 24, samples: 4, bounces: 3, threads: 1 };

test('a scene without links keeps the pixels it had before linking was traced', async () => {
  const image = await renderPathTracedImage(unlinkedScene(), SMALL);
  assert.equal(createHash('sha256').update(image.rgba).digest('hex'), '796f20c1155f33e4b9e235b02a95a965a99251b360c1062b18384e0c8b5693fc');
});

test('a mask that lets every light through gives the pixels of no mask', async () => {
  const plain = await renderPathTracedImage(unlinkedScene(), SMALL);
  const masked = await renderPathTracedImage(unlinkedScene({ lightMask: EVERY_BIT }), SMALL);
  assert.deepEqual(masked.rgba, plain.rgba);
});

// Two floors far apart, so light bounced from one never reaches the other. The camera looks straight down at one.
function twoFloors(rightMask, environment) {
  const floor = (name, x, extra) => ({ name, geometry: box(0, 1), matrix: placed([x, -0.05, 0], [10, 0.1, 10]), material: surface([0.5, 0.5, 0.5], { roughness: 1, ...extra }) });
  return { parts: [floor('left', -100, {}), floor('right', 100, { lightMask: rightMask })], environment };
}

async function centreOf(parts, environment, x) {
  const camera = { eye: [x, 3, 0], target: [x, 0, 0], up: [0, 0, -1], fov: 40 };
  const { linear } = await renderPathTracedImage({ parts, environment, camera }, { width: 16, height: 16, samples: 16, bounces: 2, denoise: false, threads: 1 });
  const centre = (8 * 16 + 8) * 3;
  return linear[centre] + linear[centre + 1] + linear[centre + 2];
}

test('the sun adds nothing at a part whose mask skips it', async () => {
  const environment = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
  const { parts } = twoFloors(without(SUN_BIT), environment);
  assert.ok(await centreOf(parts, environment, -100) > 0.1);
  assert.equal(await centreOf(parts, environment, 100), 0);
});

test('a point light adds nothing at a part whose mask skips it, and the other light still does', async () => {
  const environment = {
    pointLights: [
      { position: [100, 2, 0], color: [1, 1, 1], intensity: 6, radius: 0 },
      { position: [100, 3, 0], color: [1, 1, 1], intensity: 6, radius: 0 },
    ],
  };
  const both = await centreOf(twoFloors(EVERY_BIT, environment).parts, environment, 100);
  const onlySecond = await centreOf(twoFloors(without(POINT_FIRST_BIT), environment).parts, environment, 100);
  const neither = await centreOf(twoFloors(without(POINT_FIRST_BIT, POINT_FIRST_BIT + 1), environment).parts, environment, 100);
  assert.ok(both > onlySecond, `both ${both}, one skipped ${onlySecond}`);
  assert.ok(onlySecond > 0.05);
  assert.equal(neither, 0);
});

test('a spot light and an area light honour their bits too', async () => {
  const environment = {
    spotLights: [{ position: [100, 3, 0], direction: [0, -1, 0], angle: 1, color: [1, 1, 1], intensity: 8 }],
    areaLights: [{ position: [100, 3, 0], direction: [0, -1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 8 }],
  };
  assert.ok(await centreOf(twoFloors(EVERY_BIT, environment).parts, environment, 100) > 0.05);
  assert.equal(await centreOf(twoFloors(without(SPOT_FIRST_BIT, AREA_FIRST_BIT), environment).parts, environment, 100), 0);
});

test('the path tracer no longer names light linking as ignored', () => {
  const parts = twoFloors(without(SUN_BIT), {}).parts;
  assert.ok(!describeIgnoredFeatures(parts, {}).some(note => /linking/i.test(note)));
});
