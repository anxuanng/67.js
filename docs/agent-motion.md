# Agent motion

Release `0.7.0` adds procedural motion to agent recipes, preview seeks and snapshot render jobs.
The `agent-scene` addon and packaged MCP server share this contract.
The installed package version determines availability.

## Scene and MCP usage

```js
import { createAgentScene } from '67js/addons/agent-scene';

const scene = createAgentScene(recipe);
scene.apply([{ type: 'set-motion', motion }], { expectedRevision: scene.revision });
scene.sampleMotion(1);
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.sampleMotion(null); // Restore the authored base pose.
```

The example assumes a valid recipe, a motion record and a renderer bound to `scene.parts`.
Creation, successful edits and checkpoint restore sample time zero when the recipe contains motion.
`sampleMotion(time)` accepts absolute seconds or `null` to restore base transforms, materials and camera.
It preserves part, matrix, material handle and geometry identities.
It does not regenerate geometry or advance revisions.

MCP `scene_look` accepts optional `motionTime` with the same seconds and `null` semantics.
Omitting `motionTime` preserves the current preview pose.
`scene_inspect` reports authored motion duration, loop, track count and transient time.
Its bounds remain in `authored-base-world` space, independent of the sampled pose.

`set-motion` requires a complete motion record or explicit `null` to clear it.
The final batch must resolve every track reference, including after node or material removal.
Failed edits or seeks preserve the previous recipe, rendered pose and revisions.

Snapshot jobs select motion with `settings.motion: { start: 0 }`.
Frames use `start + elapsed` independently of imported clips and renderer shader time.
Omitting this setting holds the initial motion pose.
Nonlooping job samples must fit the authored duration.
Looping samples wrap, with an absolute maximum of 3600 seconds.
Completion and cancellation preserve the source preview time, revision and checkpoints.

## Authored data

A motion contains one duration, an optional loop flag, and typed keyframe tracks.
Node tracks address final recipe node IDs, including nodes without geometry.
Their values represent absolute local translation, XYZW quaternion rotation, or positive scale.
Material tracks address material IDs and affect every node that shares that material.
Camera tracks omit an ID and address eye, target, vertical FOV, or roll.
Roll uses radians, and FOV uses degrees.

```js
const motion = {
  duration: 2,
  loop: false,
  tracks: [{
    kind: 'node',
    id: 'hinge',
    property: 'rotation',
    interpolation: 'SMOOTH',
    keyframes: [
      { time: 0, value: [0, 0, 0, 1] },
      { time: 2, value: [0, 0, 0.70710678, 0.70710678] },
    ],
  }],
};
```

Node properties are `translation`, `rotation`, and `scale`.
Material properties are `color`, `emissiveColor`, `emission`, `metallic`, and `roughness`.
Camera properties are `eye`, `target`, `fov`, and `roll`.
Untracked properties retain authored base values.
Clipping planes retain authored values. Roll rotates the authored camera up direction.

Tracks support `LINEAR`, `STEP`, `SMOOTH`, and `CUBICSPLINE` interpolation.
Cubic keys require both `inTangent` and `outTangent`, with the same dimensions as the value.
Tangents use change per second.
Quaternion values normalize through the existing animation core.
Quaternion tangents retain their authored values.
Other interpolation modes reject tangents.

## Inverse kinematics

`motion.ik` computes node rotations from a goal, so a recipe can say where a hand should be without any quaternions. It
works on procedural recipes and imported assets, and runs after the tracks and any selected clip at every sample, in list order. `tracks` can be empty when a
motion has `ik`.

```json
{ "duration": 2, "tracks": [], "ik": [
  { "type": "two-bone", "root": "shoulder", "middle": "elbow", "end": "wrist", "target": { "node": "ball" }, "pole": [0, 3, -1] },
  { "type": "aim", "joint": "lamp", "target": { "node": "ball" }, "maxAngle": 120 }
] }
```

A `two-bone` solver takes `root`, `middle` and `end` node IDs, each a descendant of the one before. `pole` is the world
point the middle node bends toward; give one, because a straight limb has no bend direction of its own. `keepEndRotation`
defaults to `true`, so a gripper or foot keeps its world rotation.

An `aim` solver takes `joint`, or `joints` from the base of a chain to the aiming node, which then share the turn.
`worldForward` is the world direction the character faces at rest, which is the one to use on imported rigs because their
bone axes vary. Otherwise `forward` is the aiming node's local axis (default `[0, 0, 1]`). `maxAngle` limits the whole
turn in degrees.

