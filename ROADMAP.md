# 67.js implementation roadmap

67.js develops 3D authoring and rendering tools for agents, with browser previews, deterministic animation and exported media.
This document separates shipping capabilities from work in progress. Performance claims require measurements on matching scenes and hardware.

The end goal is to be as capable as Blender, as light as three.js and as AI friendly as possible. Issue 23 in the project repository defines each part and orders the work. `docs/parity.md` in that repository records the coverage of each Blender feature.

## Available

- Instanced shared geometry, PBR lighting, shadows, MSAA, FXAA and ACES tone mapping.
- Object inspection, individual assembly explosion, environment controls and deterministic film sampling.
- GLB geometry export and streamed PNG/MP4 capture on hardware WebGL or CPU SwiftShader.
- Render memory estimates, capture guards, npm distribution and synchronized website release metadata.
- General keyframe animation with reusable transforms, material tracks and deterministic seeking.
- Optional HDR, bloom, color grading and reused render targets within the render budget.
- Orthographic front, right and top views, plus flat XY scenes with pan, zoom and capture.
- glTF/GLB mesh input, base-color textures, opaque vertex colors and rigid node animation.
- Landscape, portrait and square presets, time ranges and a generic capture interface for scenes and imported assets.
- Retained scene graphs, lathe and extrusion modeling, authored camera paths and deterministic clip mixing.
- Four-influence GPU skinning, relative morph targets and glTF morph weight animations.
- Material maps, local point lights and depth-clipped volumetric fog.
- Optional recorded Rapier physics with contacts, joint limits and bounded motors.
- Static sculpt brushes, clipped surface patches, shrinkwrap and bounded mesh contact and containment queries.

Version `0.5.0` includes agent scenes with stable IDs, atomic resource/node edits and checkpoints.
Version `0.6.0` adds persistent snapshot jobs with progress, cancellation and verified image/video outputs.
Version `0.7.0` adds recipe-owned procedural motion with deterministic node, material and camera sampling.
Version `0.8.0` adds source-node authoring on imported GLBs with retained rigs, morphs, textures and independent clip timing.

Version `0.9.0` adds isolated multi-angle and pose review with unchanged source revision and preview state.

The stdio MCP server supplies twenty-one schema-backed tools and persistent CPU/GPU image previews.
Recipes retain lighting, volumetric fog, grading and directional shadow coverage with atomic edits and undo.
Imported asset sessions retain supported textures, rigs, morphs and clips from a configured local GLB catalog.

The npm package includes the prebuilt `67js-mcp` command with lazy browser startup and bundled dependency licenses.

## Next

1. Extend imported asset sessions with node-level editing, topology changes and deformed geometry diagnostics.
2. Extend visual review with posed geometry bounds, automatic framing and compact rendered diagnostics.
3. Extend render jobs with hardware encoder selection, audio, longer sequences and measured adaptive output quality.
4. Geometry, rig and asset diagnostics that help agents correct intersections, invalid transforms and unsupported materials.
5. Agent workflows for imported assets, sculpting, surface fitting, lighting and animation, verified against rendered reference scenes.
6. GPU timing and adaptive quality based on measured frame time, with stable resolution changes and explicit minimum quality.

## Longer term

Evaluate WebGPU after collecting WebGL2 bottleneck measurements.
Extend deformation with surface bindings, remeshing and authored humanoid rigs.
Improve character assets and cinematic environments through measured rendering and inspected reference frames.
Blender is the visual quality reference for authored scenes. Rendering parity and universal speed advantages remain goals that need evidence.

## Package size

Large features that carry data or a heavy dependency should ship as separate optional packages (for example `@codepawlhq/67js-film`), not as more entries of the main archive. Lazy loading alone does not help here: a lazy chunk still sits in the same npm archive, so it saves page weight but not the 1 MiB archive budget. A separate package does both, and users who never import it never download it. The cost is a second version to release and a peer range to keep in step, so small code-only addons (a few tens of KB gzip) stay in the main package. The film demo left the main archive for this reason.
