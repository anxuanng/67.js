import { mat4, quat } from 'gl-matrix';

let rapierPromise;
const ZERO = [0, 0, 0];
const IDENTITY = [0, 0, 0, 1];
const MIN_NORMAL_FLOAT32 = 2 ** -126;
const LIMITS = {
  maxBodies: [256, 4096],
  maxColliders: [1024, 8192],
  maxJoints: [512, 8192],
  maxEvents: [10000, 100000],
  maxFrames: [3601, 1000000],
};

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label}.${key} is unsupported`);
    }
  }
}

function scalar(value, label, min = -Infinity, max = Infinity) {
  const rounded = Math.fround(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(rounded) || value < min || value > max || rounded < min || rounded > max) {
    throw new RangeError(`${label} must be finite Float32 in [${min}, ${max}]`);
  }
  return rounded;
}

function positive(value, label) {
  const result = scalar(value, label, 0);
  if (result === 0) {
    throw new RangeError(`${label} must remain positive in Float32`);
  }
  return result;
}

function normalPositive(value, label) {
  const result = scalar(value, label, MIN_NORMAL_FLOAT32);
  positive(1 / result, `${label} reciprocal`);
  return result;
}

function vectorLength(value, label) {
  const squaredLength = value[0] ** 2 + value[1] ** 2 + value[2] ** 2;
  scalar(squaredLength, `${label} squared norm`, 0);
  return Math.sqrt(squaredLength);
}

function vector(value, size, label, fallback) {
  value ??= fallback;
  if (!value || value.length !== size) {
    throw new TypeError(`${label} must contain ${size} numbers`);
  }
  return Array.from(value, (number, index) => scalar(number, `${label}[${index}]`));
}

function rotation(value, label) {
  const result = vector(value, 4, label, IDENTITY);
  const length = Math.hypot(...result);
  if (!length || Math.abs(length - 1) > 1e-4) {
    throw new RangeError(`${label} must be a unit quaternion`);
  }
  return result.map(number => Math.fround(number / length));
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function namedList(list, label, limit) {
  if (!Array.isArray(list) || list.length > limit) {
    throw new RangeError(`${label} must be an array with at most ${limit} entries`);
  }
  const names = new Set();
  for (const entry of list) {
    if (typeof entry?.name !== 'string' || !entry.name.length || names.has(entry.name)) {
      throw new TypeError(`${label} names must be nonempty and unique`);
    }
    names.add(entry.name);
  }
  return list;
}

function prepare(definition, options) {
  fields(definition, ['bodies', 'colliders', 'joints', 'events', 'gravity'], 'definition');
  fields(options, ['frameCount', 'timestep', 'solverIterations', 'maxMemoryBytes', ...Object.keys(LIMITS)], 'options');
  const limits = {};
  for (const [key, [fallback, cap]] of Object.entries(LIMITS)) {
    limits[key] = integer(options[key] ?? fallback, key, 1, cap);
  }
  const frameCount = integer(options.frameCount ?? 601, 'frameCount', 1, limits.maxFrames);
  const timestep = positive(options.timestep ?? 1 / 60, 'timestep');
  positive(1 / timestep, 'timestep reciprocal');
  if (timestep > 1) {
    throw new RangeError('timestep must be at most one second');
  }
  const solverIterations = integer(options.solverIterations ?? 8, 'solverIterations', 1, 128);
  const maxMemoryBytes = integer(options.maxMemoryBytes ?? 128 * 1024 * 1024, 'maxMemoryBytes', 1, 2 ** 31 - 1);
  const rawBodies = namedList(definition.bodies, 'bodies', limits.maxBodies);
  if (!rawBodies.length) {
    throw new RangeError('bodies must not be empty');
  }
  const rawColliders = namedList(definition.colliders ?? [], 'colliders', limits.maxColliders);
  const rawJoints = namedList(definition.joints ?? [], 'joints', limits.maxJoints);
  const rawEvents = definition.events ?? [];
  if (!Array.isArray(rawEvents) || rawEvents.length > limits.maxEvents) {
    throw new RangeError('events exceed maxEvents');
  }
  const timelineBytes = rawBodies.length * frameCount * 7 * Float32Array.BYTES_PER_ELEMENT;
  // Solver memory varies with contacts and WASM allocator reuse. This is a reservation estimate, not a heap measurement.
  const solverReserveBytes = 1048576 + rawBodies.length * 16384 + rawColliders.length * 16384 + rawJoints.length * 8192 + rawColliders.length ** 2 * 128;
  const estimatedPeakBytes = timelineBytes + solverReserveBytes;
  if (!Number.isSafeInteger(estimatedPeakBytes) || estimatedPeakBytes > maxMemoryBytes) {
    throw new RangeError(`physics memory plan ${estimatedPeakBytes} exceeds maxMemoryBytes ${maxMemoryBytes}`);
  }
  const bodies = rawBodies.map(body => {
    fields(body, ['name', 'type', 'translation', 'rotation', 'linearVelocity', 'angularVelocity', 'linearDamping', 'angularDamping', 'ccd'], `body ${body.name}`);
    const type = body.type ?? 'dynamic';
    if (!['dynamic', 'fixed', 'kinematic'].includes(type)) {
      throw new TypeError(`body ${body.name} has unsupported type`);
    }
    if (type !== 'dynamic' && (body.linearVelocity || body.angularVelocity || body.linearDamping !== undefined || body.angularDamping !== undefined || body.ccd !== undefined)) {
      throw new TypeError(`body ${body.name} only supports velocity, damping, and CCD when dynamic`);
    }
    if (body.ccd !== undefined && typeof body.ccd !== 'boolean') {
      throw new TypeError('ccd must be boolean');
    }
    return {
      name: body.name,
      type,
      translation: vector(body.translation, 3, 'translation', ZERO),
      rotation: rotation(body.rotation, 'rotation'),
      linearVelocity: vector(body.linearVelocity, 3, 'linearVelocity', ZERO),
      angularVelocity: vector(body.angularVelocity, 3, 'angularVelocity', ZERO),
      linearDamping: scalar(body.linearDamping ?? 0, 'linearDamping', 0),
      angularDamping: scalar(body.angularDamping ?? 0, 'angularDamping', 0),
      ccd: body.ccd ?? false,
    };
  });
  const bodyIndices = new Map(bodies.map((body, index) => [body.name, index]));
  function bodyIndex(name) {
    if (!bodyIndices.has(name)) {
      throw new TypeError(`unknown body ${name}`);
    }
    return bodyIndices.get(name);
  }
  const colliders = rawColliders.map(collider => {
    fields(collider, ['name', 'body', 'shape', 'radius', 'halfHeight', 'halfExtents', 'translation', 'rotation', 'mass', 'density', 'friction', 'restitution'], `collider ${collider.name}`);
    const body = bodyIndex(collider.body);
    let radius;
    let halfHeight;
    let halfExtents;
    let volume;
    let smallestExtent;
    if (collider.shape === 'ball') {
      if (collider.halfHeight !== undefined || collider.halfExtents !== undefined) {
        throw new TypeError('ball only accepts radius');
      }
      radius = positive(collider.radius, 'radius');
      volume = 4 * Math.PI * radius ** 3 / 3;
      smallestExtent = radius;
    } else if (collider.shape === 'cuboid') {
      if (collider.radius !== undefined || collider.halfHeight !== undefined) {
        throw new TypeError('cuboid only accepts halfExtents');
      }
      halfExtents = vector(collider.halfExtents, 3, 'halfExtents');
      for (const extent of halfExtents) {
        positive(extent, 'halfExtents');
      }
      volume = 8 * halfExtents[0] * halfExtents[1] * halfExtents[2];
      smallestExtent = Math.min(...halfExtents);
    } else if (collider.shape === 'capsule') {
      if (collider.halfExtents !== undefined) {
        throw new TypeError('capsule only accepts radius and halfHeight');
      }
      radius = positive(collider.radius, 'radius');
      halfHeight = positive(collider.halfHeight, 'halfHeight');
      volume = Math.PI * radius ** 2 * 2 * halfHeight + 4 * Math.PI * radius ** 3 / 3;
      smallestExtent = radius;
    } else {
      throw new TypeError(`unsupported collider shape ${collider.shape}`);
    }
    positive(volume, 'collider volume');
    if (collider.mass !== undefined && collider.density !== undefined) {
      throw new TypeError('collider accepts either mass or density');
    }
    const mass = collider.mass === undefined ? undefined : positive(collider.mass, 'mass');
    const density = mass === undefined ? positive(collider.density ?? 1, 'density') : undefined;
    const effectiveMass = normalPositive(mass ?? volume * density, 'collider effective mass');
    if (mass !== undefined) {
      positive(mass / volume, 'collider effective density');
    }
    const minimumInertia = normalPositive(0.1 * effectiveMass * smallestExtent ** 2, 'collider minimum inertia scale');
    const largestExtent = halfExtents ? Math.max(...halfExtents) : radius + (halfHeight ?? 0);
    positive(effectiveMass * largestExtent ** 2, 'collider maximum inertia scale');
    return {
      body,
      shape: collider.shape,
      radius,
      halfHeight,
      halfExtents,
      mass,
      density,
      effectiveMass,
      minimumInertia,
      largestExtent,
      translation: vector(collider.translation, 3, 'collider translation', ZERO),
      rotation: rotation(collider.rotation, 'collider rotation'),
      friction: scalar(collider.friction ?? 0.5, 'friction', 0),
      restitution: scalar(collider.restitution ?? 0, 'restitution', 0, 1),
    };
  });
  const massTotals = Array(bodies.length).fill(0);
  const inertiaTotals = Array(bodies.length).fill(0);
  const minimumInertiaTotals = Array(bodies.length).fill(0);
  const maximumColliderOffsets = Array(bodies.length).fill(0);
  for (const collider of colliders) {
    const index = collider.body;
    massTotals[index] = normalPositive(massTotals[index] + collider.effectiveMass, 'compound body mass');
    inertiaTotals[index] = positive(inertiaTotals[index] + collider.effectiveMass * (collider.largestExtent ** 2 + Math.hypot(...collider.translation) ** 2), 'compound body inertia scale');
    minimumInertiaTotals[index] = normalPositive(minimumInertiaTotals[index] + collider.minimumInertia, 'compound body minimum inertia');
    maximumColliderOffsets[index] = Math.max(maximumColliderOffsets[index], Math.hypot(...collider.translation));
    for (const component of collider.translation) {
      scalar(collider.effectiveMass * component, 'collider weighted center');
    }
  }
  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    if (bodies[bodyIndex].type === 'dynamic' && massTotals[bodyIndex] === 0) {
      throw new TypeError(`dynamic body ${bodies[bodyIndex].name} requires a collider with mass`);
    }
  }
  const joints = rawJoints.map(joint => {
    fields(joint, ['name', 'type', 'bodyA', 'bodyB', 'anchorA', 'anchorB', 'axis', 'frameA', 'frameB', 'contactsEnabled'], `joint ${joint.name}`);
    if (!['spherical', 'revolute', 'fixed'].includes(joint.type)) {
      throw new TypeError('unsupported joint type');
    }
    const bodyA = bodyIndex(joint.bodyA);
    const bodyB = bodyIndex(joint.bodyB);
    if (bodyA === bodyB) {
      throw new TypeError('joint bodies must differ');
    }
    if (joint.contactsEnabled !== undefined && typeof joint.contactsEnabled !== 'boolean') {
      throw new TypeError('contactsEnabled must be boolean');
    }
    if (joint.type !== 'revolute' && joint.axis !== undefined) {
      throw new TypeError('axis requires a revolute joint');
    }
    if (joint.type !== 'fixed' && (joint.frameA !== undefined || joint.frameB !== undefined)) {
      throw new TypeError('joint frames require a fixed joint');
    }
    const axis = joint.type === 'revolute' ? vector(joint.axis, 3, 'axis') : undefined;
    if (axis && Math.abs(Math.hypot(...axis) - 1) > 1e-4) {
      throw new RangeError('axis must be a unit vector');
    }
    if (axis) {
      const axisLength = Math.hypot(...axis);
      for (let component = 0; component < 3; component++) {
        axis[component] = Math.fround(axis[component] / axisLength);
      }
    }
    return {
      type: joint.type,
      bodyA,
      bodyB,
      anchorA: vector(joint.anchorA, 3, 'anchorA', ZERO),
      anchorB: vector(joint.anchorB, 3, 'anchorB', ZERO),
      axis,
      frameA: rotation(joint.frameA, 'frameA'),
      frameB: rotation(joint.frameB, 'frameB'),
      contactsEnabled: joint.contactsEnabled ?? false,
    };
  });
  const events = rawEvents.map((event, order) => {
    fields(event, ['tick', 'body', 'type', 'impulse', 'torqueImpulse', 'point', 'translation', 'rotation'], `event ${order}`);
    const tick = integer(event.tick, 'event tick', 0, frameCount - 2);
    const body = bodyIndex(event.body);
    const type = event.type ?? 'impulse';
    if (type === 'impulse') {
      if (bodies[body].type !== 'dynamic') {
        throw new TypeError('impulses require a dynamic body');
      }
      if (event.translation !== undefined || event.rotation !== undefined || (event.impulse === undefined && event.torqueImpulse === undefined) || (event.point !== undefined && event.impulse === undefined)) {
        throw new TypeError('invalid impulse event fields');
      }
      return {
        tick,
        body,
        type,
        order,
        impulse: event.impulse === undefined ? undefined : vector(event.impulse, 3, 'impulse'),
        torqueImpulse: event.torqueImpulse === undefined ? undefined : vector(event.torqueImpulse, 3, 'torqueImpulse'),
        point: event.point === undefined ? undefined : vector(event.point, 3, 'point'),
      };
    }
    if (type !== 'kinematicPose' || bodies[body].type !== 'kinematic') {
      throw new TypeError('kinematicPose events require a kinematic body');
    }
    if (event.impulse !== undefined || event.torqueImpulse !== undefined || event.point !== undefined || (event.translation === undefined && event.rotation === undefined)) {
      throw new TypeError('invalid kinematicPose event fields');
    }
    return {
      tick,
      body,
      type,
      order,
      translation: event.translation === undefined ? undefined : vector(event.translation, 3, 'event translation'),
      rotation: event.rotation === undefined ? undefined : rotation(event.rotation, 'event rotation'),
    };
  }).sort((firstEvent, secondEvent) => firstEvent.tick - secondEvent.tick || firstEvent.order - secondEvent.order);
  const gravity = vector(definition.gravity, 3, 'gravity', [0, -9.81, 0]);
  validateMotionBounds(bodies, events, gravity, timestep, frameCount, massTotals, minimumInertiaTotals, maximumColliderOffsets);
  const memoryPlan = Object.freeze({
    timelineBytes,
    solverReserveBytes,
    estimatedPeakBytes,
    maxMemoryBytes,
    bodyCount: bodies.length,
    colliderCount: colliders.length,
    jointCount: joints.length,
    eventCount: events.length,
    frameCount,
  });
  return {
    bodies,
    colliders,
    joints,
    events,
    gravity,
    frameCount,
    timestep,
    solverIterations,
    memoryPlan,
  };
}

function validateMotionBounds(bodies, events, gravity, timestep, frameCount, massTotals, minimumInertiaTotals, maximumColliderOffsets) {
  const duration = (frameCount - 1) * timestep;
  const gravityMagnitude = vectorLength(gravity, 'gravity');
  const linearSpeedBounds = bodies.map(body => {
    const initialSpeed = vectorLength(body.linearVelocity, 'linearVelocity');
    const speedBound = initialSpeed + (body.type === 'dynamic' ? gravityMagnitude * duration : 0);
    scalar(speedBound ** 2, 'accumulated linear velocity squared norm', 0);
    return speedBound;
  });
  const angularSpeedBounds = bodies.map(body => vectorLength(body.angularVelocity, 'angularVelocity'));

  // Ignore damping and contact resistance to bound all declared impulses conservatively.
  for (const event of events) {
    if (event.type !== 'impulse') {
      continue;
    }
    if (event.impulse) {
      const impulseMagnitude = vectorLength(event.impulse, 'impulse');
      linearSpeedBounds[event.body] += impulseMagnitude / massTotals[event.body];
      scalar(linearSpeedBounds[event.body] ** 2, 'accumulated linear velocity squared norm', 0);
    }
    if (event.torqueImpulse) {
      const torqueMagnitude = vectorLength(event.torqueImpulse, 'torqueImpulse');
      angularSpeedBounds[event.body] += torqueMagnitude / minimumInertiaTotals[event.body];
      scalar(angularSpeedBounds[event.body] ** 2, 'accumulated angular velocity squared norm', 0);
    }
  }

  const kinematicTranslations = bodies.map(body => body.translation.slice());
  const kinematicTickBaseTranslations = bodies.map(body => body.translation.slice());
  const kinematicTicks = Array(bodies.length).fill(-1);
  for (const event of events) {
    const body = bodies[event.body];
    if (event.type === 'kinematicPose') {
      if (event.translation) {
        // Same-tick targets share the last integrated pose, and gaps hold that pose.
        if (kinematicTicks[event.body] !== event.tick) {
          kinematicTickBaseTranslations[event.body] = kinematicTranslations[event.body];
        }
        const previousTranslation = kinematicTickBaseTranslations[event.body];
        const targetVelocity = event.translation.map((component, axis) => (component - previousTranslation[axis]) / timestep);
        vectorLength(targetVelocity, 'kinematic target velocity');
        kinematicTranslations[event.body] = event.translation;
        kinematicTicks[event.body] = event.tick;
      }
      if (event.rotation) {
        scalar((Math.PI / timestep) ** 2, 'kinematic angular velocity squared norm', 0);
      }
      continue;
    }
    if (event.impulse && event.point) {
      const impulseMagnitude = vectorLength(event.impulse, 'impulse');
      const maximumTravel = linearSpeedBounds[event.body] * duration;
      const leverArm = Math.hypot(...event.point) + Math.hypot(...body.translation) + maximumTravel + maximumColliderOffsets[event.body];
      const torqueBound = impulseMagnitude * leverArm;
      scalar(torqueBound ** 2, 'off-center torque impulse squared norm', 0);
      angularSpeedBounds[event.body] += torqueBound / minimumInertiaTotals[event.body];
      scalar(angularSpeedBounds[event.body] ** 2, 'accumulated angular velocity squared norm', 0);
    }
  }
}

/** Validate and estimate memory without loading or allocating the Rapier WASM world. */
export function planPhysicsScene(definition, options = {}) {
  return prepare(definition, options).memoryPlan;
}

const xyz = array => ({ x: array[0], y: array[1], z: array[2] });
const xyzw = array => ({ ...xyz(array), w: array[3] });

/** Bake a named rigid-body graph with Rapier, then release its solver world. */
export async function createPhysicsScene(definition, options = {}) {
  const preparedScene = prepare(definition, options);
  rapierPromise ??= import('@dimforge/rapier3d-compat').then(async ({ default: rapier }) => {
    await rapier.init();
    return rapier;
  });
  const rapier = await rapierPromise;
  const world = new rapier.World(xyz(preparedScene.gravity));
  let timeline;
  try {
    world.timestep = preparedScene.timestep;
    world.numSolverIterations = preparedScene.solverIterations;
    const bodies = preparedScene.bodies.map(body => {
      let descriptor;
      if (body.type === 'dynamic') {
        descriptor = rapier.RigidBodyDesc.dynamic();
      } else if (body.type === 'fixed') {
        descriptor = rapier.RigidBodyDesc.fixed();
      } else {
        descriptor = rapier.RigidBodyDesc.kinematicPositionBased();
      }
      descriptor.setTranslation(...body.translation);
      descriptor.setRotation(xyzw(body.rotation));
      if (body.type === 'dynamic') {
        descriptor.setLinvel(...body.linearVelocity);
        descriptor.setAngvel(xyz(body.angularVelocity));
        descriptor.setLinearDamping(body.linearDamping);
        descriptor.setAngularDamping(body.angularDamping);
        descriptor.setCcdEnabled(body.ccd);
      }
      return world.createRigidBody(descriptor);
    });
    for (const collider of preparedScene.colliders) {
      let descriptor;
      if (collider.shape === 'ball') {
        descriptor = rapier.ColliderDesc.ball(collider.radius);
      } else if (collider.shape === 'cuboid') {
        descriptor = rapier.ColliderDesc.cuboid(...collider.halfExtents);
      } else {
        descriptor = rapier.ColliderDesc.capsule(collider.halfHeight, collider.radius);
      }
      descriptor.setTranslation(...collider.translation);
      descriptor.setRotation(xyzw(collider.rotation));
      descriptor.setFriction(collider.friction);
      descriptor.setRestitution(collider.restitution);
      if (collider.mass === undefined) {
        descriptor.setDensity(collider.density);
      } else {
        descriptor.setMass(collider.mass);
      }
      world.createCollider(descriptor, bodies[collider.body]);
    }
    for (const joint of preparedScene.joints) {
      const anchorA = xyz(joint.anchorA);
      const anchorB = xyz(joint.anchorB);
      let descriptor;
      if (joint.type === 'spherical') {
        descriptor = rapier.JointData.spherical(anchorA, anchorB);
      } else if (joint.type === 'revolute') {
        descriptor = rapier.JointData.revolute(anchorA, anchorB, xyz(joint.axis));
      } else {
        descriptor = rapier.JointData.fixed(anchorA, xyzw(joint.frameA), anchorB, xyzw(joint.frameB));
      }
      world.createImpulseJoint(descriptor, bodies[joint.bodyA], bodies[joint.bodyB], true).setContactsEnabled(joint.contactsEnabled);
    }
    timeline = new Float32Array(preparedScene.memoryPlan.timelineBytes / 4);
    let eventIndex = 0;
    for (let frame = 0; frame < preparedScene.frameCount; frame++) {
      if (frame > 0) {
        while (eventIndex < preparedScene.events.length && preparedScene.events[eventIndex].tick === frame - 1) {
          const event = preparedScene.events[eventIndex];
          eventIndex++;
          const body = bodies[event.body];
          if (event.type === 'kinematicPose') {
            if (event.translation) {
              body.setNextKinematicTranslation(xyz(event.translation));
            }
            if (event.rotation) {
              body.setNextKinematicRotation(xyzw(event.rotation));
            }
          } else {
            if (event.impulse) {
              if (event.point) {
                body.applyImpulseAtPoint(xyz(event.impulse), xyz(event.point), true);
              } else {
                body.applyImpulse(xyz(event.impulse), true);
              }
            }
            if (event.torqueImpulse) {
              body.applyTorqueImpulse(xyz(event.torqueImpulse), true);
            }
          }
        }
        world.step();
      }
      for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
        const position = bodies[bodyIndex].translation();
        const bodyRotation = bodies[bodyIndex].rotation();
        const offset = (frame * bodies.length + bodyIndex) * 7;
        timeline[offset] = position.x;
        timeline[offset + 1] = position.y;
        timeline[offset + 2] = position.z;
        timeline[offset + 3] = bodyRotation.x;
        timeline[offset + 4] = bodyRotation.y;
        timeline[offset + 5] = bodyRotation.z;
        timeline[offset + 6] = bodyRotation.w;
        for (let component = 0; component < 7; component++) {
          if (!Number.isFinite(timeline[offset + component])) {
            throw new RangeError(`solver produced nonfinite pose at frame ${frame}, body ${preparedScene.bodies[bodyIndex].name}`);
          }
        }
        const quaternionLength = Math.hypot(bodyRotation.x, bodyRotation.y, bodyRotation.z, bodyRotation.w);
        if (!quaternionLength || Math.abs(quaternionLength - 1) > 1e-3) {
          throw new RangeError('solver produced invalid quaternion');
        }
      }
    }
  } finally {
    world.free();
  }
  return recordedScene(preparedScene, timeline);
}

function recordedScene(preparedScene, timeline) {
  const bodyNames = Object.freeze(preparedScene.bodies.map(body => body.name));
  const indices = new Map(bodyNames.map((name, index) => [name, index]));
  const poseStride = bodyNames.length * 7;
  const duration = (preparedScene.frameCount - 1) * preparedScene.timestep;
  function ensureAlive() {
    if (!timeline) {
      throw new Error('physics scene is disposed');
    }
  }
  function bodyIndex(name) {
    ensureAlive();
    if (!indices.has(name)) {
      throw new TypeError(`unknown body ${name}`);
    }
    return indices.get(name);
  }
  function sample(time, output) {
    ensureAlive();
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      throw new RangeError('sample time must be finite');
    }
    output ??= new Float32Array(poseStride);
    if (!(output instanceof Float32Array) || output.length !== poseStride) {
      throw new TypeError(`sample output must be Float32Array(${poseStride})`);
    }
    let frame = Math.max(0, Math.min(duration, time)) / preparedScene.timestep;
    const nearestFrame = Math.round(frame);
    if (Math.abs(frame - nearestFrame) <= Number.EPSILON * Math.max(1, frame) * 4) {
      frame = nearestFrame;
    }
    const leftFrame = Math.min(preparedScene.frameCount - 1, Math.floor(frame));
    const rightFrame = Math.min(preparedScene.frameCount - 1, leftFrame + 1);
    const interpolation = frame - leftFrame;
    for (let bodyIndex = 0; bodyIndex < bodyNames.length; bodyIndex++) {
      const outputOffset = bodyIndex * 7;
      const leftOffset = leftFrame * poseStride + outputOffset;
      const rightOffset = rightFrame * poseStride + outputOffset;
      for (let axis = 0; axis < 3; axis++) {
        output[outputOffset + axis] = timeline[leftOffset + axis] * (1 - interpolation) + timeline[rightOffset + axis] * interpolation;
      }
      if (interpolation === 0 || leftFrame === rightFrame) {
        for (let component = 3; component < 7; component++) {
          output[outputOffset + component] = timeline[leftOffset + component];
        }
        continue;
      }
      let quaternionDot = 0;
      for (let component = 3; component < 7; component++) {
        quaternionDot += timeline[leftOffset + component] * timeline[rightOffset + component];
      }
      const quaternionSign = quaternionDot < 0 ? -1 : 1;
      quaternionDot = Math.min(1, Math.abs(quaternionDot));
      let leftWeight = 1 - interpolation;
      let rightWeight = interpolation;
      if (quaternionDot < 0.9995) {
        const angle = Math.acos(quaternionDot);
        const angleSine = Math.sin(angle);
        leftWeight = Math.sin((1 - interpolation) * angle) / angleSine;
        rightWeight = Math.sin(interpolation * angle) / angleSine;
      }
      let quaternionLengthSquared = 0;
      for (let component = 3; component < 7; component++) {
        const interpolatedComponent = leftWeight * timeline[leftOffset + component] + quaternionSign * rightWeight * timeline[rightOffset + component];
        output[outputOffset + component] = interpolatedComponent;
        quaternionLengthSquared += interpolatedComponent ** 2;
      }
      const quaternionLength = Math.sqrt(quaternionLengthSquared);
      for (let component = 3; component < 7; component++) {
        output[outputOffset + component] /= quaternionLength;
      }
    }
    return output;
  }
  function bindParts(bindings) {
    ensureAlive();
    if (!Array.isArray(bindings) || bindings.length > preparedScene.memoryPlan.bodyCount * 16) {
      throw new RangeError('bindings must be a bounded array');
    }
    const matrices = new Set();
    const matricesByBuffer = new Map();
    const retainedBindings = bindings.map(binding => {
      fields(binding, ['body', 'part'], 'binding');
      const index = bodyIndex(binding.body);
      const matrix = binding.part?.matrix;
      if (!(matrix instanceof Float32Array) || matrix.length !== 16 || matrices.has(matrix)) {
        throw new TypeError('each binding requires a distinct retained Float32 part.matrix');
      }
      matrices.add(matrix);
      let bufferMatrices = matricesByBuffer.get(matrix.buffer);
      if (!bufferMatrices) {
        bufferMatrices = [];
        matricesByBuffer.set(matrix.buffer, bufferMatrices);
      }
      bufferMatrices.push(matrix);
      for (const value of matrix) {
        scalar(value, 'binding matrix');
      }
      if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
        throw new TypeError('binding matrix must be affine');
      }
      const scale = [Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10])];
      for (const size of scale) {
        positive(size, 'binding scale');
      }
      for (const [firstAxis, secondAxis] of [[0, 1], [0, 2], [1, 2]]) {
        const axisDot = matrix[firstAxis * 4] * matrix[secondAxis * 4] + matrix[firstAxis * 4 + 1] * matrix[secondAxis * 4 + 1] + matrix[firstAxis * 4 + 2] * matrix[secondAxis * 4 + 2];
        if (Math.abs(axisDot / scale[firstAxis] / scale[secondAxis]) > 1e-5) {
          throw new TypeError('binding matrix shear is unsupported');
        }
      }
      if (mat4.determinant(matrix) < 0) {
        scale[0] *= -1;
      }
      return {
        part: binding.part,
        matrix,
        index,
        scale,
        position: new Float32Array(3),
        rotation: quat.create(),
        scratchMatrix: mat4.create(),
      };
    });
    for (const bufferMatrices of matricesByBuffer.values()) {
      bufferMatrices.sort((firstMatrix, secondMatrix) => firstMatrix.byteOffset - secondMatrix.byteOffset);
      for (let matrixIndex = 1; matrixIndex < bufferMatrices.length; matrixIndex++) {
        const previousMatrix = bufferMatrices[matrixIndex - 1];
        const currentMatrix = bufferMatrices[matrixIndex];
        if (previousMatrix.byteOffset + previousMatrix.byteLength > currentMatrix.byteOffset) {
          throw new TypeError('binding matrix views must not overlap');
        }
      }
    }
    const sampledPose = new Float32Array(poseStride);
    return Object.freeze({
      apply(time) {
        ensureAlive();
        for (let bindingIndex = 0; bindingIndex < retainedBindings.length; bindingIndex++) {
          if (retainedBindings[bindingIndex].part.matrix !== retainedBindings[bindingIndex].matrix) {
            throw new Error('binding part.matrix identity changed');
          }
        }
        sample(time, sampledPose);
        for (let bindingIndex = 0; bindingIndex < retainedBindings.length; bindingIndex++) {
          const binding = retainedBindings[bindingIndex];
          const offset = binding.index * 7;
          for (let axis = 0; axis < 3; axis++) {
            binding.position[axis] = sampledPose[offset + axis];
          }
          for (let component = 0; component < 4; component++) {
            binding.rotation[component] = sampledPose[offset + component + 3];
          }
          mat4.fromRotationTranslationScale(binding.scratchMatrix, binding.rotation, binding.position, binding.scale);
          for (let component = 0; component < 16; component++) {
            if (!Number.isFinite(binding.scratchMatrix[component])) {
              throw new RangeError('binding transform exceeds Float32 range');
            }
          }
        }
        for (let bindingIndex = 0; bindingIndex < retainedBindings.length; bindingIndex++) {
          retainedBindings[bindingIndex].matrix.set(retainedBindings[bindingIndex].scratchMatrix);
        }
        return bindings;
      },
    });
  }
  return Object.freeze({
    bodyNames,
    frameCount: preparedScene.frameCount,
    timestep: preparedScene.timestep,
    duration,
    memoryPlan: preparedScene.memoryPlan,
    bodyIndex,
    sample,
    bindParts,
    dispose() {
      timeline = null;
    },
    get disposed() {
      return timeline === null;
    },
  });
}
