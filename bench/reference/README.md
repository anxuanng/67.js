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
| `foliage` | 0.1594 | 0.1346 | 0.1290 | 0.0864 |
| `brick-flat` | 0.1999 | 0.1273 | 0.1272 | 0.1098 |
| `brick-graph` | 0.2269 | 0.1604 | 0.1602 | 0.1221 |
| `long-street` | 0.1555 | 0.1555 | 0.1407 | 0.0976 |

The mean over the 16 older scenes went from 0.2001 to 0.1751 to 0.1732. EEVEE is at 0.1645.

## Grand scenes (2026-11-01)

Three scenes test what people want to make, not one feature. Each one is built with engine code, and Blender gets the same geometry.

| Scene | Parts | Triangles drawn | 67js against Cycles | EEVEE against Cycles | Largest visible gap |
| --- | --- | --- | --- | --- | --- |
| `megacity-dusk` | 4,300 | 51.6 thousand | 0.1627 | 0.1524 | Window bands are sharper, and facades get no light from the windows |
| `mountain-valley` | 7,698 | 9.72 million | 0.3473 | 0.1828 | Trees are lighter from leaf translucency, and shadowed rock is brighter |
| `temple-hall` | 155 | 11 thousand | 0.2126 | 0.2341 | The fog shafts are stronger in 67js, and the floor gets no bounce light |

With the shadow floor `temple-hall` scored 0.5841, `mountain-valley` 0.3658 and `megacity-dusk` 0.1583.

`temple-hall` sets its own `bakeOptions`. The defaults need 1.4 million texels, and the bake allows 1 million. With the options the bake scores 0.2239, against 0.2126 without it.

### Options for the grand scenes (2026-11-02, part of issue #168)

The three scenes measure well and look plain, so `grand-scenes.js` holds three options of each, `-a`, `-b` and `-c`, each a different composition, light and time of day. `npm run reference -- --grand` draws them on both sides into `grand.json` and `images/grand-<id>.jpg`; `baseline.json` and the other images are unchanged. `python bench/reference/grand-sheets.py <directory>` (command in its header) writes one comparison sheet per scene. An picks by letter, and a later change moves the pick into `REFERENCE_SCENES`. Blender draws the same geometry; the sky is the same equirectangular gradient on both sides (`gradient` world type), and every window, lamp and sky panel is Emission.

| Option | What it is | 67js against Cycles | Cycles seconds |
| --- | --- | --- | --- |
| `mountain-valley-a` | Golden hour at a lake, sun from the left, rocky shore in the foreground | 0.3530 | 26.3 |
| `mountain-valley-b` | Midday from a high slope, a river winding down a flat valley floor | 0.1839 | 24.5 |
| `mountain-valley-c` | Alpenglow on one tall peak, forest edge close to the camera | 0.2282 | 52.7 |
| `temple-hall-a` | Four clerestory windows throw slanted sun shafts across the nave, people in the light | 0.2530 | 21.7 |
| `temple-hall-b` | Square oculus hall: ring of columns, one beam on a gilded seated figure | 0.3642 | 25.4 |
| `temple-hall-c` | Setting sun down the nave axis through a tall opening, columns as silhouettes in glowing fog | 0.2746 | 23.4 |
| `megacity-dusk-a` | Blue hour on a river with lit bridges and quays | 0.1978 | 28.9 |
| `megacity-dusk-b` | Sunrise across a bay from a pier, skyline and its reflection | 0.1575 | 33.2 |
| `megacity-dusk-c` | Night, high view over an avenue grid of car lights and dense lit towers | 0.1149 | 35.9 |

Known gaps in the 67js side: a lake or bay shows the sky only, where Cycles also mirrors the shore, the trees and the towers; the dark halls have no bounced light.

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

## Reflections in still water (2026-11-02, issue #195)

A lake, a river or a bay showed only the sky, where Cycles mirrors the shore, the trees and the towers. A large flat smooth surface now draws the scene from the mirror image of the camera into a target half the canvas size in each direction, and samples that picture. `mountain-valley-a` goes from 0.3530 to 0.2562 against Cycles and `megacity-dusk-b` from 0.1575 to 0.1377. `megacity-dusk-a` (a river between quays) does not improve: 0.1978 to 0.1985.

### Options

Both options ran on the three water options and the two default scenes that hold such a surface. FLIP against Cycles, GPU, full rescore; frame time is the median of three alternating rounds of 200 frames on the RTX 3060 (`node bench/reference/frame-time.mjs <id> gpu --water --grand`), shared with other jobs.

