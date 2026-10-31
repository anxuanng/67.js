import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { normalizeAgentLook, resolveAgentShadow } from '../src/agent-look.js';
import { createLightingState, updateLightingState } from '../src/lighting.js';
import { resolveVolumeFog } from '../src/volumetric.js';

test('default look is complete, detached JSON and idempotent', () => {
  const look = normalizeAgentLook();
  assert.deepEqual(look.environment, {
    world: false,
    setup: 'daylight',
    environmentIntensity: 1,
    environmentRotation: 0,
    lightDirection: [-3, 6, 4],
    keyColor: [3, 2.8, 2.5],
    keyIntensity: 1,
    fillIntensity: 0,
    ambientIntensity: 1,
    daylight: 1,
    pointLights: [],
    skyTop: [0.2, 0.38, 0.52],
    skyBottom: [0.62, 0.7, 0.67],
    fogColor: [0.35, 0.43, 0.43],
    fogDensity: 0.006,
    volumeFog: resolveVolumeFog(),
  });
  assert.deepEqual(look.effects, {
    saturation: 1, contrast: 1, temperature: 0, vignette: 0, grain: 0,
    ambientOcclusion: 0.8, ambientOcclusionRadius: 0.5,
    bloom: { strength: 0.12, threshold: 1, radius: 1 }, exposure: 1,
  });
  assert.deepEqual(look.shadow, { target: [0, 1, 0], extent: 3.5, distance: 8, near: 0.1, far: 15 });
  assert.deepEqual(JSON.parse(JSON.stringify(look)), look);
  assert.deepEqual(normalizeAgentLook(look), look);
  const other = normalizeAgentLook();
  look.environment.lightDirection[0] = 999;
  look.environment.volumeFog.minimum[0] = 999;
  look.effects.bloom.strength = 999;
  look.shadow.target[0] = 999;
  assert.deepEqual(other, normalizeAgentLook());
});

test('normalization preserves author intent and publishes correct lighting radiance through existing validator', () => {
  const input = {
    environment: {
      world: true,
      lightDirection: [0, 12, 0],
      keyColor: [2, 3, 4],
      keyIntensity: 7,
      fillIntensity: 0,
      ambientIntensity: 0,
      daylight: 0,
      pointLights: [{ position: [1, 2, 3], range: 0 }, { position: [-1, 0, 4], color: [0.5, 0.2, 1], intensity: 100000, radius: 0.001, range: 1 }],
      volumeFog: { density: 0.2 },
    },
    effects: { exposure: 2, bloom: { threshold: 2 }, contrast: 1.5 },
    shadow: { distance: 10 },
  };
  const before = structuredClone(input);
  const look = normalizeAgentLook(input);
  assert.deepEqual(input, before);
  assert.deepEqual(look.environment.lightDirection, [0, 12, 0]);
  assert.deepEqual(look.environment.pointLights[0], { position: [1, 2, 3], color: [1, 1, 1], intensity: 1, radius: 0.05, range: 0 });
  assert.deepEqual(look.effects.bloom, { strength: 0.12, threshold: 2, radius: 1 });
  const lighting = updateLightingState(createLightingState(), look.environment, { world: look.environment.world });
  assert.deepEqual(Array.from(lighting.keyColor), [14, 21, 28]);
  assert.equal(lighting.pointCount, 2);
  assert.equal(lighting.positions[3], 0);
  assert.equal(lighting.colors[7], 100000);
  look.environment.pointLights[0].position[0] = 100;
  look.environment.volumeFog.color[0] = 0;
  look.effects.bloom.threshold = 10;
  assert.deepEqual(input, before);
});

test('strict look schema rejects unknown keys at every object boundary', () => {
  const invalid = [
    { lighting: {} },
    { environment: { mystery: 1 } },
    { environment: { pointLights: [{ position: [0, 0, 0], mystery: 1 }] } },
    { environment: { volumeFog: { mystery: 1 } } },
    { effects: { mystery: 1 } },
    { effects: { bloom: { mystery: 1 } } },
    { shadow: { eye: [1, 2, 3] } },
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeAgentLook(input), /Unknown/);
  }
  assert.throws(() => resolveAgentShadow({ up: [0, 1, 0] }), /Unknown/);
});

