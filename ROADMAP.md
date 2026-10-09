# 67.js implementation roadmap

67.js develops a browser graphics engine with a shared workflow for interactive scenes, animation and exported media.
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

## Next

1. Adaptive quality with a target frame time, explicit minimum resolution and stable changes to avoid visible oscillation.
2. GPU timing and scene diagnostics that distinguish CPU submission, GPU work and estimated memory.
3. Picking and reusable interaction controls for object selection, annotations and assembly inspection.
4. Asset budgets and loading diagnostics for AI-generated models, including texture sizes, unsupported materials and geometry complexity.
5. Declarative scene recipes for product viewers, interactive worlds and short films, with reusable camera and lighting presets.

## Longer term

Evaluate WebGPU after collecting WebGL2 bottleneck measurements. Add skinning, morph targets and more glTF materials as bounded asset support grows.
Blender is the visual quality reference for authored scenes. Rendering parity and universal speed advantages remain goals that need evidence.
