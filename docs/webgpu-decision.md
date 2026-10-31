# WebGPU decision (issue #56)

Decision: wait. WebGL2 stays the only backend. Revisit when a feature needs compute and the CPU path has been measured as the bottleneck, not before.

Each claim carries a tag: **measured** (run on this machine on 2026-10-31), **inferred** (follows from a measurement or a source) or **guessed** (an estimate nobody ran).

Machine: Windows 11, RTX 3060 12 GB (shared with other jobs, 24 to 100 percent busy during runs), Chrome 156.0.8078.74, Playwright headless, 960 by 540, 4 MSAA samples, empty profile per run. The spike lives in gitignored `artifacts/webgpu/` and is not merged.

## What was tested

There is no WGSL port of the 67.js shaders, and writing one is the work this decision avoids. The spike draws the `bench/runtime` scenes `instanced-objects`, `many-materials` and `large-mesh` (the scenes where three.js wins, `bench/runtime/PROFILE.md`) with three.js 0.186.1 on its WebGL2 renderer and on its WebGPU renderer, with the same geometry, materials and lights. This is a proxy: it tells what the API and the driver stack change for a full PBR scene, not what a 67.js WGSL backend would cost. The spike draws `instanced-objects` as individual meshes (the bench's non-instanced three.js variant), so it is a heavier draw-call load than the 3-draw 67.js run. The 67.js rows come from `node bench/runtime/run.mjs --engine 67js --frames 20` in the same session.

## Is WebGPU available in headless Chrome here

| Chrome flags | `navigator.gpu` adapter | Source |
| --- | --- | --- |
| none (headless) | NVIDIA Ampere, 21 features, device created | measured |
| `--enable-unsafe-webgpu` | same adapter, 25 features | measured |
| `--use-angle=swiftshader --enable-unsafe-swiftshader` (what `scripts/agent-runtime.mjs` passes for the `cpu` backend) | `null` | measured |
| `--disable-gpu`, with or without `--enable-unsafe-swiftshader` | `null` | measured |
| `--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-webgpu-adapter=swiftshader` | Google SwiftShader adapter, device created | measured |

The page must be a secure context: `about:blank` has no `navigator.gpu`, an `https://` or `localhost` page does (measured).

So on a machine with a GPU, headless Chrome has WebGPU with no flags. There is no automatic software fallback: the MCP `cpu` job, which forces SwiftShader for WebGL, would get no adapter and would need a different flag set to reach SwiftShader's Vulkan adapter. A CPU-only CI machine therefore needs an explicit flag, and the WebGPU software path is a different implementation from the WebGL one (inferred).

## Frame time and first frame

Three.js, same scenes, median frame after 20 warmup frames (60 frames on the GPU, 8 on SwiftShader). The frame time includes the wait for the GPU to finish (`readPixels` for WebGL, `queue.onSubmittedWorkDone()` for WebGPU), so WebGPU carries a round trip of a few milliseconds that the WebGL wait may not (inferred from `large-mesh`, where CPU submit is 0.28 ms and the frame is 3.51 ms). All numbers are measured.

RTX 3060:

| Scene | WebGL first frame | WebGPU first frame | WebGL frame | WebGPU frame |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 123 ms | 797 ms | 6.81 ms | 18.52 ms |
| `many-materials` | 213 ms | 485 ms | 3.48 ms | 9.01 ms |
| `large-mesh` | 441 ms | 653 ms | 0.80 ms | 3.51 ms |

An earlier run of `instanced-objects` with the Chrome frame-rate limit left on gave 98 ms and 656 ms first frame, 4.37 ms and 16.78 ms frame, so the order did not change.

SwiftShader (WebGL through `--use-angle=swiftshader`, WebGPU through SwiftShader's Vulkan adapter):

| Scene | WebGL first frame | WebGPU first frame | WebGL frame | WebGPU frame |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 288 ms | 719 ms | 48.6 ms | 146.7 ms |
| `many-materials` | 424 ms | 766 ms | 266.1 ms | 384.5 ms |
| `large-mesh` | 983 ms | 1,160 ms | 235.3 ms | 419.1 ms |

67.js on its own pipeline (HDR target, MSAA, shadows, post), same session:

| Scene | RTX 3060 first frame | RTX 3060 frame | SwiftShader first frame | SwiftShader frame |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 896 ms | 2.2 ms | 1,505 ms | 389 ms |
| `many-materials` | 720 ms | 3.95 ms | 2,353 ms | 1,261 ms |
| `large-mesh` | 1,013 ms | 3.79 ms | 2,737 ms | 1,332 ms |

What this says:

- Three.js on WebGPU was slower than three.js on WebGL2 in all 6 pairs: 2.6 to 4.4 times the frame time on the GPU, 1.4 to 3.0 on SwiftShader, and 1.2 to 6.5 times the first frame (measured). A new API did not remove the first-frame compile cost: WebGPU had to build its pipelines too.
- On the fallback, WebGPU on SwiftShader was 1.4 to 3.0 times the WebGL frame (measured). The 67.js gap on SwiftShader is the per-pixel cost of one large lit shader with MSAA and an HDR target (`PROFILE.md`), which runs on the CPU either way; a graphics API does not change that (inferred).
- The 3.4 s first-frame cost that `PROFILE.md` found in ANGLE's compile of the 37,179 character fragment shader was already cut to 0.7 to 1.0 s on the GPU by `#define` specialization, which is a WebGL change that needs no new backend (measured, `PROFILE.md`).
- Not measured: a hand-written WGSL port of the 67.js shader. A hand-written WGSL path could differ from three.js's generated shaders, and these numbers do not say by how much.
- Pictures were not compared pixel for pixel. The share of non-background pixels matched between backends in every scene (0.36, 0.87, 0.29, measured), which shows the same scene was drawn and nothing more.

## Bundle size

A scene with a box, one light and a standard material, built with Vite and esbuild minify, in a clean entry (measured). These are three.js numbers, not 67.js numbers.

| Entry | Minified | Gzip |
| --- | --- | --- |
| `three` WebGLRenderer | 652,365 | 143,089 |
| `three/webgpu` WebGPURenderer (it carries its own WebGL2 fallback backend) | 1,023,136 | 236,780 |
| both imported | 1,449,769 | 329,427 |

For 67.js, the lit box is 58,928 bytes gzip (`npm run size`, 2026-10-31, against a goal of 50,000 and three.js at 133,652) and `entry:core` has a budget of 82,600 (`bench/size/budgets.json`). A second backend means a second set of shaders, pipelines and resource code. Counting template-literal text in the 7 files that hold GLSL gives 1,377 non-blank lines (an upper bound, some are JS strings): `shaders.js` 847, `post.js` 244, `environment.js` 163, `camera-effects.js` 67, `ambient-occlusion.js` 45, `render-passes.js` 4, `gl-program.js` 7. The `context.` call count is 357 in `renderer.js`, 34 in `environment.js`, 25 in `render-passes.js`, 24 in `camera-effects.js` and 12 in `gl-program.js`, about 450 call sites in total (measured by grep). Guessed: carrying both backends adds 25 to 45 KB gzip to core, because WGSL is wordier than GLSL and WebGPU needs explicit pipeline and bind group code; which would move the lit box further from its 50,000 goal. This estimate was not built.

## Which shader features would need rewriting

All of them, because GLSL ES 3.00 is not WGSL. The features that carry the most risk (found by grep, so a list of where, not a cost):

- `texelFetch` in `shaders.js` and `render-passes.js`, `dFdx` in `shaders.js`, `ambient-occlusion.js` and `splat-shader.js` (WGSL has `textureLoad` and `dpdx`, with uniformity rules that reject some of the current code).
- `discard` in `shaders.js` and `gl_VertexID` in `shaders.js` and `gl-program.js`.
- `textureLod` in `environment.js` and `splat-shader.js`: the environment prefilter and BRDF programs that `PROFILE.md` timed at 326 and 224 ms.
- `blitFramebuffer` and `renderbufferStorageMultisample` in `renderer.js`: WebGPU has no renderbuffers or blit, so the MSAA resolve becomes a render pass resolve target.
- `EXT_color_buffer_*` in `environment.js` and `renderer.js`, and `KHR_parallel_shader_compile` in `gl-program.js`, which `createRenderPipelineAsync` replaces.
- Timer queries (`createGpuTimer`) become timestamp queries, which Chrome can hide behind a permission.

Estimate (guessed): about 1,400 lines of WGSL plus a rewrite of the roughly 450 call sites in `renderer.js` and its 4 neighbours, which is weeks of work and a second picture to keep equal to the first by the 16-image reference check.

## Browser support

From primary sources, read on 2026-10-31:

- MDN browser-compat-data `api/GPU.json` (main branch): Chrome 113 on ChromeOS, macOS and Windows (marked partial until 144), Chrome 144 adds Linux on Intel Gen12 and newer only; Chrome Android 121; Firefox 141 on Windows, 145 on macOS Tahoe with Apple silicon, 147 on older macOS with Apple silicon, no Intel Mac and no Linux, no service workers; Safari 26 (iOS, iPadOS and visionOS mirror it). Status: not experimental, on the standards track.
- web.dev, "WebGPU is now supported in major browsers", published 2025-11-25: Chrome and Edge 113 on Windows (Direct3D 12), macOS and ChromeOS; Android 121 for Android 12 or newer with Qualcomm or ARM GPUs; Linux in progress; Firefox 141 Windows and 145 macOS Tahoe ARM64; Safari 26 on macOS, iOS, iPadOS and visionOS.

The issue text says MDN marks WebGPU as limited availability; that is true of the MDN page as the issue cites it, and the compat data still lists Firefox as partial and Linux, Android Firefox and Intel Macs as unsupported (2026-10-31). Coverage is wide for a viewer on current Windows, macOS, iOS and Android. It is not yet something a default can rely on, and WebGL2 reaches every one of those browsers (inferred).

## What an agent gains

- Compute shaders could speed up work that is CPU now: cloth, particles, light bake, subdivision, culling. None of the recipes has been measured as too slow; their budgets are bounded on purpose (inferred from the changelog limits).
- An agent's value in this engine is that a seek gives the same bytes. The smokes compare PNG bytes through the MCP preview on SwiftShader. Compute results can differ between adapters (floating-point order, atomics), so a GPU path would weaken that check unless it were run only for offline rendering (inferred).
- The MCP runtime depends on a CPU renderer that works with no GPU. Today's WebGPU has no such path without extra flags, and was slower on SwiftShader in this spike (measured above).
- Per-tool-call success, the measure the project uses for agent features, does not depend on the backend (inferred).

## Done conditions of the issue

The decision is written with its measurements: yes, this file. The three options: adopt, adopt for offline only, wait. Chosen: wait.

When to look again:

- A feature on the roadmap measured as too slow on the CPU and needing compute (not before), or
- the MCP `cpu` backend needs a different software renderer, or
- a three.js WebGPU frame beats WebGL2 on the same scenes on the 3060 on a quiet GPU.

Not verified: a WGSL port of the 67.js shaders; WebGPU timing on a quiet GPU (the RTX 3060 was shared); Firefox, Safari and Android behaviour (support facts only come from MDN and web.dev); the bundle growth of a real second backend.
