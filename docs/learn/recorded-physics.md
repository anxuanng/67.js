# Recorded physics

`67js/addons/physics` bakes rigid-body motion into a timeline with the Rapier 3D solver. Playback samples that recording at an absolute time and never runs the solver again, so you can seek forward and backward and get the same pose. It is available from version `0.4.0`, and the main renderer does not need Rapier for playback.

## Bake once, seek anywhere

Rapier is an optional peer dependency and is not loaded in the docs, so this example bakes a ball and a crate with a tiny hand-written integrator and then plays the recording the same way: one pose per body per frame, seven floats each, sampled at an absolute time. Drag the slider back and forth, and tick a time in the middle of a bounce to see the interpolation. The console prints the plan, the bake time, the contact ticks, and the lowest height of the ball between frames.

```js live poster=physics-recording
import { Renderer67, sphere, box } from '67js';

// A plan before the bake: frames x bodies x 7 floats x 4 bytes, like planPhysicsScene's timelineBytes.
const frameCount = 361;
const timestep = 1 / 60;
const bodyNames = ['ball', 'crate'];
const duration = (frameCount - 1) * timestep;
console.log('plan:', { frameCount, timestep, duration, timelineBytes: frameCount * bodyNames.length * 7 * 4 });

// Bake: gravity, a bounce on the floor (y = 0) and a kick at tick 120, like { tick: 120, body: 'ball', impulse }.
const radius = 0.4;
const events = [{ tick: 120, body: 'ball', impulse: [3, 3, 0] }];
const contacts = [];
const timeline = new Float32Array(frameCount * bodyNames.length * 7);
const bakeStart = performance.now();
const ball = { position: [-3, 4, 0], velocity: [0, 0, 0] };
const crate = { position: [1.5, 0.35, 0], velocity: [-1.2, 0, 0] };
for (let frame = 0; frame < frameCount; frame++) {
  const ballAngle = -(ball.position[0] + 3) / radius;
  const crateYaw = (crate.position[0] - 1.5) * 0.1;
  timeline.set([...ball.position, 0, 0, Math.sin(ballAngle / 2), Math.cos(ballAngle / 2)], (frame * 2) * 7);
  timeline.set([...crate.position, 0, Math.sin(crateYaw / 2), 0, Math.cos(crateYaw / 2)], (frame * 2 + 1) * 7);
  for (const event of events) {
    if (event.tick === frame) ball.velocity = ball.velocity.map((value, axis) => value + event.impulse[axis]);
  }
  ball.velocity[1] -= 9.81 * timestep;
  ball.position = ball.position.map((value, axis) => value + ball.velocity[axis] * timestep);
  if (ball.position[1] < radius && ball.velocity[1] < 0) {
    ball.position[1] = radius;
    ball.velocity[1] *= -0.62;
    ball.velocity[0] *= 0.99;
    contacts.push(frame);
  }
  crate.velocity[0] *= 0.985;
  crate.position[0] += crate.velocity[0] * timestep;
}
console.log(`baked ${frameCount} frames in ${(performance.now() - bakeStart).toFixed(1)} ms; contact ticks:`, contacts.slice(0, 8));

// Sampling: clamp time, linear translation, normalized shortest-arc quaternion, into a retained output.
function sample(time, out) {
  const clamped = Math.min(duration, Math.max(0, time));
  const exact = clamped / timestep;
  const first = Math.min(frameCount - 2, Math.floor(exact));
  const blend = exact - first;
  for (let body = 0; body < bodyNames.length; body++) {
    const a = (first * bodyNames.length + body) * 7;
    const b = ((first + 1) * bodyNames.length + body) * 7;
    for (let index = 0; index < 3; index++) out[body * 7 + index] = timeline[a + index] + (timeline[b + index] - timeline[a + index]) * blend;
    let dot = 0;
    for (let index = 3; index < 7; index++) dot += timeline[a + index] * timeline[b + index];
    const direction = dot < 0 ? -1 : 1;
    let length = 0;
    for (let index = 3; index < 7; index++) {
      out[body * 7 + index] = timeline[a + index] + (direction * timeline[b + index] - timeline[a + index]) * blend;
      length += out[body * 7 + index] ** 2;
    }
    for (let index = 3; index < 7; index++) out[body * 7 + index] /= Math.sqrt(length);
  }
  return out;
}

function matrixFrom(pose, offset, sx, sy, sz) {
  const [x, y, z, qx, qy, qz, qw] = pose.slice(offset, offset + 7);
  return new Float32Array([
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    x, y, z, 1,
  ]);
}

const pose = new Float32Array(bodyNames.length * 7);
const ballPart = { name: 'Ball', geometry: sphere(32, 20), matrix: matrixFrom(sample(0, pose), 0, radius, radius, radius), material: { color: [0.9, 0.45, 0.2], metallic: 0, roughness: 0.4 } };
const cratePart = { name: 'Crate', geometry: box(0.05, 3), matrix: matrixFrom(pose, 7, 0.7, 0.7, 0.7), material: { color: [0.55, 0.4, 0.25], metallic: 0, roughness: 0.7 } };
const parts = [ballPart, cratePart];

// The lowest the ball gets between frames. An interpolated pose runs no collision test, so a rotated shape can dip below the floor; a ball stays above it.
let lowest = Infinity;
for (let time = 0; time <= duration; time += timestep / 10) lowest = Math.min(lowest, sample(time, pose)[1] - radius);
console.log(`lowest ball underside while sampling at 10x the step: ${lowest.toFixed(4)} m`);

const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, parts);
function applyAnimation(time) {
  sample(time, pose);
  ballPart.matrix = matrixFrom(pose, 0, radius, radius, radius);
  cratePart.matrix = matrixFrom(pose, 7, 0.7, 0.7, 0.7);
  renderer.updateParts(parts);
  renderer.render({ eye: [0, 3.5, 9], target: [0, 1, 0], fov: 42 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
toggle.textContent = 'Pause';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = duration;
slider.step = 0.01;
slider.value = 1.1;
bar.append(toggle, slider);
document.body.append(bar);
let playing = true;
let seconds = 1.1;
let last = performance.now();
toggle.addEventListener('click', () => { playing = !playing; toggle.textContent = playing ? 'Pause' : 'Play'; last = performance.now(); });
slider.addEventListener('input', () => { playing = false; toggle.textContent = 'Play'; seconds = Number(slider.value); applyAnimation(seconds); });
slider.addEventListener('change', () => {
  sample(seconds, pose);
  console.log(`t=${seconds.toFixed(2)} s ball y=${pose[1].toFixed(3)} crate x=${pose[7].toFixed(3)}`);
});
function frame(now) {
  if (playing) {
    seconds = (seconds + (now - last) / 1000) % duration;
    slider.value = seconds;
    applyAnimation(seconds);
  }
  last = now;
  requestAnimationFrame(frame);
}
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
// Seeking back reproduces an earlier pose exactly: sampling is a pure function of the time.
sample(1.25, pose);
const firstPose = Array.from(pose);
sample(5, pose);
sample(1.25, pose);
console.log('backward seek reproduces the pose:', firstPose.every((value, index) => value === pose[index]));
addEventListener('pagehide', () => renderer.dispose());
```

