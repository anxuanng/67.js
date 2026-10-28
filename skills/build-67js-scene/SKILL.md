---
name: build-67js-scene
description: Build or refine interactive 3D scenes with 67.js. Use for 67.js models, nature worlds, cinematic scenes, camera controls, materials and anti-aliasing, including "làm cảnh 67.js" and "model bị răng cưa".
license: MIT
---

# Dựng cảnh 3D bằng 67.js

Use the actual 67.js checkout. Locate it from the active workspace or Git remote before writing files.
Read its `README.md`, `src/renderer.js` and the closest existing scene module.
Use `simplify-code` and `engineering-workflows` for implementation.

## Choose the surface

- An object studio uses `src/model.js` and `src/main.js`.
- An outdoor world uses `src/nature.js` and `src/nature-viewer.js`.
- A deterministic film uses `src/film.js` and `src/film-player.js`.
- A keyframe scene uses `src/animation.js`, `src/motion.js` and `src/motion-player.js`.
- An authored camera uses `src/camera-path.js` and the checkout's `docs/camera-path.md`.
- Local lights use the renderer environment and the checkout's `docs/lighting.md`.
- Depth-clipped fog uses `{ hdr: true, depth: true }` and the checkout's `docs/volumetric.md`.
- A skeletal asset uses `src/skinning.js`, `src/gltf.js` and the checkout's `docs/skinning.md`.
- Relative facial or shape deformation uses `src/morph.js` and the checkout's `docs/morph-targets.md`. Check source versus published support first.
- Recorded contacts or articulated physics use optional `src/physics.js` and the checkout's `docs/physics.md`.
- Baked liquid (jets, geysers, torrents, whitewater) uses optional `src/spume.js` and the checkout's `docs/spume.md`. Bake with the Spume solver first; never fake it with displaced primitives.
- A flat scene or axis view uses `src/canvas2d.js`, `src/camera.js` and `src/view2d.js`.
- A GLB asset viewer uses the optional `src/gltf.js` addon and `src/asset-viewer.js`.
- Static brush sculpting uses optional `src/sculpt.js` and the checkout's `docs/sculpt.md`.
- A curved surface badge uses optional `src/surface.js` and the checkout's `docs/surface.md`.
- Static contact, ray hits or closed-solid containment use optional `src/mesh-query.js` and the checkout's `docs/mesh-query.md`.
- Static vertex wrapping uses optional `src/shrinkwrap.js` and the checkout's `docs/shrinkwrap.md`.
- A rigid accessory on a morphing or skinned surface uses optional `src/surface-attachment.js` and `docs/surface-attachment.md`.
- Agent scene recipes use optional `src/agent-scene.js` and `docs/agent-scene.md`. Verify source versus published availability before importing.
- Agent tool calls use the installed `67js-mcp` stdio server from release `0.5.0` onward. Read `docs/mcp.md` for launch and PNG feedback.
- Agent render jobs use `docs/agent-render-jobs.md`. Check source versus published support, configure a private store and poll until terminal.
- Agent procedural animation uses `docs/agent-motion.md` from release `0.7.0`. Author recipe tracks, then seek through `sampleMotion` or MCP `motionTime`.
- Agent imported character motion uses `docs/agent-character-motion.md` from release `0.8.0`. Inspect source joints before authoring local tracks.
- Agent comparisons use `scene_review` from release `0.9.0`. Read `docs/agent-review.md` for isolated views and independent pose samples.
- An image or video export uses `render-67js-media`.

Read [scene-contract.md](references/scene-contract.md) before creating parts or changing materials.

## Build and inspect

1. State the focal point, camera, scale and intended lighting.
2. Reuse geometry identities across repeated parts. Keep transforms and materials in instance attributes.
3. Use curved surfaces and sampled fillets for close objects. Keep coarse geometry for distant objects.
4. Enable explicit MSAA, FXAA and specular filtering through `Renderer67`.
5. Set the render memory budget before allocating a target.
6. Keep per-frame animation deterministic. Pause continuous rendering when the document is hidden.
7. Validate geometry, bounds and scene budgets with the existing Node tests.
8. Capture actual rendered wide and narrow views. Inspect edges, highlights, overlap and the focal point.
9. Exercise orbit, zoom, camera selection and the requested interaction through project dev tooling.

Do not treat an `antialias: true` context as proof that the final image looks smooth.
Report measured geometry, draw counts and render size separately from visual judgments.
Do not claim Blender parity or general Three.js speed superiority from one scene.

## Finish

Deliver the scene link, a rendered image, relevant checks and known limits.
Keep this skill aligned with the checked-out renderer API when changing that API.
