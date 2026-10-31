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

## Left

- A SwiftShader frame is still 4.5 to 7 times three.js, not 3. What remains is the per-pixel cost of the lit shader with 4 MSAA samples and an HDR target. Ideas that change the cost without changing the picture: a cheaper path for parts that are flat colour with no maps, and sharing one shadow comparison across the 3 by 3 filter. Both need the pictures checked again.
- The environment BRDF lookup table is the same for every map. It could be computed once per page, or on the CPU, which removes one program and one pass.
