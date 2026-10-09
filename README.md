# 67.js

**Your 3D scene, from browser to film.**

Explore the [showcase](https://67js.codepawl.com), read the [documentation](https://67js.codepawl.com/docs.html), or give an agent the [plain-text guide](https://67js.codepawl.com/llms.txt).

67.js is a JavaScript graphics engine for interactive worlds, animated models and cinematic media in the browser.
Meshes, materials and cameras give Three.js users a familiar foundation. Scene studios, assembly inspection and image/video export extend that foundation into a production workflow.

The renderer is designed around shared geometry, predictable frame allocation and explicit CPU/GPU render budgets.
The aim is to spend less time managing draw calls, capture scripts and memory limits, and more time building the scene.

The current release includes an explodable WALL·E study, an interactive nature world, a 3D short film and a keyframe motion studio.
It also includes flat 2D views and an asset viewer. Every viewer uses the 67.js renderer.

## What it includes

- Instanced geometry, PBR lighting, shadows, MSAA, FXAA and specular filtering.
- On-demand rendering for object inspection and deterministic time sampling for the short film.
- Interactive studios with orbit controls, material settings, assembly views and GLB export.
- CPU and GPU image/video export with memory planning and encoder backpressure.
- A versioned npm package, standalone browser module and release metadata shared by the website and guide.
- Deterministic keyframe animation with retained instance buffers and absolute timeline seeking.
- Optional HDR, bloom and color grading, with reused targets included in the render budget.
- Orthographic cameras and flat XY scenes with pan, zoom and PNG capture.
- An optional glTF/GLB decoder for textured meshes, vertex colors and rigid node animation.

## Direction

67.js aims to make rendering, interaction and media production available through one browser graphics workflow.
The next implementation targets adaptive quality, GPU timing, picking and reusable interaction controls. See the [implementation roadmap](ROADMAP.md).
Performance improvements are evaluated on matching scenes and hardware. Visual quality follows the needs of each authored scene.

![WALL·E rendered by 67.js](https://67js.codepawl.com/previews/wall-e.png)

The WALL·E study contains 574 parts, 860,380 triangles and seven shared geometries.
The studio submits eight geometry draws, including the floor.
Its slider separates all 574 components, including individual fasteners, tread shoes, gears and electronics, to expose batteries, circuit boards, motors, gears and optical mechanisms.
The layer controls show the shell, the interior or both. GLB export preserves the selected layers, finish and explosion amount.

The homepage character rolls forward, looks around and moves its arms and claws.
Its assembly slider approaches each selected position smoothly, pauses driving and resumes gradually after complete reassembly.

The renderer uses sampled fillets, GGX lighting, shadows, explicit MSAA, FXAA, specular filtering and ACES tone mapping.
It reuses geometry buffers during explosion and refreshes shadows without allocating another shadow texture.
The studio renders on demand. Continuous animation pauses in hidden tabs.

## Install

```sh
npm install 67js@npm:@codepawlhq/67js
```

The registry package is `@codepawlhq/67js`. Its local alias is `67js`, so imports stay short. The project brand is 67.js.

The library is ESM and bundles its runtime dependencies. Core exports include `Renderer67`, `box`, `cylinder`, `sphere`, `torus`, `assemblyOffset`, `exportGlb`, render budget helpers and `VERSION`. Scene constructors are separate addons. Browser module downloads and the guide are available at https://67js.codepawl.com.

## Run

1. Install Node.js 22.12 or newer.
2. Run `npm ci`.
3. Run `npm run dev`.
4. Open the URL printed by Vite.

| Page | Experience |
| --- | --- |
| `/` | Installation, downloads, release metadata and examples. |
| `/object.html` | WALL·E studio with orbit, zoom, explosion, layers, finishes and GLB export. |
| `/nature.html` | Silverwater valley with viewpoints, daylight, wind, detail settings and water ripples. |
| `/film.html` | Oppenheimer, a 187-second procedural trailer study with playback and timeline controls. |
| `/motion.html` | Clockwork orbit, a 12-second keyframe animation with HDR and landscape, portrait and square framing. |
| `/view2d.html` | Flat vector scenes and front, right, top or perspective model inspection. |
| `/assets.html` | GLB loading, texture inspection, rigid animation, orbit controls and PNG capture. |

The Oppenheimer study contains 33 shots across 13 procedural sets: a laboratory, research town, scientist portraits, atomic imagery, a wired Gadget and the night test.
It uses an original synthesized score. The playable MP4 is in `public/media/critical.mp4`.
The nature world uses seeded terrain and instanced vegetation. Its balanced preset contains 2,673 parts and 585,470 triangles.

## Render images and video

1. Run `npm run score` to generate the original soundtrack.
2. Choose a command below for the required scene and backend.
3. Inspect the output and its JSON report.

```powershell
npm run render -- --kind image --scene object --backend gpu --preset high --output artifacts/wall-e.png
npm run render -- --kind image --scene nature --backend gpu --preset high --output artifacts/nature.png
npm run render -- --kind image --scene object --backend cpu --preset cpu --output artifacts/wall-e-cpu.png
npm run render -- --kind video --scene film --backend gpu --preset balanced --encoder gpu --output public/media/critical.mp4
npm run render -- --kind video --scene motion --aspect portrait --backend gpu --encoder gpu --output artifacts/short.mp4
npm run render -- --kind image --scene view2d --aspect square --backend cpu --preset cpu --output artifacts/poster.png
npm run render -- --kind video --scene assets --asset model.glb --duration 2 --output artifacts/model.mp4
```

Video exports default to JPEG capture at quality 95 and automatically use NVENC when its preflight succeeds, with a CPU encoder fallback. `--backend cpu` defaults to CPU encoding as well. Use `--capture png` for lossless frame capture or `--jpeg-quality 100` for a higher JPEG quality. H.264 delivery remains compressed in either mode.

Progress reports frames per second, speed relative to playback and estimated remaining time. The JSON sidecar separates rendering, capture, encoder backpressure and encoder finalization, alongside peak memory. Capture keeps one pending frame. The encoder applies backpressure rather than buffering a film in memory.

| Preset | Dimensions | MSAA samples | FPS | Target budget |
| --- | --- | ---: | ---: | ---: |
| `preview` | 960 × 540 | 2 | 24 | 256 MiB |
| `balanced` | 1280 × 720 | 4 | 24 | 384 MiB |
| `high` | 1920 × 1080 | 4 | 24 | 512 MiB |
| `cpu` | 640 × 360 | 1 | 12 | 192 MiB |

GPU rendering uses hardware WebGL. CPU rendering explicitly requests and verifies ANGLE SwiftShader.
The encoder independently supports two-thread libx264 or NVIDIA NVENC.
The exporter streams one frame at a time and waits for encoder backpressure.
It keeps one live scene renderer and disables development reloads during capture.

The planner reduces render dimensions before targets exceed their estimated budget.
The estimate includes geometry, texture mipmaps, shadows, HDR/bloom targets and frame staging. It excludes some browser and driver allocations.
The report records actual dimensions, estimated render memory, Node RSS and sampled browser JavaScript heap.
Node and JavaScript heap guards stop capture above 512 MiB and 256 MiB respectively.
These guards cannot guarantee that every driver or system allocation succeeds.

## Skills

The repository includes two reusable Codex skills.

- [build-67js-scene](skills/build-67js-scene/SKILL.md) covers geometry, materials, cameras, interaction and anti-aliasing.
- [render-67js-media](skills/render-67js-media/SKILL.md) covers CPU/GPU presets, streaming exports and memory measurements.

## Checks and performance

1. Run `npm test` to validate geometry, scene budgets, the timeline and independent GLB loading.
2. Run `npm run build` to create the homepage, guide and six production viewers in `dist/`.
3. Run `npm run smoke` to exercise the studio in headless Chrome.
4. Run `npm run smoke:enhancements` against the running development server to check motion, orthographic views and textured asset animation.

The smoke saves rendered screenshots, a GLB and benchmark results under the ignored `artifacts/` directory.
The benchmark compares identical geometry, camera, resolution and flat shaders with both instanced and individual draws.
It measures CPU submission over 120 samples after warmup, with GPU synchronization outside the timed region.

The results establish no general speed advantage or visual parity with Three.js or Blender.
Vite serves COOP and COEP headers for fine browser timers. Other hosts need equivalent headers for comparable timing.
Detailed measured results and limits are in [verification.md](docs/verification.md).

## API

`createModel()` returns shared geometries, column-major matrices, linear RGB materials and optional assembly offsets.
`Renderer67` groups geometry and texture descriptor identities into instanced batches.

```js
import { Renderer67 } from '67js';
import { createModel } from '67js/addons/model';

const renderer = new Renderer67(canvas, createModel(), {
  samples: 4,
  memoryBudgetMiB: 256,
});
renderer.render({ eye: [4, 3, 7], target: [0, 1.5, 0], assemblyAmount: 0.5 });
// Call resize() after CSS dimensions change.
// Call dispose() before replacing the renderer.
```

The core exports animation helpers, camera views and effect presets. `renderer.updateParts(parts)` uploads changes without replacing geometry buffers.
The current source adds [camera paths](docs/camera-path.md) with cubic moves, target tracking, roll and focal-length conversion.
These camera helpers are not included in the published `0.3.3` package yet.
The [optional asset addon](docs/gltf.md) loads glTF/GLB meshes, base-color textures, opaque vertex colors and rigid node animation.
It uses Three.js as a decoder. The core renderer and standalone module remain separate from this dependency.

Skinning, morph targets, transparent materials, compressed assets and ray tracing remain outside this release.
Blender-level realism remains a visual target. 67.js does not provide Three.js API compatibility.

## Credits

WALL·E is a Disney/Pixar character. This repository authors its study as procedural geometry without external model assets.
The Oppenheimer study follows the shot progression of [Universal Pictures’ New Trailer](https://www.youtube.com/watch?v=uYPbbksJxIg) using stylized procedural sets and an original synthesized score.
It includes no film footage, dialogue or soundtrack samples.

- [Three.js](https://threejs.org/) and its [source](https://github.com/mrdoob/three.js/) provide the benchmark reference.
- The optional asset addon bundles the Three.js glTF decoder under its MIT license.
- [Blender](https://projects.blender.org/blender/blender) provides the visual quality target.
- [gl-matrix](https://github.com/toji/gl-matrix) supplies matrix operations.

## Release synchronization

`package.json` is the version source. Release preparation builds the npm archive and a standalone browser module.
It generates `/release.json` with the version, Git commit, package integrity and verified npm publication status.
The homepage and guide read this endpoint for their commands and downloads.

1. Update the package version and changelog.
2. Run `npm test` and `npm run build`.
3. Run `npm run smoke:package`. It verifies a clean consumer installation.
4. Commit and push the release.
5. The `publish.yml` GitHub Actions workflow verifies the package and publishes new versions through the npm trusted publisher. Wait for a successful run and registry availability.
6. Run `npm run deploy`. It verifies the pushed commit, rebuilds and checks the live release. If npm has published the version, the site serves its canonical package archive and integrity.
