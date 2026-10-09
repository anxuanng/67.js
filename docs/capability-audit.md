# Engine and authoring capability audit

The upgrade covers rendering, modeling, animation, authoring, media export, and agent workflows.
This inventory records the current gaps. Passing one demo does not establish feature parity or general performance superiority.

## Reference systems

- [Three.js animation system](https://threejs.org/manual/pages/animation-system.html): clips, actions, mixers, bone animation, morph animation, and asset loading.
- [Three.js AnimationAction](https://threejs.org/docs/pages/AnimationAction.html): weighted playback, crossfades, repeat modes, and time scaling.
- [Blender keyframes](https://docs.blender.org/manual/en/4.5/animation/keyframes/introduction.html): animated properties and interpolation.
- [Blender F-Curve editing](https://docs.blender.org/manual/en/5.3/editors/graph_editor/fcurves/editing.html): curve handles and motion editing.
- [Blender Armature modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/deform/armature.html): deformation through bones.

The Blender references describe authoring capabilities. Their interpolation and rendering results require separate validation in 67.js.

## Current coverage and evidence required

| Area | Current implementation | Missing work | Completion evidence |
| --- | --- | --- | --- |
| Scene graph | Shared hierarchy, local transforms, pivots and atomic reparenting integrated in source | Constraints, dynamic node editing, package release | Nested transforms and arbitrary seeks reproduce identical poses |
| Modeling | Base primitives, lathe, hole extrusion with bevels, and curve tubes integrated in source | Mesh editing, subdivision, modifiers, package release | Edited models retain topology, normals, UVs, and export behavior |
| Animation curves | Linear, step, smooth and Hermite tangent interpolation in source | Curve editor; package release verification | Known curve samples, quaternion normalization, and continuous velocity checks |
| Animation composition | Weighted clips and absolute-time crossfades integrated in source | Additive motion, layer masks, events, package verification | Walking and gestures blend without pose discontinuities |
| Character deformation | Rigid joints, GPU skinning and skeletal GLB animation integrated in source | Morph targets, IK, retargeting, facial assets, package release | Animated imported character, expressions, and joint contact tests |
| Camera authoring | Absolute-time camera paths, target tracking, roll and focal-length conversion integrated in source | Focus control, editing, aspect-aware framing, package release | Reviewed moving shot previews across aspect ratios |
| Film authoring | Scene-specific shot list and player | Shared timeline, shot editing, transitions, audio cues | Edited timeline seeks and exports deterministically |
| Asset import | Opaque glTF meshes, five material maps, rigid and skeletal animation integrated in source | Morphs, transparency, compression, streaming, package release | Blender fixtures preserve geometry, materials, and animation |
| Materials | Factors and five PBR texture channels integrated in source | Layered materials, advanced extensions, authored tangents, package verification | Reference material scenes and texture budget checks |
| Lighting | Directional shadows and procedural studio illumination | Configurable lights, HDR environments, baked lighting, reflection probes | Reference lighting scenes, stable shadows, and measured render cost |
| Image rendering | HDR, bloom, grading, MSAA, FXAA | Depth of field, motion blur, temporal sampling, render passes | Reviewed stills and moving previews with measured artifacts |
| Simulation | Recorded Rapier rigid-body contacts, impulses, kinematics and articulated joints integrated in source; demo-specific wind, water, sparks and ignition | Joint limits, motors, worker baking, bone binding, shared particles, cloth, hair and volumetric tools; package release | Repeatable simulations, contact tests, and bounded resource usage |
| Interaction | Demo-specific orbit, zoom, and sliders | Picking, transform gizmos, reusable controls | Pointer, keyboard, and mobile interaction checks |
| Browser editor | Demonstration pages | Modeling, material, lighting, rig, curve, and timeline editing | Complete edit, save, reload, and export workflows |
| Runtime diagnostics | Render budget estimates and export reports | CPU/GPU timers, draw diagnostics, adaptive quality, LOD, culling | Matching-scene benchmarks with quality and memory measurements |
| Media export | Deterministic streamed PNG/MP4 capture | Production profiles, batch jobs, passes, resumable exports | Frame count, image quality, audio sync, memory, and time reports |
| Agent workflow | Scene and export skills | Film direction, motion review, asset selection, and editor workflows | Tasks produce usable scenes and reviewed previews through documented APIs |

This inventory remains open. Each area requires its own implementation and verification.
An API must work through exported package entry points before its capability is marked available.

## First implementation units

1. Retain animation and renderer scratch buffers to reduce per-frame allocation.
2. Add serializable curve tangents with deterministic sampling and validation.
3. Add animation composition and a shared transform hierarchy.
4. Extend asset deformation and material support.
5. Build reusable camera and timeline authoring tools.
6. Improve model and image showcases using these capabilities.

The remaining inventory stays in scope while these units land.

## Integrated source units

Hermite curves and retained animation-player buffers are integrated locally.
The orbit showcase uses analytical velocity tangents with 25 keys per orbit instead of 97 linear keys.
Tests check velocity continuity across its interior keys and matching start/end positions.
The native browser smoke verifies deterministic motion, persistent GPU resources, and responsive scene rendering.
These source checks do not establish that the new API is available in the published npm version.

Weighted clip actions and crossfades are also integrated locally.
Tests compare scalar and quaternion mixing against the installed Three.js implementation.
The mixer retains authored controls so backward seeks reproduce earlier playback and interrupted fades.

Four additional material texture channels are integrated with glTF import, budget accounting, caching, and GPU disposal.
Native GPU checks confirm image changes for every channel without WebGL errors.
Equivalent normal maps with UV coordinates scaled by `0.001` differ by only `0.000257` mean pixel-channel units.
GLB texture export remains missing. Export now rejects textured materials instead of silently discarding their maps.

The API review found detached material bindings, an absolute UV threshold, and a Float32 minimum-scale mismatch.
Each finding received a fix and a regression check.
Claude CLI was unavailable on both attempts because its weekly quota was exhausted.
The review therefore has evidence from one model family only.

## Renderer update measurement

The local CPU benchmark uses the existing WALL·E scene with 574 parts.
It warms the code, then measures five trials of 500 updates each.
GPU buffer calls are mocked. These results describe validation and instance packing only.

Run `node scripts/benchmark-instance-updates.mjs` from the repository root.
It writes `artifacts/instance-update-benchmark.json` and lowers its process priority on this shared machine.

| Metric | Before | After |
| --- | --- | --- |
| Median CPU update | 0.988 ms | 0.134 ms |
| Normal-matrix allocations across 2,500 updates | 1,435,000 | 0 |

After adding validation for all five material channels, a follow-up measurement reported a median of `0.213 ms`.
That measurement also reported zero normal-matrix allocations.

The update keeps two phases: validate every part, then write packed buffers.
Invalid mixed updates still fail before changing packed instance data or submitting GPU writes.
Normal scratch buffers belong to uploaded parts and remain bounded by the scene size.

Live GPU frame timing and broader scene measurements remain required before claiming an overall speed improvement.

## Shadow filtering measurement

The current source interpolates depth comparisons within each shadow texel before applying the existing nine-tap filter.
This removes the visible stepped shadow bands in the scientist close-up without changing the shadow texture size or render allocation.
The implementation uses explicit texel comparisons because [WebGL 2 does not guarantee linear filtering for shadow samplers](https://registry.khronos.org/webgl/specs/latest/2.0/).

Run `node scripts/benchmark-shadows.mjs 1d4f4d0` to compare the previous shader with the checked-out shader.
The native RTX 3060 check used the same portrait scene at 1280 × 720, HDR and four MSAA samples.
After ten warmup draws, forty GPU timer queries reported medians of `0.811 ms` before and `0.838 ms` after.
Estimated render allocation remained `88,630,276` bytes. Both draws reported WebGL error zero.
The increase is about `0.027 ms` in this fixed scene; it is not a general performance result or an animation benchmark.
SwiftShader also rendered the updated shader without a WebGL error.

## Trailer acceptance requirements

The current trailer does not meet the requested visual quality.
The current source replaces the scientist's unlit silhouette with lit facial features, shared head attachments and shaped headwear.
The rendered close-up still looks like a stylized mannequin with insufficient facial likeness.
Portrait exports currently crop part of the headwear; aspect-aware film framing remains unfinished.
This source change has not been deployed or published to npm.
Rigid joint animation and GPU skinning provide motion tools, but do not solve character modeling or material quality by themselves.

The environment has procedural shaders, fog, bloom and grading. These features do not yet produce convincing cinematic atmosphere.
Volumetric lighting, smoke, dust, explosion detail and lighting continuity require visible shot-level validation.

The current source provides an optional Rapier addon for rigid-body contacts and articulated spherical, revolute and fixed joints.
A native render fixture records twelve bodies and ten joints, then reproduces the same pose and pixels after a backward seek.
Its 241-frame timeline uses exactly `80,976` bytes; solver allocation is estimated separately and shared WASM capacity remains resident.
This is a technical fixture, not integrated trailer action or evidence of convincing humanoid motion.
Joint limits, motors, bone binding and off-thread baking remain unfinished.
The requested final state includes integrated physical interactions with deterministic playback or recorded simulation for arbitrary film seeks.
Simple sine motion does not satisfy the physics requirement.

Completion requires recognizable characters, a convincing environment and integrated physical interactions, demonstrated in rendered trailer shots.
Technical fixtures and passing API tests do not establish that result.