test('malformed JSON, getters, sparse arrays and executable values reject without executing accessors', () => {
  const invalid = [null, [], new Date(), { effects: null }, { shadow: [] }, { environment: { world: 1 } },
    { environment: { skyTop: new Float32Array([1, 1, 1]) } }, { effects: { exposure: undefined } },
    { environment: { pointLights: [null] } }, { environment: { lightDirection: [1, 2] } },
    { environment: { keyColor: ['1', 1, 1] } }, { effects: { grain: () => 0 } }];
  for (const input of invalid) {
    assert.throws(() => normalizeAgentLook(input));
  }
  const sparse = [0, 1, 0];
  sparse.length++;
  assert.throws(() => normalizeAgentLook({ environment: { lightDirection: sparse } }), /trailing holes/);
  const hole = [0, 1, 0];
  delete hole[1];
  assert.throws(() => normalizeAgentLook({ shadow: { target: hole } }), /dense/);
  let reads = 0;
  const getter = {};
  Object.defineProperty(getter, 'exposure', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  assert.throws(() => normalizeAgentLook({ effects: getter }), /accessors/);
  assert.equal(reads, 0);
  const cyclic = {};
  cyclic.effects = cyclic;
  assert.throws(() => normalizeAgentLook(cyclic), /acyclic/);
  const hidden = {};
  Object.defineProperty(hidden, 'exposure', { value: 1 });
  assert.throws(() => normalizeAgentLook({ effects: hidden }), /hidden/);
  const symbol = { [Symbol('hidden')]: true };
  assert.throws(() => normalizeAgentLook(symbol), /Unknown/);
});

test('lighting ranges include zero intensity and unlimited point range while rejecting invalid edge values', () => {
  const lights = Array.from({ length: 8 }, (_, index) => ({ position: [index, 0, 0], intensity: 0, range: 0 }));
  const look = normalizeAgentLook({ environment: { pointLights: lights, keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, daylight: 0, fogDensity: 0 } });
  assert.equal(look.environment.pointLights.length, 8);
  assert.equal(look.environment.keyIntensity, 0);
  assert.deepEqual(normalizeAgentLook({ environment: { pointLights: [] } }).environment.pointLights, []);
  assert.throws(() => normalizeAgentLook({ environment: { pointLights: [...lights, lights[0]] } }), /8/);
  const invalid = [
    { pointLights: [{ position: [0, 0, 0], range: 0.0001 }] },
    { pointLights: [{ position: [0, 0, 0], radius: 0 }] },
    { pointLights: [{ position: [1000001, 0, 0] }] },
    { pointLights: [{ position: [0, 0, 0], intensity: 100001 }] },
    { pointLights: [{ position: [0, 0, 0], color: [1, -0.01, 0] }] },
    { keyIntensity: 101 }, { fillIntensity: -1 }, { ambientIntensity: null }, { daylight: 101 },
    { keyColor: [1001, 0, 0] }, { fogDensity: 11 }, { skyTop: [0, 2, 0] }, { fogColor: [0, -1, 0] },
    { lightDirection: [0, 0, 0] }, { lightDirection: [0, 1e-7, 0] }, { lightDirection: [0, 1000001, 0] },
  ];
  for (const environment of invalid) {
    assert.throws(() => normalizeAgentLook({ environment }));
  }
  for (const number of [Infinity, NaN, 1e100]) {
    assert.throws(() => normalizeAgentLook({ environment: { fogDensity: number } }), /Float32/);
  }
  assert.deepEqual(normalizeAgentLook({ environment: { lightDirection: [1e-6, 0, 0] } }).environment.lightDirection, [1e-6, 0, 0]);
});

test('volume fog delegates defaults, domain ranges and Float32 bounds ordering', () => {
  const look = normalizeAgentLook({ environment: { volumeFog: {
    density: 10, minimum: [-1, -1, -1], maximum: [1, 1, 1], color: [1, 0, 1], ambient: [10, 0, 10],
    drift: [-100, 0, 100], steps: 48, anisotropy: -0.9, noiseAmount: 0, noiseScale: 100, maxDistance: 10000,
  } } });
  assert.equal(look.environment.volumeFog.steps, 48);
  const invalid = [
    { minimum: [10000, 0, 0], maximum: [10000 + 1e-6, 1, 1] },
    { density: null }, { steps: 8.5 }, { steps: 49 }, { color: [2, 0, 0] }, { ambient: [11, 0, 0] },
    { drift: [101, 0, 0] }, { anisotropy: 1 }, { noiseAmount: -1 }, { noiseScale: 0 }, { maxDistance: 0 },
  ];
  for (const volumeFog of invalid) {
    assert.throws(() => normalizeAgentLook({ environment: { volumeFog } }));
  }
  assert.throws(() => normalizeAgentLook({ environment: { volumeFog: { minimum: [1, 1, 1], maximum: [0, 0, 0] } } }), /Float32/);
});

test('effects enforce existing ranges, independent exposure and explicit bloom disable', () => {
  const look = normalizeAgentLook({ effects: { exposure: 16, saturation: 2, contrast: 0.1, temperature: -1, vignette: 1, grain: 0.1, bloom: { strength: 0, threshold: 10, radius: 4 } } });
  assert.equal(look.effects.bloom.strength, 0);
  assert.equal(look.effects.exposure, 16);
  assert.equal(normalizeAgentLook({ effects: { exposure: 0.01 } }).effects.exposure, 0.01);
  const invalid = [
    { exposure: 0 }, { exposure: 16.01 }, { saturation: 2.1 }, { contrast: 0 }, { temperature: 1.1 },
    { vignette: -1 }, { grain: 0.11 }, { bloom: null }, { bloom: { strength: 2.1 } },
    { bloom: { threshold: -1 } }, { bloom: { radius: 0 } }, { bloom: { radius: '1' } },
  ];
  for (const effects of invalid) {
    assert.throws(() => normalizeAgentLook({ effects }));
  }
});

test('shadow direction normalization preserves authored distance and handles vertical projectors', () => {
  const first = resolveAgentShadow({ target: [2, 3, 4], distance: 10 }, [0, 200, 0]);
  const second = resolveAgentShadow({ target: [2, 3, 4], distance: 10 }, [0, 2, 0]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.eye, [2, 13, 4]);
  assert.deepEqual(first.up, [0, 0, 1]);
  assert.deepEqual(resolveAgentShadow({}, [0.01, -1, 0]).up, [0, 0, 1]);
  assert.deepEqual(resolveAgentShadow({}, [1, 0, 0]).up, [0, 1, 0]);
  const look = normalizeAgentLook({ environment: { lightDirection: [0, 1, 0] } });
  assert.deepEqual(resolveAgentShadow(look.shadow, look.environment.lightDirection).eye, [0, 9, 0]);
  const input = { target: [1, 2, 3] };
  const bounds = resolveAgentShadow(input, [-3, 6, 4]);
  bounds.target[0] = 9;
  bounds.eye[0] = 9;
  assert.deepEqual(input, { target: [1, 2, 3] });
});

test('shadow numerical combinations reject collapsed eye or clipping ranges before accepting the look', () => {
  const invalid = [
    { shadow: { target: [1e6, 0, 0], distance: 0.01 }, environment: { lightDirection: [1, 0, 0] } },
    { shadow: { near: 10000, far: 10000 + 1e-6 } },
    { shadow: { near: 15, far: 15 } },
    { shadow: { extent: 0 } },
    { shadow: { distance: 0 } },
    { shadow: { target: [0, 1000001, 0] } },
    { shadow: { near: 0.0001 } },
    { shadow: { far: 1000001 } },
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeAgentLook(input));
  }
  assert.throws(() => resolveAgentShadow({}, [0, 0, 0]), /lightDirection/);
  assert.throws(() => resolveAgentShadow({ target: [1e6, 0, 0], distance: 0.01 }, [1, 0, 0]), /distinguishable/);
});

test('valid shadow extremes produce finite nonsingular view, projection and combined matrices', () => {
  for (const shadow of [
    { extent: 0.01, distance: 0.01, near: 0.001, far: 0.002 },
    { target: [1e6, -1e6, 1e6], extent: 1e5, distance: 1e6, near: 0.001, far: 1e6 },
  ]) {
    const bounds = resolveAgentShadow(shadow, [-3, 6, 4]);
    const view = mat4.lookAt(mat4.create(), bounds.eye, bounds.target, bounds.up);
    const projection = mat4.ortho(mat4.create(), -bounds.extent, bounds.extent, -bounds.extent, bounds.extent, bounds.near, bounds.far);
    const combined = mat4.multiply(mat4.create(), projection, view);
    for (const matrix of [view, projection, combined]) {
      assert.ok(matrix.every(Number.isFinite));
      assert.notEqual(mat4.determinant(matrix), 0);
    }
  }
});
