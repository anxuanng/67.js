# Humanoid retargeting and crowds

`67js/addons/retarget` is available from version `0.10.0`. It moves a humanoid clip from one skeleton onto another and
places many skinned copies with their own timing. It only consumes files: Mixamo clips need the owner's Adobe login to download,
and this package never fetches them.

```js
import { loadGltf } from '67js/addons/gltf';
import { mapHumanoidBones, createRigFromSkin, retargetClip, createSkinClipPlayer, createCrowd } from '67js/addons/retarget';

const source = createRigFromSkin(mixamoAsset.skins[0]);
const target = createRigFromSkin(characterAsset.skins[0], { rootMatrix: armatureWorldMatrix });
const clip = retargetClip(source, target, mixamoClip, { rootMotion: false });

const player = createSkinClipPlayer(characterAsset.skins[0], clip);
player.apply(seconds);
renderer.updateParts(characterAsset.parts);
```

## Rigs

A rig is `{ joints, rootMatrix?, mapping? }`. Each joint is `{ name, parent, translation, rotation, scale }` with the local rest pose,
`parent` as an index (`-1` for a root) and quaternions in XYZW order.
`createRigFromSkin(skin)` builds one from an imported skin: the bind pose becomes the rest pose.
`rootMatrix` is the world matrix of whatever sits above the root joints, such as a scaled Armature node. Pass it when the clip's root
tracks are authored relative to that node. Uniform scale is assumed throughout.

## Bone names

`mapHumanoidBones(jointNames, { overrides })` returns `{ mapping, unmapped, missing }`. Canonical names are in `HUMANOID_BONES`:
`hips`, `spine`, `chest`, `upperChest`, `neck`, `head`, then per side `leftShoulder`, `leftUpperArm`, `leftLowerArm`, `leftHand`,
`leftUpperLeg`, `leftLowerLeg`, `leftFoot`, `leftToes`, and optional fingers such as `leftIndexProximal`.
`REQUIRED_HUMANOID_BONES` (hips, spine, head, both arms with hands, both legs with feet) must all be mapped.

| Family | Examples |
| --- | --- |
| Mixamo | `mixamorig:Hips`, `mixamorig1:LeftUpLeg`, `mixamorigLeftForeArm`; `Spine1`/`Spine2` are chest and upper chest |
| VRM and Unity humanoid | `leftUpperArm`, `upperChest`, `leftToes`, `J_Bip_L_UpperArm` |
| Unreal mannequin | `pelvis`, `spine_01`..`spine_03`, `clavicle_l`, `upperarm_l`, `thigh_l`, `calf_l`, `ball_l` |
| Blender and Rigify | `DEF-spine` is the pelvis, `DEF-upper_arm.L`, `DEF-thigh.L`, `DEF-shin.L`; twist bones (`.001`) stay unmapped |
| Quaternius | `Abdomen`, `Torso`, `UpperArm.L`, `Fist.L`, `Toes.L` |

Left and right come from `Left`/`Right`, `L`/`R` words or `.L`/`_l` suffixes. The first joint that matches a bone wins, so a second
neck or spine joint stays unmapped. When a bone is missing or wrong, pass `sourceOverrides` or `targetOverrides` to `retargetClip`
(or `overrides` to `mapHumanoidBones`) as `{ leftLowerLeg: 'shinbone_left' }`. A rig that misses required bones throws a `RangeError`
whose `missingBones` array and message list them.

## Retargeting

`retargetClip(sourceRig, targetRig, clip, options)` returns a new `createAnimationClip` clip with one rotation track per shared bone,
named after the target joints, and a hips translation track. Any code that plays clips by joint name can play it.

For every bone, the world-space rotation change of the source from its rest pose is applied to the target's rest pose. The target's
local rotation is then taken relative to its own animated parent. T-pose against A-pose, and different local bone axes, therefore end up
pointing the same way. Unmapped target joints keep their rest pose. The hips move by the source's world offset from its rest position,
scaled by the ratio of rest hip heights above the feet (hips to foot along Y, averaged over both legs).

| Option | Default | Meaning |
| --- | --- | --- |
| `bones` | every shared bone | Canonical bones to transfer |
| `rootMotion` | `true` | `false` removes horizontal (X and Z) hips travel and keeps vertical bob |
| `scale` | `1` | Extra multiplier on the hips translation |
| `frameRate` | `30` | Resampling rate; output keyframes are linear |

Assumptions and limits:

- Both rigs face the same direction, with +Y up. A source that faces the other way needs its root rotated first.
- The clip is resampled at `frameRate`, so cubic-spline and step curves are baked to linear keys.
- Source scale and non-hips translation tracks are ignored. Finger and toe bones transfer only when mapped in both rigs.
- The source and target rest pose must be the bind pose (the node pose equals the inverse bind pose). A file that animates away from it is not detected.
- No foot-lock, no IK, no retargeting of rotation limits. Different proportions can make feet slide or arms intersect the body.

`createSkinClipPlayer(skin, clip, { rig, meshWorldMatrix })` applies a clip to a skin: `apply(seconds)` samples the clip, composes joint
world matrices and calls `updateSkinPose`. The renderer still needs `updateParts` afterwards.

## Crowds

`createCrowd({ count, clip, seed, layout, spacing, columns, size, rateJitter, randomYaw })` is deterministic for a seed. `layout` is
`'grid'` (centred, `columns` wide) or `'scatter'` (rejection sampling with at least `0.75 * spacing` between instances where room allows).
Each instance has `position`, `yawRadians`, a `timeOffset` in the clip duration, a `playbackRate` within `1 ± rateJitter` and a
column-major `matrix`. `clipTime(index, seconds)` gives the instance's clip time and `sample(seconds)` returns every instance's tracks
(buffers are reused on the next call).

The renderer batches skinned parts by pose identity, so each instance needs its own skin pose (its own `createSkinPose` palette, one
imported asset per instance) and becomes its own batch. Instances cannot share a pose and still differ in time.

### Measured cost

Headless Chrome with GPU on the author's machine (RTX 3060, 960x540, 4x MSAA, one measurement of 60 frames after 10 warm-up frames).
Each instance had 3,000 skinned vertices, 65 joints and its own pose. It was a synthetic bending chain, not a humanoid, so a real
character mesh with far more vertices will cost more in the render column. Pose is clip sampling plus joint matrices in JavaScript,
upload is `renderer.updateParts`, render includes `gl.finish()`.

| Instances | Batches | Pose ms | Upload ms | Render ms | Frame ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 0.13 | 0.21 | 0.29 | 0.63 |
| 10 | 11 | 0.81 | 1.71 | 0.40 | 2.92 |
| 50 | 51 | 3.87 | 8.25 | 1.02 | 13.14 |
| 100 | 101 | 7.85 | 17.04 | 1.63 | 26.52 |

Cost grows linearly at about 0.26 ms per animated instance per frame, mostly from the per-pose palette upload and the JavaScript pose
work, both on the main thread. At this size roughly 50 animated instances fit a 60 fps budget (16.7 ms) and 100 do not. These are
single measurements, not a benchmark suite. Fewer animated instances help: poses can be updated at a lower rate or shared by distant
instances.
