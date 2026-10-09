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
The helper does not implement mixer controls, imported skin animation authoring, or live playback clocks.

## Bounds and checks

The controller accepts durations between 0.1 and 30 seconds.
A motion requires at least one track.
It can contain at most 128 tracks, 64 keys per track, and 2048 keys in total.
Values and tangents must remain finite at Float32 precision.
The scene integration must also enforce its total recipe byte budget.

1. Run `node --test tests/agent-motion.test.js`.

The CPU tests cover curves, looping, references, bounds, backward seeks, retained buffers, and failed sample publication.
Native rendering and published MCP verification belong to the integration layer.
