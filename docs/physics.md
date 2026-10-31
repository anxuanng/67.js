# Recorded rigid-body physics

This optional addon uses Rapier 3D to bake collisions and joint motion into a timeline.
Scene playback can seek forward or backward without changing the simulation.
The main renderer does not need Rapier for playback.
Available from version `0.4.0`.
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
| `revolute` | Required unit `axis` expressed in both bodies' local frames. Optional `limits` and `motor`. |
| `prismatic` | Required unit `axis` expressed in both bodies' local frames. Optional `limits` and `motor`. |
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

## Joint limits and motors

Revolute joints permit one relative rotation, and prismatic joints permit one relative translation along their axis.
Their optional `limits: [minimum, maximum]` restrict that coordinate.
Revolute coordinates use radians. Prismatic coordinates use scene distance units.
Both endpoints must remain strictly increasing after Float32 rounding.

Position motor targets must stay inside the rounded limits. Velocity targets can push against a limit, which the solver enforces.

The prismatic coordinate is the signed distance between the world anchors, projected onto the first body's world axis.
Its initial anchors must align along that axis, and its body orientations must match.
Controlled revolute joints require initially coincident anchors and matching world axes.
Their initial relative twist angle must fit the limits.
Initial coordinate membership uses the Float32-rounded coordinate, matching the solver's numeric precision.
Uncontrolled revolute joints retain their existing initialization behavior.

At an exact half-turn, `+Math.PI` and `-Math.PI` describe the same orientation.
Limit validation uses whichever endpoint the range permits, while nearby excluded angles still fail.
Exact half-turn quaternion antipodes use a canonical sign before baking so their solver trajectories agree.

```js
definition.joints = [{
  name: 'slider', type: 'prismatic',
  bodyA: 'base', bodyB: 'carriage', axis: [1, 0, 0],
  limits: [-1, 1],
  motor: { mode: 'position', target: 0.5, stiffness: 40, damping: 8, maxForce: 10 },
}];
```

Motors use complete serializable snapshots with the fields below.
The addon fixes their Rapier model to `ForceBased` and requires a positive force cap.
An active motor needs at least one directly attached dynamic body.

| Mode | Required fields | Behavior |
| --- | --- | --- |
| `position` | `target`, positive `stiffness`, nonnegative `damping`, positive `maxForce` | Drives toward the relative coordinate with zero target velocity. |
| `velocity` | `target`, positive `damping`, positive `maxForce` | Drives toward the relative speed without a position target. `stiffness` is unsupported. |

For revolute motors, `target` uses radians or radians per second, and `maxForce` caps torque.
For prismatic motors, `target` uses distance or distance per second, and `maxForce` caps force.
Motor response depends on mass, inertia, contacts and the force cap. Targets are not prescribed poses.

`motor: null` disables actuation by zeroing the gains and force cap.
It retains momentum and joint constraints instead of holding the current pose.
Disabling an already disabled motor is a valid no-op.

Spherical and fixed joints reject these single-coordinate limits and motor fields, including `motor: null`.
Rapier `0.21.0` exposes per-axis spherical motor methods, but this addon does not yet define their multi-axis data contract.
Its spherical binding does not expose the single-coordinate limit methods used here.

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

A `jointMotor` event replaces the complete motor snapshot of a named revolute or prismatic joint.
Its fields are `tick`, `type`, `joint` and `motor`. Body impulse and pose fields are unsupported.
The replacement persists until another motor event, and both attached bodies wake when the event runs.
Same-tick snapshots preserve declaration order, so the final snapshot controls that tick's integration.

```js
definition.events = [
  { tick: 60, type: 'jointMotor', joint: 'slider', motor: { mode: 'position', target: -0.5, stiffness: 40, damping: 8, maxForce: 10 } },
  { tick: 120, type: 'jointMotor', joint: 'slider', motor: null },
];
```

Motor events obey the same tick range and before-integration timing as impulses.
Initial motors, limits and nested event snapshots are copied before awaiting WASM initialization.
Recorded sampling never changes motor state or reruns the solver.

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

Joint controls also have explicit public bounds after Float32 rounding.
Revolute limits and position targets stay within `[-Math.fround(Math.PI), Math.fround(Math.PI)]`.
Prismatic limits and position targets stay within `[-1e6, 1e6]`.
Motor speed targets stay within `[-1e4, 1e4]`, gains cannot exceed `1e6`, and force caps cannot exceed `1e8`.
Nonzero targets and damping must not round to zero.

Preflight checks motor force and step-impulse squared norms, gain products with the timestep, and nonzero target-driven impulse estimates.
Positive squared estimates must remain normal Float32 values, so extremely weak controls can fail validation.
It aggregates peak force caps across connected joint components for the complete recording duration.
Every dynamic body in such a component receives conservative linear and angular acceleration bounds from those forces and torques.
Anchor lengths and collider offsets bound motor torque and the corresponding linear motion.
The resulting acceleration, speed and position estimates must remain within their validated Float32 ranges.

These bounds deliberately ignore motor disable intervals, joint limits, damping and contact resistance.
They can reject long recordings or unusual mass and inertia ratios that can otherwise simulate successfully.
They preserve the existing mass and inertia checks and include motor-induced motion instead of checking authored targets alone.

