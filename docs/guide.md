# 67.js guide

Build a scene once. Make it interactive. Export the frame or film.

67.js is a WebGL2 graphics toolkit with shared geometry, deterministic animation and a bounded media pipeline. It is not API-compatible with Three.js and does not provide a Blender-style modeling editor.

## Install

```sh
npm install 67js@npm:@codepawlhq/67js
```

The alias lets your application import `67js`. Without the alias, import `@codepawlhq/67js`. Use a package-aware development server such as Vite. The homepage's release command pins the published version.

Its browser module is a bundled ES module served with CORS headers. A local checkout can be newer than the published package. Check `VERSION` and `release.json` before using a feature.

## Getting started

1. Create `index.html` with the canvas below.
2. Save the JavaScript example as `main.js` in the same directory.
3. Run a development server that resolves npm imports, such as Vite.

```html
<canvas id="scene" style="width:100%;height:70vh;display:block"></canvas>
<script type="module" src="./main.js"></script>
```

```js
import { Renderer67, box } from '67js';

const canvas = document.querySelector('#scene');
const parts = [{
  name: 'My first cube',
  geometry: box(0.08, 4),
  matrix: new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]),
  material: {
    color: [0.2, 0.55, 0.38],
    metallic: 0,
    roughness: 0.55,
    emission: 0,
    tag: 'surface',
  },
}];
const renderer = new Renderer67(canvas, parts, {
  ground: false,
  pixelRatio: 1.25,
  samples: 4,
  memoryBudgetMiB: 256,
});
const draw = () => renderer.render({ eye: [3, 2, 4], target: [0, 0, 0] });
const observer = new ResizeObserver(() => {
  renderer.resize();
  draw();
});
observer.observe(canvas);
draw();
window.addEventListener('pagehide', () => {
  observer.disconnect();
  renderer.dispose();
}, { once: true });
```

The page displays a rounded green cube in a WebGL2 browser. The observer redraws when its canvas changes size.

For a browser import without npm, use the exact `module` URL from [release metadata](/release.json) instead of `67js`.
The bundled ES module includes its dependencies. Serve the HTML over HTTP. Release metadata provides its URL for browser-only imports.

## Parts and geometry

A scene is an array of parts. Each part has a unique `name`, a shared `geometry`, a column-major 16-value `Float32Array` `matrix`, and a `material`.

Geometry uses `Float32Array` positions and normals, and `Uint32Array` triangle indices. Normals must have unit length and triangles face outward. Optional `uvs` have two values per vertex. Optional `colors` are opaque linear RGB.

Transforms must be finite and invertible. Use one geometry object for repeated parts, rather than creating identical meshes for every instance. Each geometry and texture descriptor identity pair becomes an instanced batch.

```js
import { Renderer67, box } from '67js';
const geometry = box(0.08, 4);
const parts = [{
  name: 'Rounded cube', geometry,
  matrix: new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
  material: { color: [0.3,0.42,0.55], metallic: 0.7, roughness: 0.3, emission: 0, tag: 'surface' },
}];
const renderer = new Renderer67(canvas, parts, {
  ground: false, hdr: true, samples: 4, pixelRatio: 1.25, memoryBudgetMiB: 256,
});
renderer.render({ eye: [3,2,4], target: [0,0,0] });
```

Supply a real HTML canvas with nonzero CSS width and height. The example assumes `canvas` refers to that element. `box(fillet, samples)`, `cylinder(segments)`, `sphere(segments, rings)` and `torus(tubeRadius, segments, sides)` are core primitives. Inspect the supplied demos for dimension and transform conventions.

## Procedural modeling

Version `0.4.0` provides `lathe`, `extrude` and `tube` through `67js/addons/modeling`.
They generate static geometry from radius/height profiles, polygon contours and XYZ paths.
Extrusion supports holes and bevels. Open tube ends remain uncapped.

1. Choose a profile, contour or path in local coordinates.
2. Generate the geometry once with the matching addon function.
3. Assign the result to a part before creating `Renderer67`.
4. Share the geometry among repeated parts.

