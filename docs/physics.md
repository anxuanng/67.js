# Recorded rigid-body physics

This optional addon uses Rapier 3D to bake collisions and joint motion into a timeline.
Scene playback can seek forward or backward without changing the simulation.
The main renderer does not need Rapier for playback.
This API is available in the current source checkout and is not included in the published `0.3.3` package.
The library build exports it through `67js/addons/physics` when using the npm alias.
Rapier is an optional peer dependency and remains outside the core and library archive.

```sh
npm install @dimforge/rapier3d-compat@0.21.0
```

Use a package-aware development server such as Vite to resolve the solver import.

```js
import { createPhysicsScene, planPhysicsScene } from '../src/physics.js';

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
const physics = await createPhysicsScene(definition, options);
const bindings = physics.bindParts([{ body: 'box', part: boxPart }]);
const updatedParts = [boxPart];

function applyAnimation(time) {
  bindings.apply(time);
  renderer.updateParts(updatedParts);
}

applyAnimation(5);
applyAnimation(1); // A backward seek produces the same recorded pose.
physics.dispose();
```

`boxPart` is an existing 67.js part with a retained `Float32Array(16)` matrix.
The binding replaces its world translation and rotation while keeping its scale and matrix identity.
The physics body origin must match the visual part origin.
Multiple visual parts can bind to one body when they share that origin.
Visual offsets need separate parts or body definitions.

## Definition

Names must be nonempty and unique within each body, collider, or joint list.
References use body names.
Arrays follow their declared creation order.
Unknown properties fail validation instead of changing the simulation silently.
Inputs are copied before asynchronous initialization.

Bodies use `dynamic`, `fixed`, or `kinematic` types.
The default type is `dynamic`.
Each body accepts `translation` and `rotation` in world space.
Rotation uses a unit quaternion `[x, y, z, w]`.
Dynamic bodies also accept `linearVelocity`, `angularVelocity`, `linearDamping`, `angularDamping`, and boolean `ccd`.
Every dynamic body needs at least one collider.

Colliders attach to a named body through `body`.
Their `translation` and `rotation` are relative to that body.
Multiple colliders form a compound body.
Collider scales come from their dimensions, independently of visual part scales.

| Shape | Required dimensions |
| --- | --- |
| `ball` | Positive `radius`. |
| `cuboid` | Three positive `halfExtents`. |
| `capsule` | Positive `radius` and `halfHeight` for its cylindrical segment along local Y. |

Each collider accepts either positive `mass` or positive `density`.
The default density is `1`.
Rapier computes the center of mass and angular inertia from these collider properties.
The default `friction` is `0.5` and the default `restitution` is `0`.
Restitution must stay between zero and one.

Joints connect `bodyA` and `bodyB` at local `anchorA` and `anchorB` points.
The default anchors are `[0, 0, 0]`.
Connected bodies do not collide unless `contactsEnabled` is `true`.

| Joint type | Additional fields |
| --- | --- |
| `spherical` | None. The joint permits relative rotation. |
| `revolute` | Required unit `axis` expressed in both bodies' local frames. |
| `fixed` | Optional unit `frameA` and `frameB` quaternions. Both default to identity. |

An articulated ragdoll is a graph of dynamic bodies, colliders, and joints.
This example connects two capsule bodies named `upperArm` and `forearm`.
Their initial translations and rotations must place these anchors together.

```js
definition.joints = [{
  name: 'elbow', type: 'revolute',
  bodyA: 'upperArm', bodyB: 'forearm',
  anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0],
  axis: [0, 0, 1], contactsEnabled: false,
}];
```

## Tick events

Events run before their tick's integration step.
Frame zero records the initial pose.
Tick zero events affect frame one.
The final valid tick is `frameCount - 2`.
Events run in ascending tick order, preserving declaration order within each tick.

An `impulse` event targets a dynamic body.
The default event type is `impulse`.
Its `impulse` and `torqueImpulse` vectors use world space.
An optional world `point` applies the linear impulse away from the center of mass.
At least one impulse vector is required.

```js
definition.events = [
  { tick: 0, body: 'forearm', torqueImpulse: [0, 0, 0.2] },
  { tick: 60, body: 'upperArm', impulse: [1, 2, 0], point: [0, 1, 0] },
];
```

A `kinematicPose` event targets a position-based kinematic body.
Its optional `translation` and `rotation` define the next world pose.
At least one field is required.
Rapier computes velocity from this target, so a moving kinematic collider can push dynamic bodies.
An unchanged target holds its previous position.

```js
definition.events = [
  { tick: 0, type: 'kinematicPose', body: 'platform', translation: [0, 1, 0] },
];
```

## Sampling and bindings

`physics.sample(time, out)` returns packed poses in `physics.bodyNames` order.
Each body occupies seven Float32 values `[x, y, z, qx, qy, qz, qw]`.
`physics.bodyIndex(name)` returns that body's index.
The output must have exactly `bodyNames.length * 7` values.
Omitting `out` allocates a new array.
Supplying a retained output avoids allocations during playback.

```js
const pose = new Float32Array(physics.bodyNames.length * 7);
physics.sample(1.25, pose);
const boxOffset = physics.bodyIndex('box') * 7;
const boxHeight = pose[boxOffset + 1];
```

