import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere } from '../src/geometry.js';
import { applyWaterReflection, attachWaterReflection, findWaterSurface, waterMirrorLevel, waterMirrorWeight, WATER_BLUR_LIMIT_ROUGHNESS, WATER_MAXIMUM_BLUR_LEVEL } from '../src/water-reflection.js';
import { createFragmentShader } from '../src/shaders.js';
import { Renderer67 } from '../src/renderer.js';

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
  assert.equal(findWaterSurface(lakeScene({ ...WATER, roughness: 0.6 })), null);
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

test('a render pass frame skips the mirror image and the next lit frame draws it again', () => {
  const context = new Proxy({}, {
    get: (_, name) => {
      if (name === 'checkFramebufferStatus') {
        return () => 1;
      }
      if (name === 'FRAMEBUFFER_COMPLETE') {
        return 1;
      }
      return typeof name === 'string' && name === name.toUpperCase() ? 0 : () => ({});
    },
  });
  const renderedFrames = [];
  const renderer = { context, canvas: { width: 960, height: 540 }, hdr: false, viewProjection: new Float32Array(16), render: frame => renderedFrames.push(frame), dispose() {} };
  const detach = attachWaterReflection(renderer, findWaterSurface(lakeScene()));
  const camera = { eye: [0, 20, 100], target: [0, 0, 0] };
  const mirrorDraws = () => renderedFrames.filter(frame => frame.reflectionTarget).length;
  renderer.render({ ...camera, pass: 'objectId' });
  assert.equal(mirrorDraws(), 0);
  assert.equal(renderedFrames.length, 1);
  renderer.render(camera);
  assert.equal(mirrorDraws(), 1);
  detach();
});

test('the mirror draw leaves out spot and area lights and the lit frame sends them again', () => {
  const counts = {};
  const context = new Proxy({}, { get: (_, name) => (name === 'uniform1i' ? (location, value) => { counts[location] = value; } : () => {}) });
  const renderer = Object.create(Renderer67.prototype);
  const lighting = { spotCount: 3, areaCount: 2, shadowCasters: [], pointShadows: [], spotPositions: [], spotColors: [], spotDirections: [], spotParameters: [], areaPositions: [], areaColors: [], areaNormals: [], areaTangents: [] };
  Object.assign(renderer, { context, lighting, uniforms: { spotLightCount: 'spot', areaLightCount: 'area' } });
  renderer.applyLocalLightUniforms(true);
  assert.deepEqual(counts, { spot: 0, area: 0 });
  renderer.applyLocalLightUniforms();
  assert.deepEqual(counts, { spot: 3, area: 2 });
});

function reuseRig(options) {
  const context = new Proxy({}, { get: (_, name) => (name === 'checkFramebufferStatus' ? () => 1 : name === 'FRAMEBUFFER_COMPLETE' ? 1 : typeof name === 'string' && name === name.toUpperCase() ? 0 : () => ({})) });
  const mirrorFrames = [];
  const renderer = { context, canvas: { width: 960, height: 540 }, hdr: false, viewProjection: new Float32Array(16), render: frame => frame.reflectionTarget && mirrorFrames.push(frame), updateParts() {}, dispose() {} };
  const detach = attachWaterReflection(renderer, findWaterSurface(lakeScene()), options);
  return { renderer, mirrorFrames, detach };
}

test('the mirror image is kept while the frame holds the same values, even when its arrays are changed in place', () => {
  const { renderer, mirrorFrames, detach } = reuseRig();
  const eye = [0, 20, 100];
  renderer.render({ eye, target: [0, 0, 0], time: 1 });
  renderer.render({ eye: [0, 20, 100], target: [0, 0, 0], time: 1 });
  assert.equal(mirrorFrames.length, 1);
  eye[0] = 5;
  renderer.render({ eye, target: [0, 0, 0], time: 1 });
  assert.equal(mirrorFrames.length, 2);
  renderer.render({ eye, target: [0, 0, 0], time: 2 });
  assert.equal(mirrorFrames.length, 3);
  detach();
});

