# Reference renders

This suite scores how close a 67js render is to Blender on 21 fixed scenes. Later work uses these scores as its starting point.

## Run it

Run `npm run reference`. It prints one row for each scene, and it rewrites `baseline.json` and `images/`.

The run needs Chrome, Blender 5.2, `uv` and an NVIDIA GPU, and it took 751 s on an RTX 3060 with other jobs on the machine (2026-11-01). Use `--scene <id>` to render one scene, then `--score-only` to score the scenes in the work directory; that also rewrites `baseline.json` with only those scenes. Use `CHROME_PATH` and `BLENDER_PATH` to change the program paths.

CI does not run this suite. `tests/reference-baseline.test.js` checks only that the committed baseline is complete.

## One sun (2026-11-01)

The HDRI holds its own sun: 6 of its 524,288 pixels carry 48.1 percent of the sky light, at 48 degrees of elevation. Most scenes also add a sun light. Cycles and EEVEE therefore drew two shadows of each object, and 67js drew one because its environment casts no shadow. `scenes.js` and `render-blender.py` now cap the image at radiance 16 on both sides, which removes the sun and its halo and keeps the clouds. The sky keeps 49.2 percent of its light. A scene with a sky now has only its own sun light.

`baseline.json` and `images/` use the cap. Scores measured before this date, including the tables and notes below, `khronos.json` and `path-tracer.json`, use the sky with two suns. Scenes with a constant world did not move when the cap went in.

## No shadow floor (2026-11-01)

A key shadow in 67js kept 18 percent of the sun (`src/shaders.js`, `src/cascaded-shadows.js`). A sealed hall was evenly lit, and every shadow was too light. A key shadow now blocks the sun fully. `fog` (+0.0031) and `megacity-dusk` (+0.0044) got worse, and all other scenes stayed level or improved.

Scores against Cycles, with each change in turn:

| Scene | Two suns, floor | One sun, floor | One sun, no floor (now) | EEVEE now |
| --- | --- | --- | --- | --- |
| `outdoor-hdri` | 0.0676 | 0.0466 | 0.0462 | 0.0403 |
| `character` | 0.0995 | 0.0823 | 0.0799 | 0.0622 |
| `glass` | 0.1326 | 0.1033 | 0.1034 | 0.1009 |
| `car-paint` | 0.1521 | 0.1084 | 0.1059 | 0.0844 |
| `brushed-film` | 0.1613 | 0.1172 | 0.1149 | 0.0984 |
| `metal` | 0.1868 | 0.1309 | 0.1294 | 0.0916 |
| `material-spheres` | 0.1598 | 0.1337 | 0.1312 | 0.1053 |
| `foliage` | 0.1594 | 0.1346 | 0.1173 | 0.0888 |
| `brick-flat` | 0.1999 | 0.1273 | 0.1272 | 0.1098 |
| `brick-graph` | 0.2269 | 0.1604 | 0.1602 | 0.1221 |
| `long-street` | 0.1555 | 0.1555 | 0.1407 | 0.0976 |

The mean over the 16 older scenes went from 0.2001 to 0.1751 to 0.1732. EEVEE is at 0.1645.

## Grand scenes (2026-11-01)

Three scenes test what people want to make, not one feature. Each one is built with engine code, and Blender gets the same geometry.

| Scene | Parts | Triangles drawn | 67js against Cycles | EEVEE against Cycles | Largest visible gap |
| --- | --- | --- | --- | --- | --- |
| `megacity-dusk` | 4,300 | 51.6 thousand | 0.1627 | 0.1524 | Window bands are sharper, and facades get no light from the windows |
| `mountain-valley` | 7,698 | 9.72 million | 0.2623 | 0.1879 | The valley floor and the trees are 1.3 to 1.7 times as bright as in Cycles, and shadowed rock is brighter (see "Sky visibility in crowns and valleys") |
| `temple-hall` | 155 | 11 thousand | 0.2126 | 0.2341 | The fog shafts are stronger in 67js, and the floor gets no bounce light |

With the shadow floor `temple-hall` scored 0.5841, `mountain-valley` 0.3658 and `megacity-dusk` 0.1583.

`temple-hall` sets its own `bakeOptions`. The defaults need 1.4 million texels, and the bake allows 1 million. With the options the bake scores 0.2239, against 0.2126 without it.

## Dark spaces (2026-11-01, part of issue #159)

`dark-shaft` is a closed stone room, 11 m by 15 m and 6.5 m high, with one 2.2 m opening in the roof. The sun comes through it as a shaft in `volumeFog` (density 0.07) and lands on the floor and on a plinth with an urn. There is no HDRI, and the world is a constant 0.03, as in `temple-hall`.

A whole-frame score hides a mostly black frame, so a scene can declare `brightRegion: { luminance, dilation }` in `scenes.js`. `score.py` takes the pixels where the Cycles image is brighter than `luminance` in display space (0.1), grows them by `dilation` pixels (4), and also scores the FLIP error inside them: `region-pixels` (share of the frame), `region-gpu-vs-cycles`, `region-gpu-vs-eevee` and `region-eevee-vs-cycles`. Cycles picks the region, so neither renderer under test decides what is scored. `dark-shaft` and `temple-hall` declare one (9.9 and 9.6 percent of the frame); every other column is unchanged.

Gap 2 of the issue, measured: `node bench/reference/run.mjs --scene <id> --skip-blender --ambient 0` draws a scene in 67js with the world's light removed from every surface. In `dark-shaft` the region score goes from 0.2157 to 0.1676 and the whole frame from 0.2321 to 0.2310, so the world light does reach inside the closed room and the walls were lighter than in Cycles. In `temple-hall` the whole frame improves (0.2126 to 0.2028) and the region gets worse (0.2512 to 0.3012): the hall has open roof slots, and the world light is right there. So the leak is real, and removing the world is not the fix.

The fix is in the bake. It already shoots cosine rays from every texel, and a ray that leaves the scene on its first leg has seen the sky. The share of those rays is the sky visibility of the texel, and it costs no extra ray. A part that sees less than 98 percent of the sky on average gets that visibility as an `occlusionMap` (linear, one byte, read through the lightmap UVs), which the shader already multiplies into the world's diffuse light and into its reflections. A part that sees the sky (open scenes, ground) gets no map and draws exactly as before. A part with an `occlusionMap` of its own keeps it. There is no new recipe field and no shader change.

Compared on 2026-11-01 (RTX 3060, 67js side only; Cycles and EEVEE images are the earlier ones):

| Option | `dark-shaft` whole | `dark-shaft` region | `temple-hall` whole | `temple-hall` region |
| --- | --- | --- | --- | --- |
| No bake (committed baseline) | 0.2321 | 0.2157 | 0.2126 | 0.2512 |
| World light off (measurement only) | 0.2310 | 0.1676 | 0.2028 | 0.3012 |
| Screen space occlusion, radius 4 | 0.2203 | 0.2120 | 0.2117 | 0.2521 |
| Bake before this change | 0.2612 | 0.2369 | 0.2239 | 0.2374 |
| Bake with sky visibility | 0.1301 | 0.1710 | 0.1129 | 0.2528 |
| EEVEE | 0.2653 | 0.2643 | 0.2341 | 0.2455 |

Screen space occlusion only darkens creases, so it does not change a room's walls. The bake before this change added bounced light and left the leak, so `dark-shaft` got worse. With sky visibility the whole frame of both scenes roughly halves its distance to Cycles. The shaft region of `temple-hall` did not move (0.2512 to 0.2528): its error is in the fog shafts, which this change leaves alone. `npm run reference -- --bake dark-shaft,temple-hall` draws the baked rows; their sheets are `images/dark-shaft-baked.jpg` and `images/temple-hall-baked.jpg`. The baked rows are not in `baseline.json`, as with the other bake rows. `dark-shaft` bakes 109,904 texels in 12 s and `temple-hall` 440,192 texels in 46 s (`bakeOptions` of the scene, another session loading the machine). Scores in this table are 2 bounces; with the default of 3 bounces from 2026-11-02 the baked rows are 0.0609 and 0.0560 whole frame after the later fog and streak changes (see "Baked rooms and the bounce count").

The no-bake scores of the five outdoor scenes are the same to four digits after a full rescore (`outdoor-hdri` 0.0462, `character` 0.0799, `metal` 0.1294, `car-paint` 0.1059, `foliage` 0.1290), and a scene without a bake runs the same shaders as before. A baked part that sees the sky is unchanged; outdoor scenes were not re-measured with a bake.

Frame cost of a baked room (`node bench/reference/frame-time.mjs dark-shaft gpu`, 960 x 540, RTX 3060 shared with other jobs, so noisy): plain 2.34 and 2.47 ms in two runs, baked with sky visibility 2.98 and 3.86 ms, and the same bake without it 2.04 ms against 2.04 ms plain. So the occlusion map costs roughly 0.6 to 1.4 ms in a closed room on this load; treat it as a measured range, not a figure. Only a baked part that sees under 98 percent of the sky pays it.

