# Runtime against three.js

This suite compares what a frame costs in 67js and in three.js on 7 matching scenes. **three.js wins most of them today, but 67js wins the GPU frame in 2 of 7 scenes.**

## Culling and levels of detail (issue 37)

Scene `large-outdoor` has 6,000 spheres of about 1,000 triangles over 600 by 600 units, seen from the edge, so about a quarter of them are in view and most are far. `67js` uses the default frustum culling and the levels from `generateGeometryLods` (ratios 0.25 and 0.06, 1 pixel of error). `67js-no-lod` has culling only, and `67js-no-culling` has neither, which is what the renderer did before. three.js draws 6,000 individual meshes, which it culls per mesh, without levels. Measured on 2026-10-31 at 960 by 540, `--frames 30`, other jobs were using the RTX 3060 between 1 and 87 percent (`gpuBusyBefore` in a full report), so the GPU numbers are noisy.

| Engine | RTX 3060 frame (ms) | Triangles | SwiftShader frame (ms) |
| --- | --- | --- | --- |
| `67js-no-culling` | 8.41 | 5,760,014 | 4,428 |
| `67js-no-lod` (culling) | 7.68 | 4,359,374 | 4,061 |
| `67js` (culling and levels) | 1.55 | 270,474 | 517 |
| three.js | 6.00 | 4,359,372 | 944 |

Culling alone gives the same picture pixel for pixel as no culling, on both backends. Levels change 1.9 percent of the pixels by more than 8 levels (mean absolute difference 0.45 of 255). The other 7 scenes draw the same pictures as before pixel for pixel on the RTX 3060 (checked on 4 of them), and their frame times moved within the noise. The run draws the first frame again after the measured frames and fails when the `large-outdoor` picture differs.

## Run it

Run `npm run benchmark:runtime`. It takes about 8 minutes, and it rewrites `report.json`. Stop other GPU work first, because `report.json` records how busy the GPU was before each run.

CI does not run this suite. It needs Chrome and a GPU, and `tests/runtime-report.test.js` checks only that the committed report is complete.

## Result

Measured on 2026-11-03 at 960 by 540 with 4 MSAA samples, against three.js 0.186.1, after the issue 74 changes. The GPU was between 5 and 95 percent busy before the runs (`gpuBusyBefore` in `report.json`; 8 percent before the first scene), so the RTX 3060 numbers are noisy. A ratio above 1 means that 67js costs more.

**Full frame on SwiftShader, in milliseconds.** This is the path that a headless agent uses.

| Scene | 67js | three.js | Ratio |
| --- | --- | --- | --- |
| `instanced-objects` | 101 | 34 (instanced 43) | 3.0 |
| `many-materials` | 524 | 193 | 2.7 |
| `many-lights` | 367 | 144 | 2.6 |
| `transparency` | 329 | 67 | 4.9 |
| `moving-shadows` | 73 | 28 | 2.6 |
| `large-mesh` | 443 | 172 | 2.6 |
| `skinned-characters` | 177 | 45 | 3.9 |

**Full frame on an RTX 3060, in milliseconds.** Other jobs shared the GPU during parts of this run, so these numbers are noisy.

| Scene | 67js | three.js | Ratio |
| --- | --- | --- | --- |
| `instanced-objects` | 0.84 | 2.36 (instanced 0.27) | 0.4 |
| `many-materials` | 2.32 | 1.62 | 1.4 |
| `many-lights` | 1.41 | 0.85 | 1.7 |
| `transparency` | 0.97 | 0.74 | 1.3 |
| `moving-shadows` | 0.85 | 1.16 | 0.7 |
| `large-mesh` | 2.38 | 0.37 | 6.4 |
| `skinned-characters` | 4.02 | 1.99 | 2.0 |

**First frame on an RTX 3060, in milliseconds.** Each run has an empty browser profile, so no shader cache helps either engine.

