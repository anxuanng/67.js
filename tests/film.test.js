import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilmScenes, FILM_DURATION, FILM_SHOTS, sampleFilm } from '../src/film.js';
import { resolveEffects } from '../src/effects.js';
import { planRenderSize } from '../src/budget.js';
import { mat4 } from 'gl-matrix';
import { PerspectiveCamera, Vector3 } from 'three';

const distance = (first, second) => Math.hypot(...first.map((value, axis) => value - second[axis]));

test('187-second study has contiguous authored cuts, a late detonation and terminal black', () => {
  assert.equal(FILM_DURATION, 187);
  assert.ok(FILM_SHOTS.length >= 24 && FILM_SHOTS.length <= 35);
  assert.equal(FILM_SHOTS[0].start, 0);
  assert.equal(FILM_SHOTS.at(-1).end, FILM_DURATION);
  for (const [index, shot] of FILM_SHOTS.entries()) {
    assert.ok(shot.end > shot.start);
    if (index) assert.equal(shot.start, FILM_SHOTS[index - 1].end);
    assert.equal(sampleFilm(shot.start).shotIndex, index);
    assert.equal(sampleFilm(shot.start).scene, shot.scene);
    assert.equal(sampleFilm(shot.end - 0.00001).shotIndex, index);
  }
  assert.deepEqual(sampleFilm(-10), sampleFilm(0));
  assert.deepEqual(sampleFilm(1000), sampleFilm(FILM_DURATION));
  assert.equal(sampleFilm(0).fade, 1);
  assert.equal(sampleFilm(2).fade, 0);
  assert.equal(sampleFilm(FILM_DURATION).fade, 1);
  assert.equal(sampleFilm(180.9).title, '');
  assert.equal(sampleFilm(183).title, '');
  assert.equal(sampleFilm(185).title, 'OPPENHEIMER');
  assert.equal(sampleFilm(185).subtitle, 'A 67.js trailer study');
  assert.equal(sampleFilm(185).titleOpacity, 1);
  assert.equal(sampleFilm(180.9).explosionProgress, 0);
  assert.equal(sampleFilm(181).sceneTime, 0);
  assert.equal(sampleFilm(181).flash, 1);
  assert.equal(sampleFilm(183).explosionProgress, 1);
  assert.ok(sampleFilm(182).explosionProgress > 0.6);
});

test('random-access frame samples are finite and independent of playback order', () => {
  const scenes = createFilmScenes();
  const times = Array.from({ length: FILM_DURATION * 24 + 1 }, (_, index) => index / 24);
  const samples = times.map(sampleFilm);
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = sampleFilm(times[index]);
    assert.deepEqual(sample, samples[index]);
    assert.ok(scenes[sample.scene]);
    for (const value of [...sample.camera.eye, ...sample.camera.target, sample.camera.fov, sample.exposure, sample.time, sample.sceneTime]) {
      assert.ok(Number.isFinite(value));
    }
    for (const value of [sample.fade, sample.monochrome, sample.explosionProgress, sample.flash, sample.titleOpacity]) {
      assert.ok(value >= 0 && value <= 1);
    }
    assert.ok(sample.camera.fov >= 20 && sample.camera.fov <= 65);
    assert.ok(distance(sample.camera.eye, sample.camera.target) > 0.5);
    assert.doesNotThrow(() => resolveEffects(sample.effects));
  }
  for (const invalid of [NaN, Infinity, -Infinity, undefined, null, '1', {}]) {
    assert.throws(() => sampleFilm(invalid), TypeError);
  }
});

test('camera motion is continuous and eases to rest within each shot', () => {
  for (const shot of FILM_SHOTS) {
    assert.ok(distance(sampleFilm(shot.start).camera.eye, sampleFilm(shot.end - 0.001).camera.eye) > 0.1);
    assert.ok(distance(sampleFilm(shot.start).camera.eye, sampleFilm(shot.start + 0.001).camera.eye) < 0.001);
    assert.ok(distance(sampleFilm(shot.end - 0.002).camera.eye, sampleFilm(shot.end - 0.001).camera.eye) < 0.001);
    for (let time = shot.start; time + 0.01 < shot.end; time += 0.01) {
      assert.ok(distance(sampleFilm(time).camera.eye, sampleFilm(time + 0.01).camera.eye) < 0.12);
      assert.ok(distance(sampleFilm(time).camera.target, sampleFilm(time + 0.01).camera.target) < 0.05);
    }
  }
});

