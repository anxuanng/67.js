# Animation curves

`createAnimationClip` accepts `LINEAR`, `STEP`, `SMOOTH` and `CUBICSPLINE` tracks.
Clips own immutable copies of their keyframes, values and tangents.
`sampleAnimationClip` returns independent scalar values or arrays.

```js
const clip = createAnimationClip({
  duration: 2,
  tracks: [{
    target: 'part',
    property: 'translation',
    interpolation: 'CUBICSPLINE',
    keyframes: [
      { time: 0, value: [0, 0, 0], inTangent: [0, 0, 0], outTangent: [4, 0, 0] },
      { time: 2, value: [2, 0, 0], inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
    ],
  }],
});
```

## Tangent contract

Spline tracks need at least two keyframes.
Each keyframe must contain finite `inTangent` and `outTangent` values with the same shape as its value.
Scalar properties use numbers. Translation and scale use three components. Rotation uses four components in `[x, y, z, w]` order.

Tangents express component changes per second. Quaternion tangents are component derivatives, not angular velocities.

The spline uses the starting keyframe's outgoing tangent and the ending keyframe's incoming tangent.
The Hermite equation multiplies those derivatives by the segment duration.
Quaternion curves interpolate their components, then normalize the result, without changing endpoint signs.
These interpolation rules follow [glTF Appendix C](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#appendix-c-animation-sampler-interpolation-modes).

Keyframe rotation values retain the existing normalization behavior. Tangents retain their supplied magnitude.
`LINEAR` and `SMOOTH` rotations retain shortest-arc spherical interpolation.
`STEP` holds the preceding keyframe. Endpoints clamp, and looping wraps negative times and exact clip boundaries.

## Output constraints

Spline overshoot clamps emission to zero or greater and metallic to `[0, 1]`.
It clamps roughness to `[1e-8, 1]` and scale components to `1e-8` or greater.
These constraints protect 67js material and positive-scale domains. They can flatten a curve near its limits.
Translation and generic `value` tracks keep their finite overshoot.

Nonfinite spline output and zero interpolated quaternions throw `RangeError`.
The player also rejects matrices that exceed the finite Float32 range.
A failed `apply()` leaves bound matrices and material properties unchanged.

## Playback buffers

`createAnimationPlayer` compiles target bindings and sampling buffers once.
Each `apply(time)` reuses transform arrays and composed matrix buffers.
It performs binary searches independently, so arbitrary seek order produces the same result.
Matrix identities and initial untracked transform components remain stable.

The player creates one shallow material copy for each target with material tracks during binding.
Additional players bound to the same target reuse that isolated material.
Animated targets therefore retain independent material properties even when their original material was shared or frozen.
Material identities remain stable during playback. Nested texture references stay shared.
Transform-only targets retain their original material objects.

## API design choice

| Shape | Example | Consequence |
| --- | --- | --- |
| Tangents in keyframes | `{ time, value, inTangent, outTangent }` | Supports JSON round trips, input validation and glTF derivative data. |
| Separate curve callback | `curve(time, output)` | Supports procedural curves but requires executable code and caller-managed state. |

Explicit tangent data keeps the existing track model and permits deterministic sampling without external callback state.
This unit does not add a mixer, skeletal animation, morph targets or glTF importer changes.
