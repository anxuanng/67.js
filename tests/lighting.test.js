import test from 'node:test';
import assert from 'node:assert/strict';
import { createLightingState, updateLightingState } from '../src/lighting.js';

test('lighting preserves legacy key defaults and independently controls direct fill and ambient light', () => {
  const state = createLightingState();
  updateLightingState(state, {});
  assert.deepEqual(Array.from(state.keyColor), [5.2, 4.7, 4.1].map(Math.fround));
  updateLightingState(state, { daylight: 0.5 }, { world: true });
  assert.deepEqual(Array.from(state.keyColor), [1.85, 1.7, 1.45].map(Math.fround));
  updateLightingState(state, { keyColor: [1, 0.5, 0.1], keyIntensity: 2, fillIntensity: 0, ambientIntensity: 0 });
  assert.deepEqual(Array.from(state.keyColor), [2, 1, 0.2].map(Math.fround));
  assert.equal(state.fillIntensity, 0);
  assert.equal(state.ambientIntensity, 0);
});

test('animated lights retain uniform buffers and removal clears stale lights without mutating source', () => {
  const state = createLightingState();
  const identities = [state.positions, state.colors, state.radii, state.keyColor];
  const light = { position: [1, 2, 3], color: [1, 0.5, 0], intensity: 12, range: 7, radius: 0.2 };
  const original = structuredClone(light);
  updateLightingState(state, { pointLights: [light] });
  assert.deepEqual(Array.from(state.positions.slice(0, 4)), [1, 2, 3, 7]);
  assert.deepEqual(Array.from(state.colors.slice(0, 4)), [1, 0.5, 0, 12]);
  assert.equal(state.pointCount, 1);
  for (let frame = 0; frame < 100; frame++) updateLightingState(state, { pointLights: [{ ...light, position: [frame, 2, 3] }] });
  updateLightingState(state, { pointLights: [] });
  assert.equal(state.pointCount, 0);
  assert.ok(state.positions.every(value => value === 0));
  assert.ok(state.colors.every(value => value === 0));
  assert.ok(state.radii.every(value => value === 0));
  assert.deepEqual([state.positions, state.colors, state.radii, state.keyColor], identities);
  assert.deepEqual(light, original);
});

test('malformed later lights reject atomically before replacing any retained lighting values', () => {
  const state = createLightingState();
  const light = { position: [0, 2, 1] };
  updateLightingState(state, { pointLights: [light], fillIntensity: 0.4 });
  const snapshot = structuredClone(state);
  for (const malformed of [
    null,
    { position: [0, 0] },
    { position: [Infinity, 0, 0] },
    { position: ['1', 0, 0] },
    { position: [0, 0, 0], color: [1, -1, 0] },
    { position: [0, 0, 0], intensity: NaN },
    { position: [0, 0, 0], radius: 1e-100 },
    { position: [0, 0, 0], range: 1e-100 },
  ]) {
    assert.throws(() => updateLightingState(state, { pointLights: [light, malformed], fillIntensity: 0 }));
    assert.deepEqual(state, snapshot);
  }
  assert.throws(() => updateLightingState(state, { pointLights: Array(9).fill(light) }), /at most/);
  assert.throws(() => updateLightingState(state, { keyIntensity: -1 }));
  assert.throws(() => updateLightingState(state, { ambientIntensity: Infinity }));
  assert.deepEqual(state, snapshot);
});

test('spot lights store a normalized direction and the Blender cone cosines', () => {
  const state = createLightingState();
  updateLightingState(state, { spotLights: [{ position: [0, 3, 0], direction: [0, -2, 0], angle: Math.PI / 3, penumbra: 0.5, intensity: 9 }] });
  assert.equal(state.spotCount, 1);
  assert.deepEqual(Array.from(state.spotDirections.slice(0, 3)), [0, -1, 0]);
  const cosineOuter = Math.cos(Math.PI / 3);
  assert.ok(Math.abs(state.spotDirections[3] - cosineOuter) < 1e-6);
  assert.ok(Math.abs(state.spotParameters[1] - (cosineOuter + (1 - cosineOuter) * 0.5)) < 1e-6);
  assert.equal(state.spotParameters[2], -1);
  assert.equal(state.spotColors[3], 9);
});

test('a hard-edged spot light keeps its inner cosine above the outer one', () => {
  const state = createLightingState();
  updateLightingState(state, { spotLights: [{ position: [0, 3, 0], direction: [0, -1, 0], penumbra: 0 }] });
  assert.ok(state.spotParameters[1] > state.spotDirections[3]);
});

test('shadow tiles go to point lights first, six for a point light and one for a spot light', () => {
  const state = createLightingState();
  updateLightingState(state, {
    spotLights: [{ position: [0, 3, 0], direction: [0, -1, 0], castShadow: true }],
    pointLights: [{ position: [1, 1, 1] }, { position: [2, 2, 2], castShadow: true }],
  });
  assert.equal(state.pointShadows[0], -1);
  assert.equal(state.pointShadows[1], 0);
  assert.equal(state.spotParameters[2], 6);
  assert.equal(state.shadowCasters.length, 7);
});

test('shadow casters beyond the 24 tile atlas are rejected before any state changes', () => {
  const state = createLightingState();
  updateLightingState(state, { pointLights: [{ position: [1, 1, 1] }] });
  const fivePointLights = [0, 1, 2, 3, 4].map(index => ({ position: [index, 1, 1], castShadow: true }));
  assert.throws(() => updateLightingState(state, { pointLights: fivePointLights }), /atlas/);
  assert.equal(state.pointCount, 1);
});

test('area lights store a unit normal and a width axis perpendicular to it', () => {
  const state = createLightingState();
  updateLightingState(state, { areaLights: [{ position: [0, 3, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 2, height: 1, intensity: 5 }] });
  assert.equal(state.areaCount, 1);
  const normal = Array.from(state.areaNormals.slice(0, 3));
  const tangent = Array.from(state.areaTangents.slice(0, 3));
  assert.equal(normal[0] * tangent[0] + normal[1] * tangent[1] + normal[2] * tangent[2], 0);
  assert.equal(state.areaNormals[3], 2);
  assert.equal(state.areaTangents[3], 1);
  assert.equal(state.areaColors[3], 5);
});

test('malformed spot and area lights are rejected', () => {
  const state = createLightingState();
  assert.throws(() => updateLightingState(state, { spotLights: [{ position: [0, 0, 0], direction: [0, 0, 0] }] }), /zero length/);
  assert.throws(() => updateLightingState(state, { spotLights: [{ position: [0, 0, 0], direction: [0, -1, 0], angle: 2 }] }), /angle/);
  assert.throws(() => updateLightingState(state, { areaLights: [{ position: [0, 0, 0], direction: [0, -1, 0], width: 0, height: 1 }] }), /width/);
  assert.throws(() => updateLightingState(state, { areaLights: new Array(5).fill({ position: [0, 0, 0], direction: [0, -1, 0], width: 1, height: 1 }) }), /at most 4/);
});