test('sets keep shared geometry, valid surfaces and the 384 MiB target budget', () => {
  const scenes = createFilmScenes();
  assert.ok(Object.keys(scenes).length >= 8);
  const referencedSets = new Set(FILM_SHOTS.map(shot => shot.scene));
  assert.deepEqual([...referencedSets].sort(), Object.keys(scenes).sort());
  const budgets = {};
  const checkedGeometries = new Set();
  for (const [name, scene] of Object.entries(scenes)) {
    assert.equal(scene.ground, false);
    assert.ok(scene.environment.fogDensity >= 0);
    assert.equal(scene.environment.lightDirection.length, 3);
    assert.ok(scene.parts.length > 100 && scene.parts.length <= 1500);
    const triangleCount = scene.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    assert.ok(triangleCount <= 700000, name);
    const geometries = new Set(scene.parts.map(part => part.geometry));
    assert.ok(geometries.size <= 12);
    let geometryBytes = scene.parts.length * 41 * 4;
    for (const geometry of geometries) {
      geometryBytes += geometry.positions.byteLength + geometry.normals.byteLength + geometry.indices.byteLength;
      if (checkedGeometries.has(geometry)) continue;
      checkedGeometries.add(geometry);
      assert.ok(geometry.positions instanceof Float32Array);
      assert.ok(geometry.normals instanceof Float32Array);
      assert.ok(geometry.indices instanceof Uint32Array);
      assert.equal(geometry.positions.length, geometry.normals.length);
      assert.ok(Array.from(geometry.positions).every(Number.isFinite));
      for (let vertex = 0; vertex < geometry.normals.length; vertex += 3) {
        assert.ok(Math.abs(Math.hypot(...geometry.normals.slice(vertex, vertex + 3)) - 1) < 0.00001);
      }
      for (const index of geometry.indices) assert.ok(index < geometry.positions.length / 3);
    }
    for (const part of scene.parts) {
      assert.ok(part.name);
      assert.ok(part.matrix instanceof Float32Array);
      assert.equal(part.matrix.length, 16);
      assert.equal(part.matrix[15], 1);
      assert.ok(Array.from(part.matrix).every(Number.isFinite));
      assert.ok(part.material.color.every(value => value >= 0 && value <= 1));
      assert.ok(part.material.roughness > 0 && part.material.roughness <= 1);
      assert.ok(part.material.metallic >= 0 && part.material.metallic <= 1);
      assert.ok(part.material.emission >= 0);
    }
    const plan = planRenderSize({ width: 1280, height: 720, samples: 4, memoryBudgetMiB: 384, hdr: true, bloom: true, geometryBytes });
    assert.equal(plan.reduced, false);
    assert.ok(plan.estimatedBytes < 384 * 1024 * 1024);
    budgets[name] = { parts: scene.parts.length, triangles: triangleCount, geometries: geometries.size, estimatedMiB: Math.round(plan.estimatedBytes / 1024 / 1024) };
  }
  assert.ok(scenes.ignition.parts.some(part => part.material.tag === 'fire'));
  assert.ok(scenes.ignition.parts.some(part => part.material.tag === 'smoke'));
  assert.ok(scenes.portrait.parts.some(part => part.name === 'Fedora sweeping brim'));
  assert.ok(scenes.settlement.parts.some(part => part.name === 'Army jeep chassis'));
  console.log(JSON.stringify(budgets));
});


test('authored motion is visible, deterministic and retains render identities across seeks', () => {
  const scenes = createFilmScenes();
  const snapshot = scene => scene.parts.map(part => ({ matrix: Array.from(part.matrix), color: [...part.material.color], emission: part.material.emission }));
  for (const name of ['sparks', 'atom', 'waves', 'control', 'gadget', 'settlement', 'portrait', 'desert', 'night']) {
    const scene = scenes[name];
    const identities = scene.parts.map(part => ({ part, geometry: part.geometry, matrix: part.matrix }));
    scene.animate(2.75);
    const expected = snapshot(scene);
    scene.animate(7.3);
    assert.notDeepEqual(snapshot(scene), expected, name);
    scene.animate(0);
    scene.animate(2.75);
    assert.deepEqual(snapshot(scene), expected, name);
    scene.parts.forEach((part, index) => {
      assert.equal(part, identities[index].part);
      assert.equal(part.geometry, identities[index].geometry);
      assert.equal(part.matrix, identities[index].matrix);
      assert.ok(Array.from(part.matrix).every(Number.isFinite));
    });
  }
});