The [modeling contract](/modeling.md) defines input bounds, winding, bevel limits and resource estimates.
The [scene graph](/scene-graph.md) supports hierarchy and pivots without changing mesh topology.
The [modeling demo](/modeling.html) combines these tools in a lantern scene.
These generators do not perform solid Boolean operations or provide a mesh editor.

## Sculpt brushes

Version `0.4.0` provides `sculptGeometry` through `67js/addons/sculpt`.
It applies `inflate`, directional `displace` and `smooth` strokes to a copy of static indexed geometry.
Stroke centers, radii and strengths use geometry-local units.
The result preserves topology, UVs and colors, and rebuilds normals.

1. Define bounded strokes on the undeformed mesh.
2. Call `sculptGeometry` before creating the renderer.
3. Inspect the resulting surface for folds or intersections.
4. Rebuild surface patches and query indices after changing geometry.

The [sculpt contract](/sculpt.md) defines brush strength, seam handling and work limits.
Smoothing can shrink volume. Sculpting rejects skin and morph channels and does not remesh or prevent intersections.
Compatible deformations can become [relative morph targets](/morph-targets.md) for animation.

## Contact detection

Version `0.4.0` provides static BVH queries through `67js/addons/mesh-query`.
`createMeshQueryIndex` copies positions and indices. `createMeshPairQuery` tests two indices under explicit affine matrices.
The `surfaces` mode finds triangle contact. The `closed-solids` mode also tests containment between two validated solid indices.

1. Build one index per static geometry with explicit count and memory budgets.
2. For containment, create both indices with `solid: true`.
3. Create a pair query with the required mode.
4. Evaluate the query with both current world matrices.
5. Dispose the indices when their geometry is no longer needed.

An index also supports `raycast(matrix, ray)` for a triangle number, hit point and barycentric coordinates.
The [mesh query contract](/mesh-query.md) describes results, solid validation, numerical limits and budget errors.
Rebuild indices after geometry edits. Queries reject skin and morph channels.
Contact results do not measure penetration depth, resolve collisions or diagnose z-fighting.

## Shrinkwrap and surface patches

Version `0.4.0` provides `shrinkwrapGeometry` through `67js/addons/shrinkwrap`.
It returns new static geometry in target-local coordinates while preserving source topology, UVs and colors.
Nearest mode chooses a surface point. Project mode casts along a target-local direction.

1. Define `sourceToTarget` to map source-local positions into target-local coordinates.
2. Choose `nearest` or `project` mode and a bounded `maxDistance`.
3. Set `clearance` and an explicit `onMiss` policy.
4. Use the returned geometry with the target part's retained matrix.
5. Inspect `stats` and the resulting mesh before rendering.

The [shrinkwrap contract](/shrinkwrap.md) defines local distances, work budgets and miss handling.
Collapsed output triangles cause errors. Projection does not guarantee clearance across the complete accessory surface.

`createSurfacePatch` from `67js/addons/surface` clips target triangles into an overlay with its own UVs and material.
The [surface patch contract](/surface.md) defines projector orientation, depth and local clearance.
Patches and shrinkwrap are static operations. They do not follow skin or morph deformation.

## HDR environment lighting

