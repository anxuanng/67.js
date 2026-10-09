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
- A skeletal asset uses `src/skinning.js`, `src/gltf.js` and the checkout's `docs/skinning.md`.
- Recorded contacts or articulated physics use optional `src/physics.js` and the checkout's `docs/physics.md`.
- A flat scene or axis view uses `src/canvas2d.js`, `src/camera.js` and `src/view2d.js`.
- A GLB asset viewer uses the optional `src/gltf.js` addon and `src/asset-viewer.js`.
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
