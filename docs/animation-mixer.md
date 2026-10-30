# Animation mixer

`createAnimationMixer(parts)` captures the initial local transforms and material values of named parts.
`clipAction(clip)` binds a clip from `createAnimationClip` and returns a reusable action.
Repeated calls with the same clip object return the same action.
`apply(time)` evaluates the complete scene at an absolute time in seconds and returns `parts`.

```js
import { createAnimationMixer } from '67js';

const mixer = createAnimationMixer(parts);
const walk = mixer.clipAction(walkClip).play({ at: 0 });
const gesture = mixer.clipAction(gestureClip);
mixer.crossFade(walk, gesture, { at: 2, duration: 0.5 });
mixer.apply(2.25);
mixer.apply(1);
```

## Action controls

| Method | Behavior |
| --- | --- |
| `play({ at, offset = 0, timeScale = 1, weight = 1 })` | Starts or restarts playback at `at`, with the given local offset and speed. |
| `stop(at)` | Stops contributing from `at` onward. Earlier times retain their recorded playback. |
| `fadeTo(weight, { at, duration })` | Interpolates from the effective weight at `at` to the target weight. |
| `getState(time)` | Returns `phase`, `playing`, `weight` and the unwrapped `localTime`. |
| `crossFade(from, to, { at, duration })` | Fades the source to zero and the destination to one. |

Omitted `at` and state-query times default to the last successful `apply()` time, initially zero.
Every action requires nondecreasing authored control times. Controls can share a timestamp, and the last control wins.
A new fade interrupts a previous fade continuously from its effective weight at the interruption time.
`crossFade` automatically starts a stopped destination at local time zero.
An already playing destination retains its playback origin, offset and speed.

Weights must be finite numbers within `[0, 1]`.
Fade duration must produce a finite end time strictly after its start.
Offsets and speeds must be finite. Negative speed reverses playback, and zero speed holds a local pose.
The source clip controls looping and endpoint clamping.

Action phases are `scheduled`, `playing`, `fading` and `stopped`.
A completed fade to zero keeps the action playing with zero weight.
Zero-weight actions skip curve evaluation. `stop()` records an explicit stopped state.

## Mixing rules

Mixing operates independently on each target property.
Clips that omit a property contribute no weight to that property.
When the total weight is below one, the captured base pose supplies the remaining weight.
When the total exceeds one, clip contributions normalize by their total weight.
Translation, scale and material properties use weighted linear interpolation.

Rotation uses incremental shortest-arc spherical interpolation in action registration order, followed by normalization.
Quaternion antipodes represent the same rotation and therefore blend without cancellation.
Three or more rotations can produce different results with different registration orders.
The weighting and rotation rules follow the installed Three.js `PropertyMixer` implementation.
Regression tests compare scalar and quaternion output against the installed Three.js mixer.

Scale and roughness remain at least `1e-8`.
Metallic and roughness remain at most one. Metallic and emission remain nonnegative.
These constraints can flatten curves near their domain limits.

## Seek and scene ownership

Playback retains control timelines and never consumes fade events during evaluation.
Backward and forward seeks therefore produce the same result for the same timeline and time.
Command authoring and playback seeking have separate ordering rules.
Controls allocate timeline records. Repeated `apply()` calls reuse compiled curve, mixing and matrix buffers.

Matrix identities remain stable. Untracked transform components retain their captured base values.
When all transform contributions stop, the mixer restores the captured matrix exactly.

Material tracks receive one shallow material copy per target during registration.
Players and mixers reuse the same isolated material when they bind the same target.
Material identities remain stable during playback, while nested texture references stay shared.
Parts without registered tracks retain their existing scene objects.

All samples and composed matrices must pass validation before the mixer writes scene properties.
Nonfinite output, invalid quaternions and Float32 matrix overflow throw without changing scene properties or the last successful mixer time.
Mixer matrices must be affine transforms with positive scale and no shear.
Tracked material properties must start in their valid domains. Missing emission defaults to zero.
The mixer owns registered properties during playback, so external writes do not change its captured base pose.

## API design choice

| Shape | Evaluation | Tradeoff |
| --- | --- | --- |
| Mutable action state with `update(delta)` | Advances clocks and consumes transitions. | Fits render loops, but arbitrary seeks need reconstruction of prior transitions. |
| Retained control timeline with `apply(time)` | Selects a state snapshot and evaluates its envelope. | Preserves seek history, with memory proportional to authored controls. |

Retained timelines support deterministic film sampling and interrupted fades without depending on previous evaluation calls.
The mixer uses `compileAnimationSampler` from the curve module, so interpolation math has one implementation.

This mixer has no additive blending, because it needs an explicit reference pose and quaternion delta convention. [Skeleton pose layers](skeleton-pose.md) provide additive layers, joint masks and IK for skinned rigs.
This module does not add skeletal skinning, morph targets, hierarchy propagation, root motion extraction, transition warping or animation events.