Sampling clamps finite times to `[0, physics.duration]`.
Translations use linear interpolation.
Quaternions use normalized interpolation along the shortest arc.
Times at recorded ticks return their stored poses.
Interpolated poses do not run collision detection and can show small penetrations between frames.
A smaller timestep reduces these interpolation artifacts.

Bindings retain their sample buffer and transformation scratch matrices.
Their `apply(time)` method allocates no arrays during playback.
Bindings validate every target before updating any matrix.
Replacing a target matrix fails before any target changes.
Distinct matrix views must also occupy nonoverlapping byte ranges in their shared buffer.

Affine matrices with independent nonzero scales are supported.
Shear and perspective matrices fail validation.
Reflections use a negative X scale with the same handedness as the original matrix.

## Limits and disposal

`frameCount` defaults to `601` and includes frame zero.
`timestep` defaults to `1 / 60` seconds, rounded to Float32.
The maximum timestep is one second.
`solverIterations` defaults to `8` and accepts integers from `1` through `128`.
`duration` equals `(frameCount - 1) * timestep`.
Long timelines require larger frame limits and memory budgets.

| Option | Default | Maximum configurable value |
| --- | --- | --- |
| `maxBodies` | `256` | `4096` |
| `maxColliders` | `1024` | `8192` |
| `maxJoints` | `512` | `8192` |
| `maxEvents` | `10000` | `100000` |
| `maxFrames` | `3601` | `1000000` |
| `maxMemoryBytes` | `134217728` | `2147483647` |

`planPhysicsScene` validates the full definition without loading Rapier or allocating its world.
Its frozen result contains exact `timelineBytes` and an estimated `solverReserveBytes`.
The reservation accounts for body, collider, joint, and potential contact counts.
`estimatedPeakBytes` must fit `maxMemoryBytes` before WASM initialization and timeline allocation.
The reservation is not a hard measurement or cap on Rapier's WASM heap.
Shared WASM initialization, JavaScript metadata, caller outputs, and visual bindings are outside this estimate.

Numbers must remain finite in Float32.
Positive dimensions, mass, density, and timestep must remain positive after rounding.
Collider volume and inertia scales must also remain finite and positive.

Effective collider masses and conservative minimum inertia estimates must remain normal Float32 values, at least `2 ** -126`.
Their reciprocals and the timestep reciprocal must remain finite and positive.
This restriction prevents Rapier from treating very small masses or inertias as zero.
The minimum inertia estimate uses `0.1 * mass * smallestExtent ** 2` for each collider.
Compound bodies add these lower bounds.

Gravity, initial velocities, and impulse vectors must have finite Float32 squared norms.
Preflight also bounds accumulated velocity from gravity and declared impulses.
Angular bounds include torque impulses and off-center impulses divided by the minimum inertia estimate.
Lever-arm estimates include initial positions, collider offsets, and conservative travel over the whole recording.
These estimates ignore damping and contact resistance, so they can reject otherwise usable configurations.

Kinematic translation changes divided by the timestep must have finite Float32 squared norms.
Kinematic rotation targets require a finite squared bound of `(Math.PI / timestep) ** 2`.
Same-tick translation targets use the previous integrated translation for these checks.
These checks cover declared motion, without guaranteeing bounds on every force from contact or constraint solving.
Finite extreme velocities can also be changed by Rapier's internal motion limits.
The preflight checks prevent known overflow cases; they do not promise preservation of arbitrarily large authored speeds.

Large translations can lose small movements through Float32 rounding.
For example, `16777217` becomes `16777216`.
Nonfinite solver outputs fail the bake and release the world.

Every completed or failed bake frees the Rapier world and its contained solver resources.
`physics.dispose()` releases the recorded timeline reference and is safe to call repeatedly.
Sampling, binding creation, body lookup, and existing bindings fail after disposal.
Caller-owned arrays and part matrices remain available.
The shared Rapier module and its reusable WASM memory remain initialized.

JavaScript and WASM allocators can retain freed capacity for reuse.

## Design and boundaries

Two API shapes were considered.
One exposed a mutable solver world with delta-time callbacks.
The selected shape accepts a serializable body graph and explicit tick events, then records a bounded timeline.
This shape makes film seeks independent of playback order and keeps solver state out of render callbacks.

The addon supports rigid-body contacts, compound colliders, impulses, kinematics, and articulated graphs.
It does not implement cloth, soft bodies, mesh colliders, motors, joint limits, sensors, collision masks, or live solver editing.
It does not bind physics directly to skeletal bones or generate a humanoid skeleton.
Those features need additional public contracts.
Creating a scene bakes synchronously after asynchronous WASM initialization and can block the main thread.
A worker integration can move that bake off the render thread.

Repeat recordings require identical inputs, creation order, timestep, solver options, and Rapier version.
Rapier documents cross-platform determinism for its WASM solver under identical initial conditions.
Input calculations such as `Math.sin` can differ across platforms and invalidate that guarantee.
This addon does not promise identical trajectories across different Rapier versions.
The implementation uses `@dimforge/rapier3d-compat` version `0.21.0`, licensed under Apache 2.0.

Sources: [Rapier JavaScript setup](https://rapier.rs/docs/user_guides/javascript/getting_started_js/) and [Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/).