Kinematic translation changes divided by the timestep must have finite Float32 squared norms.
Kinematic rotation targets require a finite squared bound of `(Math.PI / timestep) ** 2`.
Same-tick translation targets use the previous integrated translation for these checks.
These checks cover declared motion, without guaranteeing bounds on every force from contact or constraint solving.

Rapier's internal motion limits can also change finite extreme velocities.
The preflight checks prevent known overflow cases.
They do not promise preservation of arbitrarily large authored speeds.

Large translations can lose small movements through Float32 rounding.
For example, `16777217` becomes `16777216`.
Nonfinite solver outputs fail the bake and release the world.
The bake also validates actual linear and angular velocity squared norms at every recorded frame.

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

Two motor control shapes were considered.
A live `scene.joint(name).setMotor(...)` API exposes mutable solver state and callbacks during playback.
The selected shape adds complete joint motor snapshots to the existing serializable definitions and tick events.
This preserves pre-async validation, deterministic bake order and arbitrary recorded seeks after the solver world is freed.

The addon supports rigid-body contacts, compound colliders, impulses, kinematics, articulated graphs, and single-coordinate joint limits and motors.
It does not implement cloth, soft bodies, spherical multi-axis controls, or live solver editing.
It does not bind physics directly to skeletal bones or generate a humanoid skeleton.
Those features need additional public contracts.
Creating a scene bakes synchronously after asynchronous WASM initialization and can block the main thread.
A worker integration can move that bake off the render thread.

## Mesh colliders, sensors and masks

A collider takes `shape: 'convexHull'` with `points` (flat xyz, at most `maxHullPoints`, default 2048) or `shape: 'trimesh'` with `vertices` and `indices` (at most `maxColliderTriangles` triangles across the scene, default 20000).
Counts are checked before any typed array is allocated, and indices must point at a vertex.
A trimesh needs a `fixed` or `kinematic` body, because it encloses no volume to take a mass from.
Use a convex hull for a dynamic body; its true mass comes from the hull, and the bounding box only sizes the safety checks.

`sensor: true` makes a collider report overlaps without pushing anything.
`groups` and `mask` are 16-bit integers. Two colliders touch only when each one's `groups` shares a bit with the other's `mask`.
Both default to `0xffff`.

The recorded scene lists what happened:

- `contactEvents`: `{ frame, kind: 'contact' | 'sensor', started, colliderA, colliderB }` in step order, with indices into `colliderNames`. `contactEventsTruncated` is true past `maxContactEvents` (default 4096).
- `restFrames`: per body, the frame from which it stays under 0.02 m/s and 0.05 rad/s until the end, or `-1` while it still moves.

`bakePhysicsScene` is the synchronous twin of `createPhysicsScene`. Await `loadPhysicsEngine()` once, then bake without awaiting.
`setPhysicsModuleLoader` replaces how Rapier is imported, for a host that serves it from a URL, as the MCP preview does.

## Recipe physics

A scene recipe takes a `physics` section, and `set-physics` edits it (`null` clears it):

```json
"physics": {
  "duration": 3,
  "gravity": [0, -9.81, 0],
  "bodies": [
    { "node": "tray", "type": "fixed", "shape": "trimesh" },
    { "node": "ball-1", "shape": "ball", "restitution": 0.3, "layer": 1, "collidesWith": [0] }
  ],
  "joints": [{ "type": "revolute", "bodyA": "door", "bodyB": "frame", "axis": [0, 1, 0], "limits": [0, 1.5] }]
}
```

Each body is a root node with a geometry. Its collider is fitted to that geometry at the node scale: `box`, `ball` and `capsule` from the bounds, `convex` from at most 2048 distinct vertices, `trimesh` from every triangle.
Defaults are `box` for dynamic bodies and sensors, `trimesh` for fixed ones.
`layer` (0 to 15) and `collidesWith` replace raw bit masks.
A node cannot have both a physics body and a motion `translation` or `rotation` track.
Limits: 64 bodies, 64 joints, 10 seconds, 60 steps a second, so at most 601 frames.

The bake runs once, when the scene is created or the section changes, and is reused while the section and the geometry stay the same.
After that the scene treats physics like motion: `sampleMotion(time)` and the MCP `motionTime` read the recording, so a seek back gives the same matrices. A time past `duration` holds the last pose, and `null` restores the authored pose.
Rapier is loaded on demand, an optional peer dependency. The MCP runtime serves it from `node_modules` to the preview page, like Manifold, so the server bundle does not carry it.

`scene_inspect` returns a `physics` report: per body the `finalPosition`, `finalSpeed` and `restsAtTime` (null while moving), the `contacts` between bodies with `firstTime`, `count` and `touchingAtEnd`, and the sensor `enter` and `leave` events with times.
An agent can check that a ball came to rest on a mesh from these numbers, without a picture.

Repeat recordings require identical inputs, creation order, timestep, solver options, and Rapier version.
Rapier documents cross-platform determinism for its WASM solver under identical initial conditions.
Input calculations such as `Math.sin` can differ across platforms and invalidate that guarantee.
This addon does not promise identical trajectories across different Rapier versions.
The implementation uses `@dimforge/rapier3d-compat` version `0.21.0`, licensed under Apache 2.0.

Sources: [Rapier JavaScript setup](https://rapier.rs/docs/user_guides/javascript/getting_started_js/), [Rapier joints](https://rapier.rs/docs/user_guides/javascript/joints/) and [Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/).