## Fog shafts (2026-11-02, part of issue #159)

Gap 3 of the issue, measured on the 67js renders against the Cycles arrays (`volumeFog` in `src/post.js`). The phase function and the units were checked first and are correct: `volumeLightColor` is the sun irradiance, the Henyey-Greenstein term has its 1/4 pi, and the sign of `anisotropy` matches Blender's Volume Scatter, so no tuning constant sits on a bug. Step placement was tried and does not matter: spacing the steps by distance squared moved `dark-shaft` from 0.1292 to 0.1295 and `temple-hall` from 0.2381 to 0.2378, so that change was dropped.

Two errors carry the score:

- **A constant ambient term in a closed room.** The fog adds `ambient` (0.02) everywhere, as if the world lit it. In `dark-shaft` the 67js frame is 0.0125 in linear luminance away from the shaft, where Cycles has 0.002 to 0.006, because a closed room does not see the world. With the fog ambient set to zero the whole frame goes from 0.2321 to 0.1144 and the region from 0.2157 to 0.1728. The ambient now keeps 15 percent of its value where the sun's shadow map says the fog is in shadow, and all of it where the sun reaches the fog.
- **No glow around a bright source.** Cycles scatters the light of bright pixels sideways. Around the lit door of `temple-hall`, the mean linear luminance in a ring 30 to 45 pixels from the door is 0.1055 in Cycles and 0.0373 in 67js (EEVEE 0.0526). The fog now adds a blur of the frame: 24 taps over about 14 percent of the frame height, weighted by the fog's opacity along the ray (`1 - transmittance`) and tinted by the fog colour. The taps are rotated by the same per-pixel jitter as the steps. The same ring now reads 0.0974, and every ring out to 300 pixels is within 0.008 of Cycles. The blur radius and the weight (0.009) are fitted to that profile and to the two region scores; they are not a recipe field.

Scores against Cycles on 2026-11-02, whole frame (shaft region), RTX 3060, 67js side only:

| Scene | No bake before | No bake now | Baked before | Baked now | EEVEE |
| --- | --- | --- | --- | --- | --- |
| `dark-shaft` | 0.2321 (0.2157) | 0.1425 (0.1219) | 0.1301 (0.1710) | 0.0669 (0.1814) | 0.2653 (0.2643) |
| `temple-hall` | 0.2126 (0.2512) | 0.1438 (0.2341) | 0.1129 (0.2528) | 0.0716 (0.2575) | 0.2341 (0.2455) |
| `fog` | 0.2643 | 0.2238 | | | 0.2662 |

The region of `dark-shaft` improved clearly without a bake (0.2157 to 0.1219). The region of `temple-hall` moved less (0.2512 to 0.2341). What is left there is haze outside the shafts, where 67js is 0.0095 and Cycles 0.0033. A higher ambient floor lowers the region score (0.2100 at a floor of 0.4) but raises the region of `dark-shaft` (0.1676) and both whole-frame scores, so one constant cannot serve both scenes. The baked rows improved as a whole frame and got slightly worse in the region (0.1710 to 0.1814, 0.2528 to 0.2575): the bake already darkens the walls, and the fog change takes light from the same pixels. `fog` improved by 0.0405, well inside the limit. Every other scene has the same scores to four digits, and a scene without `volumeFog` runs the same post shader as before.

Cost: `frame-time.mjs dark-shaft gpu`, plain frame, two runs each on a loaded machine: 1.9 and 2.1 ms before, 2.1 and 2.3 ms after, so about 0.1 to 0.3 ms for the 24 extra taps. The core entry grows by 115 bytes gzip (83,853 to 83,968), and six size budgets rose by 50 to 100 bytes because their bundles contain the post shader. `images/dark-shaft-baked.jpg` and `images/temple-hall-baked.jpg` come from `npm run reference -- --bake dark-shaft,temple-hall`.

## Streaks and speckle in dark scenes (2026-11-02, part of issue #159)

FLIP does not punish two defects that show at a glance in the baked frames and around the door of `temple-hall`, so `bench/reference/noise.py` measures them. It takes the display-space luminance of a frame, subtracts a gaussian blur of it (sigma 6 px) and reports the standard deviation of what is left, as a percentage, over two regions chosen from the Cycles image: `dark` (Cycles under 0.1 and more than 12 px from any brighter pixel, where walls, ceiling and floor sit) and `glow` (30 to 60 px from the pixels where Cycles is over 0.5, the ring around the door). Cycles has its own path tracing noise, so its value is the floor a clean render reaches, not zero.

**Bake streaks.** Cause, measured: `planLightmaps` unwrapped each geometry once, at unit size, and gave every part that shares it the same layout. The hall's walls, floor and carpet all share the unit box, so a 2 x 32 x 180 m wall got one square of the lightmap per face, the same as a 2 m cube. The texels were 90 times longer than wide on the wall, 180 times on the floor and 2,867 times on the carpet (up to 5 m long, 0.002 m wide), which draws as streaks that fan out from the vanishing point along every long edge, and as the red lines on the carpet. The unwrap now sees the part at its world size (the length of each matrix column, normals by the inverse transpose), is cached per geometry and scale, and gives texels of equal size both ways (stretch 1.00 on all three parts). A second effect stayed once the streaks were gone: each texel has only 48 rays, so the lightmap was grain. `smoothTexels` now blurs the gathered light and the sky visibility over neighbouring texels (two passes of a gaussian, sigma 1.5 texels, a 7 x 7 window) and counts a neighbour only when it lies on the same plane (normal dot above 0.9, within one texel of this texel's plane), so a corner, a seam and the gap between two parts do not leak. Only fixing the stretch made the metric worse (`temple-hall` baked 0.448 to 0.443, `dark-shaft` baked 0.318 to 0.375) because streaks became fine grain; the smoothing is what lowers it.

**Glow speckle.** Cause, measured: the 24 taps of the fog's glow each read one pixel of the frame, rotated by the per-pixel step jitter, so the sum is a different 24 samples per pixel. Without the jitter the same taps draw ghost copies of the door. Each tap now reads the frame's mip chain at the level that covers the gap between neighbouring taps (`log2(0.7 * radius in pixels)`), with no jitter, so the 24 taps add up to a smooth blur. The renderer builds the mips only for a frame with `volumeFog`, and puts the texture back to a plain linear filter when the fog goes away. The ring profile is kept: the mean display luminance 30 to 45 px from the door is 0.0889 before and 0.0903 after, against 0.1000 in Cycles.

High frequency energy against Cycles (`dark` / `glow`; lower is smoother), 67js render on 2026-11-02:

| Scene | Cycles | Before | After |
| --- | --- | --- | --- |
| `temple-hall` baked | 0.158 / 1.053 | 0.448 / 1.826 | 0.182 / 0.990 |
| `temple-hall` no bake | 0.158 / 1.053 | 0.182 / 1.539 | 0.161 / 0.826 |
| `dark-shaft` baked | 0.140 / 0.140 | 0.318 / 0.643 | 0.150 / 0.310 |
| `dark-shaft` no bake | 0.140 / 0.140 | 0.105 / 0.505 | 0.085 / 0.256 |

Scores against Cycles, whole frame (shaft region), before this change and after:

| Scene | No bake before | No bake now | Baked before | Baked now |
| --- | --- | --- | --- | --- |
| `dark-shaft` | 0.1425 (0.1219) | 0.1430 (0.1273) | 0.0669 (0.1814) | 0.0653 (0.1847) |
| `temple-hall` | 0.1438 (0.2341) | 0.1436 (0.2305) | 0.0716 (0.2575) | 0.0578 (0.2550) |
| `fog` | 0.2238 | 0.2242 | | |

The region of baked `dark-shaft` and of plain `dark-shaft` got a little worse (0.0033 and 0.0054), the cost of a smoother glow. Every scene without `volumeFog` and every unbaked scene keeps its scores to four digits. Baked rooms on the same machine and the same scoring: `lit-interior` 0.1974 before and 0.1915 now, `brick-room` 0.2070 and 0.2048 (the 0.1444 and 0.1515 in the CHANGELOG are not explained by the sun or shadow changes; the sky visibility map exposed the 2 bounce default, see "Baked rooms and the bounce count"). `temple-hall` keeps `bakeOptions` `{ texelsPerUnit: 2, samples: 48, maxSeconds: 300 }`: the bake now has 456,000 texels (440,192 before), under the 1 million limit. Bake time did not change measurably (`temple-hall` 37 to 49 s in the runs of both versions, `dark-shaft` 9 to 13 s, on a loaded machine). `brick-room` has 98,848 texels where it had 28,576, because thin parts no longer share one small square; its bake still takes 3.5 s.

A part's `skyVisibility` in the bake report is now a mean over texels spread by area, so a floor slab reads 0.5 (its top face sees the closed room, its underside sees outside) where every face counted the same before (a slab's four sides then outweighed its top).

