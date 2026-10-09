import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, quat } from 'gl-matrix';
import { AnimationClip, AnimationMixer, NumberKeyframeTrack, Object3D, QuaternionKeyframeTrack } from 'three';
import { createAnimationClip, createAnimationPlayer } from '../src/animation.js';
import { createAnimationMixer } from '../src/animation-mixer.js';

function constantClip(target, property, value) {
  return createAnimationClip({ duration: 2, tracks: [{ target, property, keyframes: [{ time: 0, value }] }] });
}

test('players and mixers retain the same isolated material across bindings', () => {
  const target = part('part');
  const player = createAnimationPlayer(constantClip('part', 'emission', 2), [target]);
  const material = target.material;
  const mixer = createAnimationMixer([target]);
  mixer.clipAction(constantClip('part', 'roughness', 0.8)).play();
  mixer.apply(1);
  player.apply(1);
  assert.equal(target.material, material);
  assert.equal(target.material.emission, 2);
  assert.equal(target.material.roughness, 0.8);
});

test('clamped spline scale poses can bind another player or mixer after Float32 rounding', () => {
  const target = part('part');
  const clip = createAnimationClip({ duration: 2, tracks: [{
    target: 'part', property: 'scale', interpolation: 'CUBICSPLINE', keyframes: [
      { time: 0, value: [1, 1, 1], inTangent: [0, 0, 0], outTangent: [-20, 0, 0] },
      { time: 2, value: [1, 1, 1], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
    ],
  }] });
  const mixer = createAnimationMixer([target]);
  mixer.clipAction(clip).play();
  mixer.apply(1);
  assert.equal(target.matrix[0], Math.fround(1e-8));
  assert.doesNotThrow(() => createAnimationMixer([target]));
  assert.doesNotThrow(() => createAnimationPlayer(clip, [target]));
});

function part(name, translation = [0, 0, 0], scale = [1, 1, 1], material = { emission: 0, metallic: 0.2, roughness: 0.5 }) {
  return { name, matrix: mat4.fromRotationTranslationScale(mat4.create(), [0, 0, 0, 1], translation, scale), material };
}

function rotation(angles) {
  return Array.from(quat.fromEuler(new Float64Array(4), ...angles));
}

function close(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

function sceneSnapshot(parts) {
  return parts.map(current => ({ matrix: Array.from(current.matrix), material: { ...current.material } }));
}

test('overlapping walk, head and gesture clips blend per property with captured base pose', () => {
  const parts = [part('body', [1, 2, 3], [2, 3, 4]), part('foot'), part('head'), part('hand')];
  const walk = createAnimationClip({ duration: 2, tracks: [
    { target: 'body', property: 'translation', keyframes: [{ time: 0, value: [0, 2, 3] }, { time: 2, value: [4, 2, 3] }] },
    { target: 'foot', property: 'rotation', keyframes: [{ time: 0, value: rotation([90, 0, 0]) }] },
  ] });
  const head = constantClip('head', 'rotation', rotation([0, 60, 0]));
  const gesture = createAnimationClip({ duration: 2, tracks: [
    { target: 'body', property: 'translation', keyframes: [{ time: 0, value: [6, 2, 3] }] },
    { target: 'hand', property: 'rotation', keyframes: [{ time: 0, value: rotation([0, 0, 90]) }] },
    { target: 'hand', property: 'emission', keyframes: [{ time: 0, value: 4 }] },
  ] });
  const mixer = createAnimationMixer(parts);
  mixer.clipAction(walk).play({ weight: 0.75 });
  mixer.clipAction(head).play({ weight: 0.5 });
  mixer.clipAction(gesture).play({ weight: 0.25 });
  assert.equal(mixer.apply(1), parts);
  close(parts[0].matrix[12], 3);
  assert.deepEqual(Array.from(parts[0].matrix.slice(13, 15)), [2, 3]);
  assert.deepEqual(Array.from(mat4.getScaling(new Float64Array(3), parts[0].matrix)), [2, 3, 4]);
  close(parts[1].matrix[5], Math.cos(67.5 * Math.PI / 180));
  close(parts[2].matrix[0], Math.cos(Math.PI / 6));
  close(parts[3].matrix[0], Math.cos(Math.PI / 8));
  assert.equal(parts[3].material.emission, 1);
});

test('weights above a total of one normalize and match installed Three PropertyMixer semantics', () => {
  const current = part('body', [10, 0, 0]);
  const mixer = createAnimationMixer([current]);
  mixer.clipAction(constantClip('body', 'translation', [2, 0, 0])).play({ weight: 1 });
  mixer.clipAction(constantClip('body', 'translation', [6, 0, 0])).play({ weight: 0.5 });
  mixer.apply(1);
  close(current.matrix[12], 10 / 3);

  const reference = new Object3D();
  reference.position.x = 10;
  const referenceMixer = new AnimationMixer(reference);
  referenceMixer.clipAction(new AnimationClip('first', 2, [new NumberKeyframeTrack('.position[x]', [0], [2])])).setEffectiveWeight(1).play();
  referenceMixer.clipAction(new AnimationClip('second', 2, [new NumberKeyframeTrack('.position[x]', [0], [6])])).setEffectiveWeight(0.5).play();
  referenceMixer.setTime(1);
  close(current.matrix[12], reference.position.x);
});

test('shortest-arc quaternion mixing handles antipodes and matches Three for two actions', () => {
  const current = part('head');
  const firstRotation = rotation([0, 40, 0]);
  const antipode = firstRotation.map(component => -component);
  const mixer = createAnimationMixer([current]);
  const first = mixer.clipAction(constantClip('head', 'rotation', firstRotation)).play({ weight: 0.5 });
  const second = mixer.clipAction(constantClip('head', 'rotation', antipode)).play({ weight: 0.5 });
  mixer.apply(1);
  const expected = mat4.fromQuat(mat4.create(), firstRotation);
  for (let index = 0; index < 16; index++) close(current.matrix[index], expected[index]);
  close(Math.hypot(...mat4.getRotation(new Float64Array(4), current.matrix)), 1);

  const reference = new Object3D();
  const referenceMixer = new AnimationMixer(reference);
  for (const [index, quaternion] of [firstRotation, antipode].entries()) {
    referenceMixer.clipAction(new AnimationClip(`rotation-${index}`, 2, [new QuaternionKeyframeTrack('.quaternion', [0], quaternion)])).setEffectiveWeight(0.5).play();
  }
  referenceMixer.setTime(1);
  reference.updateMatrix();
  for (let index = 0; index < 16; index++) close(current.matrix[index], reference.matrix.elements[index]);
  first.stop(2);
  second.stop(2);
  mixer.apply(2);
  assert.deepEqual(current.matrix, mat4.create());
});

test('crossfades retain boundary continuity and replay correctly across arbitrary seeks', () => {
  const current = part('body');
  const mixer = createAnimationMixer([current]);
  const firstClip = constantClip('body', 'translation', [0, 0, 0]);
  const first = mixer.clipAction(firstClip).play();
  const second = mixer.clipAction(constantClip('body', 'translation', [10, 0, 0]));
  assert.equal(mixer.clipAction(firstClip), first);
  mixer.crossFade(first, second, { at: 2, duration: 2 });
  assert.equal(second.getState(1).phase, 'scheduled');
  assert.equal(first.getState(3).phase, 'fading');
  assert.equal(first.getState(4).weight, 0);
  assert.equal(second.getState(4).weight, 1);
  for (const [time, expected] of [[2, 0], [3, 5], [4, 10], [2 - 1e-6, 0], [2 + 1e-6, 5e-6], [4 - 1e-6, 10 - 5e-6], [4 + 1e-6, 10]]) {
    mixer.apply(time);
    close(current.matrix[12], expected);
  }
  second.stop(6);
  const saved = new Map();
  for (const time of [-1, 0, 2.5, 3, 5, 6, 100]) {
    mixer.apply(time);
    saved.set(time, sceneSnapshot([current]));
  }
  for (const time of [100, 3, -1, 6, 2.5, 5, 0, 3]) {
    mixer.apply(time);
    assert.deepEqual(sceneSnapshot([current]), saved.get(time));
  }
  assert.equal(second.getState(100).phase, 'stopped');
  assert.equal(second.getState(5).playing, true);
});

test('interrupted fades preserve earlier history and restart continuously from the scheduled weight', () => {
  const current = part('body', [2, 0, 0]);
  const mixer = createAnimationMixer([current]);
  const action = mixer.clipAction(constantClip('body', 'translation', [10, 0, 0])).play();
  action.fadeTo(0, { at: 2, duration: 2 });
  action.fadeTo(1, { at: 3, duration: 2 });
  assert.equal(action.getState(2.5).weight, 0.75);
  assert.equal(action.getState(3).weight, 0.5);
  assert.equal(action.getState(4).weight, 0.75);
  assert.equal(action.getState(5).weight, 1);
  for (const time of [5, 3, 2.5, 4, 2.5]) {
    mixer.apply(time);
    close(current.matrix[12], 2 + 8 * action.getState(time).weight);
  }
  mixer.apply(3 - 1e-7);
  const before = current.matrix[12];
  mixer.apply(3 + 1e-7);
  close(current.matrix[12], before);
});

test('play, stop and replay use explicit origins, offsets and signed time scales', () => {
  const current = part('body');
  const clip = createAnimationClip({ duration: 2, loop: true, tracks: [{ target: 'body', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [2, 0, 0] }] }] });
  const mixer = createAnimationMixer([current]);
  const action = mixer.clipAction(clip).play({ at: 3, offset: 1.5, timeScale: -1 });
  action.stop(5);
  action.play({ at: 6, offset: 0.5, timeScale: 0 });
  for (const [time, expected] of [[2, 0], [3, 1.5], [4, 0.5], [5, 0], [10, 0.5], [4, 0.5]]) {
    mixer.apply(time);
    close(current.matrix[12], expected);
  }
  mixer.apply(12);
  action.play();
  assert.equal(action.getState(12).localTime, 0);
  assert.equal(mixer.time, 12);
});

