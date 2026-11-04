import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentMap, computeIrradianceCoefficients, evaluateIrradiance } from '../src/environment.js';
import { findGroundSurface, groundBounceEnvironment, withGroundBounce } from '../src/ground-bounce.js';

const WIDTH = 8;
const HEIGHT = 4;

function uniformSky(value, extra = {}) {
  return createEnvironmentMap({ width: WIDTH, height: HEIGHT, data: new Float32Array(WIDTH * HEIGHT * 3).fill(value), ...extra });
}

function pixel(map, column, row) {
  const offset = (row * map.width + column) * map.channels;
  return Array.from(map.data.slice(offset, offset + 3));
}

test('the diffuse copy has albedo times the sky and sun on the ground in its lower half and the sky above', () => {
  const sky = uniformSky(0.5);
  const bounced = withGroundBounce(sky, { albedo: [0.4, 0.2, 0.1], keyColor: [Math.PI, Math.PI, Math.PI], lightDirection: [0, 2, 0] });
  const copy = bounced.irradianceSource;
  const skyOnGround = evaluateIrradiance(computeIrradianceCoefficients(sky), [0, 1, 0]);
  assert.deepEqual(pixel(copy, 3, 0), pixel(sky, 3, 0));
  assert.deepEqual(pixel(copy, 3, 1), pixel(sky, 3, 1));
  const expected = [0.4, 0.2, 0.1].map((albedo, index) => albedo * (1 + skyOnGround[index]));
  pixel(copy, 3, 3).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-5));
  assert.deepEqual(pixel(copy, 0, 2), pixel(copy, 7, 3));
});

test('the background and the reflections keep the original sky', () => {
  const sky = uniformSky(0.5, { intensity: 2, rotation: 1, showBackground: true });
  const before = Array.from(sky.data);
  const bounced = withGroundBounce(sky, { albedo: [0.5, 0.5, 0.5], keyColor: [1, 1, 1], lightDirection: [0, 1, 0] });
  assert.equal(bounced.data, sky.data);
  assert.equal(bounced.intensity, 2);
  assert.equal(bounced.rotation, 1);
  assert.equal(bounced.showBackground, true);
  assert.deepEqual(Array.from(sky.data), before);
});

test('a sun below the horizon, black albedo or no sun leaves only the sky term', () => {
  const sky = uniformSky(0.5);
  const skyOnGround = evaluateIrradiance(computeIrradianceCoefficients(sky), [0, 1, 0]);
  const night = withGroundBounce(sky, { albedo: [1, 1, 1], keyColor: [5, 5, 5], lightDirection: [0, -1, 0] });
  assert.ok(Math.abs(pixel(night.irradianceSource, 0, 3)[0] - skyOnGround[0]) < 1e-5);
  const black = withGroundBounce(sky, { albedo: [0, 0, 0], keyColor: [5, 5, 5], lightDirection: [0, 1, 0] });
  assert.deepEqual(pixel(black.irradianceSource, 0, 3), [0, 0, 0]);
});

test('the bounce lights a wall: a sideways normal gets more irradiance from the diffuse copy', () => {
  const sky = uniformSky(0.5);
  const sideways = [1, 0, 0];
  const bounced = withGroundBounce(sky, { albedo: [0.9, 0.9, 0.9], keyColor: [3, 3, 3], lightDirection: [0, 1, 0] });
  const plain = evaluateIrradiance(computeIrradianceCoefficients(sky), sideways);
  const lit = evaluateIrradiance(computeIrradianceCoefficients(bounced.irradianceSource), sideways);
  assert.ok(lit[0] > plain[0]);
});

function slab(name, center, size, material) {
  const corners = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) corners.push(x, y, z);
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, ...center, 1]);
  const indices = new Uint32Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);
  return { name, geometry: { positions: new Float32Array(corners), indices }, matrix, material };
}

const GRASS = { tag: 'surface', color: [0.2, 0.4, 0.1], metallic: 0, roughness: 0.9 };
const environmentOf = map => ({ map, keyColor: [3, 3, 3], lightDirection: [-3, 6, 4] });

function openScene(floorMaterial = GRASS) {
  return [slab('floor', [0, -0.05, 0], [40, 0.1, 40], floorMaterial), slab('wall', [0, 2, 0], [6, 4, 0.2], { tag: 'surface', color: [0.5, 0.5, 0.5] })];
}

test('the floor is the lowest thin part that spans the scene, and its albedo is its colour', () => {
  assert.deepEqual(findGroundSurface(openScene()), { albedo: [0.2, 0.4, 0.1] });
  assert.deepEqual(findGroundSurface(openScene({ ...GRASS, metallic: 0.2 })).albedo.map(value => Number(value.toFixed(2))), [0.16, 0.32, 0.08]);
});

test('no floor, a textured, metal, water or lone part gives no ground', () => {
  assert.equal(findGroundSurface(openScene().slice(1)), null);
  assert.equal(findGroundSurface(openScene({ ...GRASS, map: { image: {} } })), null);
  assert.equal(findGroundSurface(openScene({ ...GRASS, metallic: 1 })), null);
  assert.equal(findGroundSurface(openScene({ ...GRASS, tag: 'liquid' })), null);
  assert.equal(findGroundSurface([openScene()[0]]), null);
});

