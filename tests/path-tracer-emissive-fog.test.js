import assert from 'node:assert/strict';
import test from 'node:test';

import { describeIgnoredFeatures, renderPathTracedImage } from '../src/path-tracer.js';
import { henyeyGreensteinPhase, resolveTraceVolume, sampleHenyeyGreensteinCosine, volumeInterval } from '../src/path-tracer-volume.js';

const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const IMAGE = { width: 16, height: 16, denoise: false, threads: 1, bounces: 4 };
const CENTER_PIXEL = (8 * 16 + 8) * 3;

function groundQuad() {
  const half = 20;
  return {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function ground(materialExtra) {
  return [{ name: 'ground', geometry: groundQuad(), material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], emission: 0, ...materialExtra } }];
}

function singleTexel(red, green, blue) {
  return { image: { data: new Uint8Array([red, green, blue, 255]), width: 1, height: 1 }, colorSpace: 'srgb' };
}

async function centerRadiance(parts, environment, samples) {
  const { linear } = await renderPathTracedImage({ parts, environment, camera: LOOKING_DOWN }, { ...IMAGE, samples });
  return [linear[CENTER_PIXEL], linear[CENTER_PIXEL + 1], linear[CENTER_PIXEL + 2]];
}

test('an emissive map colours the emission and the strength scales it', async () => {
  const lookup = value => ((value / 255 + 0.055) / 1.055) ** 2.4;
  const [red, green, blue] = await centerRadiance(ground({ emission: 2, emissiveColor: [1, 1, 1], emissiveMap: singleTexel(255, 128, 0) }), {}, 1);
  assert.ok(Math.abs(red - 2) < 1e-6, `red ${red}`);
  assert.ok(Math.abs(green - 2 * lookup(128)) < 1e-6, `green ${green}`);
  assert.equal(blue, 0);
  const [unmapped] = await centerRadiance(ground({ emission: 2, emissiveColor: [1, 1, 1] }), {}, 1);
  assert.equal(unmapped, 2);
  const [switchedOff] = await centerRadiance(ground({ emission: 0, emissiveMap: singleTexel(255, 255, 255) }), {}, 1);
  assert.equal(switchedOff, 0);
});

test('an emissive map no longer appears among the ignored features', () => {
  const notes = describeIgnoredFeatures([{ material: { emissiveMap: {}, emission: 1 } }], {});
  assert.ok(!notes.some(note => note.includes('emissiveMap')), notes.join(' '));
});

const FOG_SLAB = { minimum: [-30, 1, -30], maximum: [30, 2, 30], steps: 8 };

test('an absorbing fog slab removes light by exp(-density * thickness)', async () => {
  const parts = ground({ emission: 1, emissiveColor: [1, 1, 1] });
  const [clear] = await centerRadiance(parts, {}, 1);
  const [thin] = await centerRadiance(parts, { volumeFog: { ...FOG_SLAB, density: 1, color: [0, 0, 0] } }, 1024);
  assert.equal(clear, 1);
  // The centre ray crosses 1 unit of fog; 1024 samples leave a standard error near 0.015.
  assert.ok(Math.abs(thin - Math.exp(-1)) < 0.06, `transmitted ${thin}`);
});

test('a lit fog slab scatters sunlight toward the camera over a black floor', async () => {
  // A black metal floor reflects nothing, so every bit of light in the picture comes from the fog.
  const parts = ground({ metallic: 1 });
  const sun = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
  const fog = { ...FOG_SLAB, density: 0.1, color: [1, 1, 1], anisotropy: 0.3 };
  const { linear: clear } = await renderPathTracedImage({ parts, environment: sun, camera: LOOKING_DOWN }, { ...IMAGE, samples: 4 });
  const { linear: fogged } = await renderPathTracedImage({ parts, environment: { ...sun, volumeFog: fog }, camera: LOOKING_DOWN }, { ...IMAGE, samples: 64, bounces: 1 });
  assert.ok(Math.max(...clear) < 1e-6);
  // One scattering event per path: sun 3 * phase(back scatter, g 0.3) 0.033 * (1 - exp(-0.2)) / 2 = 0.009; a second event (about 0.002 more, with the longer oblique rays) is lit with a rounder phase.
  const mean = fogged.reduce((sum, value) => sum + value, 0) / fogged.length;
  assert.ok(mean > 0.0075 && mean < 0.014, `scattered ${mean}`);
});

