import assert from 'node:assert/strict';
import test from 'node:test';
import { createWallEPreviewScene } from '../src/wall-e-preview-scene.js';
import { createModel } from '../src/model.js';
import { groupParts } from '../src/renderer.js';

function snapshot(scene) {
  return scene.parts.map(part => Array.from(part.matrix));
}

function close(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('preview preserves the assembled model, all instance identities and assembly data', () => {
  const scene = createWallEPreviewScene();
  const model = createModel();
  const identities = scene.parts.map(part => ({ part, matrix: part.matrix, geometry: part.geometry, material: part.material, assembly: part.assembly }));
  assert.equal(scene.parts.length, 574);
  assert.equal(new Set(scene.parts.map(part => part.geometry)).size, 7);
  scene.sample(0);
  for (let index = 0; index < model.length; index++) {
    assert.equal(scene.parts[index].name, model[index].name);
    assert.deepEqual(scene.parts[index].assembly, model[index].assembly);
    scene.parts[index].matrix.forEach((value, axis) => close(value, model[index].matrix[axis]));
  }
  for (const time of [3, 9, 1200, -7]) {
    scene.sample(time);
    for (const identity of identities) {
      assert.equal(scene.parts.includes(identity.part), true);
      for (const key of ['matrix', 'geometry', 'material', 'assembly']) assert.equal(identity.part[key], identity[key]);
    }
    assert.equal(groupParts(scene.parts).length, 7);
  }
});

test('absolute sampling is deterministic, periodic and rejects invalid seconds', () => {
  const scene = createWallEPreviewScene();
  const frame = scene.sample(1.25);
  const first = snapshot(scene);
  scene.sample(8);
  scene.sample(-100);
  assert.deepEqual(scene.sample(1.25), frame);
  assert.deepEqual(snapshot(scene), first);
  scene.sample(scene.duration + 1.25);
  assert.deepEqual(snapshot(scene), first);
  assert.deepEqual(frame.target, [0, 1.5, 0]);
  assert.equal(frame.effects.bloom.strength, 0);
  for (const invalid of [NaN, Infinity, -Infinity, undefined, '1']) assert.throws(() => scene.sample(invalid), TypeError);
});

test('both caterpillars circulate with coherent shoe/pad pairs and stationary ground contact', () => {
  const scene = createWallEPreviewScene();
  const base = snapshot(scene);
  scene.sample(1);
  for (const side of [-1, 1]) {
    const indices = scene.parts.flatMap((part, index) => part.name === 'Caterpillar steel shoe' && Math.sign(base[index][12]) === side ? [index] : []);
    assert.ok(indices.length > 25);
    let moved = 0;
    for (const index of indices) {
      const shoe = scene.parts[index];
      const pad = scene.parts[index + 1];
      assert.equal(pad.name, 'Caterpillar rubber traction pad');
      for (const axis of [12, 13, 14]) close(shoe.matrix[axis], pad.matrix[axis]);
      close(Math.atan2(shoe.matrix[6], shoe.matrix[5]), Math.atan2(pad.matrix[6], pad.matrix[5]));
      if (Math.abs(shoe.matrix[13] - base[index][13]) > 0.01) moved++;
      if (base[index][13] < 0.1 && base[index][14] > -0.3 && base[index][14] < 0.3) {
        close(shoe.matrix[13], base[index][13]);
        close(shoe.matrix[14], base[index][14]);
      }
    }
    assert.ok(moved > 5);
  }
});

test('wheel bolts orbit their own sprockets and retain their radius and x coordinate', () => {
  const scene = createWallEPreviewScene();
  const base = snapshot(scene);
  const centers = scene.parts.flatMap((part, index) => part.name === 'Track sprocket drum' ? [index] : []);
  scene.sample(3);
  for (let index = 0; index < scene.parts.length; index++) {
    const part = scene.parts[index];
    if (part.name !== 'Track wheel bolt') continue;
    const centerIndex = centers.filter(candidate => Math.sign(base[candidate][12]) === Math.sign(base[index][12])).reduce((closest, candidate) => {
      const distance = value => Math.hypot(base[index][13] - base[value][13], base[index][14] - base[value][14]);
      return distance(candidate) < distance(closest) ? candidate : closest;
    });
    const center = scene.parts[centerIndex];
    const radius = Math.hypot(base[index][13] - base[centerIndex][13], base[index][14] - base[centerIndex][14]);
    close(Math.hypot(part.matrix[13] - center.matrix[13], part.matrix[14] - center.matrix[14]), radius);
    close(part.matrix[12], base[index][12]);
    assert.ok(Math.hypot(part.matrix[13] - base[index][13], part.matrix[14] - base[index][14] - 0.28) > 0.02);
  }
});

test('travel eases through reversals and every transform stays continuous across the loop seam', () => {
  const scene = createWallEPreviewScene();
  for (const boundary of [3, 9, 12]) {
    scene.sample(boundary - 0.0001);
    const before = snapshot(scene);
    scene.sample(boundary + 0.0001);
    scene.parts.forEach((part, index) => part.matrix.forEach((value, axis) => close(value, before[index][axis], 0.0002)));
  }
  scene.sample(3);
  close(scene.parts[0].matrix[14], 0.28);
  scene.sample(9);
  close(scene.parts[0].matrix[14], -0.28);
  for (let time = 0; time < scene.duration; time += 0.125) {
    scene.sample(time);
    for (const part of scene.parts) assert.ok(Array.from(part.matrix).every(Number.isFinite));
  }
});