test('a part update, a lower camera and a changed canvas size each draw the mirror image again', () => {
  const { renderer, mirrorFrames, detach } = reuseRig();
  const camera = { eye: [0, 20, 100], target: [0, 0, 0] };
  renderer.render(camera);
  renderer.render(camera);
  assert.equal(mirrorFrames.length, 1);
  renderer.updateParts([]);
  renderer.render(camera);
  assert.equal(mirrorFrames.length, 2);
  renderer.canvas.width = 1280;
  renderer.render(camera);
  assert.equal(mirrorFrames.length, 3);
  renderer.render({ eye: [0, -5, 100], target: [0, 0, 0] });
  renderer.render(camera);
  assert.equal(mirrorFrames.length, 4);
  detach();
});

test('updateEvery 2 keeps the picture for one lit frame after each draw, and detaching puts updateParts back', () => {
  const { renderer, mirrorFrames, detach } = reuseRig({ updateEvery: 2 });
  for (let step = 0; step < 6; step++) {
    renderer.render({ eye: [step, 20, 100], target: [0, 0, 0] });
  }
  assert.equal(mirrorFrames.length, 3);
  assert.notEqual(renderer.updateParts.name, 'updateParts');
  detach();
  assert.equal(renderer.updateParts.name, 'updateParts');
});

test('rougher water keeps the mirror pass and blurs it instead of dropping it', () => {
  for (const roughness of [0.05, 0.1, 0.13, 0.2, 0.35, 0.49]) {
    const result = applyWaterReflection(lakeScene({ ...WATER, roughness }));
    assert.equal(result.report.placed, true, `roughness ${roughness}`);
    assert.deepEqual(result.surface.partIndices, [1]);
  }
  assert.equal(applyWaterReflection(lakeScene({ ...WATER, roughness: WATER_BLUR_LIMIT_ROUGHNESS })).surface, null);
});

test('the mirror level is 0 up to roughness 0.1 and rises continuously to the limit', () => {
  assert.equal(waterMirrorLevel(0.04), 0);
  assert.equal(waterMirrorLevel(0.1), 0);
  assert.ok(waterMirrorLevel(0.13) > 0 && waterMirrorLevel(0.13) < 0.5, 'a step to 0.13 is a small blur, not a jump');
  assert.ok(waterMirrorLevel(0.2) > waterMirrorLevel(0.13));
  assert.ok(waterMirrorLevel(0.35) > waterMirrorLevel(0.2));
  assert.equal(waterMirrorLevel(WATER_BLUR_LIMIT_ROUGHNESS), WATER_MAXIMUM_BLUR_LEVEL);
  assert.equal(waterMirrorLevel(0.9), WATER_MAXIMUM_BLUR_LEVEL);
});

test('the mirror weight is 1 until the fade starts and 0 at the limit', () => {
  assert.equal(waterMirrorWeight(0.13), 1);
  assert.equal(waterMirrorWeight(0.35), 1);
  assert.ok(waterMirrorWeight(0.42) > 0 && waterMirrorWeight(0.42) < 1);
  assert.equal(waterMirrorWeight(WATER_BLUR_LIMIT_ROUGHNESS), 0);
});

test('the shader samples a mip level taken from roughness', () => {
  const source = createFragmentShader(['studioLighting', 'waterReflection']);
  assert.match(source, /float mirrorLevel = 5\.0 \* clamp\(\(roughness - 0\.10\) \/ 0\.40, 0\.0, 1\.0\)/);
  assert.match(source, /textureLod\(waterReflection,/);
});

test('worldBounds equals the per-axis formula it replaced, under a rotated and moved matrix', async () => {
  const { worldBounds } = await import('../src/probe-trace.js');
  const positions = new Float32Array(3 * 500);
  let state = 11;
  for (let index = 0; index < positions.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    positions[index] = (state / 2 ** 32 - 0.5) * 400;
  }
  const angle = 0.7;
  const matrix = [Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1.5, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, 120.25, -3.5, 40];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  assert.deepEqual(worldBounds({ geometry: { positions }, matrix }), { minimum, maximum });
});
