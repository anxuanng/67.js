import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAnimationClip, sampleAnimationClip } from '../src/animation.js';
import { compileAgentMotion, normalizeAgentMotion } from '../src/agent-motion.js';
import { createCameraPath } from '../src/camera-path.js';
import { EASING_NAMES } from '../src/easing.js';
import { exportGlb } from '../src/export.js';
import { box } from '../src/geometry.js';
import { parseGltf } from '../src/gltf.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/blender/easing-golden.json', import.meta.url), 'utf8'));
const BLENDER_TOLERANCE = 1e-4;

function scalarClip(easing, duration = 1) {
  return createAnimationClip({
    duration,
    tracks: [{
      target: 'part', property: 'value',
      keyframes: [{ time: 0, value: 0, easing }, { time: duration, value: 1 }],
    }],
  });
}

test('every easing matches Blender 5.2 at 20 sample times within 1e-4', () => {
  assert.equal(golden.sampleCount, 20);
  for (const blenderCase of golden.cases) {
    const clip = scalarClip(blenderCase.easing);
    blenderCase.values.forEach((expected, index) => {
      const time = index / (golden.sampleCount - 1);
      const actual = sampleAnimationClip(clip, time)[0].value;
      assert.ok(Math.abs(actual - expected) < BLENDER_TOLERANCE, `${blenderCase.easing} at ${time}: ${actual} differs from Blender ${expected}`);
    });
  }
});

test('the golden covers every named easing except linear', () => {
  const covered = new Set(golden.cases.map(blenderCase => blenderCase.easing.replace(/\(.*/, '')));
  for (const name of EASING_NAMES.filter(name => name !== 'linear')) assert.ok(covered.has(name), `${name} has no Blender case`);
});

test('seeks are deterministic: the same time gives the same value in any order', () => {
  for (const name of EASING_NAMES) {
    const clip = scalarClip(name);
    const forward = [0.1, 0.37, 0.8].map(time => sampleAnimationClip(clip, time)[0].value);
    const backward = [0.8, 0.37, 0.1].map(time => sampleAnimationClip(clip, time)[0].value).reverse();
    assert.deepEqual(backward, forward, name);
  }
  const bezier = scalarClip('cubic-bezier(0.34, 1.56, 0.64, 1)');
  assert.equal(sampleAnimationClip(bezier, 0.42)[0].value, sampleAnimationClip(bezier, 0.42)[0].value);
});

test('segments start and end on their keyframe values', () => {
  for (const name of EASING_NAMES) {
    const clip = scalarClip(name);
    assert.ok(Math.abs(sampleAnimationClip(clip, 0)[0].value) < 1e-12, name);
    assert.ok(Math.abs(sampleAnimationClip(clip, 1)[0].value - 1) < 1e-12, name);
  }
});

test('cubic-bezier follows the CSS curve and may overshoot with y outside 0..1', () => {
  const ease = scalarClip('cubic-bezier(0.25, 0.1, 0.25, 1)');
  // The CSS "ease" curve at 0.5 progress is about 0.8024.
  assert.ok(Math.abs(sampleAnimationClip(ease, 0.5)[0].value - 0.80240) < 1e-3);
  const diagonal = scalarClip('cubic-bezier(0.25, 0.25, 0.75, 0.75)');
  assert.ok(Math.abs(sampleAnimationClip(diagonal, 0.3)[0].value - 0.3) < 1e-6);
  const overshoot = scalarClip('cubic-bezier(0.34, 1.56, 0.64, 1)');
  assert.ok(sampleAnimationClip(overshoot, 0.5)[0].value > 1);
});

test('easing applies to rotation, applies to the segment after its keyframe and replaces smoothstep', () => {
  const quaternionEnd = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
  const rotation = createAnimationClip({
    duration: 1,
    tracks: [{ target: 'part', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1], easing: 'easeInQuad' }, { time: 1, value: quaternionEnd }] }],
  });
  const halfway = sampleAnimationClip(rotation, 0.5)[0].value;
  const angle = 2 * Math.atan2(halfway[2], halfway[3]);
  assert.ok(Math.abs(angle - 0.25 * Math.PI / 2) < 1e-9);
  const smooth = createAnimationClip({
    duration: 2,
    tracks: [{
      target: 'part', property: 'value', interpolation: 'SMOOTH',
      keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1, easing: 'linear' }, { time: 2, value: 2 }],
    }],
  });
  assert.ok(Math.abs(sampleAnimationClip(smooth, 0.25)[0].value - 0.15625) < 1e-12);
  assert.ok(Math.abs(sampleAnimationClip(smooth, 1.25)[0].value - 1.25) < 1e-12);
});

test('an unknown easing is an error that names the valid forms', () => {
  assert.throws(() => scalarClip('bouncy'), /Unknown easing "bouncy".*easeOutBack/);
  assert.throws(() => scalarClip('easeoutback'), /Did you mean easeOutBack/);
  assert.throws(() => scalarClip('easeOutBounc'), /Unknown easing/);
  assert.throws(() => scalarClip('cubic-bezier(0.5, 1)'), /needs four numbers/);
  assert.throws(() => scalarClip('cubic-bezier(1.5, 0, 0.5, 1)'), /x1 must be a number from 0 to 1/);
  assert.throws(() => scalarClip('cubic-bezier(0, 0, 1, 99)'), /y2 must be a number from -4 to 5/);
  assert.throws(() => scalarClip(7), /Unknown easing 7/);
});

