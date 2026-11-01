# Light bake

`67js/addons/light-bake` writes the light that bounces between surfaces into one lightmap texture per part. It is in the current source and not yet published. Recipes reach it through the `bake` section (see below), so MCP agents can bake without code (issue #55).

```js
import { bakeLightmaps } from '67js/addons/light-bake';

const { parts: bakedParts, report } = bakeLightmaps(parts, {
  pointLights: environment.pointLights,
  keyColor: environment.keyColor,
  lightDirection: environment.lightDirection,
}, { samples: 128, bounces: 2 });

const renderer = new Renderer67(canvas, bakedParts, rendererOptions);
```

## In a recipe

```json
{ "bake": { "preset": "standard" } }
```

`bake` (or the `set-bake` operation, `null` clears it) takes a `preset` and optional `samples`, `bounces` and `texelsPerUnit` that override it:

| Preset | samples | bounces | texelsPerUnit |
| --- | --- | --- | --- |
| `draft` | 32 | 1 | 3 |
| `standard` (default) | 128 | 2 | 6 |
| `fine` | 192 | 2 | 7 |

Ranges are 1 to 256 samples, 1 to 3 bounces and 1 to 12 texels per unit. The bake lights the rest pose with the recipe's point lights and key light (key colour times `keyIntensity`). It runs when the scene builds and again only when a part, its matrix, a light, a material or the bake fields change: camera edits, effects edits, motion seeks and renders reuse the result. A bake that passes its time limit fails the edit and leaves the scene as it was. The limit is 90 s when the bake runs on a worker (the MCP preview does this, so it blocks nothing) and 20 s on the page's own thread when there is no Worker. The preview's call deadline grows by the 90 s for a `scene_create` whose recipe has a `bake` and for a `scene_apply` with `set-bake`; other calls keep 30 s. The same recipe gives the same lightmap bytes. `scene_inspect` returns `bake`: the resolved fields, `used` (the samples, bounces and texelsPerUnit that were traced), `reduced`, `texels`, `rayWork`, `seconds` (of the run that made the lightmaps), `bakedParts`, `skipped` (name and reason) and `reused`.

### Work budget

The unwrap gives the texel count before any ray is traced, so the work of a bake is plain arithmetic: path steps, texels x samples x bounces. It reads no clock and does not depend on machine speed, and the same recipe always resolves to the same numbers. Measured on this machine, a path step costs about 1.8 to 3.1 microseconds, in a closed 56 part room and in the 57 node demo room alike (the number of lights did not change it, so it is not counted).

- A preset (all three fields equal to `draft`, `standard` or `fine`) is scaled down until it fits 5 million path steps: samples by a fifth and texelsPerUnit by a tenth, repeatedly (samples not below 16, texelsPerUnit not below 1). That is 9 to 16 s of tracing on an idle machine, under the 20 s inline limit, and a busy machine still finishes inside the 90 s worker limit. `bake.used` shows the result and `bake.reduced` is `true`. The demo room at `standard` runs at about 64 samples instead of 16 and 2.32 before. A scene that cannot fit even 16 samples at texelsPerUnit 1 fails with a message to remove parts or lights.
- Explicit `samples`, `bounces` or `texelsPerUnit` (any combination that is not exactly a preset) are never reduced. They are limited by a hard bound of 24 million path steps (about 5 times the demo room at samples 96, bounces 2, texelsPerUnit 3, which bakes in 11 to 17 s), and by the real time limit (90 s on a worker, 20 s inline). Over the bound they fail before any ray is traced and the message names what fits, for example "samples 120 or fewer with texelsPerUnit 12, or texelsPerUnit 8.61 or less with samples 256". Under the bound they run, and one that passes its limit fails with "The scene is unchanged. Try samples 128, or texelsPerUnit 3.5." (half of what was asked); the clock decides only that failure, never what is traced.

A node that hosts cloth is skipped like a hair host: the cloth simulation replaces its geometry every frame, so a lightmap built on the rest geometry would not follow it (and the renderer refuses a light map on geometry without `lightUvs`, which failed every frame after t=0). Baked parts read every other material field live, so motion tracks on colour still work; the lightmap itself is fixed at the rest pose.

## What it bakes

The bake traces cosine-weighted paths from each texel through up to `bounces` reflections. Each hit adds its own emission and the direct light it receives from the point lights and the sun, with shadow rays. A texel stores that light times its own albedo. Direct light is not baked: it stays live, so shadows and moving lights keep working. The stored light is only what has bounced at least once, so a scene needs the same lights at run time that it gave the bake.

Spot lights take the cone and soft edge the renderer uses (`angle`, `penumbra`, default 0.15), with `range` and `radius` as for a point light. An area light is a rectangle that emits from its front side only, with the path tracer's `intensity * cosine / distance squared`. A hit is lit by one shadow ray per area light to a point of the rectangle that changes on every call; the sequence is a hash of the call count, so it repeats exactly, and the many paths of a texel average the soft shadow. At most 8 spot and 4 area lights. A scene without spot or area lights bakes the same bytes as before.

Not baked: the environment map (it already lights every surface at run time) and specular reflection. A metal part reflects no baked light. Fresnel and sheen are ignored.

## How a part draws it

A baked part is a copy with new geometry and a new material. A plain part (no maps, pattern, layers or emission) gets lightmap UVs from the `uv_unwrap` unwrap in channel 0, and its material gets `emissiveMap` (the lightmap, `srgb`, linear filter, clamped), `emissiveColor [1, 1, 1]` and `emission` set to the brightest texel, so the renderer, its shaders and every scene without a bake stay as they are. The input parts are not changed.

A part with texture maps, a pattern, layers or its own emission cannot lend its emissive map or its UV channel 0, so it takes the light through the renderer's `lightMap` slot instead. Its geometry keeps `uvs` (the unwrap splits vertices along its seams, and each new vertex copies the `uvs` and `colors` of the vertex it came from) and gains `lightUvs`, the second UV set. The material keeps every field and gains `lightMap` (`srgb`, linear filter, clamped) and `lightMapScale` (the brightest texel). The texture holds the light that arrives, not the light times an albedo, and the fragment shader adds `color * (1 - metallic) * lightMap * lightMapScale` under the existing shading, so the pattern or texture (box projected or UV mapped) tints it at run time. The renderer uploads the two UV sets as one four-wide attribute; the shader branch, the sampler and the uniforms compile out of any scene with no `lightMap`. The bake traces such a part with its colour times the mean colour of its base map, so a brick wall reflects brick coloured light and not white light.

Skipped, with the reason in `report.skipped`: transparent parts, a material tag that draws its own look (water, fire, foliage), skinned or morphing parts, a cloth sheet, and a node that hosts a hair or particle system (its geometry is rebuilt every frame and has no UVs; the recipe bake marks these, which fixed `scene_create` failing with "Textured geometry requires UV channel 0"). Skipped parts still block and reflect light.

GLB export writes `lightUvs` as `TEXCOORD_1` and the light map as the emissive texture on `texCoord` 1, with the base colour factor as `emissiveFactor`. glTF has no light map slot, so a base colour texture does not tint it there: the export is an approximation for viewers, not for reference renders. The path tracer ignores `lightMap` and `emissiveMap` on purpose: it traces indirect light itself, so reading a baked map would count the same light twice.

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

The `lit-interior` reference scene (25,648 texels at the defaults) bakes in about 6 s in the page on an RTX 3060 machine, running at below-normal priority. Its score against Cycles goes from 0.5055 to 0.1444 with the bake (`npm run reference -- --bake lit-interior`; details in `bench/reference/README.md`). Frame time on the same scene (960x540, 4 samples, RTX 3060, below-normal priority, 200 frames read back after each draw, two runs of each in alternating order): median 2.08 and 2.02 ms without the bake, 1.88 and 1.66 ms with it, so the bake costs no measurable draw time (one extra texture read per baked part; the spread between runs is load on the machine). `node bench/reference/frame-time.mjs lit-interior gpu` repeats it. The recipe path on a closed room with 8 boxes bakes 13,184 texels in 4.8 s at `standard`.