test('an open scene with a floor gets one bounced map, the same object on every call', () => {
  const parts = openScene();
  const environment = environmentOf(uniformSky(0.5));
  const first = groundBounceEnvironment(parts, environment);
  assert.ok(first.map.irradianceSource);
  assert.equal(groundBounceEnvironment(parts, environment).map, first.map);
});

test('a baked part, a closed room, no floor, no map or groundBounce false keep the environment', () => {
  const environment = environmentOf(uniformSky(0.5));
  const baked = openScene().map(part => ({ ...part, material: { ...part.material, lightMap: {} } }));
  assert.equal(groundBounceEnvironment(baked, environment), environment);
  assert.equal(groundBounceEnvironment(openScene().slice(1), environment), environment);
  assert.equal(groundBounceEnvironment(openScene(), { ...environment, map: undefined }).map, undefined);
  assert.equal(groundBounceEnvironment(openScene(), { ...environment, groundBounce: false }).map, environment.map);
  const room = [
    slab('floor', [0, -0.05, 0], [8, 0.1, 8], GRASS), slab('ceiling', [0, 3.05, 0], [8, 0.1, 8], GRASS),
    slab('back', [0, 1.5, -4.05], [8, 3.2, 0.1], GRASS), slab('front', [0, 1.5, 4.05], [8, 3.2, 0.1], GRASS),
    slab('left', [-4.05, 1.5, 0], [0.1, 3.2, 8], GRASS), slab('right', [4.05, 1.5, 0], [0.1, 3.2, 8], GRASS),
  ];
  assert.equal(groundBounceEnvironment(room, environment), environment);
});

test('an automatic floor gives its albedo when no part forms one, and keyIntensity scales the sun', () => {
  const parts = openScene().slice(1).concat(slab('block', [0, 1, 2], [1, 1, 1], GRASS));
  const environment = environmentOf(uniformSky(0.5));
  const albedo = [0.22, 0.22, 0.21];
  const lit = groundBounceEnvironment(parts, environment, { automaticAlbedo: albedo });
  assert.ok(lit.map.irradianceSource);
  const dimmer = groundBounceEnvironment(parts, { ...environment, keyIntensity: 0 }, { automaticAlbedo: albedo });
  assert.ok(pixel(dimmer.map.irradianceSource, 0, 3)[0] < pixel(lit.map.irradianceSource, 0, 3)[0]);
});

test('a point, spot or area light keeps the environment, as the term knows only the sun and the sky', () => {
  const environment = environmentOf(uniformSky(0.5));
  for (const field of ['pointLights', 'spotLights', 'areaLights']) {
    assert.equal(groundBounceEnvironment(openScene(), { ...environment, [field]: [{}] }).map, environment.map);
  }
  assert.ok(groundBounceEnvironment(openScene(), { ...environment, pointLights: [] }).map.irradianceSource);
});

function textureOf(pixels, colorSpace = 'srgb') {
  return { image: { width: pixels.length, height: 1, data: new Uint8ClampedArray(pixels.flat()) }, colorSpace };
}

test('a textured floor gives its colour times the mean of the texture in linear space', () => {
  const checker = textureOf([[255, 255, 255, 255], [0, 0, 0, 255]]);
  const albedo = findGroundSurface(openScene({ ...GRASS, color: [1, 0.5, 0.25], map: checker })).albedo;
  [0.5, 0.25, 0.125].forEach((expected, index) => assert.ok(Math.abs(albedo[index] - expected) < 1e-6));
  const linearMiddle = textureOf([[128, 128, 128, 255]], 'linear');
  assert.ok(Math.abs(findGroundSurface(openScene({ ...GRASS, color: [1, 1, 1], map: linearMiddle })).albedo[0] - 128 / 255) < 1e-6);
});

test('the mean of a texture is found once per image', () => {
  const map = textureOf([[255, 255, 255, 255]]);
  findGroundSurface(openScene({ ...GRASS, map }));
  map.image.data.fill(0);
  assert.ok(findGroundSurface(openScene({ ...GRASS, map })).albedo[0] > 0.1);
});

test('a low sun adds a bounce colour to the map, a high sun, no sun or outdoorFill false add none', () => {
  const parts = openScene();
  const lowSun = { map: uniformSky(0.5), keyColor: [3, 3, 3], lightDirection: [-5, 1, 4] };
  const filled = groundBounceEnvironment(parts, lowSun);
  assert.ok(filled.map.irradianceSource);
  assert.ok(filled.map.bounce.every(channel => channel > 0));
  // The renderer adds a bounce through this method; without it the colour is never drawn (issue #392).
  const coefficients = computeIrradianceCoefficients(filled.map);
  const lit = filled.map.irradianceWithBounce(coefficients);
  assert.ok(lit[0] > coefficients[0] && lit[1] > coefficients[1] && lit[2] > coefficients[2]);
  assert.ok(groundBounceEnvironment(parts.slice(1), lowSun).map.irradianceWithBounce);
  assert.equal(groundBounceEnvironment(parts, lowSun).map, filled.map);
  assert.equal(groundBounceEnvironment(parts, environmentOf(uniformSky(0.5))).map.bounce, undefined);
  assert.equal(groundBounceEnvironment(parts, { ...lowSun, keyColor: [0, 0, 0] }).map.bounce, undefined);
  assert.equal(groundBounceEnvironment(parts, { ...lowSun, outdoorFill: false }).map.bounce, undefined);
  const withoutFloor = groundBounceEnvironment(parts.slice(1), lowSun);
  assert.ok(withoutFloor.map.bounce.every(channel => channel > 0));
});