test('material blending isolates shared frozen materials and retains identities', () => {
  const shared = Object.freeze({ emission: 2, metallic: 0.3, roughness: 0.6, map: {} });
  const parts = [part('first', [0, 0, 0], [1, 1, 1], shared), part('second', [0, 0, 0], [1, 1, 1], shared), part('untracked', [0, 0, 0], [1, 1, 1], shared)];
  const mixer = createAnimationMixer(parts);
  const first = mixer.clipAction(constantClip('first', 'emission', 10)).play({ weight: 0.5 });
  mixer.clipAction(constantClip('second', 'emission', 4)).play();
  const matrices = parts.map(current => current.matrix);
  const materials = parts.map(current => current.material);
  assert.notEqual(materials[0], materials[1]);
  assert.notEqual(materials[0], shared);
  assert.equal(materials[2], shared);
  for (const time of [0, 1, 0.5]) {
    mixer.apply(time);
    assert.equal(parts[0].material.emission, 6);
    assert.equal(parts[1].material.emission, 4);
    for (let index = 0; index < parts.length; index++) {
      assert.equal(parts[index].matrix, matrices[index]);
      assert.equal(parts[index].material, materials[index]);
      assert.equal(parts[index].material.map, shared.map);
    }
  }
  first.stop(2);
  mixer.apply(2);
  assert.equal(parts[0].material.emission, 2);
  assert.equal(shared.emission, 2);
});

