import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilmScenes, FILM_DURATION, sampleFilm } from '../src/film.js';

test('film timeline includes every set with exact cut boundaries and terminal black', () => {
  const cuts = [[0, 'apparatus'], [5, 'atom'], [10, 'waves'], [13.5, 'desert'], [19, 'ignition'], [26, 'aftermath']];
  assert.equal(FILM_DURATION, 32);
  for (const [time, scene] of cuts) {
    const sample = sampleFilm(time);
    assert.equal(sample.scene, scene);
    assert.equal(sample.sceneTime, 0);
  }
  assert.deepEqual(sampleFilm(-10), sampleFilm(0));
  assert.deepEqual(sampleFilm(100), sampleFilm(32));
  assert.equal(sampleFilm(0).fade, 1);
  assert.equal(sampleFilm(2).fade, 0);
  assert.equal(sampleFilm(32).fade, 1);
  assert.equal(sampleFilm(29.5).title, 'CRITICAL');
  assert.equal(sampleFilm(29.5).titleOpacity, 1);
  assert.equal(sampleFilm(18.9).explosionProgress, 0);
  assert.equal(sampleFilm(19).flash, 1);
  assert.equal(sampleFilm(25.9).explosionProgress, 1);
  assert.equal(sampleFilm(27).explosionProgress, 1);
});

test('all frame samples are deterministic, finite, bounded and have usable cameras', () => {
  const scenes = createFilmScenes();
  for (let frame = 0; frame <= FILM_DURATION * 60; frame++) {
    const time = frame / 60;
    const sample = sampleFilm(time);
    assert.deepEqual(sample, sampleFilm(time));
    assert.ok(scenes[sample.scene]);
    for (const value of [...sample.camera.eye, ...sample.camera.target, sample.camera.fov, sample.exposure, sample.time, sample.sceneTime]) {
      assert.ok(Number.isFinite(value));
    }
    for (const value of [sample.fade, sample.monochrome, sample.explosionProgress, sample.flash, sample.titleOpacity]) {
      assert.ok(value >= 0 && value <= 1);
    }
    assert.ok(sample.camera.fov >= 20 && sample.camera.fov <= 65);
    assert.ok(Math.hypot(...sample.camera.eye.map((value, axis) => value - sample.camera.target[axis])) > 0.5);
  }
  for (const invalid of [NaN, Infinity, -Infinity, undefined, '1']) {
    assert.throws(() => sampleFilm(invalid), TypeError);
  }
});

test('camera motion stays continuous and eases to rest within each authored shot', () => {
  const boundaries = [0, 5, 10, 13.5, 17, 19, 26, 32];
  const distance = (first, second) => Math.hypot(...first.map((value, axis) => value - second[axis]));
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    assert.ok(distance(sampleFilm(start).camera.eye, sampleFilm(end - 0.001).camera.eye) > 0.1);
    assert.ok(distance(sampleFilm(start).camera.eye, sampleFilm(start + 0.001).camera.eye) < 0.001);
    assert.ok(distance(sampleFilm(end - 0.002).camera.eye, sampleFilm(end - 0.001).camera.eye) < 0.001);
    for (let time = start; time + 0.01 < end; time += 0.01) {
      assert.ok(distance(sampleFilm(time).camera.eye, sampleFilm(time + 0.01).camera.eye) < 0.1);
      assert.ok(distance(sampleFilm(time).camera.target, sampleFilm(time + 0.01).camera.target) < 0.04);
    }
  }
});

test('six 3D sets respect instancing, material, geometry and scene budgets', () => {
  const scenes = createFilmScenes();
  assert.equal(Object.keys(scenes).length, 6);
  const budgets = {};
  for (const [name, scene] of Object.entries(scenes)) {
    assert.equal(scene.ground, false);
    assert.ok(scene.environment.fogDensity >= 0);
    assert.equal(scene.environment.lightDirection.length, 3);
    assert.ok(scene.parts.length > 100 && scene.parts.length < 1000);
    const triangleCount = scene.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    assert.ok(triangleCount < 600000, name);
    assert.ok(new Set(scene.parts.map(part => part.geometry)).size <= 8);
    for (const part of scene.parts) {
      assert.ok(part.name);
      assert.ok(part.matrix instanceof Float32Array);
      assert.equal(part.matrix.length, 16);
      assert.equal(part.matrix[15], 1);
      assert.ok(Array.from(part.matrix).every(Number.isFinite));
      assert.ok(part.geometry.positions instanceof Float32Array);
      assert.ok(part.geometry.normals instanceof Float32Array);
      assert.ok(part.geometry.indices instanceof Uint32Array);
      assert.ok(part.material.color.every(value => value >= 0 && value <= 1));
      assert.ok(part.material.roughness > 0 && part.material.roughness <= 1);
      assert.ok(part.material.metallic >= 0 && part.material.metallic <= 1);
      assert.ok(part.material.emission >= 0);
    }
    budgets[name] = { parts: scene.parts.length, triangles: triangleCount };
  }
  assert.ok(scenes.ignition.parts.some(part => part.material.tag === 'fire'));
  assert.ok(scenes.ignition.parts.some(part => part.material.tag === 'smoke'));
  console.log(JSON.stringify(budgets));
});
