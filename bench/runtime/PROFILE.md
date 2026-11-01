# Where a frame and the first frame go

Issue 74. Measured on 2026-10-31 at 960 by 540, scene `instanced-objects` unless noted, Chrome headless, an empty profile for each run. The RTX 3060 was shared with other jobs (25 to 99 percent busy), so GPU frame times are noisy. SwiftShader numbers were stable between runs.

## First frame on the RTX 3060

The first frame took 3,526 ms. Each program was timed from `createShader` to the link status, so the numbers include compile and link.

| Piece | Milliseconds |
| --- | --- |
| Main fragment shader (37,179 characters) | 2,286 |
| Environment prefilter and BRDF programs, which are most of the 553 ms in `createEnvironmentResources` | 326 + 224 |
| Post-processing program | 232 |
| Liquid program | 195 |
| Depth program | 122 |
| Sky, bloom, environment background | 23 + 10 + 19 |

So about 3.4 s of 3.5 s is shader compilation, and the main fragment shader alone is 65 percent. Buffer upload and the prefilter draw calls are small. The `hdr` and `samples` options change none of this (hdr off 3,539 ms, one sample 3,300 ms).

The main program takes that long because ANGLE compiles every branch. The branches on `surface.w` (the material tag) and on map flags are runtime values, so nothing can be dropped. When the unused ones were replaced by the constant `false` in the source, the same program compiled in 244 ms.

## Frame on SwiftShader

The first draw on SwiftShader also pays a compile, so the first frame was 1.8 s there. The frame was 620 ms. Passes were left out one at a time (the picture is wrong in each case, this only splits the cost):

| Left out | Frame (ms) |
| --- | --- |
| Nothing | 620 |
| Main opaque pass | 139 |
| Post-processing draw | 631 (no change, about 45 ms measured alone) |
| Environment background | 679 (no change, about 45 ms measured alone) |
| All three | 32 |

The main fragment shader is about 480 ms of 620. Toggles:

| Change | Frame (ms) |
| --- | --- |
| `hdr` off | 524 |
| `samples` 1 | 351 |
| `hdr` off and `samples` 1 | 323 |
| Fragment shader that returns the base colour | 195 |
| Shadow lookup removed (36 texel fetches) | 586 |
| Environment lighting removed | 570 |
| Point-light loop removed | 640 (no change) |
| Unused material features removed from the source | 349 |

So the cost is the size of the one program, not one feature: each large block alone moves the frame by 5 to 10 percent, and removing the code the scene never reaches moves it by 44 percent. MSAA is the second cost (43 percent on SwiftShader), and it is part of the picture. The post-processing pass and the environment background are each under 10 percent.

## What was changed

1. The main fragment shader is built from `#define`s chosen from the parts' materials (`createFragmentShader` in `src/shaders.js`). A feature a scene does not use is the constant `false`.
2. All programs, and the environment prefilter and BRDF programs, are started before any is checked, with `KHR_parallel_shader_compile`.

## After

Same scenes, `node bench/runtime/run.mjs --scene <id> --engine <name> --frames 8`. The pictures are identical: all 16 reference images (8 scenes, GPU and SwiftShader) match before and after, 15 pixel for pixel and `metal` on the GPU in 2 pixels by one level.

| Scene | First frame, RTX 3060 (ms) | SwiftShader frame (ms) | three.js on SwiftShader (ms) | Ratio |
| --- | --- | --- | --- | --- |
| `instanced-objects` | 4,100 to 488 | 654 to 337 | 48 | 13.5 to 7.0 |
| `many-materials` | 3,704 to 826 | 2,465 to 1,058 | 235 | 10.5 to 4.5 |
| `large-mesh` | 4,384 to 975 | 2,336 to 1,189 | 231 | 10.1 to 5.1 |

## Equal feature set, and where the frame goes (2026-11-01, no engine change)

Measured on `perf/frame-cost-equal-features`, 960 by 540, Chrome headless. Four new engines in `bench/runtime` turn one feature off at a time and need `--engine <name>`: `67js-ldr` (no HDR target), `67js-one-sample` (no MSAA), `67js-ldr-one-sample` (both), `three-one-sample` (three.js without MSAA). `--cpu-only` runs only SwiftShader.

**SwiftShader, frame in ms, 6 frames each, one run per row** (`base-cpu`, `base-cpu-three-one-sample`):