Cost: the core entry grows 92 bytes gzip over the fog change (83,968 to 84,060; 207 bytes over the 83,853 before it). `frame-time.mjs dark-shaft gpu`, plain frame on a shared machine: 2.75 and 2.81 ms, where the fog change measured 2.1 and 2.3, so the mip chain costs about 0.5 ms for a frame at 960 x 540 (noisy). Size baseline and budgets were rewritten.

## Baked rooms and the bounce count (2026-11-02, part of issue #159)

After the sky visibility change, `lit-interior` and `brick-room` baked scored 0.1974 and 0.2070 against Cycles, where the code before it scored 0.1444 and 0.1515. The occlusion map is correct: a closed room has no sky to see, and Cycles gives it none. It exposed a different error. The bake followed 2 bounces by default, which cuts off light that a room with walls of albedo 0.7 would still receive, and the world's diffuse light had been filling that gap by accident.

Measured on the baked `lit-interior` (display luminance, whole frame, Cycles 0.4719): 2 bounces with the occlusion map 0.4336 (8.1 percent dark), 2 bounces with the map switched off 0.4532 (4.0 percent dark), so the map removed the 4 percent that was hiding the missing bounces. Every region (floor, walls, back wall, table) was 3 to 12 percent darker than Cycles, none lighter. The map reaches only the world's diffuse light and reflections: the shader adds the light map as a separate term, and a point light is not multiplied by it. Score of `lit-interior` by option, 2026-11-02, RTX 3060:

| Option | `lit-interior` | `brick-room` |
| --- | --- | --- |
| Occlusion map off, 2 bounces | 0.1384 | |
| Occlusion map on, 2 bounces (before this change) | 0.1915 | 0.2048 |
| Occlusion map on, 3 bounces (now the default) | 0.1341 | 0.1412 |
| Occlusion map on, 4 bounces | 0.1092 | 0.1095 |

