import assert from 'node:assert/strict';
import test from 'node:test';
import { createLightingState, updateLightingState } from '../src/lighting.js';

// The conversion table in docs/agent-look.md: a three.js r155+ light copies over with these values.
// Both sides give the irradiance on a surface facing the light, as a white diffuse surface shows it (radiance = irradiance / PI).
const TOLERANCE = 0.02;
const DISTANCE = 10;

function assertWithinTolerance(actual, expected, label) {
  const relativeError = Math.abs(actual - expected) / expected;
  assert.ok(relativeError <= TOLERANCE, `${label}: ${actual} against ${expected}, ${(relativeError * 100).toFixed(2)} percent off`);
}

// three.js: DirectionalLight irradiance is intensity; Point, Spot and Rect area lights follow intensity / d^2 on axis (area: nits * area).
const threeJsDirectional = { intensity: 3.1 };
const threeJsPoint = { intensity: 120 };
const threeJsSpot = { intensity: 80 };
const threeJsArea = { nits: 40, width: 2, height: 0.5 };

function portedState() {
  const state = createLightingState();
  updateLightingState(state, {
    keyColor: [1, 1, 1],
    keyIntensity: threeJsDirectional.intensity,
    pointLights: [{ position: [0, DISTANCE, 0], intensity: threeJsPoint.intensity, radius: 0.1 }],
    spotLights: [{ position: [0, DISTANCE, 0], direction: [0, -1, 0], intensity: threeJsSpot.intensity, radius: 0.1, angle: 0.8 }],
    areaLights: [{ position: [0, DISTANCE, 0], direction: [0, -1, 0], width: threeJsArea.width, height: threeJsArea.height, intensity: threeJsArea.nits * threeJsArea.width * threeJsArea.height }],
  });
  return state;
}

// The engine's own formulas from src/shaders.js, read from the uniforms the lighting state fills, for a point at the origin facing up.
test('a ported three.js directional light gives the same irradiance', () => {
  assertWithinTolerance(portedState().keyColor[0], threeJsDirectional.intensity, 'directional');
});

test('a ported three.js point light gives intensity / d^2 at distance d', () => {
  const state = portedState();
  const engineIrradiance = state.colors[0] * state.colors[3] / Math.max(DISTANCE ** 2, state.radii[0] ** 2);
  assertWithinTolerance(engineIrradiance, threeJsPoint.intensity / DISTANCE ** 2, 'point');
});

test('a ported three.js spot light gives intensity / d^2 on its axis', () => {
  const state = portedState();
  const engineIrradiance = state.spotColors[0] * state.spotColors[3] / Math.max(DISTANCE ** 2, 0.1 ** 2);
  assertWithinTolerance(engineIrradiance, threeJsSpot.intensity / DISTANCE ** 2, 'spot');
});

test('a ported three.js rect area light with nits * width * height matches far from the light', () => {
  const state = portedState();
  const area = state.areaNormals[3] * state.areaTangents[3];
  const engineIrradiance = state.areaColors[0] * state.areaColors[3] / (DISTANCE ** 2 + area / Math.PI);
  assertWithinTolerance(engineIrradiance, threeJsArea.nits * threeJsArea.width * threeJsArea.height / DISTANCE ** 2, 'area');
});