| Engine | `large-mesh` | `many-materials` | `instanced-objects` |
| --- | --- | --- | --- |
| three.js (4 samples) | 215 | 231 | 48 |
| 67js (HDR, 4 samples) | 1,684 | 1,219 | 376 |
| `67js-ldr` | 1,183 | 1,082 | 292 |
| `67js-one-sample` | 556 | 522 | 227 |
| `67js-ldr-one-sample` | 533 | 490 | 194 |
| three.js (one sample) | 94 | 86 | 37 |

Fair comparison: MSAA costs three.js 2.3, 2.7 and 1.3 times and costs 67js 3.0, 2.3 and 1.7 times, so it is not what separates them. With the same feature set (no MSAA, and no HDR target for 67js) 67js is 5.7, 5.7 and 5.2 times three.js, against 7.8, 5.3 and 7.8 for the defaults. 67js still draws an environment background and a post pass that three.js does not, and those are about 45 ms each on `instanced-objects` (measured above). The equal-feature gap is therefore the cost of the lit shader itself, which agrees with the profile above.

**RTX 3060, frame in ms, 60 frames, one run per row** (`gpu-matrix`, GPU 5 to 40 percent busy):

| Engine | `large-mesh` | `many-materials` | `instanced-objects` |
| --- | --- | --- | --- |
| three.js | 0.56 | 5.67 | 7.25 |
| 67js | 3.82 | 3.48 | 2.06 |
| `67js-ldr-one-sample` | 3.24 | 3.17 | 2.08 |
| three.js (one sample) | 0.56 | 6.89 | 9.91 |

Repeated `large-mesh` 67js runs gave 3.41, 3.58, 3.63, 3.82 and 3.11 to 3.98 across sessions, and three.js 0.61 to 0.63. On the GPU 67js wins `many-materials` and `instanced-objects` in this run (three.js draws 965 and 4,154 objects one by one) and loses `large-mesh` by 6.8 times. `instanced-objects` has no `three-instanced` row here, which beat 67js in the earlier report.

**Why `large-mesh` costs 3.6 ms against 0.6 ms on the GPU.** It is one sphere with 1,046,528 triangles, and 67js draws it in 3 passes (environment background, the mesh, post), which is also true of the RTX run above. Splitting the frame by wrapping the WebGL draw calls (script not kept in the repository):

| What | Frame (ms) |
| --- | --- |
| Whole frame | 3.1 to 3.9 |
| Mesh draw replaced by one triangle (fixed cost of the passes) | 1.3 |
| Mesh drawn with a minimal vertex and fragment shader on the same vertex array and targets | 2.1 |
| Mesh draw with `RASTERIZER_DISCARD` (vertex stage only) | 2.4 to 2.5 |
| Both full-screen passes skipped | 3.2 |
| `hdr` off, `samples` 1, or both | 3.2 to 3.3 (2.7 with HDR off alone) |
| Only 5 of the 15 vertex attributes enabled, or a non-instanced `drawElements` | 3.8 to 3.9 (no change) |
| Vertex shader cut to `gl_Position` only | 2.4 (no change) |
| Same page on ANGLE Vulkan instead of D3D11 | 67js 1.20, three.js 0.52 |

So: the passes around the mesh cost 1.3 ms, three.js's whole frame is 0.6, and about 2 ms is the mesh itself, split between getting 1 million tiny triangles through the pipeline (about 0.8 ms even with trivial shaders) and shading them (about 1.5 ms). Neither HDR nor MSAA nor the vertex shader's contents nor the number of attributes moves it. On Vulkan the ratio falls from 5.8 to 2.3, so more than half of the gap is specific to ANGLE's D3D11 path, and the cause inside it was not found. Almost every one of the 1 million triangles covers less than a pixel, so the lit shader runs on a 2 by 2 quad per triangle; that fits the shading share but was not isolated.

**One change tried and reverted.** Skipping the two fill-light `illuminate` calls when `fillIntensity` is 0 (the benchmark's value). SwiftShader frame, one run each: `large-mesh` 1,684 to 1,338 (this scene swings by 20 percent between runs), `many-materials` 1,219 to 1,233, `instanced-objects` 376 to 383. Inside the noise on two of three scenes, so it was not kept.

## Left

- A SwiftShader frame is still 4.5 to 7 times three.js, not 3. What remains is the per-pixel cost of the lit shader with 4 MSAA samples and an HDR target. Ideas that change the cost without changing the picture: a cheaper path for parts that are flat colour with no maps, and sharing one shadow comparison across the 3 by 3 filter. Both need the pictures checked again.
- The environment BRDF lookup table is the same for every map. It could be computed once per page, or on the CPU, which removes one program and one pass.