## Bake with Rapier

The addon requires the optional peer dependency `@dimforge/rapier3d-compat@0.21.0` (`npm install @dimforge/rapier3d-compat@0.21.0`), and a package-aware dev server such as Vite to resolve it. It bakes body contacts, joints, limits and bounded motors into a timeline.

1. Define named bodies, colliders, joints and tick events.
2. Call `planPhysicsScene` to validate the definition and allocation estimate.
3. Await `createPhysicsScene` to bake the bounded recording.
4. Bind visual parts through `physics.bindParts`.
5. Apply bindings at absolute time before uploading changed parts.
6. Call `physics.dispose()` when the recording is no longer needed.

```js
import { createPhysicsScene, planPhysicsScene } from '67js/addons/physics';

const definition = {
  gravity: [0, -9.81, 0],
  bodies: [
    { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
    { name: 'box', type: 'dynamic', translation: [0, 3, 0] },
  ],
  colliders: [
    { name: 'floor', body: 'floor', shape: 'cuboid', halfExtents: [5, 0.5, 5] },
    { name: 'box', body: 'box', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 },
  ],
  events: [{ tick: 120, body: 'box', impulse: [2, 4, 0] }],
};
const options = { frameCount: 601, timestep: 1 / 60, maxMemoryBytes: 64 * 1024 * 1024 };
const plan = planPhysicsScene(definition, options);
console.log(plan.timelineBytes, plan.estimatedPeakBytes);
const physics = await createPhysicsScene(definition, options);
const bindings = physics.bindParts([{ body: 'box', part: boxPart }]);

function applyAnimation(time) {
  bindings.apply(time);
  renderer.updateParts([boxPart]);
}
applyAnimation(5);
applyAnimation(1); // A backward seek produces the same recorded pose.
physics.dispose();
```