| Scene | 67js | three.js | Ratio |
| --- | --- | --- | --- |
| `instanced-objects` | 257 | 85 | 3.0 |
| `many-materials` | 233 | 109 | 2.1 |
| `many-lights` | 230 | 123 | 1.9 |
| `transparency` | 225 | 132 | 1.7 |
| `moving-shadows` | 259 | 119 | 2.2 |
| `large-mesh` | 394 | 246 | 1.6 |
| `skinned-characters` | 310 | 289 | 1.1 |

## GPU memory per render target

Each 67js result in `report.json` lists its render targets (`renderTargets`: name, size, format, samples, bytes). The same list comes from `renderer.memoryReport()`. At 960 by 540 with 4 samples, for `instanced-objects` and `large-outdoor` alike: `shadowMap` 16 MB (2048 by 2048 depth), `multisampleColor` 15.82 MB (RGBA16F), `multisampleDepth` 7.91 MB and `frameColor` 3.96 MB. The counter totals 45.31 MB and 47.54 MB, so 1.6 to 3.8 MB is geometry and textures.

## Where each engine wins

**three.js wins:**

- Full frames on SwiftShader, in every scene.
- Full frames on the RTX 3060, in 5 of 7 scenes. 67js is faster than three.js with separate meshes in `instanced-objects` and `moving-shadows`, but an `InstancedMesh` beats 67js in `instanced-objects` by 3.1 times.
- The first frame, in every scene.
- GPU memory that WebGL calls show, in every scene. 67js allocates about 44 MB for its render targets (it was 46 MB): 16 MB shadow map, 15.8 MB multisampled colour, 7.9 MB multisampled depth and 4 MB resolved colour at this size. A scene with no shadow casters allocates a one texel shadow map instead of 16 MB, and bloom, ambient occlusion, cascades and the point light atlas allocate only when used. The benchmark scenes all cast shadows. three.js shows 0 to 32 MB because its targets live in the canvas, which the counter leaves out.
- Fewer triangles when objects are off camera, because it culls them. 67js draws all of them (issue 37).
- Heap memory in `skinned-characters`, because three.js clones one parsed file.

**67js wins:**

- CPU time to submit a frame, in 6 of 7 scenes. It takes 0.07 ms against 3.91 ms for 5,000 individual meshes. It groups objects into a few draw calls by itself. An `InstancedMesh` needs the same grouping by hand in three.js.
- Heap memory in 6 of 7 scenes.

Issue 74 tracks the frame and first-frame costs. The cause is not measured yet.

## Do the pictures match?

FLIP between the two engines, where 0 means identical.

| Scene | FLIP |
| --- | --- |
| `large-mesh` | 0.027 |
| `instanced-objects` | 0.047 |
| `moving-shadows` | 0.090 |
| `skinned-characters` | 0.102 |
| `transparency` | 0.129 |
| `many-lights` | 0.132 |
| `many-materials` | 0.241 |

Both engines use the same geometry, lights and tone curve, so these are small differences. `many-materials` is the largest, because half of its spheres are metal and three.js has only an ambient light, with nothing for metal to reflect. 67js reflects a constant environment map, so it is the one that has reflections.

The comparison is not exact. 67js pays for an environment map and an HDR post-processing pass, and three.js does not. A scene with an environment map in three.js costs more than this.

## How it measures

- **Full frame:** from the start of the render call until `readPixels` returns one pixel, which waits for the GPU. `context.finish()` returns at once in Chrome, so it can not do this.
- **CPU submit:** the render call only.
- **First frame:** from building the scene to the first finished frame, with a new browser and profile for each run.
- **GPU memory:** watched through WebGL buffer, texture and renderbuffer calls. It leaves out the canvas's own buffers, for both engines.
- **Heap:** after a forced garbage collection, minus the heap before the scene was built.

`report.json` also holds GPU timer query results. Do not rely on them: they gave 0.15 ms for 1 million triangles in three.js, which is not plausible.

## Limits

- One machine and one resolution. Other jobs used the GPU during the RTX 3060 runs, and `report.json` records how busy it was.
- `skinned-characters` draws its robots at one spot, so that the same pixels overdraw in both engines.
- The scenes do not use textures.
- These numbers replace no claim in `docs/benchmark.json`. That file compares one scene with the same raw shader in both engines, so it measures submission cost only.