test('Back and Elastic take bounded arguments and other easings take none', () => {
  const defaultOvershoot = scalarClip('easeOutBack');
  const explicitOvershoot = scalarClip('easeOutBack(1.70158)');
  assert.equal(sampleAnimationClip(defaultOvershoot, 0.4)[0].value, sampleAnimationClip(explicitOvershoot, 0.4)[0].value);
  assert.ok(sampleAnimationClip(scalarClip('easeOutBack(4)'), 0.4)[0].value > sampleAnimationClip(defaultOvershoot, 0.4)[0].value);
  assert.equal(sampleAnimationClip(scalarClip('easeOutElastic(1)'), 0.3)[0].value, sampleAnimationClip(scalarClip('easeOutElastic(1, 0.3)'), 0.3)[0].value);
  assert.equal(sampleAnimationClip(scalarClip(' easeOutBack ( 2 ) '), 0.4)[0].value, sampleAnimationClip(scalarClip('easeOutBack(2)'), 0.4)[0].value);
  assert.throws(() => scalarClip('easeOutSine(2)'), /easeOutSine takes no arguments/);
  assert.throws(() => scalarClip('easeOutBack(1, 2)'), /easeOutBack takes at most 1 argument: easeOutBack\(overshoot\)/);
  assert.throws(() => scalarClip('easeOutBack(11)'), /easeOutBack overshoot must be a number from 0 to 10/);
  assert.throws(() => scalarClip('easeOutElastic(0.5)'), /easeOutElastic amplitude must be a number from 1 to 10/);
  assert.throws(() => scalarClip('easeOutElastic(2, 0)'), /easeOutElastic period must be a number from 0.05 to 2/);
  assert.throws(() => scalarClip('easeOutBack(fast)'), /arguments must be finite numbers/);
  assert.throws(() => scalarClip('linear(1)'), /linear takes no arguments/);
});

test('easing is rejected on STEP and CUBICSPLINE tracks', () => {
  const keyframes = [{ time: 0, value: 0, easing: 'easeOutBack', inTangent: 0, outTangent: 0 }, { time: 1, value: 1, inTangent: 0, outTangent: 0 }];
  for (const interpolation of ['STEP', 'CUBICSPLINE']) {
    assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ target: 'part', property: 'value', interpolation, keyframes }] }), /needs LINEAR or SMOOTH/);
  }
});

const recipe = {
  nodes: [{ id: 'lid' }],
  materials: [{ id: 'bulb', tag: 'surface', color: [0.2, 0.3, 0.4], roughness: 0.5, metallic: 0, emission: 0 }],
  camera: { eye: [1, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
};

test('recipe motion keeps easing on node, material and camera tracks and rejects an unknown name', () => {
  const input = {
    duration: 1,
    tracks: [
      { kind: 'node', id: 'lid', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0], easing: 'easeOutBack(3)' }, { time: 1, value: [0, 1, 0] }] },
      { kind: 'material', id: 'bulb', property: 'emission', keyframes: [{ time: 0, value: 0, easing: 'easeInOutCubic' }, { time: 1, value: 4 }] },
      { kind: 'camera', property: 'fov', keyframes: [{ time: 0, value: 30, easing: 'cubic-bezier(0.2, 0, 0, 1)' }, { time: 1, value: 60 }] },
    ],
  };
  const normalized = normalizeAgentMotion(input, recipe);
  assert.equal(normalized.tracks[0].keyframes[0].easing, 'easeOutBack(3)');
  assert.equal(normalized.tracks[1].keyframes[0].easing, 'easeInOutCubic');
  assert.equal(normalized.tracks[2].keyframes[0].easing, 'cubic-bezier(0.2, 0, 0, 1)');
  const sampler = compileAgentMotion(input, recipe);
  const overshootOutput = sampler.sample(0.6);
  assert.ok(overshootOutput.nodes.get('lid').translation[1] > 1, 'easeOutBack passes its end value');
  assert.ok(sampler.sample(0.6).nodes.get('lid').translation[1] === overshootOutput.nodes.get('lid').translation[1]);
  input.tracks[0].keyframes[0].easing = 'springy';
  assert.throws(() => normalizeAgentMotion(input, recipe), /Unknown easing "springy"/);
});

test('camera path channels take easing', () => {
  const path = createCameraPath({
    duration: 1,
    fov: { keyframes: [{ time: 0, value: 30, easing: 'easeInQuad' }, { time: 1, value: 50 }] },
    eye: [0, 0, 4],
  });
  assert.ok(Math.abs(path.sample(0.5).fov - 35) < 1e-9);
});

test('GLB export bakes eased tracks to linear samples that follow the curve', async () => {
  const part = { name: 'Lid', geometry: box(), matrix: mat4.create(), material: { color: [1, 1, 1], metallic: 0, roughness: 1 } };
  const clip = createAnimationClip({
    duration: 1,
    tracks: [{ target: 'Lid', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0], easing: 'easeOutBounce' }, { time: 1, value: [0, 1, 0] }] }],
  });
  const copy = await parseGltf(exportGlb([part], { clips: [{ name: 'Drop', ...clip }] }));
  const track = copy.animations[0].tracks[0];
  assert.ok(track.times.length > 16, 'the eased segment is sampled, not written as two keys');
  const tolerance = 1e-5;
  track.times.forEach((time, index) => {
    const expected = sampleAnimationClip(clip, time)[0].value[1];
    assert.ok(Math.abs(track.values[index * 3 + 1] - expected) < tolerance, `sample at ${time}`);
  });
});