| Option | `mountain-valley-a` | `megacity-dusk-b` | Frame, `mountain-valley-a` | Frame, `megacity-dusk-b` |
| --- | --- | --- | --- | --- |
| No reflection (before) | 0.3530 | 0.1575 | 6.37 ms | 2.78 ms |
| Screen-space reflection (`bench/reference/ssr-water.js`, 80 steps and 6 refinements, full resolution) | 0.3310 | 0.1423 | 7.25 ms | 4.09 ms |
| Planar reflection (`src/water-reflection.js`) | 0.2562 | 0.1377 | 10.70 ms | 4.82 ms |

The planar reflection wins on the score and costs more: it draws the scene a second time, at a quarter of the pixels but with all of the geometry. The screen-space version can only show what the frame holds, so it loses the shore's far side and anything behind a nearer surface; in `mountain-valley-a` the far peaks and the trees against the sky are most of what the lake shows. It stays in the harness (`--ssr-water`) as the comparison and is not shipped. The planar cost is what a scene with water pays: +4.3 ms and +2.0 ms here. A scene without water pays nothing: `temple-hall-a` measured 2.00 ms off, 1.90 ms planar and 1.80 ms screen-space, which is the spread of the machine, and its shader is the same text.

### What qualifies

No recipe field. `findWaterSurface(parts)` picks parts whose material has `roughness` of at most 0.1 and is not `liquid`, `foam`, `unlit`, `fire`, `smoke` or `floor` and has no `transmission`; whose bounds are flat (taller by at most 2 percent of the wider side); and whose footprint is at least 0.2 percent of the scene's. Metal qualifies the same way as water, so a polished floor reflects too. The largest such part sets the plane, at the top of its bounds, and parts within 5 cm of that height join it. One plane per frame: a second water level is not reflected. A camera below the plane draws no reflection. A narrow river in a wide scene qualifies at 0.2 percent and not at the 1 percent first tried; at 1 percent `megacity-dusk-a` was untouched.

### The look

A mirror looked fake: the first version, a hard reflection mixed in by the shader's own Fresnel, scored 0.2099 on `megacity-dusk-b`, worse than none. Three changes fixed it, in this order of effect:

1. The sky the lighting already adds to a smooth surface is taken out before the reflection is added, so the water does not get the sky twice (the reflection picture holds the sky).
2. Fresnel from the reflectance of water (0.02 at normal incidence): strong at grazing angles, faint when looking down into the water.
3. Small moving ripples shake the picture, more with distance, and eight taps smear it, more up and down than across, as ripples stretch a reflection.

Blur alone did not help: 12 taps over a wider area scored worse than 8 over a narrower one on both scenes (0.1944 against 0.1893 on `megacity-dusk-b`, before the sky was taken out). Water colour and depth near the shore are not done: the surface is a box and carries no depth, so the water has the body colour of its material everywhere. By eye, in the image of `mountain-valley-a` the lake reads as real still water: dark, strongly mirrored near the far shore and fading toward the camera. The bay in `megacity-dusk-b` reads as water too, and its reflection of the lit windows is brighter than Cycles': there the band of water is 0.34 where Cycles has 0.10, with or without the reflection, so that part of the gap is the water's body colour or the haze, not the reflection.

### Scores against Cycles (GPU, full rescore, 2026-11-02)

| Scene | Before | After | CPU before | CPU after |
| --- | --- | --- | --- | --- |
| `mountain-valley-a` | 0.3530 | 0.2562 | 0.3539 | 0.2567 |
| `megacity-dusk-b` | 0.1575 | 0.1377 | 0.1584 | 0.1371 |
| `megacity-dusk-a` | 0.1978 | 0.1985 | 0.1972 | 0.1980 |
| `mountain-valley-b` | 0.1839 | 0.1784 | 0.1840 | 0.1785 |
| `foliage` (default suite) | 0.1290 | 0.1181 | 0.1287 | 0.1178 |
| `mountain-valley` (default suite) | 0.3478 | 0.3490 | 0.3466 | 0.3478 |

The other 19 default scenes and the other 4 grand options re-scored identically to four digits, on GPU and CPU (`--no-water` reproduces the old numbers). Those two default scenes hold a qualifying surface, so they changed. `mountain-valley` is worse by 0.0012 and `megacity-dusk-a` by 0.0007.

### Size

The core grew by 374 bytes gzip in a `lit-box` scene (limit 400): a material field that batches parts, a feature name, a slot in the shader, and the second draw's target and early return. The reflection itself is the addon `67js/addons/water-reflection` (25,403 bytes gzip as an entry, budget 26,000). The shipped archive is 709,306 bytes.

