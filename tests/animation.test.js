import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, quat } from 'gl-matrix';
import { createAnimationClip, createAnimationPlayer, sampleAnimationClip } from '../src/animation.js';
import { createMotionScene } from '../src/motion.js';

function valueClip(interpolation = 'LINEAR', loop = false) {
  return createAnimationClip({ duration: 4, loop, tracks: [{ target: 'value', property: 'value', interpolation, keyframes: [{ time: 4, value: 8 }, { time: 0, value: 0 }, { time: 2, value: 4 }] }] });
}

test('keyframes normalize input order, clamp endpoints and sample independently of call order', () => {
  const clip = valueClip();
  const value = time => sampleAnimationClip(clip, time)[0].value;
  assert.equal(value(-10), 0);
  assert.equal(value(100), 8);
  assert.equal(value(1.5), 3);
  value(3);
  assert.equal(value(1.5), 3);
  assert.equal(value(2), 4);
  assert.deepEqual(clip.tracks[0].keyframes.map(key => key.time), [0, 2, 4]);
  assert.ok(Object.isFrozen(clip.tracks[0].keyframes));
});

test('STEP and SMOOTH interpolation retain their endpoint behavior', () => {
  const step = valueClip('STEP');
  assert.equal(sampleAnimationClip(step, 1.99)[0].value, 0);
  assert.equal(sampleAnimationClip(step, 2)[0].value, 4);
  assert.equal(sampleAnimationClip(step, 4)[0].value, 8);
  const smooth = valueClip('SMOOTH');
  assert.equal(sampleAnimationClip(smooth, 0.5)[0].value, 0.625);
  assert.equal(sampleAnimationClip(smooth, 1)[0].value, 2);
});

test('looping wraps exact endpoints and negative times', () => {
  const clip = valueClip('LINEAR', true);
  assert.equal(sampleAnimationClip(clip, 4)[0].value, 0);
  assert.equal(sampleAnimationClip(clip, 5)[0].value, 2);
  assert.equal(sampleAnimationClip(clip, -1)[0].value, 6);
});

test('quaternion keyframes normalize and interpolate the shortest arc', () => {
  const clip = createAnimationClip({ duration: 2, tracks: [{ target: 'part', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 2] }, { time: 2, value: [0, 0, 0, -3] }] }] });
  const rotation = sampleAnimationClip(clip, 1)[0].value;
  assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-6);
  assert.ok(Math.abs(rotation[3]) > 0.999);
  const halfTurn = createAnimationClip({ duration: 2, tracks: [{ target: 'part', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 2, value: [0, 1, 0, 0] }] }] });
  const midpoint = sampleAnimationClip(halfTurn, 1)[0].value;
  assert.ok(Math.abs(midpoint[1] - Math.SQRT1_2) < 1e-6);
});

test('bound animation preserves matrix identities and initial untracked transform components', () => {
  const matrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 35, 0), [1, 2, 3], [2, 3, 4]);
  const mesh = {};
  const part = { name: 'part', matrix, geometry: mesh, material: { emission: 0, roughness: 0.5 } };
  const initialBasis = Array.from(matrix.slice(0, 12));
  const clip = createAnimationClip({ duration: 2, tracks: [
    { target: 'part', property: 'translation', keyframes: [{ time: 0, value: [1, 2, 3] }, { time: 2, value: [5, 6, 7] }] },
    { target: 'part', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }] },
  ] });
  const player = createAnimationPlayer(clip, [part]);
  player.apply(1);
  const midpoint = Array.from(matrix);
  player.apply(2);
  player.apply(1);
  assert.deepEqual(Array.from(matrix), midpoint);
  assert.equal(part.matrix, matrix);
  assert.equal(part.geometry, mesh);
  assert.equal(part.material.emission, 1);
  assert.deepEqual(Array.from(matrix.slice(12, 15)), [3, 4, 5]);
  const scale = mat4.getScaling(new Float32Array(3), matrix);
  assert.ok(scale.every((value, axis) => Math.abs(value - [2, 3, 4][axis]) < 1e-5));
  assert.ok(Array.from(matrix.slice(0, 12)).every((value, axis) => Math.abs(value - initialBasis[axis]) < 1e-5));
});

test('motion sampling keeps geometry and matrix identities and frames portrait around the same focal point', () => {
  const scene = createMotionScene();
  const matrices = scene.parts.map(part => part.matrix);
  const meshes = scene.parts.map(part => part.geometry);
  const portrait = scene.sample(6, 'portrait');
  const expected = scene.parts.map(part => Array.from(part.matrix));
  scene.sample(2);
  scene.sample(11);
  scene.sample(6);
  for (let index = 0; index < scene.parts.length; index++) {
    assert.equal(scene.parts[index].matrix, matrices[index]);
    assert.equal(scene.parts[index].geometry, meshes[index]);
    assert.deepEqual(Array.from(scene.parts[index].matrix), expected[index]);
    assert.ok(Array.from(scene.parts[index].matrix).every(Number.isFinite));
  }
  assert.equal(scene.sample(3.99).shot, 0);
  assert.equal(scene.sample(4).shot, 1);
  assert.equal(scene.sample(8).shot, 2);
  assert.deepEqual(portrait.camera.target, scene.sample(6).camera.target);
  assert.ok(Math.hypot(...portrait.camera.eye) > Math.hypot(...scene.sample(6).camera.eye));
  assert.equal(scene.duration, 12);
  assert.equal(new Set(meshes).size, 5);
});

test('invalid tracks, values and bindings fail explicitly', () => {
  const track = { target: 'part', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] };
  assert.throws(() => createAnimationClip({ duration: 0 }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, loop: 'yes' }), TypeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, interpolation: 'CUBIC' }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, property: 'unknown' }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [{ time: 0, value: [NaN, 0, 0] }] }] }), TypeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [track, track] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [track.keyframes[0], track.keyframes[0]] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, keyframes: [{ time: 2, value: [0, 0, 0] }] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 0] }] }] }), RangeError);
  assert.throws(() => createAnimationClip({ duration: 1, tracks: [{ ...track, property: 'scale', keyframes: [{ time: 0, value: [0, 1, 1] }] }] }), RangeError);
  assert.throws(() => sampleAnimationClip(valueClip(), Infinity), TypeError);
  assert.throws(() => createAnimationPlayer(createAnimationClip({ duration: 1, tracks: [track] }), []), RangeError);
});