`target` and `pole` are each `[x, y, z]` in world metres, `{ "node": id }` to follow a node, or
`{ "keyframes": [{ "time", "value" }], "interpolation" }`. `weight` is 0 to 1 (default 1), or keyframes to fade a solve in
or out. Keyframes count toward the motion's limit of 2048. A motion holds at most 16 solvers.

A node with IK nodes below it needs uniform scale and no scale track, because a non-uniform parent would shear the chain.
Put sizes on a child node with the geometry, or on the last node of the chain, whose own scale does not matter.

`scene_inspect` returns `motionIk`, one `{ type, reached, worstError, atTime }` per solver, from 33 samples across the
clip. `worstError` is metres for two-bone and radians for aim, so a target out of reach shows up without looking at every
frame. A limb that cannot reach stretches toward the target.

On an imported asset, joints are its `node-N` IDs from `scene_inspect` with `kind: "hierarchy"`, and they must be editable.
Each sample stages the clip and overrides, reads the local pose, solves, and stages again, so the rest of the body stays on
the selected clip and skins and rigid parts all follow. Targets are in world space, under the asset's `root`, which needs a
uniform scale. Some rigs have no chain to the foot: if the foot is not a descendant of the lower leg, two-bone IK refuses it.
There are no joint angle limits. [Skeleton pose layers](skeleton-pose.md) add clip layers and masks in code.

## Internal sampling helpers

`normalizeAgentMotion(input, recipe)` returns canonical plain JSON, or `null` for absent motion.
It copies values, sorts keyframes, and rejects duplicate times, unknown fields, missing references, and duplicate target properties.
References must exist in the final recipe after the entire edit batch.

`compileAgentMotion(motion, recipe)` returns a retained sampler, or `null` for absent motion.
The sampler copies its inputs and reuses the existing animation core and camera path implementation.
Its `sample(time)` method returns `{nodes, materials, camera}`.
The node and material maps contain patches keyed by recipe IDs.
Vector patches use retained `Float64Array` values, while scalar patches use numbers.

Camera vectors use retained `Float32Array` values to validate rounded poses.
The camera output is `null` when no camera tracks exist.

Outputs are borrowed staging buffers.
Callers must copy them before retaining a pose and must not mutate the returned maps, patches, or arrays.
A failed sample leaves previously published sampler outputs unchanged.
The caller must validate composed hierarchy transforms, geometry bounds, and renderer constraints before publishing the rendered pose.
This helper does not regenerate geometry or bind directly to renderer parts.

## Sampling and state

Sampling uses absolute time and does not depend on previous seeks.
Nonlooping clips clamp to the duration, while looping clips wrap modulo the duration.
Sample times must be finite and within zero and 3600 seconds.
Cubic scale and material overshoot fails validation rather than silently clamping.

Material samples retain the agent material domain, including roughness zero.
Combined emission and emissive color must remain within Float32 radiance limits.
Unlit materials also obey the HDR radiance ceiling.

Camera samples reject coincident eye and target positions, invalid up directions, and invalid lenses.

Authoring changes belong in revisioned recipe transactions.
Transient sampling must preserve the canonical recipe, source revision, topology revision, and checkpoint contents.
Checkpoint restore must reconstruct bindings from the restored recipe.
Job snapshots must retain authored motion independently of imported animation and renderer shader time.
Release `0.8.0` reuses this motion contract for [imported character joints](agent-character-motion.md).
The helper does not implement mixer controls, facial morph tracks or live playback clocks.

## Physics beside motion

A recipe can also carry a `physics` section (see "Recipe physics" in `docs/physics.md`). It is recorded once with Rapier and played back through the same `sampleMotion(time)` and MCP `motionTime`, so one seek moves tracks, IK and bodies together.
A body node takes its pose from the recording. A node cannot have a body and a motion translation or rotation track, and a scene may have physics without any motion tracks.

## Bounds and checks

The controller accepts durations between 0.1 and 30 seconds.
A motion requires at least one track.
It can contain at most 128 tracks, 64 keys per track, and 2048 keys in total.
Values and tangents must remain finite at Float32 precision.
The scene integration must also enforce its total recipe byte budget.

1. Run `node --test tests/agent-motion.test.js`.

The CPU tests cover curves, looping, references, bounds, backward seeks, retained buffers, and failed sample publication.
Native rendering and published MCP verification belong to the integration layer.
