# Path tracer

`67js/addons/path-tracer` draws one still the way an offline renderer does: it follows light paths on the CPU instead of rasterizing. It is in the current source and not yet published. It loads only when a render job asks for it, so a normal scene pays nothing (issue #57).

```js
import { renderPathTracedImage } from '67js/addons/path-tracer';

const { rgba, linear, report } = await renderPathTracedImage(
  { parts, environment, camera },        // the same objects the rasterizer takes
  { width: 960, height: 540, samples: 64, bounces: 8, seed: 0, denoise: true, threads: 4, maxSeconds: 300 },
);
```

From an agent, submit an `image` render job with `settings.renderer` (see [render jobs](agent-render-jobs.md#path-tracer)).

## What it draws

Unidirectional path tracing against the triangle BVH that the [light bake](light-bake.md) uses, with next-event estimation for every light and the environment map drawn by importance, then a wavelet denoiser.

- Surfaces: diffuse, GGX specular with metals, clear coat, glass (`transmission`, `ior`, rough glass), emission, image maps (`map`, with `alphaMode: "mask"` cutouts) and vertex colour. Skinned parts are drawn at their current pose.
- Lights: the sun (`keyColor`, `lightDirection`, as a 1 degree disk), point lights with a radius, spot lights with a soft cone, rectangular area lights, and the environment map with its rotation. All of them cast soft shadows, whatever their `castShadow` says, as in Cycles.
- Light that bounces between surfaces, and the sky seen in mirrors and through glass.

## What it does not draw

`report.ignored` lists the ones this scene asks for.

- Volume fog (`volumeFog`), and the procedural sky when there is no environment map (the sky is black).
- Normal maps, metallic-roughness maps, occlusion maps and emissive maps. Material graphs and patterns are drawn through the colour map they bake.
- Translucent leaves (foliage looks darker than in the rasterizer), liquids, foam and blended transparency (traced as plain or opaque surfaces).
- Lights seen in mirrors (area lights and spot lights are lit but not visible), caustics, subsurface scattering, motion blur, depth of field, bloom and colour grade.
- Multiple-scattering GGX: rough metal is a little darker than in Blender.

## Limits

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `width`, `height` | 960, 540 | 16 to 4096 | Output size, at most 2,073,600 pixels. |
| `samples` | 64 | 1 to 1024 | Paths per pixel. |
| `bounces` | 8 | 1 to 16 | Reflections followed by each path. |
| `seed` | 0 | 0 to 2147483647 | Changes the noise. |
| `threads` | 4 | 1 to 8 | Module workers; the pixels are the same for any count. Without `Worker` it runs on one thread. |
| `maxSeconds` | 300 | 1 to 1800 | Wall-clock limit. Passing it throws; there is never a partial image. |
| `denoise` | true | boolean | Filters the light with normal, depth and noise guides. |
| `fireflyClamp` | 20 | 1 to 1000 | Largest radiance one bounce may add to a sample. |

Also checked before any ray is traced: samples times pixels times bounces at most 4 billion, 400,000 triangles, 1,024 parts, 32 lights, and finite numbers and in-range indices in every part. A render job limits `maxSeconds` to 240 so that it ends before the job deadline.

The same scene and options give the same bytes. Random numbers come from a hash of the pixel, the sample and the seed, never from `Math.random` or the clock, and a pixel does not depend on which thread drew it.

## Choosing CPU

A WebGL2 fragment tracer was not built. The WebGPU decision (issue #56) set no WebGPU backend for now, and a fragment path would need the BVH and every material in textures. The CPU path reuses `src/triangle-bvh.js` and `src/ray-query.js` as they are, runs in the job page next to the scene, and needs no GPU: it measured 25 to 238 seconds for a 960 by 540 still at 32 samples on a Ryzen 5 5600X with four threads, while another session also loaded the machine (table in `bench/reference/README.md`).

## Measured

`npm run reference -- --path-tracer [--samples 32]` draws each reference scene with the tracer and scores it against the Cycles render of the same scene with FLIP (`bench/reference/path-tracer.json`). It leaves `baseline.json` and `images/` alone, and it needs the Cycles renders of an earlier `npm run reference`.

Scores and times are in the table of `bench/reference/README.md`. Cycles used 256 samples with a denoiser, and the tracer 32 samples with its own filter, so the remaining gap is partly noise and partly the differences listed above.