test('invalid control commands do not corrupt action timelines or partial crossfades', () => {
  const current = part('body');
  const mixer = createAnimationMixer([current]);
  const first = mixer.clipAction(constantClip('body', 'translation', [2, 0, 0])).play();
  const second = mixer.clipAction(constantClip('body', 'translation', [10, 0, 0]));
  for (const weight of [-1, 1.1, Infinity, NaN, '1']) {
    assert.throws(() => first.play({ at: 1, weight }), RangeError);
    assert.throws(() => first.fadeTo(weight, { at: 1, duration: 1 }), RangeError);
  }
  for (const duration of [0, -1, Infinity, NaN]) {
    assert.throws(() => mixer.crossFade(first, second, { at: 1, duration }), RangeError);
  }
  assert.equal(first.getState(2).weight, 1);
  assert.equal(second.getState(2).playing, false);
  assert.throws(() => first.fadeTo(0, { at: 1e308, duration: 1 }), RangeError);
  assert.throws(() => first.play({ at: Infinity }), TypeError);
  assert.throws(() => first.play({ timeScale: NaN }), TypeError);
  assert.throws(() => first.play({ offset: Infinity }), TypeError);
  second.play({ at: 10 });
  assert.throws(() => mixer.crossFade(first, second, { at: 2, duration: 2 }), /nondecreasing/);
  assert.equal(first.getState(3).weight, 1);
  assert.throws(() => mixer.crossFade(first, first, { at: 2, duration: 2 }), RangeError);
  assert.throws(() => mixer.crossFade(first, {}, { at: 2, duration: 2 }), RangeError);
  first.stop(4);
  assert.throws(() => first.fadeTo(1, { at: 5, duration: 1 }), /Play/);
  assert.throws(() => first.play({ at: 3 }), /nondecreasing/);
  assert.throws(() => mixer.apply(NaN), TypeError);
});

