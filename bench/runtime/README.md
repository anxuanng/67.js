# Runtime against three.js

This suite compares what a frame costs in 67.js and in three.js on 7 matching scenes. **three.js wins most of them today.**

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

Measured on 2026-10-31 at 960 by 540 with 4 MSAA samples, against three.js 0.186.1. A ratio above 1 means that 67.js costs more.

**Full frame on SwiftShader, in milliseconds.** This is the path that a headless agent uses.

| Scene | 67.js | three.js | Ratio |
| --- | --- | --- | --- |
| `instanced-objects` | 631 | 48 (instanced 44) | 13.3 |
| `many-materials` | 2,207 | 237 | 9.3 |
| `many-lights` | 1,506 | 261 | 5.8 |
| `transparency` | 1,699 | 131 | 12.9 |
| `moving-shadows` | 411 | 43 | 9.5 |
| `large-mesh` | 2,216 | 221 | 10.0 |
| `skinned-characters` | 730 | 68 | 10.8 |

**Full frame on an RTX 3060, in milliseconds.** Other jobs were using the GPU during this run, so these numbers are noisy.

| Scene | 67.js | three.js | Ratio |
| --- | --- | --- | --- |
| `instanced-objects` | 1.25 | 4.34 (instanced 0.36) | 0.3 |
| `many-materials` | 4.75 | 2.97 | 1.6 |
| `many-lights` | 4.54 | 2.46 | 1.8 |
| `transparency` | 2.70 | 1.35 | 2.0 |
| `moving-shadows` | 2.34 | 1.85 | 1.3 |
| `large-mesh` | 4.24 | 0.59 | 7.2 |
| `skinned-characters` | 9.02 | 3.13 | 2.9 |

**First frame on an RTX 3060, in milliseconds.** Each run has an empty browser profile, so no shader cache helps either engine.

| Scene | 67.js | three.js | Ratio |
| --- | --- | --- | --- |
| `instanced-objects` | 2,608 | 204 | 12.8 |
| `many-materials` | 2,564 | 269 | 9.5 |
| `many-lights` | 2,655 | 276 | 9.6 |
| `transparency` | 2,853 | 231 | 12.4 |
| `moving-shadows` | 2,606 | 245 | 10.6 |
| `large-mesh` | 3,113 | 459 | 6.8 |
| `skinned-characters` | 3,266 | 551 | 5.9 |

## Where each engine wins

**three.js wins:**

- Full frames on SwiftShader, in every scene.
- Full frames on the RTX 3060, in 6 of 7 scenes. In the seventh, an `InstancedMesh` beats 67.js by 3.5 times.
- The first frame, in every scene.
- GPU memory that WebGL calls show, in every scene. 67.js allocates about 46 MB for its render targets.
- Fewer triangles when objects are off camera, because it culls them. 67.js draws all of them (issue 37).
- Heap memory in `skinned-characters`, because three.js clones one parsed file.

**67.js wins:**

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

Both engines use the same geometry, lights and tone curve, so these are small differences. `many-materials` is the largest, because half of its spheres are metal and three.js has only an ambient light, with nothing for metal to reflect. 67.js reflects a constant environment map, so it is the one that has reflections.

The comparison is not exact. 67.js pays for an environment map and an HDR post-processing pass, and three.js does not. A scene with an environment map in three.js costs more than this.

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
