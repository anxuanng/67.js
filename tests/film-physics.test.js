import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPhysicsScene } from '../src/physics.js';
import { CRADLE, CRADLE_BAKE_OPTIONS, cradlePivot, createCradleDefinition } from '../src/film-physics-definition.js';
import recording from '../src/film-physics-clip.json' with { type: 'json' };
import { createFilmScenes, sampleFilm } from '../src/film.js';
import { PerspectiveCamera, Vector3 } from 'three';

test('committed film motion matches the named solver bake and physical collisions transfer energy', async () => {
  const definition = createCradleDefinition();
  assert.equal(recording.provenance.definitionHash, createHash('sha256').update(JSON.stringify({ definition, options: CRADLE_BAKE_OPTIONS })).digest('hex'));
  const physics = await createPhysicsScene(definition, CRADLE_BAKE_OPTIONS);
  try {
    assert.equal(recording.provenance.timelineBytes, physics.memoryPlan.timelineBytes);
    const pose = new Float32Array(physics.bodyNames.length * 7);
    for (let frame = 0; frame <= CRADLE.duration * CRADLE.captureRate; frame++) {
      physics.sample(frame / CRADLE.captureRate, pose);
      for (let index = 0; index < CRADLE.count; index++) {
        const offset = physics.bodyIndex(`Cradle ball ${index}`) * 7;
        const position = recording.tracks[index * 2].keyframes[frame].value;
        const rotation = recording.tracks[index * 2 + 1].keyframes[frame].value;
        assert.deepEqual([...position, ...rotation], Array.from(pose.subarray(offset, offset + 7)));
        assert.ok(Math.abs(Math.hypot(...position.map((component, axis) => component - cradlePivot(index)[axis])) - CRADLE.length) < 0.001);
        assert.ok(Math.abs(position[0]) + CRADLE.radius < 1.45 - 0.025, 'The whole swing envelope must clear both visible supports');
      }
    }
    const first = recording.tracks[0].keyframes;
    const last = recording.tracks[(CRADLE.count - 1) * 2].keyframes;
    assert.ok(first[0].value[0] < cradlePivot(0)[0] - 0.5);
    assert.ok(last[30].value[0] > cradlePivot(CRADLE.count - 1)[0] + 0.5);
    for (let index = 1; index < CRADLE.count - 1; index++) {
      assert.ok(Math.abs(recording.tracks[index * 2].keyframes[30].value[0] - cradlePivot(index)[0]) < 0.02);
    }
  } finally {
    physics.dispose();
  }
  const withoutContact = createCradleDefinition();
  for (const collider of withoutContact.colliders) collider.radius = 0.001;
  const isolated = await createPhysicsScene(withoutContact, CRADLE_BAKE_OPTIONS);
  try {
    const pose = isolated.sample(1);
    const last = isolated.bodyIndex('Cradle ball 4') * 7;
    assert.ok(Math.abs(pose[last] - cradlePivot(4)[0]) < 1e-6, 'Without contacts, energy cannot reach the initially stationary end ball');
  } finally {
    isolated.dispose();
  }
});

test('film playback retains balls and suspension matrices and reproduces backward seeks', () => {
  const scene = createFilmScenes().apparatus;
  const parts = scene.parts.filter(part => part.name.startsWith('Cradle ball ') || part.cradleCord);
  const matrices = parts.map(part => part.matrix);
  scene.animate(1);
  const pose = parts.map(part => Array.from(part.matrix));
  for (const time of [7, 0.3, 4.5, 0, 1]) scene.animate(time);
  assert.deepEqual(parts.map(part => Array.from(part.matrix)), pose);
  parts.forEach((part, index) => assert.equal(part.matrix, matrices[index]));
  for (const cord of parts.filter(part => part.cradleCord)) {
    const { pivot, ball, depthOffset } = cord.cradleCord;
    const start = [0, 1, 2].map(axis => cord.matrix[12 + axis] - cord.matrix[4 + axis] / 2);
    const end = [0, 1, 2].map(axis => cord.matrix[12 + axis] + cord.matrix[4 + axis] / 2);
    start.forEach((component, axis) => assert.ok(Math.abs(component - pivot[axis]) < 1e-6));
    end.forEach((component, axis) => assert.ok(Math.abs(component - ball.matrix[12 + axis] - (axis === 2 ? depthOffset : 0)) < 1e-6));
  }
});

test('opening shot keeps the entire moving ball envelope in wide and portrait frames', () => {
  const scene = createFilmScenes().apparatus;
  const balls = scene.parts.filter(part => part.name.startsWith('Cradle ball '));
  for (const aspect of [16 / 9, 9 / 16]) {
    for (let time = 0; time < 7; time += 1 / 30) {
      const sample = sampleFilm(time, { aspect });
      scene.animate(sample.sceneTime);
      const camera = new PerspectiveCamera(sample.camera.fov, aspect, sample.camera.near, sample.camera.far);
      camera.position.fromArray(sample.camera.eye);
      camera.up.fromArray(sample.camera.up);
      camera.lookAt(...sample.camera.target);
      camera.updateMatrixWorld();
      for (const ball of balls) {
        for (const horizontal of [-1, 1]) {
          for (const vertical of [-1, 1]) {
            for (const depth of [-1, 1]) {
              const projected = new Vector3(ball.matrix[12] + horizontal * CRADLE.radius, ball.matrix[13] + vertical * CRADLE.radius, ball.matrix[14] + depth * CRADLE.radius).project(camera);
              assert.ok(Math.abs(projected.x) < 0.98 && Math.abs(projected.y) < 0.98, `${aspect} at ${time}: ${ball.name}`);
            }
          }
        }
      }
    }
  }
});
