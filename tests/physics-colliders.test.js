import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhysicsScene, planPhysicsScene } from '../src/physics.js';

// A ramp-free tray: a trimesh floor made of two triangles at height zero.
const FLOOR_VERTICES = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5];
const FLOOR_INDICES = [0, 2, 1, 0, 3, 2];

function trimeshFloor() {
  return {
    bodies: [{ name: 'floor', type: 'fixed' }],
    colliders: [{ name: 'floor', body: 'floor', shape: 'trimesh', vertices: FLOOR_VERTICES, indices: FLOOR_INDICES }],
  };
}

function dropBall(definition, name, height, extra = {}) {
  definition.bodies.push({ name, translation: [0, height, 0] });
  definition.colliders.push({ name, body: name, shape: 'ball', radius: 0.25, mass: 1, ...extra });
}

function bodyHeight(scene, name, time) {
  return scene.sample(time)[scene.bodyIndex(name) * 7 + 1];
}

test('a ball comes to rest on a trimesh floor', async () => {
  const definition = trimeshFloor();
  dropBall(definition, 'ball', 2);
  const scene = await createPhysicsScene(definition, { frameCount: 181 });
  assert.ok(Math.abs(bodyHeight(scene, 'ball', scene.duration) - 0.25) < 0.02);
  assert.ok(scene.restFrames[scene.bodyIndex('ball')] > 0);
  assert.ok(scene.contactEvents.some(event => event.kind === 'contact' && event.started));
  scene.dispose();
});

test('a convex hull body rests on a trimesh floor', async () => {
  const definition = trimeshFloor();
  const cube = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) cube.push(x, y, z);
  definition.bodies.push({ name: 'crate', translation: [0, 2, 0] });
  definition.colliders.push({ name: 'crate', body: 'crate', shape: 'convexHull', points: cube, density: 1 });
  const scene = await createPhysicsScene(definition, { frameCount: 181 });
  assert.ok(Math.abs(bodyHeight(scene, 'crate', scene.duration) - 0.5) < 0.03);
  scene.dispose();
});

test('trimesh and hull counts are rejected before anything is allocated', () => {
  const definition = trimeshFloor();
  assert.throws(() => planPhysicsScene(definition, { maxColliderTriangles: 1 }), /maxColliderTriangles/);
  const dynamicTrimesh = trimeshFloor();
  dynamicTrimesh.bodies[0].type = 'dynamic';
  assert.throws(() => planPhysicsScene(dynamicTrimesh), /fixed or kinematic/);
  const outOfRange = trimeshFloor();
  outOfRange.colliders[0].indices = [0, 1, 9];
  assert.throws(() => planPhysicsScene(outOfRange), /indices/);
  const hugeHull = trimeshFloor();
  hugeHull.bodies.push({ name: 'hull' });
  hugeHull.colliders.push({ name: 'hull', body: 'hull', shape: 'convexHull', points: new Array(3 * 5000).fill(1), mass: 1 });
  assert.throws(() => planPhysicsScene(hugeHull, { maxHullPoints: 2048 }), /points/);
  const flatHull = trimeshFloor();
  flatHull.bodies.push({ name: 'hull' });
  flatHull.colliders.push({ name: 'hull', body: 'hull', shape: 'convexHull', points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], mass: 1 });
  assert.throws(() => planPhysicsScene(flatHull));
});

test('a sensor reports enter and leave without pushing the body', async () => {
  const definition = trimeshFloor();
  definition.bodies.push({ name: 'zone', type: 'fixed', translation: [0, 1, 0] });
  definition.colliders.push({ name: 'zone', body: 'zone', shape: 'cuboid', halfExtents: [1, 0.25, 1], sensor: true });
  dropBall(definition, 'ball', 3);
  const scene = await createPhysicsScene(definition, { frameCount: 181 });
  const sensorEvents = scene.contactEvents.filter(event => event.kind === 'sensor');
  assert.deepEqual(sensorEvents.map(event => event.started), [true, false]);
  assert.ok(sensorEvents[0].frame < sensorEvents[1].frame);
  assert.ok(Math.abs(bodyHeight(scene, 'ball', scene.duration) - 0.25) < 0.02, 'the ball falls through the sensor');
  scene.dispose();
});

test('collision masks let a ball pass through a floor it does not collide with', async () => {
  const definition = trimeshFloor();
  definition.colliders[0].groups = 0b01;
  definition.colliders[0].mask = 0b01;
  dropBall(definition, 'ghost', 2, { groups: 0b10, mask: 0b10 });
  dropBall(definition, 'solid', 2, { groups: 0b01, mask: 0b01 });
  definition.bodies.find(body => body.name === 'solid').translation = [1, 2, 0];
  const scene = await createPhysicsScene(definition, { frameCount: 181 });
  assert.ok(bodyHeight(scene, 'ghost', scene.duration) < -5, 'the ghost ball falls through');
  assert.ok(Math.abs(bodyHeight(scene, 'solid', scene.duration) - 0.25) < 0.02);
  scene.dispose();
});

test('a seek back reproduces the same poses', async () => {
  const definition = trimeshFloor();
  dropBall(definition, 'ball', 2, { restitution: 0.5 });
  const scene = await createPhysicsScene(definition, { frameCount: 181 });
  const first = Float32Array.from(scene.sample(1.3));
  scene.sample(0.2);
  scene.sample(scene.duration);
  assert.deepEqual(Float32Array.from(scene.sample(1.3)), first);
  scene.dispose();
});