Pass `environment: { map }` to light and reflect from an equirectangular HDR image. `loadHdri(url)` from `67js/addons/hdri` parses a Poly Haven `.hdr` file, and `createEnvironmentMap` accepts your own float data. Without a map, rendering is unchanged. The [lighting contract](/lighting.md#environment-maps-ibl) covers rotation, background display, memory and limits.

## Humanoid retargeting and crowds

`67js/addons/retarget` is available from version `0.10.0`. It moves a humanoid clip onto another skeleton and offsets many copies in time.

1. Build rigs with `createRigFromSkin(asset.skins[0])`. Name families (Mixamo, VRM, Unreal, Rigify, Quaternius) map through `mapHumanoidBones`; fix a miss with `targetOverrides`.
2. Call `retargetClip(sourceRig, targetRig, clip, { rootMotion })`.
3. Play it with `createSkinClipPlayer(skin, clip).apply(seconds)`, then `renderer.updateParts(parts)`.
4. For a crowd, `createCrowd({ count, clip, seed })` gives placement, time offsets and playback rates. Each instance needs its own skin pose.

The [retarget contract](/retarget.md) covers rest-pose assumptions and measured cost. Mixamo clips need the owner's Adobe login to download; the code only consumes files.

## Baked liquid

`67js/addons/spume` is available from version `0.10.0`. It plays back liquid baked offline by the Spume GPU solver.

1. Bake a cache folder with Spume's `run.py` or its Blender add-on.
2. Load it with `loadSpumeCache(folderUrl)`.
3. Create a player with `createSpumePlayer(cache, { matrix, loop })`.
4. Each frame, call `renderer.replaceParts([...sceneParts, ...player.partsAt(seconds)])` and render.

The [Spume contract](/spume.md) covers the cache format, whitewater options, placement and measured cost.
Textured, skinned and morphed parts may stay in the list unchanged while frames are replaced; adding or removing them needs a new renderer.

## Wheeled vehicles

`67js/addons/vehicle` is available from version `0.10.0`. It drives a car or truck along a path with deterministic, physics-free animation.

1. Describe the vehicle with `createVehicleRig({ parts })`; wheels are found by name and geometry. Check `rig.wheels` or `findWheelCandidates(names)`.
2. Build a drive with `driveAlongPath(rig, points, { cruiseSpeed, groundHeight })`.
3. Each frame, call `applyVehiclePoseToParts(rig, drive.sample(seconds))` and then `renderer.updateParts(parts)`.

Wheel spin, front-wheel steering, roll, pitch and ground following come from the path.
Scene-graph nodes and imported GLBs use `applyVehiclePoseToSceneGraph` and `applyVehiclePoseToAsset`.
The [vehicle contract](/vehicle.md) lists conventions, options and limits.

## Trees and grass

`67js/addons/vegetation` is available from version `0.10.0`. It grows seeded trees with real branches and leaf cards, grass and flowers.

1. Scatter with `scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, mix, leaves })`.
2. Pick detail per camera with `selectLevels(forest.instances, eye)`.
3. Pass `view.parts` to `Renderer67` and rebuild when `view.changed` is true.

Cards (`leaves: 'cards'`, the default) are single-sided, alpha-masked, double-sided `foliage` textures that sway with the wind; `'mesh'` leaves cost about twice the triangles. Pass `barkTextures` for scanned bark and `leafTextures: await loadLeafTextures('/textures/leaves')` for scanned leaf cards. The [Vegetation contract](/vegetation.md) lists species, triangle budgets and limits.

## Terrain and ground textures

`67js/addons/terrain` and `67js/addons/texture-set` are available from version `0.10.0`. They build a chunked, seeded heightfield with distance level of detail and a four-layer ground material (slope, height and mask rules, height-based edge blending, triplanar cliffs, anti-tiling) from CC0 scans.

1. `const set = await loadTextureSet('/textures/leafy_grass')` per layer, then `material.layers = [{ ...set, scale: 3 }, ...]` and `material.splat = { rules }`.
2. `const terrain = createTerrain({ size, chunks, resolution, levels, seed })`; give every `terrain.parts` entry the one shared material.
3. Pass `terrain.heightAt` to `scatterVegetation` and vehicles, and call `renderer.replaceParts` when `terrain.update(eye)` returns parts.

The [Terrain contract](/terrain.md) lists every option, the texture-array memory and the limits.

## Retained surface attachments

`createSurfaceAttachment` is introduced in `0.4.1`. Published npm `0.4.0` does not include this addon.
It binds a rigid accessory to one triangle through world transforms, relative morphs and four-influence skinning.
The accessory uses the attachment's retained world matrix. Its positive Z axis follows the posed triangle's geometric winding.

1. Choose an original triangle number and barycentric coordinates for the contact point.
2. Bind the target with `createSurfaceAttachment` from `67js/addons/surface-attachment` using `0.4.1` or a current source build.
3. Assign `attachment.matrix` to the accessory part before creating the renderer.
4. Update the target matrix, morph weights and skin palette for the frame.
5. Call `attachment.update()` before `renderer.updateParts()`.

The [attachment contract](/surface-attachment.md) defines retained identities, world-unit clearance and unsupported shader deformation.
Updates sample the selected triangle without rebuilding a BVH.
Static raycast hits can supply binding coordinates, but query indices cannot raycast a visibly skinned or morphed surface.
An attachment positions one rigid frame. It does not conform the accessory footprint or prevent every intersection.

## Materials and color

`color` and `emissiveColor` are linear RGB. `metallic` and `roughness` describe the PBR surface. `emission` sets emission intensity. `material.map` is a decoded texture descriptor with an image, UV channel 0, color space and supported sampler settings.

The optional GLB addon creates these descriptors. HDR requires `EXT_color_buffer_float`. Inspect `renderer.capabilities.hdr` and `hdrFallbackReason`. The renderer falls back when floating-point targets are unavailable.

Tags select specialized behavior: `armor` allows studio finish overrides. `floor` is a studio floor. `water` adds animated normals and ripples. `foliage` and `grass` add wind and accept a base-colour `map` with alpha mask, a `normalMap` and `doubleSided` for leaf cards.

`material.alphaMode` is `'opaque'` (default), `'mask'` (cutout at `alphaCutoff`, default 0.5, shadows follow it) or `'blend'` (drawn last, back to front, no depth write). `material.opacity` (default 1) multiplies the base map alpha. `material.doubleSided` (default false) disables back-face culling and lights both faces. These are batch state and cannot change after upload. See `docs/material-maps.md`.

`terrain` adds surface variation. `fire` and `smoke` support film effects. `unlit` is a flat color. Other tags use ordinary PBR shading.

`water` flattens normals into a rippled pond and only suits horizontal surfaces. Shaped water uses `liquid`: it is drawn after the opaque scene, refracts what lies behind it, darkens with thickness and reflects the environment by the Fresnel term. Its `color` is the light one metre of liquid lets through, so `[0.56, 0.84, 0.88]` is clear blue-green water. `foam` draws soft alpha-blended droplets for whitewater. Tune both with `frame.liquid` or `environment.liquid`: `{ thickness: 0.5, ior: 1.33, refraction: 1, scattering: 1, foamOpacity: 0.55, foamSoftness: 1 }`. A liquid refracts opaque parts only.

## Renderer reference

`new Renderer67(canvas, parts, options)` owns GPU geometry, texture and target allocations. Constructor options:

| Option | Default | Purpose |
| --- | --- | --- |
| batching | true | Share instance batches by geometry and map identity |
| pixelRatio | 1.5 | Render scale relative to CSS size. Not automatically devicePixelRatio |
| ground | true | Add the studio floor. Disable for worlds, 2D and assets |
| world | false | Enable outdoor rendering and world clipping defaults |
| samples | 4 | Requested MSAA count. Negotiated against hardware |
| hdr | false | Request floating-point color targets |
| memoryBudgetMiB | 256 | Estimated render allocation budget |
| environment | {} | Sky, light and fog settings |
| shadowBounds | {} | Custom extent, eye and target for shadow framing |
| benchmark | false | Diagnostic flat shader. Not the appearance renderer |

`render(frame)` draws synchronously. `resize()` replans targets after CSS size or `pixelRatio` changes. `updateParts(parts, { shadows: true })` uploads changed matrices and materials using retained buffers. It does not add new part, geometry or texture identities.

Construct a new renderer for a new graph. `dispose()` releases owned resources.

Read `memoryPlan` for actual width, height, estimatedBytes and reduced status. `capabilities` for HDR and MSAA negotiation. `triangles`, `batches.length` and `cpuMilliseconds` for diagnostics. CPU submission time is not GPU frame time.

## Cameras and framing

A perspective frame supplies `eye`, `target`, optional `up`, `fov` in degrees, `near` and `far`. Set `projection: 'orthographic'` and `orthographicHeight` for axis views. Clipping planes must satisfy `0 < near < far`.

`cameraView('front' | 'right' | 'top' | 'perspective', { target, height, distance })` creates an axis camera. `fitOrthographicHeight(bounds, view, aspect, padding)` frames the bounds without cropping. Bounds have `minimum` and `maximum` vectors. Flat 2D uses XY geometry, the `unlit` tag and a front orthographic camera.

The canvas2d addon supplies a reusable poster scene.

## Effects and lighting

```js
renderer.render({
  eye: [3,2,4], target: [0,0,0], exposure: 1,
  effects: {
    bloom: { strength: 0.18, threshold: 0.9, radius: 1.2 },
    saturation: 1, contrast: 1.04, temperature: 0.03, vignette: 0.12, grain: 0,
  },
});
```

`EFFECT_PRESETS` provides ready-made looks. `resolveEffects` validates and resolves settings. Bloom uses retained half-resolution targets included in the memory estimate. Start with neutral settings and small changes.

Bloom cannot recover missing geometry or lighting detail.

Outdoor `environment` accepts `skyTop`, `skyBottom` (display RGB), `fogColor` (linear RGB), `fogDensity`, `lightDirection` and `daylight`. Set `world: true` and `ground: false`. Frames can override environment and supply `time`, `wind`, `waterRipple` and `rippleTime`.

## Local lights and volume fog

Version `0.4.0` supports local lighting through the renderer's `environment` option and per-frame environment overrides.
`pointLights` accepts at most eight world-space lights with linear RGB colors.
`keyIntensity`, `fillIntensity` and `ambientIntensity` control the existing studio lighting.

1. Set the environment's lighting controls when creating the renderer.
2. Supply the complete `frame.environment.pointLights` list to animate local lights.
3. Inspect exposure and material response at a fixed sample time.

The [lighting contract](/lighting.md) defines intensity, radius, range and validation limits.
Point lights have no local shadows and can illuminate through walls.
Radius regularizes attenuation and does not create an area emitter.

The [volume fog contract](/volumetric.md) covers depth-clipped directional scattering in version `0.4.0`.
Active fog requires `hdr: true`, `depth: true` and supported floating-point targets.
Its depth texture contributes to the render memory estimate.

## Deterministic animation

```js
import { createAnimationClip, createAnimationPlayer } from '67js';
const clip = createAnimationClip({ duration: 2, tracks: [{
  target: 'Rounded cube', property: 'translation', interpolation: 'SMOOTH',
  keyframes: [{ time: 0, value: [0,0,0] }, { time: 2, value: [0,1,0] }],
}] });
const player = createAnimationPlayer(clip, parts);
player.apply(1);
renderer.updateParts(parts);
renderer.render({ eye: [3,2,4], target: [0,0,0], time: 1 });
```

Tracks target unique part names. Supported transform tracks are translation, rotation (quaternion XYZW) and scale. Material tracks include metallic, roughness and emission. Interpolation supports `LINEAR`, `STEP`, `SMOOTH` and `CUBICSPLINE`.

`sampleAnimationClip(clip, time)` returns samples without binding parts. Preserve the original graph and apply absolute time so seeking backwards reproduces the scene. Use `requestAnimationFrame` for playback, pause when hidden, and use a fixed sample time for export.

## Animation curves and mixing

Version `0.4.0` supports `CUBICSPLINE` tracks with explicit `inTangent` and `outTangent` values on every keyframe.
Tangents represent component changes per second. Quaternion tangents are component derivatives.
The [curve contract](/animation-curves.md) defines interpolation, overshoot constraints and retained player buffers.

`createAnimationMixer(parts)` combines clips through reusable actions and absolute-time control timelines.
Actions support weights, playback speed, fades and crossfades.
The [mixer contract](/animation-mixer.md) defines blending, ownership and control ordering.

1. Create clips and bind their actions through `mixer.clipAction(clip)`.
2. Author `play`, `fadeTo` or `crossFade` controls in nondecreasing time order.
3. Call `mixer.apply(time)` for the desired absolute time.
4. Upload the changed parts with `renderer.updateParts(parts)`.

Playback can seek backward independently of control authoring order.
The mixer owns its registered properties and captures their base values during binding.

## Skeletal and morph animation

Version `0.4.0` supports four-influence GPU skinning and relative position/normal morph targets.
`createSkinPose` supplies a retained joint palette. `updateSkinPose` calculates mesh-local joint matrices from world joints and inverse binds.
`createMorphPose` supplies retained weights for the geometry's relative targets.
The renderer applies morph deltas before skinning.

1. Define static skin influences or relative morph channels before renderer construction.
2. Assign the matching retained `skin` and `morph` poses to each part.
3. Update joint palette values and morph weights for the desired frame.
4. Call `renderer.updateParts(parts)` to validate and upload the poses.

The [skinning contract](/skinning.md) defines supported transforms, four influences and identity requirements.
The [morph contract](/morph-targets.md) defines channel shapes, weight bounds and resource estimates.
Changing topology, influences or pose identities requires a new renderer.

The glTF addon imports supported skins and relative targets, including joint and weight animation.
`asset.applyAnimation(time, clipIndex)` updates retained parts and poses for upload.
The [glTF morph contract](/gltf-morph.md) and [asset contract](/gltf.md) define the supported asset subset.

## Recorded physics

Version `0.4.0` provides recorded rigid-body simulation through `67js/addons/physics`.
The addon requires the separate optional peer dependency `@dimforge/rapier3d-compat@0.21.0`.
It bakes body contacts, joints, limits and bounded motors into a timeline.
Playback samples that recording without rerunning the solver.

1. Define named bodies, colliders, joints and tick events.
2. Call `planPhysicsScene` to validate the definition and allocation estimate.
3. Await `createPhysicsScene` to bake the bounded recording.
4. Bind visual parts through `physics.bindParts`.
5. Apply bindings at absolute time before uploading changed parts.
6. Call `physics.dispose()` when the recording is no longer needed.

The [physics contract](/physics.md) defines supported colliders, joint controls, timing and disposal.
Recorded poses can seek forward or backward. Interpolation between recorded frames can show small penetrations.
The bake can block the main thread after WASM initialization.
Cloth, soft bodies, mesh colliders and direct skeletal bindings are unsupported.

## Assemblies and interaction

Explodable parts include `assembly: { layer: 'exterior' | 'interior', section, offset: [x,y,z], detailOffset: [x,y,z] }`. Base matrices stay assembled. A frame's `assemblyAmount` goes from 0 to 1. Section offsets separate first, small detail offsets separate later.

`assemblyOffset(part, amount)` returns the same offset for export. Filter parts by layer and recreate the renderer after disposing its predecessor.

The object studio implements pointer capture for orbit, wheel zoom, keyboard arrows and a slider. Render only after a change when the scene is static. Use a ResizeObserver to call `resize()` and redraw. Offer keyboard controls and honor `prefers-reduced-motion`.

## Import and export models

```js
import { loadGltf } from '67js/addons/gltf';
const asset = await loadGltf('/model.glb');
const renderer = new Renderer67(canvas, asset.parts, { ground: false, hdr: true });
if (asset.animations.length) renderer.updateParts(asset.applyAnimation(1));
renderer.render({ eye: [3,2,4], target: [0,0,0] });
// Close in this order: renderer.dispose(); asset.dispose();
```

Version `0.4.0` imports supported opaque meshes, vertex colors, five PBR texture channels, skins, relative morph targets and animation.
Transparent or double-sided materials and compressed geometry remain unsupported.
The optional decoder uses Three.js GLTFLoader without its renderer. Read the [asset contract](/gltf.md) before choosing a model.

Core `exportGlb(parts)` returns GLB geometry. This geometry exporter is not a full texture/animation round-trip. For exploded output, apply `assemblyOffset` to copied matrices. Use the browser demo's PNG controls for a still.

Render immediately before canvas capture.

## Images and films

Offline media commands run from the repository checkout, not from an installed npm package. Install checkout dependencies and provide Chrome and FFmpeg. The exporter reports missing tools. On Windows it uses Chrome's standard install path and `~/.local/bin/ffmpeg.exe`.

```sh
npm run render -- --scene motion --kind image --backend gpu --time 3 --output artifacts/frame.png
npm run render -- --scene motion --kind video --backend gpu --encoder cpu --preset balanced --duration 12 --fps 24 --memory 384 --output artifacts/film.mp4
npm run render -- --scene motion --kind video --backend cpu --preset cpu --aspect portrait --duration 2 --output artifacts/cpu-trial.mp4
```

Scenes: object, nature, film, motion, view2d and assets. Use `--assembly 1` for object inspection. `--asset path/model.glb` with assets. `--start` for a timeline range.

`--aspect` supports landscape, portrait and square. `--width` and `--height` set dimensions (even dimensions for video). `--encoder gpu` requires NVENC. GPU rasterization and GPU encoding are independent.

Select original film audio with `--audio`. Other scenes default to silent.

Presets: preview 960×540 / 2 samples / 24fps / 256MiB. Balanced 1280×720 / 4 / 24 / 384MiB. High 1920×1080 / 4 / 24 / 512MiB. Cpu 640×360 / 1 / 12 / 192MiB.

Export one short trial before a full film. Inspect output JSON and FFprobe for backend, dimensions, duration, frame count and audio.

## Performance and memory

Reuse geometry and decoded textures. Do not create a renderer per frame. Change existing transforms through `updateParts`. Use lower scene detail before increasing the budget.

Pause hidden scenes and avoid simultaneous GPU exports. For static previews, redraw on demand.

The planner includes geometry, textures and mipmaps, shadows, MSAA, HDR, bloom and one capture staging frame. It reduces render dimensions when necessary. The exporter keeps one pending capture and respects encoder backpressure. This is an estimated allocation budget, not a hard process RAM/VRAM cap.

Driver/browser allocations can still fail. Sampled browser JS heap and Node RSS do not measure total graphics memory.

## Lifecycle and troubleshooting

WebGL2 unavailable: enable hardware acceleration or choose a supported browser. CPU export can use SwiftShader. Jagged edges: inspect actual render size and negotiated samples. Increase pixelRatio only within the budget.

Blown highlights: lower exposure and bloom, check linear color values. Missing asset: inspect its unsupported-feature error and convert the asset to the supported subset. Memory error: reduce resolution, MSAA, textures or scene detail. Context loss: stop playback, dispose the renderer and recreate on restoration.

Release mismatch: compare VERSION and homepage release metadata.

Disconnect observers, cancel animation frames, release pointer state and call `dispose()` on page/component teardown. Dispose decoded assets after the renderer. Keep errors visible. Do not silently substitute a different asset.

## Models and AI agents

Version `0.5.0` includes [agent scene sessions](/agent-scene.md) and the `67js-mcp` command.
Its [MCP server](/mcp.md) provides nineteen tools for authoring, previewing and exporting scenes through a persistent browser runtime.
Release `0.7.0` adds [agent motion](/agent-motion.md) for deterministic joint, material and camera keyframes.
Read the MCP guide for npm installation, client configuration and CPU/GPU selection.
The [agent look contract](/agent-look.md) adds retained lighting, volumetric fog, grading and directional shadows to recipe edits and checkpoints.
Release `0.8.0` adds [imported character motion](/agent-character-motion.md) with editable joints and retained skin, morph and texture resources.

Release `0.9.0` adds [visual review](/agent-review.md) for several labeled views or motion samples in one PNG grid.
Review uses an isolated snapshot and preserves the source preview pose, revision and checkpoint handles.

The [asset adapter](/agent-asset.md) imports local catalog GLBs with supported textures, rigs, morphs and deterministic clip sampling.

The addon accepts JSON recipes with stable object IDs, shared geometry and material resources, hierarchy and a camera.
Edits use an expected revision and commit as one batch. Checkpoints restore the supported scene state.
The session keeps existing renderer-facing parts and matrices for transform, material and camera edits.

Agents can build from an empty recipe with `add-geometry`, `add-material` and `add-node` commands.
Explicit removal and rebinding use the same atomic batch contract.
Checkpoints retain shared geometry under the session budget. Release unused snapshots before increasing scene detail.
The preview reconciles rigid, untextured topology while keeping unchanged geometry buffers and draw batches.

The CPU addon owns recipe state. The separate Node MCP server connects it to browser rendering. Background render jobs remain unsupported.

Give the agent this guide and the matching repository skill. Start with a scene brief: focal subject, visual references, camera, output size, required interaction, GPU/CPU backend and memory budget. Read the matching scene recipe and run the smallest trial first.

Suggested prompt: “Use 67.js to build an interactive mechanical study. Reuse meshes, use a 256MiB render budget, provide orbit and keyboard controls, pause hidden playback, and capture a real wide and mobile preview. List unsupported features. Do not claim speed superiority without a comparable benchmark.”

Agent workflow: inspect the installed `VERSION` and supported exports. Create finite invertible transforms. Share geometry identities. Validate bounds.

Render and inspect edges/highlights. Exercise interactions. Run project tests. Export one deterministic frame.

Report actual dimensions and estimated memory separately from observed process metrics. Never infer visual quality from successful compilation.

Repository skills: `skills/build-67js-scene/SKILL.md` and `skills/render-67js-media/SKILL.md` contain the scene and media procedures. Copy or reference them in your agent's skill system. They are also included in the npm archive. A model can use the plain-text guide without a skill runtime.

## Addons and limits

Core exports are available from `67js`:

| Export | Purpose |
| --- | --- |
| VERSION | Build version from the package metadata |
| Renderer67 | WebGL2 rendering and owned GPU resources |
| box, cylinder, sphere, torus | Shared primitive geometry |
| exportGlb | Geometry and basic material export |
| RENDER_PRESETS | Dimensions, MSAA, FPS and budgets for media |
| planRenderSize | Plan dimensions against the estimated allocation budget |
| estimateFrameBytes | Estimate targets and staging for a frame |
| assemblyOffset | Compute section and small-detail displacement |
| cameraView, fitOrthographicHeight | Axis cameras and fitted bounds |
| EFFECT_PRESETS, resolveEffects | Named looks and validated effect settings |
| createAnimationClip, sampleAnimationClip, createAnimationPlayer | Validate tracks, sample time and bind part animation |

`planRenderSize` accepts width, height, pixelRatio, samples, memoryBudgetMiB, geometryBytes, textureBytes, hdr, bloom, shadowResolution and maximumSize. It returns actual dimensions, estimatedBytes and reduced status. `estimateFrameBytes(width, height, samples, shadowResolution, { hdr, bloom })` estimates target storage. Neither function measures total VRAM.

`67js/addons/model`: createModel. `67js/addons/nature`: createNatureWorld. `67js/addons/film`: deterministic film recipes. `67js/addons/motion`: createMotionScene.

`67js/addons/canvas2d`: 2D recipes. `67js/addons/gltf`: optional asset decoding. These are separate imports to keep the core smaller.

67.js targets WebGL2. Version `0.4.0` includes the APIs below. Check the installed package version and release metadata before using them.

## Release and source availability

Published npm `0.4.0` includes modeling, sculpting, static mesh queries, shrinkwrap, surface patches, animation mixing, skinning, morphs, physics and lighting.
Retained [surface attachments](/surface-attachment.md) are introduced in `0.4.1` and are absent from published npm `0.4.0`.
Source checkouts can contain unreleased changes beyond their package version.

The [release metadata](/release.json) identifies the published package and browser module.
The checkout's `CHANGELOG.md` separates released features from unreleased work.
The [GLB snapshot contract](/export-glb.md) describes geometry, colors, UVs, HDR emission and current morph weights.
Module contracts define their own resource limits and disposal requirements.
