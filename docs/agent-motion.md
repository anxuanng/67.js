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
[Skeleton pose layers](skeleton-pose.md) add clip layers and masks in code.

### Joint limits and sanity warnings

A two-bone solver takes `limits: { "root": { "x": [min, max], "y": [...], "z": [...] }, "middle": {...} }` in degrees. Each
range bounds how far that joint turns away from its rest rotation, per axis of the joint's own frame, as Euler XYZ (the
order Blender uses). A limited joint is clamped after the solve and the end rotation is restored, so a clamped knee leaves
the foot short of its target and `reached` turns false. `motionIk[n].limited` lists each joint and axis a limit changed:
`{ joint, axis, requested, applied, atTime }`, degrees, first time it happens.

`motionIk[n].warnings` lists `{ code, message, atTime }` once per code:

| Code | When |
| --- | --- |
| `hyperextended` | The middle joint is within 5 degrees of straight: the target is at or past the limb's reach |
| `wrong-bend` | The middle joint bends opposite to its natural side, which a pole on the wrong side produces while the foot still arrives |

The natural side is `bendToward` (a world direction, such as `[0, 0, 1]` for a knee on a character that faces +z) or, when
that is absent, the way the limb is bent in its rest pose. A limb that rests perfectly straight and has no `bendToward` is
never checked for the wrong bend, so give legs and arms one.

## Constraints

`motion.constraints` is a list of Blender-style node constraints, at most 32. Each names the constrained `node` (a recipe
node, or an editable asset node), a `type`, a `target` node where the type needs one, and an `influence`: 0 to 1 (default 1)
or an expression. Influence blends the node's matrix before and after the constraint, location, rotation and scale
separately, as Blender does. Euler angles are XYZ in degrees. `space` is `world` (default) or `local`, local being the node's
own transform under its parent.

| Type | Fields | Meaning |
| --- | --- | --- |
| `copy_location` | `target`, `axes`, `invert`, `offset`, `space` | The chosen axes take the target's location; `offset` adds it to the node's own |
| `copy_rotation` | `target`, `axes`, `invert`, `mix` (`replace` or `add`), `space` | The chosen Euler axes take the target's |
| `copy_scale` | `target`, `axes`, `offset`, `space` | The chosen axes take the target's scale; `offset` multiplies |
| `limit_location` | `x`, `y`, `z` as `[min, max]`, `space` | Clamp the location per axis |
| `limit_rotation` | `x`, `y`, `z` as `[min, max]` degrees, `space` | Clamp the Euler angles per axis |
| `track_to` | `target`, `trackAxis` (default `-z`), `upAxis` (default `y`), `worldUp` (default `[0, 1, 0]`) | Turn the node so its track axis points at the target and its up axis leans toward `worldUp`. Blender's up is Z, so its numbers match with `worldUp: [0, 0, 1]` |
| `child_of` | `target`, `inverse` (`rest` or `none`) | The node follows the target: its world matrix becomes target * inverse * its own. `rest` uses the inverse of the target's rest matrix, so the node stays put until the target moves; Blender's default is `none` |
| `floor` | `target`, `axis` (default `+y`), `offset` | Keep the node on the positive side of the plane through the target, along `axis`, plus `offset` |

Not covered yet: `use_*` switches on `child_of`, `limit_scale`, `copy_transforms`, `damped_track`, `locked_track`,
`stretch_to`, bone sub-targets and `head_tail`.

## Drivers

`motion.drivers` sets one node component or material property from a bounded expression, at most 32. A target is
`{ "kind": "node", "id", "property": "translation" | "rotation" | "scale", "component": "x" | "y" | "z" }` (rotation is Euler
XYZ in degrees) or `{ "kind": "material", "id", "property" }` for `emission`, `metallic` and `roughness`, or with a
`component` for `color` and `emissiveColor` (`x`, `y`, `z` for red, green, blue). A driven property cannot also have a track.

An expression is JSON data and is never run as code. It is the motion context of the one expression language described in
[field expressions](mesh.md#field-expressions): the same operators with the same results, the same syntax, and limits of 64
parts and 8 levels. Where a field reads mesh attributes, a driver reads `"time"` (seconds) or a node
`{ "node", "property", "component", "space" }`, for example `{ "mul": ["time", 2] }`; vectors, attributes and noise are field
inputs and are rejected here with a message that says so. `sin` and `cos` take radians. One difference remains: `div` by zero
gives 0 in a field but is a non-finite result in a driver, which is an error, so a mistaken driver is reported.

### Evaluation order

For any time, the pose is built in this order and keeps no state between samples, so seeking gives the same pose as playing
to that time:

1. Tracks, and for an asset the selected clip.
2. IK, in list order.
3. Drivers. They read the pose from steps 1 and 2, so one driver never sees another's result.
4. Constraints, in list order. Each reads the pose the ones before it left. Expressions in `influence` read the pose from
   step 2.

IK targets that follow a node see that node before drivers and constraints move it. Material drivers on an imported asset
read node values from the tracks and rest pose, not the clip.

## Authored rigs

A recipe `armatures` list holds skeletons. Each bone has a `name`, a `parent` (a bone name or `null`), a rest `head` in the
armature's own space and an optional `tail`; without one the tail is the mean of the children's heads. Instead of
`bones`, give `preset: "humanoid"` or `"quadruped"` and `fit: { node }` (a mesh node whose bounds size the rig) or
`fit: { bounds: { min, max } }`. `fit.landmarks` moves a bone head by name, or its tail as `<name>Tail`. Presets are
resolved to explicit bones when the recipe is read, so a stored recipe does not change when the mesh does. A humanoid
faces +Z with Y up and uses the `HUMANOID_BONES` names, so `retargetClip` maps it without overrides. Its knees sit a little
forward of the leg line and its elbows a little behind, so a two-bone solve without a pole folds them the right way.
A quadruped lies along Z and names its legs `leftFrontUpperLeg`, `rightHindFoot` and so on.

Every bone becomes a recipe node (ID is `prefix` plus the name; the armature root is a node with the armature's ID), parented
like the bones and carrying the `armature` field. Those nodes are regenerated from `armatures` each time the recipe is read, so edit
bones with `set-armatures`, not `set-node`. Node rotation tracks and `motion.ik` address bones like any node; rotation is local
to the bone head, and at rest it is the identity. Positive X rotation swings a hanging limb backward, so a thigh swings from
negative to positive and a shin folds with positive values.

A mesh node binds with `skin: { armature, maxInfluences, maxDistance }`. Weights are the distance from each vertex to each bone
segment, `((nearest + softness) / (distance + softness))^4`, with the nearest four kept and normalised. Bone heat diffusion
or a geodesic falloff would be smoother where two limbs pass close, but needs a sparse solve per bone; this method depends only on
position, so vertices split at a hard edge get identical weights and seams never open. A vertex farther than `maxDistance`
(default a quarter of the rig's size) from every bone still binds to its nearest bones and is reported as unweighted.
`scene_inspect` returns `rig` per armature with `skinned` (vertices and `unweightedVertices` per node), `bonesWithNoVertices`
and `jointAxisProblems` (`zero-length`, `straight-chain`, `knee-bends-backward`, `elbow-bends-forward`).

`scene_export_glb` writes the bones at rest, the skins and a clip named `motion` baked at 30 frames a second from tracks and
IK (bone nodes only). In code, `scene.rigExport()` returns the `nodes` and `clips` options for `exportGlb`. Skinned parts render and export their
bone-driven shape; the node transform of a skinned mesh does not move it, move the armature instead. The `rigged-walker`
task in `bench/agent-modeling` builds and walks a character this way.

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