### Use

```js
import { applyWaterReflection, attachWaterReflection } from '@codepawlhq/67js/addons/water-reflection';

const water = applyWaterReflection(parts);
const renderer = new Renderer67(canvas, water.parts, options);
attachWaterReflection(renderer, water.surface);
```

`water.surface` is null when no part qualifies, and `attachWaterReflection` then does nothing. A recipe scene does not place it yet: the recipe path has no hook that loads the addon from the materials, and that is the next piece of work. `npm run reference -- --no-water` draws the harness scenes without it.

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

## Limits

- Scores come from one camera for each scene and one machine. They do not measure motion or speed.
- This suite sets an HDRI from code and leaves occlusion off; `--ambient-occlusion <strength> [--ambient-occlusion-radius <units>]` turns it on. A recipe reaches only the named procedural setups, so these scores still describe a better environment than an agent gets (issue #53).
- The Blender leaf material has no translucency, and the 67js foliage shader adds it by a trick. `foliage` is therefore partly a difference in materials.
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

## Recipe bake presets (2026-11-02, part of issue #170)

An agent names a preset (`bake: { preset }`), and `standard` and `fine` shrink to the path work budget of 5 million steps (`bake.used`, `bake.reduced`). `npm run reference -- --skip-blender --bake <ids> --bake-preset <name> --probes <ids>` bakes the way a recipe does (`normalizeAgentBake` and `bakeAgentParts`, the scene's own `bakeOptions` ignored) and scores against the Cycles renders already in `artifacts/reference`. The preset rows below carry the room probe a recipe adds with a bake; the no-bake row has none. A preset the budget refuses (the error a recipe gets) draws the scene unbaked and prints `REFUSED`. Whole frame FLIP against Cycles, RTX 3060 shared with other jobs, one run per cell, bake seconds from the harness (not an idle machine):

| Scene | No bake | draft | standard | fine |
| --- | --- | --- | --- | --- |
| `lit-interior` | 0.5055 | 0.2919, 0.5 s, 8,000 texels | 0.1270, 3.4 s, 19,360 texels | 0.1293, 3.3 s, 16,800 texels |
| `brick-room` | 0.5102 | 0.3185, 1.4 s, 37,136 texels | 0.1353, 1.8 s, 42,576 texels | 0.1382, 1.8 s, 37,136 texels |
| `metal-room` | 0.5128 | 0.3187, 0.8 s, 8,816 texels | 0.1594, 3.2 s, 15,936 texels | 0.1624, 4.6 s, 18,336 texels |
| `dark-shaft` | 0.1430 | 0.0791, 0.9 s, 28,208 texels | 0.0610, 2.3 s, 40,336 texels | 0.0603, 2.2 s, 35,664 texels |
| `temple-hall` | 0.1436 | 0.0706, 5.7 s, 285,376 texels | refused (0.1504 drawn unbaked with a probe) | refused (same) |

What the table shows:

- `standard` is the preset to name for a room: it halves the error of `draft` on `lit-interior`, `brick-room` and `metal-room` (3 bounces against 1) and beats the default bake of "Baked rooms and the bounce count" (0.1341, 0.1412, 0.1656) on all three, for 2 to 3.5 s.
- `fine` is no better than `standard`. Its extra samples and density are cut back to the same budget (38 to 77 samples, 3.0 to 4.6 texels per unit), so it ends up within 0.003 of `standard`, slightly worse on three of five rooms, and costs the same or a little more. A recipe gains nothing by asking for it on these scenes.
- `temple-hall` (167 parts, 3 bounces) is out of reach of `standard` and `fine`: even 16 samples at 1 texel per unit pass 5 million steps, so a recipe gets the error and no bake. `draft` works (reduced to 16 samples and 1.29 texels per unit) and scores 0.0706, against 0.0560 for the scene's own tuned options. Reaching `standard` on a hall needs explicit settings within the 24 million explicit limit, or a lower budget floor; this is left open.
- `draft` is a rough preset: one bounce leaves the lit rooms at 0.29 to 0.32, still well under the unbaked 0.51.

Frame costs from the issue (a baked closed room, and the fog glow mip chain on `dark-shaft`) were not measured: `nvidia-smi` showed 14 to 48 percent utilization and 6 to 7 GB in use over 24 seconds while another worker held the GPU, so a number would be a loaded one. The ranges above in this file stay ranges.
