# Wheeled vehicles

`67js/addons/vehicle` drives a car or truck along a path with deterministic, physics-free animation. It is available from version `0.10.0`. Wheel spin, front-wheel steering, roll, pitch and ground following all come from the path, and `sample(seconds)` gives the same pose for the same time.

## The maths behind a drive

The docs run with the core module only, so this example builds a car from boxes and cylinders and applies the same rules by hand on a circular path: wheel spin is `distance / radius`, the steer angle is `atan(wheelbase * curvature)` with Ackermann angles per front wheel, and roll follows lateral acceleration. Drag the speed slider. Faster driving leans the body more. The console prints the pose once a second.

```js live poster=vehicle-drive
import { Renderer67, box, cylinder } from '67js';

const multiply = (a, b) => {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
};
const move = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scale = (x, y, z) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
const turnY = a => new Float32Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);
const turnX = a => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);
const turnZ = a => new Float32Array([Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const wheelRadius = 0.35;
const wheelbase = 2.6;
const trackWidth = 1.5;
const pathRadius = 6;
const rollGain = 0.012;
const wheelSpecs = [
  { id: 'front left', x: trackWidth / 2, z: wheelbase / 2, front: true },
  { id: 'front right', x: -trackWidth / 2, z: wheelbase / 2, front: true },
  { id: 'rear left', x: trackWidth / 2, z: -wheelbase / 2, front: false },
  { id: 'rear right', x: -trackWidth / 2, z: -wheelbase / 2, front: false },
];

const bodyPart = { name: 'Body', geometry: box(0.1, 3), matrix: scale(1.8, 0.55, 4), material: { color: [0.8, 0.2, 0.18], metallic: 0.3, roughness: 0.35 } };
const cabinPart = { name: 'Cabin', geometry: box(0.15, 3), matrix: scale(1.5, 0.5, 2), material: { color: [0.15, 0.2, 0.28], metallic: 0, roughness: 0.2 } };
const tire = cylinder(24, 0.05, 2);
const wheelParts = wheelSpecs.map(spec => ({ name: `Wheel ${spec.id}`, geometry: tire, matrix: scale(1, 1, 1), material: { color: [0.06, 0.06, 0.07], metallic: 0, roughness: 0.8 } }));
const parts = [bodyPart, cabinPart, ...wheelParts];

// The pose for a time, from the path alone: nothing depends on the previous frame.
function sample(seconds, speed) {
  const distance = speed * seconds;
  const angle = distance / pathRadius;
  const curvature = 1 / pathRadius;
  const steer = Math.atan(wheelbase * curvature);
  const lateral = speed * speed * curvature;
  return {
    time: seconds,
    distance,
    speed,
    position: [pathRadius * Math.sin(angle), 0, pathRadius * Math.cos(angle) - pathRadius],
    heading: Math.PI / 2 + angle,
    roll: rollGain * lateral,
    steerAngle: steer,
    wheels: wheelSpecs.map(spec => {
      const side = spec.x > 0 ? 1 : -1;
      const turnRadius = pathRadius - side * spec.x;
      const ackermann = spec.front ? Math.atan2(spec.z + wheelbase / 2, turnRadius) : 0;
      return { id: spec.id, spinAngle: distance * (turnRadius / pathRadius) / wheelRadius, steerAngle: ackermann };
    }),
  };
}

function apply(pose) {
  const frame = multiply(multiply(move(...pose.position), turnY(pose.heading)), turnZ(pose.roll));
  parts[0].matrix = multiply(frame, multiply(move(0, 0.65, 0), scale(1.8, 0.55, 4)));
  parts[1].matrix = multiply(frame, multiply(move(0, 1.15, -0.2), scale(1.5, 0.5, 2)));
  pose.wheels.forEach((wheel, index) => {
    const spec = wheelSpecs[index];
    const local = multiply(move(spec.x, wheelRadius, spec.z), multiply(turnY(wheel.steerAngle), multiply(turnX(-wheel.spinAngle), multiply(turnZ(Math.PI / 2), scale(wheelRadius, 0.28, wheelRadius)))));
    parts[2 + index].matrix = multiply(frame, local);
  });
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const renderer = new Renderer67(canvas, parts);
const state = { speed: 6, yaw: 0.5, pitch: 0.7, distance: 17, playing: true };
let seconds = 0;
let last = performance.now();
let nextLog = 0;

function draw() {
  const pose = sample(seconds, state.speed);
  apply(pose);
  renderer.updateParts(parts);
  const flat = Math.cos(state.pitch) * state.distance;
  renderer.render({ eye: [Math.sin(state.yaw) * flat, Math.sin(state.pitch) * state.distance, Math.cos(state.yaw) * flat - pathRadius], target: [0, 0.5, -pathRadius], fov: 42 });
  return pose;
}

function frame(now) {
  if (state.playing) seconds += (now - last) / 1000;
  last = now;
  const pose = draw();
  if (state.playing && seconds > nextLog) {
    nextLog = seconds + 1;
    console.log(`t=${seconds.toFixed(1)} s distance ${pose.distance.toFixed(1)} m, steer ${pose.steerAngle.toFixed(3)} rad, roll ${pose.roll.toFixed(3)} rad, front-left spin ${pose.wheels[0].spinAngle.toFixed(1)} rad`);
  }
  requestAnimationFrame(frame);
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
toggle.textContent = 'Pause';
toggle.addEventListener('click', () => { state.playing = !state.playing; toggle.textContent = state.playing ? 'Pause' : 'Play'; });
const speed = document.createElement('input');
speed.type = 'range';
speed.min = 1;
speed.max = 14;
speed.step = 0.5;
speed.value = state.speed;
speed.addEventListener('input', () => { state.speed = Number(speed.value); });
speed.addEventListener('change', () => console.log(`speed ${state.speed} m/s, lateral acceleration ${(state.speed ** 2 / pathRadius).toFixed(2)} m/s²`));
bar.append(toggle, 'speed', speed);
document.body.append(bar);
canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  state.yaw -= event.movementX * 0.01;
  state.pitch = Math.min(1.3, Math.max(0.15, state.pitch + event.movementY * 0.01));
});
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

In this model the inside wheels spin slower in the corner because their path is shorter, as in the addon, where they turn slower by their lateral offset times the heading change.

## Drive a real vehicle

1. Describe the vehicle with `createVehicleRig({ parts })`. Wheels are found by name and geometry. Check `rig.wheels` or `findWheelCandidates(names)`.
2. Build a drive with `driveAlongPath(rig, points, { cruiseSpeed, groundHeight })`.
3. Each frame, call `applyVehiclePoseToParts(rig, drive.sample(seconds))` and then `renderer.updateParts(parts)`.

```js
import { Renderer67 } from '67js';
import { createVehicleRig, driveAlongPath, applyVehiclePoseToParts } from '67js/addons/vehicle';

