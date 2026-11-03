import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere } from '../src/geometry.js';
import { applyWaterReflection, attachWaterReflection, findWaterSurface } from '../src/water-reflection.js';
import { createFragmentShader } from '../src/shaders.js';

const cube = box(0, 1);

function placed(name, translation, scale, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

const WATER = { color: [0.02, 0.05, 0.08], roughness: 0.04 };

function lakeScene(waterMaterial = WATER) {
  return [
    placed('ground', [0, -2, 0], [4000, 2, 4000]),
    placed('lake', [0, -1.5, 0], [900, 1, 900], waterMaterial),
    placed('boulder', [300, 4, 0], [8, 8, 8]),
  ];
}

test('a large flat smooth box qualifies and its top is the plane', () => {
  const surface = findWaterSurface(lakeScene());
  assert.deepEqual(surface.partIndices, [1]);
  assert.equal(surface.height, -1);
});

test('a scene with no such surface gets no surface and keeps its parts', () => {
  const parts = lakeScene({ roughness: 0.6 });
  assert.equal(findWaterSurface(parts), null);
  const result = applyWaterReflection(parts);
  assert.equal(result.surface, null);
  assert.equal(result.parts, parts);
});

test('a surface that is small, tall, rough, liquid or transmissive does not qualify', () => {
  assert.equal(findWaterSurface([placed('ground', [0, -2, 0], [4000, 2, 4000]), placed('puddle', [0, -1, 0], [20, 0.2, 20], WATER)]), null);
  assert.equal(findWaterSurface([placed('ground', [0, -2, 0], [4000, 2, 4000]), placed('tower', [0, 50, 0], [900, 400, 900], WATER)]), null);
  assert.equal(findWaterSurface(lakeScene({ ...WATER, roughness: 0.3 })), null);
  assert.equal(findWaterSurface(lakeScene({ ...WATER, tag: 'liquid' })), null);
  assert.equal(findWaterSurface(lakeScene({ ...WATER, transmission: 0.9 })), null);
});

test('smooth metal qualifies the same way as water', () => {
  const surface = findWaterSurface(lakeScene({ color: [0.8, 0.8, 0.8], metallic: 1, roughness: 0.05 }));
  assert.deepEqual(surface.partIndices, [1]);
});

test('a ball is not flat', () => {
  const parts = [placed('ground', [0, -2, 0], [4000, 2, 4000]), { ...placed('ball', [0, 0, 0], [600, 600, 600], WATER), geometry: sphere(16, 12) }];
  assert.equal(findWaterSurface(parts), null);
});

test('marked parts keep reading the live material and carry the flag', () => {
  const live = { ...WATER, tag: 'surface', color: [0.1, 0.2, 0.3], metallic: 0 };
  const parts = lakeScene();
  parts[1] = { ...parts[1], material: live };
  const { parts: marked, report } = applyWaterReflection(parts);
  assert.equal(marked[1].material.waterReflection, true);
  assert.equal(marked[0], parts[0]);
  assert.equal(report.placed, true);
  live.color = [0.9, 0.9, 0.9];
  assert.deepEqual(marked[1].material.color, [0.9, 0.9, 0.9]);
});

test('attaching to nothing changes nothing', () => {
  const renderer = { render() {}, dispose() {} };
  const render = renderer.render;
  const detach = attachWaterReflection(renderer, null);
  assert.equal(renderer.render, render);
  detach();
});

test('the shader of a scene without the feature is the shader it was', () => {
  const plain = createFragmentShader(['studioLighting']);
  const withWater = createFragmentShader(['studioLighting', 'waterReflection']);
  assert.ok(!plain.includes('waterReflection'));
  assert.ok(withWater.includes('waterReflectionMatrix'));
  assert.ok(withWater.includes('discard'));
});

test('the mirror image is drawn at three quarters of the canvas in each direction', () => {
  const textureSizes = [];
  const context = new Proxy({}, {
    get: (_, name) => {
      if (name === 'texImage2D') {
        return (...callArguments) => textureSizes.push([callArguments[3], callArguments[4]]);
      }
      if (name === 'checkFramebufferStatus') {
        return () => 1;
      }
      if (name === 'FRAMEBUFFER_COMPLETE') {
        return 1;
      }
      return typeof name === 'string' && name === name.toUpperCase() ? 0 : () => ({});
    },
  });
  const renderer = { context, canvas: { width: 960, height: 540 }, hdr: false, viewProjection: new Float32Array(16), render() {}, dispose() {} };
  const detach = attachWaterReflection(renderer, findWaterSurface(lakeScene()));
  renderer.render({ eye: [0, 20, 100], target: [0, 0, 0] });
  assert.deepEqual(textureSizes, [[720, 405]]);
  detach();
});