test('tailored figure surfaces face outward and keep a closed shoulder silhouette', () => {
  const scene = createFilmScenes().portrait;
  const coat = scene.parts.find(part => part.name === 'Sculpted tailored jacket').geometry;
  let farthest = 0;
  for (let index = 3; index < coat.positions.length; index += 3) {
    if (coat.positions[index] > coat.positions[farthest]) farthest = index;
  }
  assert.ok(coat.normals[farthest] > 0.5);
  assert.ok(scene.parts.some(part => part.name === 'Tailored shoulder line'));
});

test('authored actor joints retain attached headwear and hands through holds and arbitrary seeks', () => {
  const scene = createFilmScenes().portrait;
  const head = scene.parts.find(part => part.name === 'Continuous sculpted head');
  const hat = scene.parts.find(part => part.name === 'Fedora tapered felt crown');
  const hand = scene.parts.find(part => part.name === 'Resting hand silhouette');
  const cuff = scene.parts.find(part => part.name === 'Shirt cuff' && part.actorJoint.name === hand.actorJoint.name);
  const relative = (parent, child) => Array.from(mat4.multiply(mat4.create(), mat4.invert(mat4.create(), parent.matrix), child.matrix));
  scene.animate(0);
  const headAttachment = relative(head, hat);
  const armAttachment = relative(cuff, hand);
  const assembled = Array.from(head.matrix);
  scene.animate(5);
  const held = Array.from(head.matrix);
  assert.notDeepEqual(held, assembled);
  scene.animate(6.5);
  assert.deepEqual(Array.from(head.matrix), held);
  for (const time of [10.3, 2.7, 23.9, 0, 5]) {
    scene.animate(time);
    relative(head, hat).forEach((value, index) => assert.ok(Math.abs(value - headAttachment[index]) < 1e-5));
    relative(cuff, hand).forEach((value, index) => assert.ok(Math.abs(value - armAttachment[index]) < 1e-5));
  }
  assert.deepEqual(Array.from(head.matrix), held);
  scene.animate(12);
  assert.deepEqual(Array.from(head.matrix), assembled);
});

test('facial features share the head joint and remain attached during arbitrary film seeks', () => {
  const scene = createFilmScenes().portrait;
  const head = scene.parts.find(part => part.name === 'Continuous sculpted head');
  const features = scene.parts.filter(part => part.name.startsWith('Facial '));
  assert.ok(features.length >= 12);
  assert.notEqual(head.material.tag, 'unlit');
  const relative = part => Array.from(mat4.multiply(mat4.create(), mat4.invert(mat4.create(), head.matrix), part.matrix));
  scene.animate(0);
  const initial = features.map(relative);
  for (const feature of features) assert.equal(feature.actorJoint, head.actorJoint);
  for (const time of [10.3, 2.7, 23.9, 0, 5]) {
    scene.animate(time);
    features.forEach((feature, index) => {
      relative(feature).forEach((value, element) => assert.ok(Math.abs(value - initial[index][element]) < 0.00002));
    });
  }
});

test('narrow portrait shots retain face and headwear through camera moves and backward seeks', () => {
  for (const aspect of [9 / 16, 390 / 844, 1]) {
    for (const time of [161, 162, 164.9, 150, 145, 153.9, 162]) {
      const sample = sampleFilm(time, { aspect });
      const expected = structuredClone(sample);
      sampleFilm(70, { aspect });
      assert.deepEqual(sampleFilm(time, { aspect }), expected);
      assert.equal(sample.camera.fov, sampleFilm(time).camera.fov);
      const camera = new PerspectiveCamera(sample.camera.fov, aspect, sample.camera.near, sample.camera.far);
      camera.position.fromArray(sample.camera.eye);
      camera.up.fromArray(sample.camera.up);
      camera.lookAt(...sample.camera.target);
      camera.updateMatrixWorld();
      for (const point of [[-0.22, 1.92, 0], [0.22, 1.92, 0], [0, 1.61, 0.15]]) {
        const projected = new Vector3(...point).project(camera);
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1, `${time}: ${point}`);
      }
    }
  }
  for (const time of [150, 162]) {
    const original = sampleFilm(time);
    assert.deepEqual(sampleFilm(time, { aspect: 16 / 9 }), original);
    const nearlyWide = sampleFilm(time, { aspect: 16 / 9 - 1e-6 });
    assert.ok(distance(original.camera.eye, nearlyWide.camera.eye) < 1e-5);
    assert.ok(distance(original.camera.target, nearlyWide.camera.target) < 1e-5);
  }
  for (const aspect of [0, -1, NaN, Infinity, 1e-320]) assert.throws(() => sampleFilm(10, { aspect }));
});
