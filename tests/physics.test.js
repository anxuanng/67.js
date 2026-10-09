import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { createPhysicsScene, planPhysicsScene } from '../src/physics.js';

function fallingBoxDefinition() {
  return {
    bodies: [
      { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
      { name: 'box', translation: [0, 3, 0] },
    ],
    colliders: [
      { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [5, 0.5, 5] },
      { name: 'box', body: 'box', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 },
    ],
  };
}
function bodyPose(scene, time, name) {
  const poseOffset = scene.bodyIndex(name) * 7;
  return scene.sample(time).slice(poseOffset, poseOffset + 7);
}

function anchor(pose, localAnchor) {
  const result = vec3.transformQuat(vec3.create(), localAnchor, pose.subarray(3));
  return vec3.add(result, result, pose.subarray(0, 3));
}

function near(actual, expected, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('memory plan bounds counts and rejects the bake before allocating Rapier or timeline', async () => {
  const definition = fallingBoxDefinition();
  const plan = planPhysicsScene(definition, { frameCount: 31 });
  assert.equal(plan.timelineBytes, 31 * 2 * 7 * 4);
  assert.equal(plan.estimatedPeakBytes, plan.timelineBytes + plan.solverReserveBytes);
  assert.ok(Object.isFrozen(plan));
  assert.throws(() => planPhysicsScene(definition, { frameCount: 100, maxFrames: 10 }), /frameCount/);
  assert.throws(() => planPhysicsScene(definition, { maxBodies: 1 }), /bodies/);
  assert.throws(() => planPhysicsScene(definition, { maxColliders: 1 }), /colliders/);
  await assert.rejects(createPhysicsScene(definition, { maxMemoryBytes: 1 }), /memory plan/);
  assert.throws(() => planPhysicsScene(definition, { frameCount: 1000001, maxFrames: 1000000 }), /frameCount/);
});

test('actual Rapier contact stops a falling box and supports a stable stack', async () => {
  const definition = fallingBoxDefinition();
  definition.bodies.push({ name: 'upper', translation: [0, 4.05, 0] });
  definition.colliders.push({ name: 'upper', body: 'upper', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 });
  const scene = await createPhysicsScene(definition, { frameCount: 361 });
  near(bodyPose(scene, scene.duration, 'box')[1], 0.5, 0.03);
  near(bodyPose(scene, scene.duration, 'upper')[1], 1.5, 0.05);
  assert.ok(bodyPose(scene, 0.3, 'box')[1] < 3);
  assert.deepEqual(bodyPose(scene, scene.duration, 'floor'), bodyPose(scene, 0, 'floor'));
  scene.dispose();
});

test('ball and capsule contacts use real collider dimensions', async () => {
  const definition = fallingBoxDefinition();
  definition.bodies[1].translation = [-1, 3, 0];
  definition.colliders[1] = { name: 'ball', body: 'box', shape: 'ball', radius: 0.4, mass: 1 };
  definition.bodies.push({ name: 'capsule', translation: [1, 3, 0] });
  definition.colliders.push({ name: 'capsule', body: 'capsule', shape: 'capsule', radius: 0.3, halfHeight: 0.6, mass: 1 });
  const scene = await createPhysicsScene(definition, { frameCount: 241 });
  near(bodyPose(scene, scene.duration, 'box')[1], 0.4, 0.03);
  near(bodyPose(scene, scene.duration, 'capsule')[1], 0.9, 0.03);
  scene.dispose();
});

test('compound collider mass and density both contribute to real impulse response', async () => {
  const definition = {
    gravity: [0, 0, 0],
    bodies: [{ name: 'body' }],
    colliders: [
      { name: 'left', body: 'body', shape: 'ball', radius: 0.5, translation: [-0.5, 0, 0], mass: 2 },
      { name: 'right', body: 'body', shape: 'ball', radius: 0.5, translation: [0.5, 0, 0], density: 6 / Math.PI },
    ],
    events: [{ tick: 0, body: 'body', impulse: [3, 0, 0] }],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  near(scene.sample(scene.duration)[0], scene.duration, 1e-5);
  near(scene.sample(scene.duration)[6], 1);
  scene.dispose();
});

for (const type of ['spherical', 'revolute', 'fixed']) {
  test(`${type} ragdoll constraint retains anchors while bodies collide with the floor`, async () => {
    const definition = fallingBoxDefinition();
    definition.bodies[1].translation = [0, 2.5, 0];
    definition.colliders[1] = { name: 'upper', body: 'box', shape: 'capsule', radius: 0.2, halfHeight: 0.3, mass: 1 };
    definition.bodies.push({ name: 'lower', translation: [0, 1.5, 0] });
    definition.colliders.push({ name: 'lower', body: 'lower', shape: 'capsule', radius: 0.2, halfHeight: 0.3, mass: 1 });
    definition.joints = [{
      name: 'joint',
      type,
      bodyA: 'box',
      bodyB: 'lower',
      anchorA: [0, -0.5, 0],
      anchorB: [0, 0.5, 0],
      ...(type === 'revolute' ? { axis: [0, 0, 1] } : {}),
    }];
    definition.events = [{ tick: 0, body: 'lower', impulse: [1, 0, 0], torqueImpulse: [0, 0, 0.2] }];
    const scene = await createPhysicsScene(definition, { frameCount: 241, solverIterations: 12 });
    for (const time of [0.25, 1, scene.duration]) {
      const upperPose = bodyPose(scene, time, 'box');
      const lowerPose = bodyPose(scene, time, 'lower');
      assert.ok(vec3.distance(anchor(upperPose, [0, -0.5, 0]), anchor(lowerPose, [0, 0.5, 0])) < 0.04);
      assert.ok(upperPose[1] > 0.15 && lowerPose[1] > 0.15);
    }
    if (type !== 'fixed') {
      assert.ok(Math.abs(bodyPose(scene, 0.25, 'lower')[5] - bodyPose(scene, 0.25, 'box')[5]) > 0.01, 'joint visibly bends');
    }
    scene.dispose();
  });
}

test('impulses, off-center impulses, and torque impulses are applied at declared ticks', async () => {
  const definition = {
    gravity: [0, 0, 0],
    bodies: [{ name: 'body' }],
    colliders: [{ name: 'ball', body: 'body', shape: 'ball', radius: 1, mass: 2 }],
    events: [
      { tick: 10, body: 'body', impulse: [2, 0, 0] },
      { tick: 20, body: 'body', impulse: [0, 2, 0], point: [1, 0, 0] },
      { tick: 30, body: 'body', torqueImpulse: [0, 0, 0.5] },
    ],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  near(scene.sample(scene.timestep * 10)[0], 0);
  near(scene.sample(scene.timestep * 11)[0], scene.timestep);
  assert.ok(scene.sample(scene.duration)[1] > 0.5);
  assert.ok(Math.abs(scene.sample(scene.duration)[5]) > 0.1);
  scene.dispose();
});

test('recording repeats bit exactly, and backward seeks do not change later samples', async () => {
  const definition = fallingBoxDefinition();
  definition.events = [
    { tick: 60, body: 'box', impulse: [2, 1, 0] },
    { tick: 60, body: 'box', torqueImpulse: [0, 0, 0.3] },
    { tick: 0, body: 'box', impulse: [-0.5, 0, 0] },
  ];
  const firstScene = await createPhysicsScene(definition, { frameCount: 121 });
  const secondScene = await createPhysicsScene(definition, { frameCount: 121 });
  const retainedOutput = new Float32Array(14);
  for (const tick of [120, 0, 80, 4, 120, 42]) {
    const time = tick * firstScene.timestep;
    assert.equal(firstScene.sample(time, retainedOutput), retainedOutput);
    assert.deepEqual(retainedOutput, secondScene.sample(time));
  }
  const finalPose = firstScene.sample(firstScene.duration);
  firstScene.sample(0);
  assert.deepEqual(firstScene.sample(firstScene.duration), finalPose);
  assert.deepEqual(firstScene.sample(-100), firstScene.sample(0));
  assert.deepEqual(firstScene.sample(100), finalPose);
  firstScene.dispose();
  secondScene.dispose();
});

test('kinematic targets push a dynamic body and samples interpolate translation and unit quaternions', async () => {
  const definition = {
    gravity: [0, 0, 0],
    bodies: [
      { name: 'platform', type: 'kinematic', translation: [-2, 0, 0] },
      { name: 'ball', translation: [0, 0, 0] },
    ],
    colliders: [
      { name: 'platform', body: 'platform', shape: 'cuboid', halfExtents: [0.5, 2, 2] },
      { name: 'ball', body: 'ball', shape: 'ball', radius: 0.5, mass: 1 },
    ],
    events: Array.from({ length: 60 }, (_, tick) => ({
      tick,
      type: 'kinematicPose',
      body: 'platform',
      translation: [-2 + (tick + 1) / 30, 0, 0],
      ...(tick === 59 ? { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } : {}),
    })),
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  assert.ok(bodyPose(scene, scene.duration, 'ball')[0] > 0.5);
  const previousPose = bodyPose(scene, 59 * scene.timestep, 'platform');
  const finalPose = bodyPose(scene, scene.duration, 'platform');
  const halfwayPose = bodyPose(scene, 59.5 * scene.timestep, 'platform');
  near(halfwayPose[0], (previousPose[0] + finalPose[0]) / 2);
  near(Math.hypot(...halfwayPose.subarray(3)), 1);
  near(halfwayPose[5], Math.sin(Math.PI / 8));
  scene.dispose();
});

test('part binding keeps matrix identity and scales, and updates all bindings atomically', async () => {
  const scene = await createPhysicsScene(fallingBoxDefinition(), { frameCount: 31 });
  const part = { matrix: mat4.fromScaling(mat4.create(), [-2, 3, 4]) };
  const other = { matrix: mat4.create() };
  const matrix = part.matrix;
  const binding = scene.bindParts([{ body: 'box', part }, { body: 'floor', part: other }]);
  binding.apply(scene.duration);
  assert.equal(part.matrix, matrix);
  near(part.matrix[0], -2);
  near(part.matrix[5], 3);
  near(part.matrix[10], 4);
  near(part.matrix[13], bodyPose(scene, scene.duration, 'box')[1]);
  const previous = part.matrix.slice();
  other.matrix = mat4.create();
  assert.throws(() => binding.apply(0), /identity changed/);
  assert.deepEqual(part.matrix, previous);
  scene.dispose();
  assert.throws(() => binding.apply(0), /disposed/);
});

test('malformed bodies, colliders, constraints, and events fail at the boundary', () => {
  const cases = [
    definition => definition.bodies.push({ name: 'box' }),
    definition => definition.bodies[1].rotation = [0, 0, 0, 0],
    definition => definition.bodies[1].translation = [Infinity, 0, 0],
    definition => definition.bodies[0].linearVelocity = [1, 0, 0],
    definition => definition.bodies[1].type = 'soft',
    definition => definition.colliders[1].mass = -1,
    definition => definition.colliders[1].density = 1,
    definition => definition.colliders[1].halfExtents = [0, 1, 1],
    definition => definition.colliders[1].body = 'missing',
    definition => definition.colliders[1].shape = 'mesh',
    definition => definition.colliders[1].sensor = true,
    definition => definition.colliders = [definition.colliders[0]],
    definition => definition.joints = [{ name: 'j', type: 'spherical', bodyA: 'box', bodyB: 'box' }],
    definition => definition.joints = [{ name: 'j', type: 'revolute', bodyA: 'box', bodyB: 'floor', axis: [0, 0, 0] }],
    definition => definition.events = [{ tick: 100, body: 'box', impulse: [1, 0, 0] }],
    definition => definition.events = [{ tick: 0, body: 'floor', impulse: [1, 0, 0] }],
    definition => definition.events = [{ tick: 0, body: 'box', impulse: [1, 0, 0], translation: [1, 0, 0] }],
    definition => definition.events = [{ tick: 0, body: 'box', type: 'kinematicPose', translation: [1, 0, 0] }],
  ];
  for (const mutate of cases) {
    const definition = fallingBoxDefinition();
    mutate(definition);
    assert.throws(() => planPhysicsScene(definition, { frameCount: 10 }));
  }
});

test('binding rejects distinct overlapping matrix views before changing either target', async () => {
  const definition = fallingBoxDefinition();
  definition.bodies[1].type = 'fixed';
  const scene = await createPhysicsScene(definition, { frameCount: 1 });
  const buffer = new ArrayBuffer(21 * Float32Array.BYTES_PER_ELEMENT);
  const firstMatrix = new Float32Array(buffer, 0, 16);
  const secondMatrix = new Float32Array(buffer, 5 * Float32Array.BYTES_PER_ELEMENT, 16);
  mat4.identity(firstMatrix);
  mat4.identity(secondMatrix);
  const beforeBinding = new Float32Array(buffer).slice();
  assert.throws(() => scene.bindParts([
    { body: 'floor', part: { matrix: firstMatrix } },
    { body: 'box', part: { matrix: secondMatrix } },
  ]), /must not overlap/);
  assert.deepEqual(new Float32Array(buffer), beforeBinding);
  scene.dispose();
});

test('Float32 validation rejects rounded zero, overflow, and unsafe geometry inertia', async () => {
  for (const value of [1e-50, 1e40, NaN]) {
    const definition = fallingBoxDefinition();
    definition.colliders[1].mass = value;
    assert.throws(() => planPhysicsScene(definition), /Float32/);
  }
  const thin = fallingBoxDefinition();
  thin.colliders[1].halfExtents = [1e-15, 1e15, 1e15];
  delete thin.colliders[1].mass;
  assert.throws(() => planPhysicsScene(thin), /inertia/);
  assert.throws(() => planPhysicsScene(fallingBoxDefinition(), { timestep: 1e-50 }), /Float32/);
  const compound = fallingBoxDefinition();
  compound.colliders[1].mass = 2e38;
  compound.colliders.push({ ...compound.colliders[1], name: 'second' });
  assert.throws(() => planPhysicsScene(compound), /compound body mass/);
  const rounded = fallingBoxDefinition();
  rounded.bodies[1].translation = [0, 16777217, 0];
  const scene = await createPhysicsScene(rounded, { frameCount: 1 });
  assert.equal(bodyPose(scene, 0, 'box')[1], 16777216);
  scene.dispose();
});

test('solver preflight rejects normal-looking inputs that freeze or overflow Rapier motion', () => {
  function ballDefinition() {
    return {
      gravity: [0, 0, 0],
      bodies: [{ name: 'ball' }],
      colliders: [{ name: 'ball', body: 'ball', shape: 'ball', radius: 1, mass: 1 }],
    };
  }
  for (const tinyMass of [1e-38, 1e-40]) {
    const definition = ballDefinition();
    definition.gravity = [0, -9.81, 0];
    definition.colliders[0].mass = tinyMass;
    assert.throws(() => planPhysicsScene(definition, { frameCount: 3 }), /effective mass/);
  }
  for (const velocityField of ['linearVelocity', 'angularVelocity']) {
    const definition = ballDefinition();
    definition.bodies[0][velocityField] = [1e20, 0, 0];
    assert.throws(() => planPhysicsScene(definition, { frameCount: 3 }), /squared norm/);
  }
  const gravityOverflow = ballDefinition();
  gravityOverflow.gravity = [1e20, 0, 0];
  assert.throws(() => planPhysicsScene(gravityOverflow), /gravity squared norm/);
  for (const impulseField of ['impulse', 'torqueImpulse']) {
    const definition = ballDefinition();
    definition.events = [{ tick: 0, body: 'ball', [impulseField]: [1e20, 0, 0] }];
    assert.throws(() => planPhysicsScene(definition), /squared norm/);
  }
  const inducedVelocityOverflow = ballDefinition();
  inducedVelocityOverflow.colliders[0].mass = 1e-10;
  inducedVelocityOverflow.events = [{ tick: 0, body: 'ball', impulse: [1e10, 0, 0] }];
  assert.throws(() => planPhysicsScene(inducedVelocityOverflow), /accumulated linear velocity/);
  const offCenterOverflow = ballDefinition();
  offCenterOverflow.events = [{ tick: 0, body: 'ball', impulse: [0, 1e10, 0], point: [1e10, 0, 0] }];
  assert.throws(() => planPhysicsScene(offCenterOverflow), /off-center torque impulse/);
  const kinematicOverflow = {
    gravity: [0, 0, 0],
    bodies: [{ name: 'platform', type: 'kinematic' }],
    events: [{ tick: 0, body: 'platform', type: 'kinematicPose', translation: [1, 0, 0] }],
  };
  assert.throws(() => planPhysicsScene(kinematicOverflow, { timestep: 1e-40, frameCount: 3 }), /timestep reciprocal/);
  kinematicOverflow.events[0].translation = [1e20, 0, 0];
  assert.throws(() => planPhysicsScene(kinematicOverflow, { frameCount: 3 }), /kinematic target velocity/);
  kinematicOverflow.events = [1e19, 2e19].map(translation => ({ tick: 0, body: 'platform', type: 'kinematicPose', translation: [translation, 0, 0] }));
  assert.throws(() => planPhysicsScene(kinematicOverflow, { timestep: 1, frameCount: 3 }), /kinematic target velocity/);
});

test('small normal mass still responds to gravity instead of silently freezing', async () => {
  const definition = {
    bodies: [{ name: 'ball', translation: [0, 3, 0] }],
    colliders: [{ name: 'ball', body: 'ball', shape: 'ball', radius: 1, mass: 1e-20 }],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 3 });
  assert.ok(scene.sample(scene.duration)[1] < scene.sample(0)[1]);
  scene.dispose();
});

test('inputs are copied before awaiting WASM initialization, and event/joint limits are enforced', async () => {
  const definition = fallingBoxDefinition();
  const pending = createPhysicsScene(definition, { frameCount: 2 });
  definition.bodies[1].translation[1] = 99;
  definition.colliders[1].halfExtents[1] = 99;
  const scene = await pending;
  near(bodyPose(scene, 0, 'box')[1], 3);
  scene.dispose();
  definition.joints = ['one', 'two'].map(name => ({ name, type: 'spherical', bodyA: 'floor', bodyB: 'box' }));
  assert.throws(() => planPhysicsScene(definition, { maxJoints: 1 }), /joints/);
  definition.joints = [];
  definition.events = [0, 1].map(tick => ({ tick, body: 'box', impulse: [1, 0, 0] }));
  assert.throws(() => planPhysicsScene(definition, { maxEvents: 1 }), /maxEvents/);
});

test('invalid samples and bindings cannot mutate matrices, and disposed scenes reject calls', async () => {
  const scene = await createPhysicsScene(fallingBoxDefinition(), { frameCount: 1 });
  assert.throws(() => scene.sample(NaN), /finite/);
  assert.throws(() => scene.sample(0, new Float32Array(1)), /output/);
  assert.throws(() => scene.bodyIndex('missing'), /unknown/);
  const part = { matrix: mat4.create() };
  part.matrix[4] = 0.25;
  assert.throws(() => scene.bindParts([{ body: 'box', part }]), /shear/);
  part.matrix[4] = 0;
  part.matrix[3] = 1e-6;
  assert.throws(() => scene.bindParts([{ body: 'box', part }]), /affine/);
  part.matrix[3] = 0;
  assert.throws(() => scene.bindParts([{ body: 'box', part }, { body: 'floor', part }]), /distinct/);
  scene.dispose();
  scene.dispose();
  assert.equal(scene.disposed, true);
  assert.throws(() => scene.sample(0), /disposed/);
  assert.throws(() => scene.bodyIndex('box'), /disposed/);
  assert.throws(() => scene.bindParts([]), /disposed/);
});
