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

## Materials and color

`color` and `emissiveColor` are linear RGB. `metallic` and `roughness` describe the PBR surface. `emission` sets emission intensity. `material.map` is a decoded texture descriptor with an image, UV channel 0, color space and supported sampler settings.

The optional GLB addon creates these descriptors. HDR requires `EXT_color_buffer_float`. Inspect `renderer.capabilities.hdr` and `hdrFallbackReason`. The renderer falls back when floating-point targets are unavailable.

Tags select specialized behavior: `armor` allows studio finish overrides. `floor` is a studio floor. `water` adds animated normals and ripples. `foliage` and `grass` add wind.

`terrain` adds surface variation. `fire` and `smoke` support film effects. `unlit` is a flat color. Other tags use ordinary PBR shading.

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

Tracks target unique part names. Supported transform tracks are translation, rotation (quaternion XYZW) and scale. Material tracks include metallic, roughness and emission. Interpolation is LINEAR, STEP or SMOOTH.

`sampleAnimationClip(clip, time)` returns samples without binding parts. Preserve the original graph and apply absolute time so seeking backwards reproduces the scene. Use `requestAnimationFrame` for playback, pause when hidden, and use a fixed sample time for export.

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

Supported: standard opaque meshes, UV base-color PNG/JPEG textures, vertex colors, emissive color and rigid node animation. Unsupported: skinning, morph targets, transparent or double-sided materials, compressed geometry and additional PBR maps. The optional decoder uses Three.js GLTFLoader, not its renderer. Read the [asset contract](/gltf.md) before choosing a model.

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

## Current source additions

The current checkout adds authoring and animation APIs through separate modules:

- [Scene hierarchy](scene-graph.md), [procedural modeling](modeling.md), [animation curves](animation-curves.md) and [clip mixing](animation-mixer.md).
- [Skeletal animation](skinning.md), [relative morph targets](morph-targets.md) and [glTF morph animation](gltf-morph.md).
- [Recorded Rapier physics](physics.md), including contacts, joints, limits and bounded motors.
- [Static sculpt brushes](sculpt.md), [curved surface patches](surface.md) and [BVH mesh queries](mesh-query.md).
- [Static shrinkwrap](shrinkwrap.md) through nearest-surface or directional projection, with bounded work and explicit miss handling.
- [GLB snapshot export](export-glb.md), including vertex colors, UVs, HDR emission and current morph weights.

These APIs do not provide a Blender-style editor, WebGPU backend or general asset compatibility. Mesh queries operate on static geometry. They do not automatically resolve collisions or diagnose z-fighting. The physics addon requires its separate Rapier dependency. See each module's contract for limits and disposal requirements.

The current source also adds [surface attachments](surface-attachment.md), newer than npm `0.4.0`.
These retained rigid frames follow selected triangles through morphing and skinning without rebuilding a mesh query index each frame.
