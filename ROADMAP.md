# 67.js implementation roadmap

67.js develops 3D authoring and rendering tools for agents, with browser previews, deterministic animation and exported media.
This document separates shipping capabilities from work in progress. Performance claims require measurements on matching scenes and hardware.

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

## Next

The current source, after npm `0.4.1`, includes fixed-topology agent scenes with stable IDs, atomic revisioned edits and checkpoints.
Its stdio MCP server supplies ten schema-backed tools and persistent CPU/GPU image previews.

1. Extend agent sessions with dynamic node and resource creation while preserving bounded allocation, replay and undo.
2. Extend MCP visual feedback with bounded multi-angle and absolute animation-time previews, plus persistent authored lighting and effect controls.
3. Persistent render jobs with progress, cancellation, explicit CPU/GPU budgets and deterministic image and video export.
4. Geometry, rig and asset diagnostics that help agents correct intersections, invalid transforms and unsupported materials.
5. Agent workflows for imported assets, sculpting, surface fitting, lighting and animation, verified against rendered reference scenes.
6. GPU timing and adaptive quality based on measured frame time, with stable resolution changes and explicit minimum quality.

## Longer term

Evaluate WebGPU after collecting WebGL2 bottleneck measurements.
Extend deformation with surface bindings, remeshing and authored humanoid rigs.
Improve character assets and cinematic environments through measured rendering and inspected reference frames.
Blender is the visual quality reference for authored scenes. Rendering parity and universal speed advantages remain goals that need evidence.