`bounces` now defaults to 3 in `bakeLightmaps`. A geometric tail for the cut-off bounces (the last bounce's ratio to the one before, summed) was tried and dropped: it overshot and scored 0.2302, 0.2492 and 0.1063 on `lit-interior`, `brick-room` and `dark-shaft`. Recipe presets name their bounces (draft 1, standard 2, fine 2) and are unchanged.

Baked scores against Cycles, whole frame (shaft region), before and after:

| Scene | 2 bounces | 3 bounces |
| --- | --- | --- |
| `lit-interior` | 0.1915 | 0.1341 |
| `brick-room` | 0.2048 | 0.1412 |
| `metal-room` | 0.2232 | 0.1656 |
| `dark-shaft` | 0.0653 (0.1847) | 0.0609 (0.1763) |
| `temple-hall` | 0.0578 (0.2550) | 0.0560 (0.2529) |

Cost: the bake takes more path steps. `temple-hall` 38.9 to 74.9 s, `dark-shaft` 9.0 to 17.5 s, `lit-interior` 4.0 to 5.8 s, `brick-room` 4.3 to 5.2 s, `metal-room` 5.6 to 7.1 s (one run each, shared machine). The frame is unchanged: no shader or bundle code moved. A bake that passes `bounces: 2` keeps the old time and the old light.

## Closed rooms without a bake (2026-11-02, issue #163)

Without a bake, `dark-shaft` scores 0.1430 against Cycles and `temple-hall` 0.1436; with the default bake 0.0609 and 0.0560. An agent that never asks for a bake gets the first pair. Three ways to close the gap were weighed.

| Option | `dark-shaft` | `temple-hall` | Cost | Verdict |
| --- | --- | --- | --- | --- |
| No bake | 0.1430 | 0.1436 | none | the gap |
| Sky visibility alone, no light written, 0.5 texels per unit, 16 samples | 0.1021 | 0.0856 | bake 0.1 s and 0.9 s (1,168 and 102,048 texels) | measured, not shipped |
| Sky visibility alone, 1.5 texels per unit, 16 samples | 0.1026 | 0.0859 | bake 0.2 s and 3.2 s (7,904 and 340,752 texels) | density does not matter |
| Default bake (3 bounces) | 0.0609 | 0.0560 | 17.5 s and 75 s | the target |
| `scene_inspect` names the bake | 0.0609 once the agent adds it | 0.0560 | no frame cost, no schema | shipped |

Sky visibility alone gets about half of the bake's gain (`dark-shaft` 0.1430 to 0.1021 of 0.0821, `temple-hall` 0.1436 to 0.0856 of 0.0876) in a second. It does not shoot light, so the room keeps no bounced light and the sun shaft region gets worse (0.3066 and 0.2660, against 0.1763 and 0.2529 with the bake). `node bench/reference/run.mjs --skip-blender --bake dark-shaft,temple-hall --sky-only 0.5,16` draws these rows; `bakeSkyVisibility` in `src/light-bake.js` is the function. A density of 3 texels per unit with 32 samples was started and stopped on a loaded machine, so it has no number.

Why it is not applied on its own. The agent scene loads its bake code on demand, picked by a text marker (`"bake":{`) in the recipe, and `createAgentScene` is synchronous. A scene that asks for nothing has no marker, so an automatic bake would make every recipe load the ray tracer or add a second detection path before the scene exists. The lifted look would also become a half-fix (0.10, not 0.06) that hides the cheaper full answer from the agent. A new recipe field was not added: an agent that does not know a closed room needs one would not set it.

What ships: a `closed-room-without-bake` diagnostic in `scene_inspect` (`src/closed-room.js`). It shoots 48 fixed rays from the middle of the scene's bounds and counts a hit only on a triangle whose front face looks at the ray, so a solid object around the centre is never a room. At 90 percent or more (the share the automatic reflection probe already uses) and with no `bake` in the recipe, the result carries a warning that names `"bake": { "preset": "standard" }` and `scene_apply set-bake`. Nothing runs per frame: the test runs in `scene_inspect`, is kept until the scene's revision changes, and skips scenes of more than 150,000 triangles. Measured worst case, with no ray hitting anything, is 30 ms at 20,000 triangles and 140 ms at 150,000. A six-slab test room is detected (the reference scenes are drawn in the harness page, so `dark-shaft` itself was not run through it); the same room with its roof removed, a lone box and a recipe with a bake are not (`tests/closed-room.test.js`).

The no-bake scores of every scene are unchanged: no shader, renderer or scene build code moved, and the full rescore after this change matches the committed `baseline.json`. Size: the agent scene entry grows by 884 bytes gzip and `light-bake` by 158; every budget still holds, so none changed. Whether a cold agent follows the existing rule in the skill without the diagnostic was not measured: the suite's tasks each need a reference recipe and checks, which cost more than the $1 the issue allowed.

## Reflections between objects (2026-11-02, issue #167)

A mirror sphere and a steel cylinder showed only the sky and a flat horizon, where Cycles and EEVEE show the floor and the other objects. Parts now take a probe of their own, and `metal` goes from 0.1294 to 0.1036 against Cycles (EEVEE 0.0916). That recovers 68 percent of the gap to EEVEE and does not reach it.

### Where the `metal` error was

FLIP error by region, before the change, on the existing 960 by 540 renders. The regions are discs projected from the object bounds, so a share of each shadow counts toward the object. The renders used here score 0.1336 against Cycles (the committed baseline said 0.1294), so read the columns against each other and not against the table above. Each cell is the region's share of the whole image mean, mean error times the share of pixels.

| Region | Pixels | 67js before | 67js with probes | EEVEE |
| --- | --- | --- | --- | --- |
| Chrome sphere | 5.6% | 0.0184 | 0.0145 | 0.0116 |
| Gold torus | 1.6% | 0.0016 | 0.0016 | 0.0016 |
| Copper box | 9.4% | 0.0307 | 0.0246 | 0.0248 |
| Steel cylinder | 2.8% | 0.0106 | 0.0078 | 0.0055 |
| Floor | 64.2% | 0.0702 | 0.0639 | 0.0565 |
| Sky | 16.5% | 0.0025 | 0.0025 | 0.0016 |
| Whole image | | 0.1336 | 0.1147 | 0.1014 |

The four reflective parts held 46 percent of the error before and 55 percent of the gap to EEVEE (0.0178 of 0.0322). The sphere's lower half showed sky below the horizon, where Cycles shows the grey floor, and the cylinder reflected no lit floor. The floor itself is not a reflector (roughness 0.8). Its remaining gap to EEVEE (0.0074 after the change, 0.0137 before) is indirect light and shadow softness, which a reflection does not change.

### Options

| Option | What it costs per frame | Score on `metal` | Status |
| --- | --- | --- | --- |
| One probe per reflective part, traced without that part | 1.51 ms plain against 1.58 ms with four probes (RTX 3060, medians of three alternating rounds of 200 frames; the spread between rounds was about 0.2 ms). A scene with no reflective part draws the same frame: no wrapper, no shader change. Once: a CPU trace of 128 by 64 texels per probe and a GPU prefilter on the first draw. | 0.1294 to 0.1036 | Built |
| Screen-space reflections | Not built. Inferred: a depth and colour pass before the reflective parts and a ray march for each reflective pixel, paid only by scenes with smooth metal. It shows only what is on screen, so the floor behind the camera and the back of an object stay missing. | not measured | Not built |
| Planar reflection for flat floors | Not built. A second scene draw for each mirror plane. The `metal` floor is rough, so it has nothing to reflect, and the `metal-room` floor is the only case here. | not measured | Not built |

A probe at the middle of the object and traced without it is the only option the code already supports, it costs no frame in a plain scene, and it gives a Cycles-like reflection of the floor and of other parts up to one bounce of direct light. A first version with one bounce had speckle on the floor (16 samples) and scored 0.1250 on the analysis renders; with no bounce and the sky's diffuse light added to each hit, it scored 0.1147. A first version without the sky light made the floor in the reflection black and scored 0.1457, worse than no probe (0.1336).

### What it does

`traceObjectProbes(parts, lighting, options)` in `src/probe-trace.js` finds the parts with `metallic` of at least 0.5 and `roughness` of at most 0.6, traces one 128 by 64 map at the middle of each one's bounds with that part left out, and returns the same shape as `traceProbes` plus the index of the part. `placeProbes` gives each such part its own probe. More than 8 reflective parts (lamp posts, spires) get none, because they read as shapes and not as mirrors. A trace shades a hit with the direct light, the part's colour (half the colour for metal) and the environment map's diffuse light. A ray that misses reads the environment map.

`npm run reference -- --object-probes [<id>,<id>]` places these probes on the named scenes (every scene when no ids follow). It is opt in, like `--bake` and `--probes`, and the committed `baseline.json` and `images/` are the default run without it (`metal` 0.1294 again, confirmed on 2026-11-02). The scores below are from a full run with the flag. There is no recipe field: a recipe scene does not place object probes yet, because the recipe path has no map of the sky to light the floor in the reflection (the procedural sky is a colour gradient), and that is the next piece of work.

### Scores against Cycles with `--object-probes` (GPU, full rescore, 2026-11-02)

| Scene | Before | After | EEVEE |
| --- | --- | --- | --- |
| `metal` | 0.1294 | 0.1036 | 0.0916 |
| `car-paint` | 0.1059 | 0.1038 | 0.0844 |
| `brushed-film` | 0.1149 | 0.1029 | 0.0984 |
| `material-spheres` | 0.1312 | 0.1293 | 0.1053 |
| `metal-room` | 0.5128 | 0.5076 | 0.5262 |

Every other scene scored the same to four digits, GPU and CPU. `car-paint` has one reflective part, so it gains little: the clearcoat sphere reflects the floor and nothing else. The issue's second box holds (no frame cost without a reflective part); its first box does not (`metal` is 0.012 above EEVEE).

## Baseline

Measured on 2026-10-30 with an RTX 3060, SwiftShader and Blender 5.2.2. The metric is [FLIP](https://github.com/NVlabs/flip) for LDR images: 0 means identical, and a higher score means a larger visible difference.

| Scene | 67js against Cycles | EEVEE against Cycles | 67js against EEVEE | Largest visible gap against Cycles |
| --- | --- | --- | --- | --- |
| `outdoor-hdri` | 0.0676 | 0.0383 | 0.0520 | Soft shadow contact, and a darker ball base |
| `character` | 0.0995 | 0.0740 | 0.0833 | No contact shadow from the environment light |
| `glass` | 0.1450 | 0.1150 | 0.1469 | The sphere does not bend the view or reflect the sky |
| `foliage` | 0.1594 | 0.0783 | 0.1386 | Bright leaves from a built-in translucency trick |
| `material-spheres` | 0.1598 | 0.1006 | 0.1196 | No reflection between objects, and light shadows |
| `metal` | 0.1868 | 0.0934 | 0.1565 | No reflection between objects |
| `fog` | 0.2612 | 0.2662 | 0.0542 | No multiple scattering |
| `lit-interior` | 0.4997 | 0.5159 | 0.1204 | No indirect light, and point lights cast no shadows |
| `spot-area` | 0.1242 | 0.1935 | 0.1707 | The sphere is lit more weakly at its shaded edge, and the wall has no bounce light |
| `brick-graph` | 0.2269 | 0.1440 | 0.1480 | Bump is stronger than Blender's Bump node (measured 2026-11-01, see below; an earlier note said weaker), and Blender's noise is not 67js noise, so brick tone differs |
| `brushed-film` | 0.1613 | 0.0939 | 0.1601 | The film colours on the dark sphere are close to Cycles, but its reflections are softer; the brushed highlight is pinched less at the pole, and there is no ground bounce under the spheres |

Rows are the baseline taken before shadows for point lights. The `lit-interior` scene now sets `castShadow` on its three point lights. With shadows, 67js scores 0.5055 against Cycles (0.4997 before, so 0.0058 worse) and 0.0923 against EEVEE (0.1204 before, better): the shadow shape now matches, but Cycles fills its shadows with indirect light and 67js leaves them dark. The committed `lit-interior` row stays at the earlier numbers. `spot-area` is new with shadows, a spot light and an area light.

Light bake (issue #55): `npm run reference -- --bake lit-interior` bakes bounced light into the room with `addons/light-bake` (defaults: 128 samples, 3 bounces since 2026-11-02, 25,648 texels, about 6 s on this machine) and leaves the scene itself unchanged; Blender still gets the plain scene. Measured 2026-10-31 on the RTX 3060: `lit-interior` against Cycles goes from 0.5055 to 0.1444 (SwiftShader 0.5051 to 0.1439), and against EEVEE from 0.0923 to 0.4739, because EEVEE has no indirect light here and the bake adds it. No other scene moved by more than 0.002 (the largest change was 0.0001, `car-paint` against EEVEE). The committed baseline rows and images are not rewritten. The remaining gap shows in the FLIP image as faint blotches on the walls, which is bake noise at 128 samples; at 48 samples the blotches were plain to see and the score was 0.1688.

`long-street` and `light-linking` (issue #52) were added on 2026-11-01. `long-street` is a 140 m street under the sun with 24 buildings, 14 lamp posts and four cars near the camera; one 2048 x 2048 sun map covers 170 m, so its texels are 8 cm wide. Against Cycles it scores 0.1555 with one map and 0.1398 with three cascades (`npm run reference -- --cascades 3`; SwiftShader 0.1554 and 0.1399; against EEVEE 0.1396 and 0.1147; EEVEE against Cycles 0.0975). Frame time on the RTX 3060 (960x540, 4 samples, 200 frames read back, median of two runs of each, `node bench/reference/frame-time.mjs long-street gpu --cascades`): 1.04 ms with one map and a still camera, 1.02 ms with a camera that moves every frame, 1.09 ms with three cascades and a still camera, 1.24 ms with three cascades and a moving camera, so the cascades cost about 0.2 ms (20 percent) in a camera move and next to nothing while the camera is still. On SwiftShader (median, `cpu`): 241 ms, 240 ms, 282 ms and 299 ms, so +17 percent still and +25 percent moving, because the cascade lookup is 36 texture fetches per pixel and the depth passes run on the CPU. The cascades earn their cost where a shadow has to be sharp near the camera and long at the same time; a scene that fits one map in a few metres gains nothing and should not use them. The remaining gap in `long-street` is Cycles' sky and bounce light, not the shadows. `light-linking` has three point lights that each light only some parts (`affects` lists); it scores 0.0998 against Cycles, with the same lists given to Blender as receiver collections. Every scene that existed before kept its score to four digits (`lit-interior` is still 0.5055 against Cycles, 0.0923 against EEVEE), and the committed images of those scenes are unchanged.

`brick-room` (issue #128) is a closed room built from a recipe (`createAgentScene`) with three brick pattern walls, two point lights and a table with a vase. Blender gets the box projection as UVs (`boxProjectedGeometry`) and the baked brick map, but not the bump or the roughness map. Measured 2026-11-01 on the RTX 3060: against Cycles 0.5102 without the bake and 0.1515 with it (`npm run reference -- --bake brick-room`; SwiftShader 0.5096 and 0.1503; EEVEE against Cycles 0.5020); the bake took 14.4 s for 28,576 texels while another session loaded the machine. `lit-interior` stayed at 0.1444 with the bake, and every scene without a bake kept its earlier score to four digits (largest change 0.0000).

`brick-graph` (issue #50) is a wall of bricks written as one material graph (triangle waves for the joints, half a brick of shift on every second course, noise through a colour ramp, height as bump) on a quad with UVs, so it uses `mapping: "uv"`. `render-blender.py` translates the same graph JSON into Blender nodes (Math, Map Range, Noise Texture, Color Ramp, Mix and Bump), so each side evaluates its own nodes. It measured 0.2269 against Cycles and 0.1440 for EEVEE on 2026-10-31. A first run scored 0.4027 and showed a black wall in 67js: the `min` and `max` nodes returned NaN. The scene found that bug. The other rows were re-measured in the same run; `glass` against Cycles moved from 0.1450 to 0.1326 and `lit-interior` to the with-shadows numbers described above, and no other score moved by more than 0.002.

`brushed-film` (issue #51) holds a brushed gold sphere (`anisotropy` 0.8), a dark sphere with a thin film (`iridescence`, IOR 1.3, 400 nm) and a silver sphere with the same film. `render-blender.py` maps the glTF anisotropy model onto Blender's aspect ratio (alpha along the tangent is `mix(alpha, 1, strength^2)`, so Blender gets Anisotropic = (1 - alpha / alpha_tangent) / 0.9 and the geometric-mean roughness) and feeds a UV-map Tangent node, because Blender's default tangent is a different field: with the default tangent the first run scored 0.1673 against Cycles and the highlight ran in rings where 67js had bands; with the UV tangent it scores 0.1613 and the highlight direction matches. Thin film goes to Principled Thin Film Thickness and IOR. EEVEE draws no thin film, so its sphere stays black. The two models are not the same: Blender's film is its own Fresnel integration, 67js uses Belcour and Barla at the view angle, so match the colours by eye in the image, not by the score alone. Measured 2026-11-01 on the RTX 3060 and SwiftShader. Before and after adding anisotropy and iridescence, every older scene scored the same against Cycles and EEVEE to four digits (largest change 0.0000, limit 0.002), because their shaders compile the two layers out.

`metal-room` (issue #55) is the `lit-interior` room with a mirror sphere, a gold sphere and a glossy floor, to show what reflection probes do: 0.5128 against Cycles without a probe and 0.4520 with one (`npm run reference -- --skip-blender --probes metal-room`; with `--bake` the score is 0.1754 without a probe and 0.1537 with one). `--probes [ids]` adds probes to the named scenes; open scenes use a hand placed probe from `PROBE_SPECIFICATIONS` in `harness.js`, and score worse (`metal` 0.1868 to 0.2246, `material-spheres` 0.1598 to 0.1740). Every scene without a probe re-scored within 0.0001 of its earlier baseline (a full rerun on 2026-11-01 matched the committed `baseline.json` exactly). With `--bake`, adding `--probes` lowers the score in the three rooms: `lit-interior` 0.1444 to 0.1213, `brick-room` 0.1515 to 0.1266, `metal-room` 0.1754 to 0.1537. `--scene` renders one scene and does not rescore. `node bench/reference/frame-time.mjs lit-interior gpu` prints medians of three rounds: 1.73 ms plain, 1.90 ms baked, 2.04 ms baked with a probe (RTX 3060, 2026-11-01), against 106.7 s for the path tracer in `path-tracer.json`.

The mean against Cycles is 0.198 for 67js and 0.160 for EEVEE. The mean difference between the RTX 3060 and SwiftShader is 0.007.

EEVEE against Cycles is a yardstick: it shows what a good rasterizer scores. In `lit-interior` and `fog`, EEVEE scores no better than 67js. Those two scenes depend on indirect light, and this suite does not use EEVEE light probes. A low score does not mean a good picture on its own, so read each score with its image in `images/`.

`baseline.json` also holds the scores for SwiftShader and each render time in Blender.

## How the two sides stay comparable

- **Geometry:** `scenes.js` builds each scene with the engine's code, and `harness.js` hands the same vertices, normals and textures to Blender. This replaces GLB, because GLB export can not write textures yet (issue #49).
- **Character:** Blender's glTF importer does not reproduce the rest pose of `RobotExpressive.glb`. three.js and 67js agree on that pose. So `harness.js` skins the vertices first, and Blender gets the result as plain geometry.
- **Lights:** a measurement on a white plane gave the units. Sun strength equals irradiance in both. A Blender point light has 4π watts for each unit of 67js intensity.
- **Environment:** the same HDRI at the same rotation. The clouds line up in the images.
- **Display:** Blender writes linear pixels, and `score.py` applies the tone curve and gamma from `src/post.js`. Both sides then use one display transform.
- **Lighting tricks:** the 67js fill lights are off. All light comes from the sun, the environment and point lights.

Khronos sample assets (issue #51): `npm run reference -- --khronos` draws files from [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) that you download by hand into `artifacts/khronos/<name>/<name>.glb` (gitignored; nothing is committed). Blender imports the same GLB with its own importer, so Cycles is the reference for the file and not for our reading of it. The run uses its own work directory and writes `khronos.json` and `images/khronos-<name>.jpg`; `baseline.json` stays as it is. The sky fills most of each frame and both sides draw it alike, so the whole-frame FLIP score is about 0.05 for every asset and says little. The `asset-` columns score only the pixels the asset changes (a second render of the empty sky decides which, threshold 0.03). Licences, checked in each model's `LICENSE.md`: ClearCoatTest and AnisotropyBarnLamp are CC BY 4.0 (Analytical Graphics, Inc. and Wayfair, LLC), TransmissionTest, AnisotropyDiscTest and SheenChair are CC0 1.0 (SheenChair's model files are CC0; only its metadata files are CC BY 4.0). Measured 2026-11-01 on the RTX 3060 (SwiftShader within 0.0004 on the whole frame):

| Asset | Pixels covered | 67js against Cycles (asset only) | 67js against EEVEE | EEVEE against Cycles | What differs |
| --- | --- | --- | --- | --- | --- |
| `ClearCoatTest` | 0.1353 | 0.2306 (was 0.2344) | 0.1808 | 0.1335 | The coat, coat roughness and coat normal textures are read; most of the gap is outside the coat |
| `TransmissionTest` | 0.1356 | 0.2708 | 0.2371 | 0.1656 | Refraction through the front surface only, no roughness-blurred background |
| `AnisotropyDiscTest` | 0.1074 | 0.2808 (was 0.3481) | 0.2772 | 0.1534 | `anisotropyTexture` is read: the disc pattern now draws, but the tiles are darker than Cycles; 0.2773 with anisotropy switched off |
| `AnisotropyBarnLamp` | 0.0733 | 0.3584 (was 0.4758) | 0.4318 | 0.3765 | `anisotropyTexture` and the coat normal texture are read, and it now scores better than anisotropy switched off (0.3945) |
| `SheenChair` | 0.1007 | 0.3745 | 0.3374 | 0.2384 | New. Cycles shows a bright red velvet rim along the top of the backrest and a more saturated orange; 67js draws the same shape and tufting but flatter, paler and with only a faint rim, so the error is a band along that edge and the seat front |

Reading `anisotropyTexture` (strength in blue, direction in red and green) fixed the shade: the factor alone spread a highlight over everything, and it scored worse than no anisotropy. The disc test is still level with anisotropy switched off, so the remaining gap there is not the texture. `TransmissionTest` is unchanged at 0.2708: its `transmissionTexture` is not read, because transmission draws in the liquid pass, which has no feature code, and the scores do not show that the other slots (iridescence, specular) matter. `SheenChair` is scored since the importer accepts a normal map with its own `KHR_texture_transform` scale and offset: the fabric tiles its base color 7 times and its normal map 2 times, so the importer bakes the base color transform into the UVs and the shader applies the normal map's remainder (`normalMapTransform`, outside core; core grew by 25 bytes gzip). The score does not say that the transform is right: the visible gap is the sheen rim, and why it is weaker was not investigated. Both Blender's engines disagree on the lamp by 0.3761, so part of that gap is Blender's own anisotropy and clear coat. Two importer bugs the assets found are fixed: `KHR_xmp` and `KHR_xmp_json_ld` (metadata) stopped the whole import, and `KHR_materials_variants` is now accepted with a warning and draws the default material.

`brick-flat` is the control for `brick-graph` (issue #50): the same wall and light in the average colour of the graph, with no maps. Measured 2026-11-01 it scores 0.1999 against Cycles (0.1119 against EEVEE, EEVEE against Cycles 0.1351), and `brick-graph` 0.2269 (0.1480), so by this baseline the graph does not score above it: the picture is more like Cycles in kind but FLIP punishes the misplaced bevel highlights and the tone differences of noise more than it rewards the brick pattern. The bump of `brick-graph` is not weaker than Blender's. In a profile across one brick edge (columns 365 to 420, rows 150 to 215 of the render) the dark side of the bevel is the same in both (about 0.25 below the wall), and the bright side is about 0.3 above the wall in 67js against 0.17 in Cycles; the luminance spread over the brick area is 0.132 against 0.109 (EEVEE 0.109), and the edges fall on the same rows. Turning the bump down only lowers the score: 0.2065 with a bump of 0.01, 0.2209 at 0.5, 0.2247 at 0.75 and 0.2269 at 1 against Cycles. So the earlier note, that bump is weaker, was wrong. The rim of 67js is brighter because it keeps the full slope of the steep joint edge; the flat wall brightness is also 0.07 lower than Cycles, which has indirect light from the floor (EEVEE matches 67js there).

Where the `brick-graph` gap comes from (issue #50, measured 2026-11-01 on the RTX 3060 with temporary scene variants that are not committed; both sides were changed the same way for each row, the flat wall of each row is the average colour of that row's graph, 512 texels). Against Cycles, FLIP, lower is better:

| Variant | 67js against Cycles | EEVEE against Cycles |
| --- | --- | --- |
| flat wall (`brick-flat`) | 0.1999 | 0.1351 |
| graph colour only | 0.2108 | 0.1432 |
| graph bump only (flat colour) | 0.2226 | 0.1401 |
| full graph (`brick-graph`) | 0.2269 | 0.1440 |
| full graph, noise node replaced by 0.5 | 0.2270 | 0.1438 |
| graph colour only, no noise | 0.2098 | 0.1427 |
| flat wall, no noise | 0.1998 | 0.1350 |

Noise contributes nothing (0.2269 against 0.2270 without it), so the different noise function is not part of the gap. Colour structure alone adds 0.010 and the bump alone adds 0.023, and the two overlap. EEVEE, which reads the same node graph and the same Bump node, is also 0.009 above its own flat wall (0.1440 against 0.1351), so the condition that a graph must score no worse than a flat wall against Cycles can not be met by an independent renderer either: FLIP counts any misplaced fine structure against a flat wall that has none. What is left over 67js is 0.083 above EEVEE's own distance to Cycles for the graph and 0.065 for the flat wall. Blender's Bump node takes a one-sided slope over a footprint of 0.1 pixel (the node's Filter Width), so the bright side of a joint is thin and faint in Cycles, while 67js reads a central difference over two texels, which gives both sides a band. Setting Filter Width to 1 pixel lowered `brick-graph` to 0.2232 and 2 pixels to 0.2208, but the second one raised the EEVEE score from 0.1480 to 0.1565, so it moved the sides apart as much as it moved them together and the harness keeps the default. A 1024 texel bake of the bump only variant scored 0.2140 against 0.2184 at 512 (Filter Width 1), but the full graph is over the 30,000,000 work limit at 1024, so the scene stays at 512. With bounced light baked into the wall and floor (`--bake`, which removes the indirect light difference) `brick-flat` scores 0.1531 and `brick-graph` 0.1892, so the gap does not come from the missing indirect light either. No engine defect was found: the slope of the bake matches Blender's Bump node on distance (0.15 is the geometric mean of 6/32 and 4/32 for the 6 by 4 wall, since a texel slope is per UV unit), the sign and the colour space are the same on both sides. The condition stays open; a fair measure to report next to the raw score is the excess over EEVEE's distance to Cycles on the same scene (0.0829 for `brick-graph`, 0.0648 for `brick-flat`), never in place of it.

## Cloth

`npm run reference -- --cloth` draws a pinned banner in wind (1 and 2 s) and a sheet dropped on a ball (0.5, 1 and 2 s). 67js bakes the sheet with its own solver; Blender bakes the same 13 by 13 grid with its cloth modifier from rest to the same time, stepping every frame, and renders that mesh in Cycles and EEVEE. Scores go to `cloth.json` and `images/cloth-*.jpg`, as FLIP over the whole frame and over the pixels the scene covers (`asset-*`, sky left out). Both solvers get the same mass (0.2 kg/m2, so 0.2 times the sheet area over 169 particles in Blender), gravity and drag; stiffness and bend stay at each side's defaults, because position based stiffness and Blender's tension, compression, shear and bending do not map one to one.

| Scene | 67js against Cycles | EEVEE against Cycles | 67js, covered pixels | EEVEE, covered pixels |
| --- | --- | --- | --- | --- |
| banner 1 s | 0.0428 | 0.0418 | 0.0713 | 0.0729 |
| banner 2 s | 0.0440 | 0.0426 | 0.0689 | 0.0709 |
| drape 0.5 s | 0.0804 | 0.0433 | 0.1012 | 0.0570 |
| drape 1 s | 0.0932 | 0.0394 | 0.1157 | 0.0514 |
| drape 2 s | 0.0909 | 0.0428 | 0.1114 | 0.0555 |

The two solvers differ in kind, so this mostly scores how alike the motion is. The banner sits at the EEVEE yardstick, which is a weak test: a flat sheet leaning in the wind has few pixels to get wrong. By eye the banner differs in shape: Blender's sheet wrinkles and sags along the bottom edge, 67js stays smooth and flat. The drape is about twice the yardstick: Blender's sheet has landed on the ball as a bell with wrinkles and its corners still up, while 67js has pulled its corners down and hangs flat panels on both sides of the ball. Wind is matched by the steady swing of the banner (Blender field strength 2 is 1.5 m/s here), because Blender's wind is a linear drag and this solver's is quadratic. The drape numbers also moved when the drag was matched: see "Recipe cloth" in `docs/physics.md`.

## Leaf model and tree regions (issue #166)

Before this change the Blender leaf was a plain Principled BSDF, while the 67js foliage shader (`CANOPY_TAG` in `src/shaders.js`) is not. `render-blender.py` now rebuilds each term of that shader on the Blender side, with the shader's own constants, for every material tagged `foliage`:

| 67js foliage term | Blender node setup |
| --- | --- |
| Back faces keep the stored normal | Geometry normal times `1 - 2 * Backfacing` undoes Blender's flip |
| Colour times `0.78 + 0.16 * sin(13 x + sin(9 y)) * sin(11 z - 5 y)` of the world position | The same sines on Geometry position, multiplied into the base colour |
| Normal moved by `0.06 * (sin(12 z), sin(9 x), cos(11 y))`, then normalised | The same vector in Blender axes, on the Principled and Translucent normals |
| Sky reflection 0.3 of a dielectric's | Specular IOR Level 0.5 * 0.3 |
| Light from behind: `colour * max(dot(-N, L), 0) * 0.3 * keyColor / (3.7, 3.4, 2.9)` | Translucent BSDF with colour weight `0.3 * pi / (3.7, 3.4, 2.9)`, which returns the same radiance for a sun of irradiance `keyColor`, added to the Principled BSDF |
| Alpha mask at 0.5 | Mix Shader with a Transparent BSDF, so the Translucent part is cut out too |

The weights are derived from the shader, not tuned. One difference stays: the 67js term was not shadowed, and the Blender Translucent BSDF is. The 67js term now multiplies by the sun shadow `visibility` as well (a leaf can only pass sun that reaches it), which is the one engine change of this issue. It moved `foliage` from 0.1181 to 0.1173; on its own the shader change is small.

Scores before and after (FLIP against Cycles, RTX 3060, 2026-11-02), with EEVEE against Cycles beside them:

| Scene | Before | Fair leaf, old shader | After | EEVEE |
| --- | --- | --- | --- | --- |
| `foliage` | 0.1290 | 0.1181 | 0.1173 | 0.0864 before, 0.0888 after |
| `mountain-valley` | 0.3473 | 0.3485 | 0.3483 | 0.1828 before, 0.1879 after |

The fair leaf alone moved `foliage` by 0.0109 (the Cycles crown got brighter, from 0.135 to 0.176 mean display luminance) and `mountain-valley` by 0.001: the leaf model was never the main gap there. No other scene changed to four digits in the full rescore.

Regions, measured on the Cycles image (display luminance, mean of the region; FLIP is the mean error of 67js against Cycles):

| Scene and region | Cycles | EEVEE | 67js | FLIP 67js | Share of the error |
| --- | --- | --- | --- | --- | --- |
| `foliage` crown (green, upper rows) | 0.176 | 0.229 | 0.300 | 0.472 | 0.37 |
| `foliage` trunk and ground under the tree | 0.139 | 0.191 | 0.208 | 0.313 | 0.02 |
| `foliage` open ground and sky | 0.689 to 0.793 | the same | the same to 0.01 | 0.03 to 0.14 | 0.55 |
| `mountain-valley` trees (green) | 0.186 | 0.225 | 0.335 | 0.481 | 0.53 |
| `mountain-valley` valley floor, rows 440 to 530 | 0.272 | 0.306 | 0.416 | about 0.5 | |

What the experiments show, each with the flags of this runner:

- `foliage` crown with `--ambient 0` (sun and shading only): 67js 0.176, the same as the whole Cycles crown. So the sun term alone is already as bright as Cycles, and the sky term adds 0.12 on top. Cycles loses most of the sky inside a dense crown to the leaves around each card; 67js has no occlusion in the ambient term, only vertex colours that darken from the crown centre. Screen space occlusion (`--ambient-occlusion 1 --ambient-occlusion-radius 1`) takes `foliage` from 0.1181 to 0.1133 and the crown to 0.283, which is not enough to close the gap. The remaining gap is recorded, not fixed: it needs occlusion between cards, which is the light bake's job (`addons/light-bake`) and is not part of a shader.
- `mountain-valley` floor with `--ambient 0`: 67js 0.180, against 0.272 for the full Cycles frame. The valley floor sits inside a ring of 1,100 m peaks that hide much of the sky in Cycles, and 67js lights the floor with the whole sky. This is inferred from the ring geometry and from the floor matching on the open `foliage` scene (0.698 against 0.689); it was not measured by removing the mountains. It is the main reason the trees there are lighter than in Cycles too. Fixing it needs sky visibility for terrain, which no shader has.
- Ground under the `foliage` tree: the floor is within 0.01 luminance of Cycles, and FLIP is worst in a band of 0.2 to 0.5 at the canopy rows, not at the trunk base. The trunk and its contact shadow are 2% of the error.

Blender render time of the two rerun scenes, now in `baseline.json`: `foliage` 26.4 s in Cycles and 13.5 s in EEVEE, `mountain-valley` 35.9 s and 39.2 s (other jobs loaded the machine).

### Sky visibility in crowns and valleys (issue #191)

The two experiments above point at the same missing term: sky light that reaches a surface which the scene itself shades. Cycles blocks that light and 67js did not. Two bakes now give the sky term a visibility, and no recipe field changes.

Causes, each measured on its own:

- Crown. With `--ambient 0` the 67js crown is 0.176, the same as the whole Cycles crown (0.175). The 0.12 the world adds in 67js (0.298 in total) is therefore sky light that Cycles stops inside the crown.
- Valley floor, from the heightfield. A script walked 32 horizon directions from 6 floor points of the `mountain-valley` height function and computed the cosine weighted share of the sky above the horizon. The ring leaves 0.69 to 0.72 of the sky open. Without the ring the share is 0.995 to 0.999. Cycles was not rerun without the ring.
- The valley sky term is 0.416 minus 0.180 = 0.236 in 67js, and 0.272 minus 0.180 = 0.092 in Cycles, which needs a share of 0.39. The ring explains the larger part of the gap. The estimate 0.18 + 0.7 * 0.236 = 0.345 is close to the measured result below (0.360). The rest is not explained: the sky of the HDRI is brightest near the horizon, which the ring hides, and a cosine share cannot see that.

What changed:

- `createTree` gives each foliage vertex a `skyVisibility` (`src/tree-sky.js`). The leaf vertices are binned in a grid of 14 cells along the longest side. For each occupied cell, 9 rays go up (1 zenith, 4 at 40 degrees, 4 at 65 degrees) and add the leaf density they cross. The cell keeps the mean of `exp(-depth)`, with a floor of 0.04. The opacity of one leaf vertex, 0.3, is the one fitted number: it was set on the `foliage` crown and not on `mountain-valley`. A level with fewer leaves counts each vertex for more, so the three levels agree.
- `createTerrain` gives each terrain vertex a `skyVisibility` (`src/terrain-sky.js`). For 16 azimuths it marches the heightfield outward in growing steps, keeps the highest horizon, and integrates the cosine weighted sky above it for the tilted surface normal. It samples a lattice of at most 160 nodes per side and interpolates, so the cost does not grow with the grid.
- The value travels in the fourth component of the vertex colour attribute, so the attribute layout is the same. The shader multiplies it into `occlusion` (which scales the environment light) and into the two fill lights in world mode. Direct lights are not touched. A mesh without the value reads 1.
- The tree value is computed on first read, which is when the renderer uploads the geometry. The terrain value is computed per chunk when the chunk is built.

Results (FLIP against Cycles, RTX 3060, 2026-11-02), with EEVEE against Cycles beside them. Region luminance is the mean display luminance of the region, taken on the Cycles image:

| Scene and region | Cycles | EEVEE | 67js before | 67js after |
| --- | --- | --- | --- | --- |
| `foliage` score | - | 0.0888 | 0.1173 | 0.1023 |
| `foliage` crown | 0.175 | 0.227 | 0.298 | 0.200 |
| `mountain-valley` score | - | 0.1879 | 0.3483 | 0.2623 |
| `mountain-valley` floor, rows 440 to 530 | 0.272 | 0.306 | 0.417 | 0.360 |
| `mountain-valley` trees (green) | 0.151 | 0.193 | 0.312 | 0.254 |

The `foliage` crown is now within 0.03 of Cycles, but the scene still scores worse than EEVEE: with the opacity at 0.12 the score was 0.1033 and the crown 0.226, so the rest of the crown error is leaf shape and placement, not sky. The valley trees stop at 0.254 because a conifer crown is already at the visibility floor, and a tree in the valley does not see the ring. The score against EEVEE of `mountain-valley` rose from 0.2382 to 0.2971, since EEVEE does not hide the sky either. No other scene changed to four digits in the full rescore, and the plain frame time of `material-spheres` did not change beyond the noise of a loaded machine (median 1.18 ms before, 1.0 ms after over 4 alternating runs).

Build time, on this machine with other jobs running: a 5 km valley terrain adds about 0.2 to 0.35 s (1.7 to 2.2 s before). A conifer crown costs about 4 ms and a broadleaf crown 6 ms for three levels, so the 3 variants of the valley forest add about 15 ms, and a forest of 3,600 distinct trees would add about 15 to 20 s only if every tree is drawn, since the value is lazy.

## Limits

- Scores come from one camera for each scene and one machine. They do not measure motion or speed.
- This suite sets an HDRI from code and leaves occlusion off; `--ambient-occlusion <strength> [--ambient-occlusion-radius <units>]` turns it on. A recipe reaches only the named procedural setups, so these scores still describe a better environment than an agent gets (issue #53).
- Both sides use the same leaf model since issue #166 (see "Leaf model and tree regions"). Grass has its own extra term in the 67js shader (`TAG_GRASS`), and Blender does not get it; no reference scene draws grass cards.
- `render-blender.py` does not read normal maps. No scene uses one yet, so a new scene with a normal map must add that first.
- `glass` and `car-paint` use the real 67js `transmission` and `clearcoat` layers, and the Blender side sets the same values on the Principled BSDF. 67js refracts through the front surface only, so the sphere does not show the inverted sky that Cycles traces through the back face.
- `car-paint` scored 0.1521 against Cycles and `glass` 0.1326 (it was 0.1450 with the `liquid` material). The other scenes scored the same as in the table above, to four digits. The table above is the 2026-10-30 baseline and has not been rewritten.
- `fog` has no noise on either side. EEVEE and 67js approximate scattering, and Cycles follows 8 volume bounces.
- Sample counts are fixed: 256 for Cycles with denoising, 64 for EEVEE and 4 MSAA samples for 67js.

Path tracer (issue #57): `npm run reference -- --path-tracer [--samples 32]` draws each scene with `addons/path-tracer` (CPU, 960 by 540, four threads, below-normal priority) and scores it against the Cycles renders of an earlier run into `path-tracer.json`; `baseline.json` and `images/` stay as they are. Measured 2026-10-31 at 32 samples with the tracer's own denoiser, on a Ryzen 5 5600X that another session was also loading (seconds are wall time and are inflated by that):

| Scene | 67js rasterizer | Path tracer | Seconds | Not drawn by the tracer |
| --- | --- | --- | --- | --- |
| `brick-graph` | 0.2269 | 0.1538 | 34.2 | normal map (bump) |
| `car-paint` | 0.1521 | 0.1372 | 44.5 | |
| `character` | 0.0995 | 0.1143 | 35.5 | |
| `fog` | 0.2612 | 0.5622 | 33.5 | volume fog |
| `foliage` | 0.1594 | 0.1597 | 126.1 | leaf translucency |
| `glass` | 0.1326 | 0.1237 | 50.3 | |
| `lit-interior` | 0.5055 | 0.1993 | 238.0 | |
| `material-spheres` | 0.1598 | 0.1215 | 66.8 | |
| `metal` | 0.1868 | 0.1467 | 43.2 | |
| `outdoor-hdri` | 0.0676 | 0.1036 | 25.1 | |
| `spot-area` | 0.1242 | 0.0639 | 71.6 | |

The mean against Cycles is 0.171 for the path tracer and 0.189 for the rasterizer (the light bake gets `lit-interior` to 0.1341 with 3 bounces (0.1444 with 2), better than the tracer's 0.1993). The tracer is worse on `outdoor-hdri` and `character`: in the images the floor is darker than in Cycles (the cause is not found), and `fog` shows the missing volume. The denoiser blurs some soft shadows. Cycles used 256 samples. See `docs/path-tracer.md` for what the tracer draws and skips.

Path tracer, second pass (issue #129, measured 2026-11-01, 64 samples at most, `noiseThreshold` 0.03, four threads, 960 by 540; seconds are wall time and include scene setup). Scores against Cycles, all 17 scenes in `path-tracer.json`:

| Scene | Score | Seconds | | Scene | Score | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| `brick-flat` | 0.1117 | 24.2 | | `lit-interior` | 0.2214 | 106.7 |
| `brick-graph` | 0.1373 | 26.8 | | `long-street` | 0.1838 | 50.2 |
| `brick-room` | 0.2743 | 125.9 | | `material-spheres` | 0.1187 | 52.3 |
| `brushed-film` | 0.1462 | 47.2 | | `metal` | 0.1435 | 43.5 |
| `car-paint` | 0.1337 | 46.5 | | `outdoor-hdri` | 0.1016 | 24.8 |
| `character` | 0.1120 | 35.1 | | `spot-area` | 0.0900 | 21.3 |
| `fog` | 0.5628 | 26.4 | | `light-linking` | 0.6191 | 33.9 |
| `foliage` | 0.1577 | 69.5 | | `glass` | 0.1220 | 41.2 |

The mean over the 11 scenes of the first table is 0.1728 (0.171 at 32 samples before). `light-linking` scores 0.6191 because the tracer does not trace light linking (every light lights every part).

Before and after on four scenes, 64 samples: every sample drawn without the box-projection and shadow-ray changes (the state of `main`), then the defaults of this change. `brick-graph` 0.1370 then 0.1373, `brick-room` 0.2794 then 0.2743 (seconds 121.2 then 126.7, the box-projected walls now read their projected UVs), `character` 0.1116 then 0.1120, `outdoor-hdri` 0.1014 then 0.1016. `brick-graph` is a UV-mapped wall, so it already drew its bump and nothing in this change touches it: against the 0.1538 of the table above (32 samples) it improved, against the same tracer at 64 samples it did not move (0.0003 worse, inside the noise). `brick-room` is the scene with box-projected materials; its normal and roughness maps used to be ignored.

Adaptive sampling is not free in quality. On `spot-area` the score is 0.0658 with every sample drawn (37.1 s), 0.0748 at `noiseThreshold` 0.008 (31.3 s), 0.0847 at 0.015 (25.1 s) and 0.0900 at 0.03 (21.3 s). `lit-interior` went from 0.1993 (32 samples, before) to 0.2214 and was not re-run with every sample drawn. `spot-area` is a hard scene for the stop rule (narrow cone, sharp penumbra); a cause was not isolated. Set `noiseThreshold: 0` to draw every sample.

Denoising a lower sample count (fixed 24 samples with the tracer's filter, threshold 0, against the 64 sample score before the change): `brick-graph` 0.1394 against 0.1370 (0.0024 worse, 17.1 s against 37.3 s) and `character` 0.1164 against 0.1116 (0.0048 worse, 17.2 s against 39.3 s). Both are within 0.005, so a 24 sample still with the filter is a good still on these two scenes at about 45 percent of the time; two scenes are not proof for all.

Darker floor in `character` and `outdoor-hdri`: not found, but narrowed. In `outdoor-hdri` the mean display value of the bottom third (the floor) is 225.5 in Cycles, 225.4 in EEVEE, 224.8 in the rasterizer and 217.1 in the tracer, so the rasterizer agrees with Cycles and the tracer alone is darker, by 8.4 of 255 (the scene is bright, so the display curve compresses it; the linear gap is larger). A white furnace test (a diffuse floor of albedo 0.4 under a sky of radiance 1) gives 0.3955 straight down (1 percent low) and 0.588 at a grazing view with the sky reflection, so sampling the environment and the diffuse lobe is not what loses the light. What is left: the sun together with the HDRI, the clamp of 20 on bounced light (`fireflyClamp`), the grazing-angle specular and light from the other parts, none of which was isolated.

## Recipe bake presets (2026-11-02, issues #170 and #189)

An agent names a preset (`bake: { preset }`). A preset shrinks to the path work budget of 5 million steps (texels x samples x bounces): samples by a fifth and texel density by a tenth, repeatedly, down to 16 samples and 1 texel per unit. A scene that still does not fit there gives up one bounce and starts again from the preset's samples and density, down to 1 bounce. A preset therefore bakes any scene the explicit limit allows, and the result says what changed: `bake.used` holds the settings that ran, `bake.reduced` is `true`, and `bake.reduction` names what the preset asked for, what ran, and that explicit samples, bounces and texelsPerUnit (up to 24 million path steps, 20 s inline) bake denser.

`npm run reference -- --skip-blender --bake <ids> --bake-preset <name> --probes <ids>` bakes the way a recipe does (`normalizeAgentBake` and `bakeAgentParts`, the scene's own `bakeOptions` ignored) and scores against the Cycles renders already in `artifacts/reference`. The preset rows carry the room probe a recipe adds with a bake; the no-bake row has none. Whole frame FLIP against Cycles, RTX 3060 shared with other jobs, one run per cell, bake seconds from the harness (not an idle machine):

| Scene | No bake | draft | standard (`fine` is the same) |
| --- | --- | --- | --- |
| `lit-interior` | 0.5055 | 0.2919, 0.5 s, 8,000 texels | 0.1270, 3.8 s, 19,360 texels (81 samples, 3 bounces, 4.86 texels per unit) |
| `brick-room` | 0.5102 | 0.3185, 1.4 s, 37,136 texels | 0.1353, 1.8 s, 42,576 texels (32 samples, 3 bounces, 3.19 texels per unit) |
| `metal-room` | 0.5128 | 0.3187, 0.8 s, 8,816 texels | 0.1594, 3.3 s, 15,936 texels (64 samples, 3 bounces, 4.37 texels per unit) |
| `dark-shaft` | 0.1430 | 0.0791, 0.9 s, 28,208 texels | 0.0610, 2.3 s, 40,336 texels |
| `temple-hall` | 0.1436 | 0.0706, 5.7 s, 285,376 texels | 0.0705, 5.7 s, 304,480 texels (16 samples, 1 bounce, 1.37 texels per unit) |

Before issue #189 `standard` and `fine` refused `temple-hall` (even 16 samples at 1 texel per unit and 3 bounces pass the budget), so a recipe got an unbaked hall at 0.1504 with a probe. Now `standard` bakes it, with one bounce, which is what `draft` does: the score matches `draft` (0.0705 against 0.0706). The scene's own tuned options score 0.0560, and reaching them takes explicit settings.

What the table shows:

- `standard` halves the error of `draft` on `lit-interior`, `brick-room` and `metal-room` (3 bounces against 1) and beats the default bake of "Baked rooms and the bounce count" (0.1341, 0.1412, 0.1656) on all three, for 2 to 4 s.
- `fine` could not be made better than `standard` inside the budget, so it is an alias with the same numbers. The old `fine` (192 samples, 7 texels per unit) was cut to the same budget, so it ended within 0.003 of `standard` and slightly worse on three of five rooms (0.1293, 0.1382, 0.1624, 0.0603). Five other mixes of samples and density were scored, each asked for through `fine` and shrunk to the budget the same way:

| Asked (samples, bounces, texels per unit) | `lit-interior` | `brick-room` | `metal-room` | `dark-shaft` | `temple-hall` |
| --- | --- | --- | --- | --- | --- |
| 128, 3, 6 (`standard`) | 0.1270 | 0.1353 | 0.1594 | 0.0610 | 0.0705 |
| 192, 3, 7 (old `fine`) | 0.1293 | 0.1382 | 0.1624 | 0.0603 | not baked |
| 256, 3, 3 | 0.1363 | 0.1655 | 0.1636 | 0.0620 | 0.0718 |
| 256, 3, 4 | 0.1401 | 0.1516 | 0.1677 | 0.0606 | 0.0699 |
| 256, 3, 5 | 0.1442 | 0.1497 | 0.1746 | 0.0637 | 0.0703 |
| 64, 3, 12 | 0.1320 | 0.1436 | 0.1667 | 0.0660 | 0.0700 |
| 48, 3, 8 | 0.1208 | 0.1533 | 0.1643 | 0.0647 | 0.0700 |
| 32, 3, 12 | 0.1274 | 0.1445 | 0.1712 | 0.0660 | 0.0700 |

  More samples on fewer texels (256 samples at 3 to 5 texels per unit) lost on every room except `dark-shaft`, and more texels on fewer samples (32 to 64 samples at 8 to 12) lost on all but `lit-interior`, where `48, 3, 8` won by 0.006 and lost 0.018 to 0.004 on the other three. The `standard` mix of about 30 to 80 samples at 3 to 5 texels per unit after shrinking is the best or within 0.005 of the best on four of five rooms (not `lit-interior`), and the differences between mixes are small next to the gap to Cycles from missing indirect specular. A smoothing radius was not tried: `SMOOTH_RADIUS_TEXELS` is a constant in `src/light-bake.js` and the recipe has no field for it. Each cell is one run, so differences under about 0.005 are not separable from noise.
- The 20 s inline limit and the budget agree on large rooms: `temple-hall`, the largest scene (167 parts, 304,480 texels), bakes in 5.7 s at the budget, and the slowest cell above is 6.0 s, so the budget leaves room under the limit on this machine.
- `draft` is a rough preset: one bounce leaves the lit rooms at 0.29 to 0.32, still well under the unbaked 0.51.

Frame costs from the issue (a baked closed room, and the fog glow mip chain on `dark-shaft`) were not measured: `nvidia-smi` showed 14 to 48 percent utilization and 6 to 7 GB in use over 24 seconds while another worker held the GPU, so a number would be a loaded one. The ranges above in this file stay ranges.