`physics.sample(time, out)` returns packed poses in `physics.bodyNames` order, seven Float32 values per body `[x, y, z, qx, qy, qz, qw]`, and `physics.bodyIndex(name)` gives a body's index. Supply a retained `out` of `bodyNames.length * 7` values to avoid allocation. The binding replaces a part's world translation and rotation while keeping its scale and matrix identity, so the physics body origin must match the visual part origin. Several parts can bind to one body when they share that origin.

## Options

| Option | Default | Maximum |
| --- | --- | --- |
| `frameCount` | `601`, including frame zero | `maxFrames` |
| `timestep` | `1 / 60` s, rounded to Float32 | 1 s |
| `solverIterations` | `8` | integers 1 to 128 |
| `maxBodies` | `256` | `4096` |
| `maxColliders` | `1024` | `8192` |
| `maxJoints` | `512` | `8192` |
| `maxEvents` | `10000` | `100000` |
| `maxFrames` | `3601` | `1000000` |
| `maxMemoryBytes` | `134217728` | `2147483647` |

Colliders are `ball` (`radius`), `cuboid` (`halfExtents`) and `capsule` (`radius`, `halfHeight` along local Y). Joints are `spherical`, `revolute` and `prismatic` (with a unit `axis`, and optional `limits` and `motor`) and `fixed`. A position motor takes `target`, positive `stiffness`, nonnegative `damping` and positive `maxForce`. A velocity motor takes `target`, positive `damping` and positive `maxForce`.

Tick events run before their tick's integration step. Frame zero records the initial pose, tick zero events affect frame one, and the last valid tick is `frameCount - 2`. An `impulse` event targets a dynamic body with world-space `impulse` and `torqueImpulse` vectors, and an optional world `point`. `duration` equals `(frameCount - 1) * timestep`. `planPhysicsScene` validates the whole definition without loading Rapier, and its frozen result holds the exact `timelineBytes` and an estimated `solverReserveBytes`.

## Limits

- Recorded poses can seek forward or backward. Translations interpolate linearly and quaternions along the shortest arc. Interpolation between frames can show small penetrations, and a smaller timestep reduces them.
- The bake can block the main thread after WASM initialization.
- Cloth, soft bodies and direct skeletal bindings are unsupported by the rigid-body bake. The contract covers mesh colliders, sensors and the cloth recipes in their own sections.
- Bindings validate every target before they update any matrix, and affine matrices with independent nonzero scales are supported. Shear and perspective fail.

The [physics contract](/physics.md) defines supported colliders, joint controls, timing and disposal.

## Common mistakes

- Not calling `physics.dispose()` when the recording is done.
- A visual part whose origin is not the body origin. Use a separate part or another body definition.
- A timeline longer than `maxFrames` or `maxMemoryBytes`. Plan first.
- Expecting the viewer to simulate. Playback only samples the recording.
- A tick past `frameCount - 2`, which is not a valid event tick.