test('fog is the same in a repeat render', async () => {
  const parts = ground({ emission: 1, emissiveColor: [1, 1, 1] });
  const environment = { keyColor: [2, 2, 2], lightDirection: [1, 1, 0], volumeFog: { ...FOG_SLAB, density: 0.5 } };
  const first = await centerRadiance(parts, environment, 8);
  const second = await centerRadiance(parts, environment, 8);
  assert.deepEqual(first, second);
});

test('fog with no density, or none at all, builds no medium', () => {
  assert.equal(resolveTraceVolume(undefined), null);
  assert.equal(resolveTraceVolume({ density: 0 }), null);
  assert.throws(() => resolveTraceVolume({ density: -1 }), RangeError);
});

test('the fog box clips a ray to where it is inside', () => {
  const volume = resolveTraceVolume({ density: 1, minimum: [-1, 0, -1], maximum: [1, 2, 1] });
  const span = new Float64Array(2);
  assert.ok(volumeInterval(volume, 0, 5, 0, 0, -1, 0, 100, span));
  assert.deepEqual([...span], [3, 5]);
  assert.ok(volumeInterval(volume, 0, 1, 0, 0, -1, 0, 100, span));
  assert.deepEqual([...span], [0, 1]);
  assert.ok(!volumeInterval(volume, 0, 5, 0, 0, -1, 0, 2, span), 'the surface comes before the fog');
  assert.ok(!volumeInterval(volume, 3, 5, 0, 0, -1, 0, 100, span), 'a ray beside the box');
  assert.ok(!volumeInterval(volume, 0, 5, 0, 1, 0, 0, 100, span), 'a ray going away');
});

test('Henyey-Greenstein draws follow their density', () => {
  for (const anisotropy of [-0.5, 0, 0.3, 0.8]) {
    // The phase function integrates to 1 over the sphere, and the draw has the matching mean cosine (= anisotropy).
    let integral = 0;
    const slices = 20000;
    for (let slice = 0; slice < slices; slice++) integral += henyeyGreensteinPhase(anisotropy, -1 + (2 * (slice + 0.5)) / slices) * 2 * Math.PI * (2 / slices);
    assert.ok(Math.abs(integral - 1) < 1e-3, `integral ${integral} for g ${anisotropy}`);
    let meanCosine = 0;
    const draws = 20000;
    for (let draw = 0; draw < draws; draw++) meanCosine += sampleHenyeyGreensteinCosine(anisotropy, (draw + 0.5) / draws) / draws;
    assert.ok(Math.abs(meanCosine - anisotropy) < 0.01, `mean cosine ${meanCosine} for g ${anisotropy}`);
  }
});

test('the report says the fog is traced as a uniform medium only when noise or ambient were asked for', () => {
  const noisy = describeIgnoredFeatures([{ material: {} }], { volumeFog: { density: 1, noiseAmount: 0.5 } });
  assert.ok(noisy.some(note => note.includes('uniform medium')));
  const plain = describeIgnoredFeatures([{ material: {} }], { volumeFog: { density: 1, noiseAmount: 0 } });
  assert.ok(!plain.some(note => note.includes('uniform medium') || note.includes('ambient')), plain.join(' '));
  const none = describeIgnoredFeatures([{ material: {} }], { volumeFog: { density: 0 } });
  assert.ok(!none.some(note => note.includes('volumeFog')));
});
