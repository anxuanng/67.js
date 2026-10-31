# Light bake

`67js/addons/light-bake` writes the light that bounces between surfaces into one lightmap texture per part. It is in the current source and not yet published. It is code only: recipes and the MCP tools cannot ask for a bake yet (issue #55).

```js
import { bakeLightmaps } from '67js/addons/light-bake';

const { parts: bakedParts, report } = bakeLightmaps(parts, {
  pointLights: environment.pointLights,
  keyColor: environment.keyColor,
  lightDirection: environment.lightDirection,
}, { samples: 128, bounces: 2 });

const renderer = new Renderer67(canvas, bakedParts, rendererOptions);
```

## What it bakes

The bake traces cosine-weighted paths from each texel through up to `bounces` reflections. Each hit adds its own emission and the direct light it receives from the point lights and the sun, with shadow rays. A texel stores that light times its own albedo. Direct light is not baked: it stays live, so shadows and moving lights keep working. The stored light is only what has bounced at least once, so a scene needs the same lights at run time that it gave the bake.

Not baked: spot lights, area lights, the environment map (it already lights every surface at run time), and specular reflection. A metal part reflects no baked light. Fresnel and sheen are ignored.

## How a part draws it

A baked part is a copy with new geometry and a new material. The geometry gets lightmap UVs from the `uv_unwrap` unwrap in channel 0. The material gets `emissiveMap` (the lightmap, `srgb`, linear filter, clamped), `emissiveColor [1, 1, 1]` and `emission` set to the brightest texel, so the renderer, its shaders and every scene without a bake stay as they are. The input parts are not changed.

The renderer reads one UV channel, so a part that already has texture maps, a pattern, layers, its own emission or transparency is left as it was and listed in `report.skipped` with the reason. Skipped parts still block and reflect light. A skinned or morphing part is skipped too.

## Limits

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `samples` | 128 | 1 to 512 | Paths per texel. |
| `bounces` | 2 | 1 to 4 | Reflections followed by each path. |
| `texelsPerUnit` | 6 | 0.5 to 64 | Lightmap density in world units. |
| `maxResolution` | 128 | 4 to 256 | Largest lightmap side for one part. |
| `maxSeconds` | 60 | 1 to 600 | Wall-clock limit. Passing it throws; a bake never returns a partial result. |

Also checked before any ray is traced: at most 256 parts, 200,000 triangles in total, 8 point lights, 1,000,000 texels and 400 million units of ray work (texels, samples, bounces and lights multiplied). Positions, indices, matrices, colours and lights must be finite and in range, and an error names the field.

The result is deterministic: the same parts, lights and options give the same bytes, with no `Math.random` and no clock in the output. `report.seconds` is the only value that varies from run to run.

## Measured

The `lit-interior` reference scene (25,648 texels at the defaults) bakes in about 6 s in the page on an RTX 3060 machine, running at below-normal priority. Its score against Cycles goes from 0.5055 to 0.1444 with the bake (`npm run reference -- --bake lit-interior`; details in `bench/reference/README.md`). Frame time with and without the bake has not been measured.