test('spline domains stay positive and zero-weight invalid curves do not run', () => {
  const current = part('body');
  const clip = createAnimationClip({ duration: 2, tracks: [
    { target: 'body', property: 'scale', interpolation: 'CUBICSPLINE', keyframes: [
      { time: 0, value: [1, 1, 1], inTangent: [0, 0, 0], outTangent: [-20, 0, 0] },
      { time: 2, value: [1, 1, 1], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
    ] },
    { target: 'body', property: 'roughness', interpolation: 'CUBICSPLINE', keyframes: [
      { time: 0, value: 0.5, inTangent: 0, outTangent: -20 },
      { time: 2, value: 0.5, inTangent: 0, outTangent: 0 },
    ] },
  ] });
  const mixer = createAnimationMixer([current]);
  mixer.clipAction(clip).play();
  mixer.apply(1);
  assert.ok(current.matrix[0] > 0);
  assert.equal(current.material.roughness, 1e-8);
  const invalidRotation = createAnimationClip({ duration: 2, tracks: [{ target: 'body', property: 'rotation', interpolation: 'CUBICSPLINE', keyframes: [
    { time: 0, value: [0, 0, 0, 1], inTangent: [0, 0, 0, 0], outTangent: [0, 0, 0, 0] },
    { time: 2, value: [0, 0, 0, -1], inTangent: [0, 0, 0, 0], outTangent: [0, 0, 0, 0] },
  ] }] });
  const invalidAction = mixer.clipAction(invalidRotation).play({ weight: 0 });
  assert.doesNotThrow(() => mixer.apply(1));
  const expected = sceneSnapshot([current]);
  invalidAction.play({ at: 1, offset: 1, weight: 1 });
  assert.throws(() => mixer.apply(1), /invalid quaternion/);
  assert.deepEqual(sceneSnapshot([current]), expected);
  assert.equal(mixer.time, 1);
});

test('invalid samples leave every matrix, material and last successful time unchanged', () => {
  const parts = [part('first'), part('second')];
  const mixer = createAnimationMixer(parts);
  const valid = mixer.clipAction(createAnimationClip({ duration: 2, tracks: [
    { target: 'first', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [2, 0, 0] }] },
    { target: 'first', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 2 }] },
  ] })).play();
  mixer.apply(0.5);
  const expected = sceneSnapshot(parts);
  const invalid = mixer.clipAction(createAnimationClip({ duration: 2, tracks: [{ target: 'second', property: 'translation', keyframes: [
    { time: 0, value: [0, 0, 0] }, { time: 2, value: [1e100, 0, 0] },
  ] }] })).play();
  assert.throws(() => mixer.apply(1), /finite Float32/);
  assert.deepEqual(sceneSnapshot(parts), expected);
  assert.equal(mixer.time, 0.5);
  invalid.stop(1);
  mixer.apply(1);
  assert.equal(parts[0].matrix[12], 1);
  assert.equal(parts[0].material.emission, 1);
  assert.equal(valid.getState(1).weight, 1);
});

test('retained transform buffers survive hundreds of seeks without replacement', () => {
  const current = part('body');
  const mixer = createAnimationMixer([current]);
  const first = mixer.clipAction(constantClip('body', 'translation', [2, 0, 0])).play();
  const second = mixer.clipAction(constantClip('body', 'translation', [6, 0, 0]));
  mixer.crossFade(first, second, { at: 0, duration: 10 });
  const originalCompose = mat4.fromRotationTranslationScale;
  let retained;
  let calls = 0;
  mat4.fromRotationTranslationScale = (output, rotationValue, translation, scale) => {
    if (!retained) retained = [output, rotationValue, translation, scale];
    else {
      assert.equal(output, retained[0]);
      assert.equal(rotationValue, retained[1]);
      assert.equal(translation, retained[2]);
      assert.equal(scale, retained[3]);
    }
    calls++;
    return originalCompose(output, rotationValue, translation, scale);
  };
  try {
    for (let frame = 0; frame < 200; frame++) mixer.apply((frame * 17 % 100) / 10);
  } finally {
    mat4.fromRotationTranslationScale = originalCompose;
  }
  assert.equal(calls, 200);
});

test('invalid bindings fail without publishing partially registered material copies', () => {
  const current = part('body');
  const material = current.material;
  const mixer = createAnimationMixer([current]);
  const invalidClip = createAnimationClip({ duration: 2, tracks: [
    { target: 'body', property: 'emission', keyframes: [{ time: 0, value: 1 }] },
    { target: 'missing', property: 'emission', keyframes: [{ time: 0, value: 1 }] },
  ] });
  assert.throws(() => mixer.clipAction(invalidClip), /not found/);
  assert.equal(current.material, material);
  assert.throws(() => mixer.clipAction(constantClip('body', 'value', 1)), /Value tracks/);
  assert.throws(() => createAnimationMixer([current, current]), /Duplicate/);
  assert.throws(() => createAnimationMixer([{ name: 'body', matrix: mat4.create().fill(NaN) }]), TypeError);
  const projective = part('projective');
  projective.matrix[3] = 1;
  assert.throws(() => createAnimationMixer([projective]), /affine/);
  const shear = part('shear');
  shear.matrix[4] = 0.5;
  assert.throws(() => createAnimationMixer([shear]), /shear/);
});