const rig = createVehicleRig({ parts: carParts });
console.log(rig.wheels.length, rig.wheelbase, rig.trackWidth);
const drive = driveAlongPath(rig, [[0, 0, 0], [10, 0, 4], [20, 0, 4], [30, 0, 0]], { cruiseSpeed: 8, groundHeight: terrain.heightAt });
const renderer = new Renderer67(canvas, [...sceneParts, ...carParts]);
function draw(seconds) {
  const pose = drive.sample(Math.min(seconds, drive.duration));
  applyVehiclePoseToParts(rig, pose);
  renderer.updateParts(carParts);
  renderer.render({ eye, target: pose.position });
}
```

Scene-graph nodes and imported GLBs use `applyVehiclePoseToSceneGraph` and `applyVehiclePoseToAsset`.

## Conventions and options

Units are metres, +Y is up and the system is right-handed. Angles are radians. The model's forward axis is `+z` unless `forwardAxis` is `'+x'`, `'-x'` or `'-z'`. Left is `up x forward`, so left is `+x` when forward is `+z`. The rig builds a local frame on the ground under the centroid of the wheel centres and moves the whole model with it. `pose.heading` is yaw about +Y, zero when facing +z. `pitch` is positive nose up, `roll` is positive when the left side rises, and steering is positive toward the left.

`driveAlongPath(rig, path, options)` returns `{ sample(seconds), duration, length, rig }`. The path is an array of `[x, y, z]` points, smoothed with a centripetal spline, or a camera path object whose eye track is followed. Give exactly one speed option.

| Option | Meaning |
| --- | --- |
| `speed` | Constant metres per second, no ramp. |
| `cruiseSpeed` | A profile with `acceleration` (3), `braking` (4), `startSpeed` (0), `endSpeed` (0) and `maxLateralAcceleration` (unlimited). |
| `startTime`, `groundHeight(x, z)`, `maxSteerAngle` | Start offset, ground fit and steering clamp. |
| `rollGain`, `pitchGain` | 0.012 rad per m/s² each. |
| `bounceFrequency`, `dampingRatio`, `suspensionTravel` | 1.6 Hz, 0.45 and 0.2 m. |
| `pathSamples` | 400, for camera paths. |

`sample(seconds)` returns `{ time, distance, speed, direction, position, heading, pitch, roll, steerAngle, wheels: [{ id, spinAngle, steerAngle, suspensionOffset }], lights }`. Roll and pitch follow lateral and longitudinal acceleration through a spring and damper, integrated at a fixed step when the drive is created, so sampling order does not matter. With `groundHeight`, the body height and its slope are fitted to the ground under the four wheels, and each wheel gets a `suspensionOffset`. The vehicle holds the end of the path with zero speed. Use `cruiseSpeed` for a natural stop, because a constant `speed` stops instantly and the body pitches.

## Limits

- Kinematic only: no collisions, tire slip or jumps. Heading follows the path tangent, plus a half turn while reversing.
- Ground is a plane fit under the wheels, so bumps narrower than the wheelbase show as suspension offsets, clamped to `suspensionTravel`.
- Rear-steered wheels get no Ackermann angle.
- Through MCP the tail lights drive only the materials of an asset recipe, and `groundHeight` is not available.
- Scene-graph nodes with a nonzero `pivot` are rejected. Wheel radius from geometry assumes a round wheel in the plane across its axle.

The [vehicle contract](https://github.com/codepawl/67.js/blob/main/docs/vehicle.md) lists conventions, options and limits.

## Common mistakes

- A model whose forward axis is not `+z` and no `forwardAxis`. The car drives sideways.
- Wheels that are merged into one geometry. The rig finds wheels by name and geometry, so keep them separate parts.
- Sampling past `drive.duration`. The vehicle holds the end of the path.
- Using a constant `speed` and expecting a smooth stop.
- Expecting collisions. The drive is kinematic.
