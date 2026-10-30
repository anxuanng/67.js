# Skeleton pose layers and IK

`67js/addons/skeleton-pose` builds a skeletal pose from clip layers, then corrects it with inverse kinematics. Use it to
wave while walking, add breathing on top of any clip, keep feet on uneven ground, reach for an object or look at a point.

```js
import { createSkeletonPose } from '67js/addons/skeleton-pose';

const pose = createSkeletonPose({
  skin: character.skins[0],
  layers: [
    { clip: walk },
    { clip: wave, mask: { joints: ['rightUpperArm'] } },
    { clip: breathe, additive: true },
  ],
  ik: [
    { type: 'two-bone', root: 'leftUpperLeg', middle: 'leftLowerLeg', end: 'leftFoot', pole: [0, 1, 2], target: (time, foot) => [foot[0], terrain.heightAt(foot[0], foot[2]), foot[2]] },
    { type: 'aim', joints: ['spine', 'head'], forward: [0, 0, 1], maxAngle: 60, target: [2, 1.6, 3] },
  ],
});

pose.apply(seconds);
renderer.updateParts(character.parts);
```

Every `apply(time)` rebuilds the pose from the rest pose: layers in order, then solvers in order. Nothing carries over
between calls, so a backward seek gives the same pose as playing forward, provided your weight and target functions
depend only on their arguments.

## Setup

`createSkeletonPose({ skin, rig, meshWorldMatrix, layers, ik })` takes a `skin` to write its joint palette, or only a
`rig` to read joint positions. `rig` defaults to `createRigFromSkin(skin)` from `67js/addons/retarget`; pass one with
`rootMatrix` when a scaled node sits above the root joints.

Anywhere a joint is named you can use the rig's joint name or a humanoid bone name such as `leftUpperArm`
(see [retargeting](retarget.md)), so a setup can move between rigs.

## Layers

| Field | Meaning |
| --- | --- |
| `clip` | From `createAnimationClip`. Tracks that name no rig joint are ignored; at least one must match |
| `weight` | 0 to 1 (default 1), or a function of time |
| `mask` | `{ joints, descendants = true, exclude }`. The layer touches only these joints. `exclude` removes joints with their descendants |
| `additive` | `true` adds the clip's change from `reference` instead of replacing the pose |
| `reference` | The clip time an additive layer counts as no change, in seconds (default 0) |
| `speed`, `offset` | Layer time is `time * speed + offset`. The clip decides looping |

A normal layer blends toward its clip by `weight`: spherical interpolation for rotation, linear for translation. Joints
its clip does not track keep the pose so far. An additive rotation is `inverse(reference) * sample`, applied in the
joint's own frame (`local = local * delta`), and weight scales the delta. An additive translation adds
`(sample - reference) * weight`. So an additive clip is the same at `reference` as no layer at all.

## Two-bone IK

| Field | Meaning |
| --- | --- |
| `root`, `middle`, `end` | The chain, such as hip, knee and ankle. `end` must descend from `middle`, and `middle` from `root`; twist joints in between are fine |
| `target` | World position, or `(time, endPosition) => position` |
| `pole` | World point the middle joint bends toward, or `(time, middlePosition) => point`. Without one, it keeps the current bend |
| `weight` | 0 to 1 (default 1), or a function of time |
| `keepEndRotation` | Default `true`: the end joint keeps its world rotation, so a foot stays flat while the leg moves |

The solve is analytic, keeps bone lengths, and turns the two upper joints by the shortest rotations, so twist already in
the pose survives. A limb that is straight in the pose with its target straight ahead has no bend direction, so give
legs and arms a `pole`.

A target out of reach leaves the limb extended toward it. The limit is kept just short of fully straight, because a
perfectly straight limb has no defined bend for the next frame.

## Aim IK

| Field | Meaning |
| --- | --- |
| `joint` or `joints` | One joint, or a chain listed from its base to the aiming joint. A chain shares the turn evenly |
| `forward` | The aiming joint's local axis that should point at the target (default `[0, 0, 1]`). Check this per rig: it depends on the bone axes |
| `target` | World position, or `(time, jointPosition) => position` |
| `maxAngle` | Degrees (default 180). Limits the whole turn; past it the joint stops at the limit |
| `weight` | 0 to 1 (default 1), or a function of time |

The turn is the shortest rotation, so `aim` does not hold an up direction and can add a little roll.

## Reading the result

`pose.jointWorld(name)` returns `{ position, rotation }` after the last `apply`, in world space, for attaching props or
chaining targets. `pose.ikResults` holds one `{ reached, error }` per solver: `error` is metres from the target for
two-bone and radians off target for aim.

## Limits

- Uniform scale only, as in the [retargeting](retarget.md) rig. Clip scale tracks are ignored.
- No joint angle limits. A pole keeps a knee on the right side, but nothing stops a target from bending it too far.
- No full-body solve: moving a hand does not move the hips. Solvers run one at a time, so order them from the base of the
  body outward.
- MCP recipes cannot use this yet. Agent tools still author joints by rotation tracks, as in
  [imported character motion](agent-character-motion.md).
- The [animation mixer](animation-mixer.md) works on rigid part transforms and has no layers, masks or IK. Use this addon
  for skinned rigs.
