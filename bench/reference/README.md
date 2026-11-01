# Reference renders

This suite scores how close a 67js render is to Blender on 15 fixed scenes. Later work uses these scores as its starting point.

## Run it

Run `npm run reference`. It prints one row for each scene, and it rewrites `baseline.json` and `images/`.

The run needs Chrome, Blender 5.2, `uv` and an NVIDIA GPU, and it takes about 2 minutes on an RTX 3060. Use `CHROME_PATH` and `BLENDER_PATH` to change the program paths.

CI does not run this suite. `tests/reference-baseline.test.js` checks only that the committed baseline is complete.

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

Light bake (issue #55): `npm run reference -- --bake lit-interior` bakes bounced light into the room with `addons/light-bake` (defaults: 128 samples, 2 bounces, 25,648 texels, about 6 s on this machine) and leaves the scene itself unchanged; Blender still gets the plain scene. Measured 2026-10-31 on the RTX 3060: `lit-interior` against Cycles goes from 0.5055 to 0.1444 (SwiftShader 0.5051 to 0.1439), and against EEVEE from 0.0923 to 0.4739, because EEVEE has no indirect light here and the bake adds it. No other scene moved by more than 0.002 (the largest change was 0.0001, `car-paint` against EEVEE). The committed baseline rows and images are not rewritten. The remaining gap shows in the FLIP image as faint blotches on the walls, which is bake noise at 128 samples; at 48 samples the blotches were plain to see and the score was 0.1688.

`long-street` and `light-linking` (issue #52) were added on 2026-11-01. `long-street` is a 140 m street under the sun with 24 buildings, 14 lamp posts and four cars near the camera; one 2048 x 2048 sun map covers 170 m, so its texels are 8 cm wide. Against Cycles it scores 0.1555 with one map and 0.1398 with three cascades (`npm run reference -- --cascades 3`; SwiftShader 0.1554 and 0.1399; against EEVEE 0.1396 and 0.1147; EEVEE against Cycles 0.0975). Frame time on the RTX 3060 (960x540, 4 samples, 200 frames read back, median of two runs of each, `node bench/reference/frame-time.mjs long-street gpu --cascades`): 1.04 ms with one map and a still camera, 1.02 ms with a camera that moves every frame, 1.09 ms with three cascades and a still camera, 1.24 ms with three cascades and a moving camera, so the cascades cost about 0.2 ms (20 percent) in a camera move and next to nothing while the camera is still. On SwiftShader (median, `cpu`): 241 ms, 240 ms, 282 ms and 299 ms, so +17 percent still and +25 percent moving, because the cascade lookup is 36 texture fetches per pixel and the depth passes run on the CPU. The cascades earn their cost where a shadow has to be sharp near the camera and long at the same time; a scene that fits one map in a few metres gains nothing and should not use them. The remaining gap in `long-street` is Cycles' sky and bounce light, not the shadows. `light-linking` has three point lights that each light only some parts (`affects` lists); it scores 0.0998 against Cycles, with the same lists given to Blender as receiver collections. Every scene that existed before kept its score to four digits (`lit-interior` is still 0.5055 against Cycles, 0.0923 against EEVEE), and the committed images of those scenes are unchanged.

`brick-room` (issue #128) is a closed room built from a recipe (`createAgentScene`) with three brick pattern walls, two point lights and a table with a vase. Blender gets the box projection as UVs (`boxProjectedGeometry`) and the baked brick map, but not the bump or the roughness map. Measured 2026-11-01 on the RTX 3060: against Cycles 0.5102 without the bake and 0.1515 with it (`npm run reference -- --bake brick-room`; SwiftShader 0.5096 and 0.1503; EEVEE against Cycles 0.5020); the bake took 14.4 s for 28,576 texels while another session loaded the machine. `lit-interior` stayed at 0.1444 with the bake, and every scene without a bake kept its earlier score to four digits (largest change 0.0000).

`brick-graph` (issue #50) is a wall of bricks written as one material graph (triangle waves for the joints, half a brick of shift on every second course, noise through a colour ramp, height as bump) on a quad with UVs, so it uses `mapping: "uv"`. `render-blender.py` translates the same graph JSON into Blender nodes (Math, Map Range, Noise Texture, Color Ramp, Mix and Bump), so each side evaluates its own nodes. It measured 0.2269 against Cycles and 0.1440 for EEVEE on 2026-10-31. A first run scored 0.4027 and showed a black wall in 67js: the `min` and `max` nodes returned NaN. The scene found that bug. The other rows were re-measured in the same run; `glass` against Cycles moved from 0.1450 to 0.1326 and `lit-interior` to the with-shadows numbers described above, and no other score moved by more than 0.002.

`brushed-film` (issue #51) holds a brushed gold sphere (`anisotropy` 0.8), a dark sphere with a thin film (`iridescence`, IOR 1.3, 400 nm) and a silver sphere with the same film. `render-blender.py` maps the glTF anisotropy model onto Blender's aspect ratio (alpha along the tangent is `mix(alpha, 1, strength^2)`, so Blender gets Anisotropic = (1 - alpha / alpha_tangent) / 0.9 and the geometric-mean roughness) and feeds a UV-map Tangent node, because Blender's default tangent is a different field: with the default tangent the first run scored 0.1673 against Cycles and the highlight ran in rings where 67js had bands; with the UV tangent it scores 0.1613 and the highlight direction matches. Thin film goes to Principled Thin Film Thickness and IOR. EEVEE draws no thin film, so its sphere stays black. The two models are not the same: Blender's film is its own Fresnel integration, 67js uses Belcour and Barla at the view angle, so match the colours by eye in the image, not by the score alone. Measured 2026-11-01 on the RTX 3060 and SwiftShader. Before and after adding anisotropy and iridescence, every older scene scored the same against Cycles and EEVEE to four digits (largest change 0.0000, limit 0.002), because their shaders compile the two layers out.

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

Khronos sample assets (issue #51): `npm run reference -- --khronos` draws files from [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) that you download by hand into `artifacts/khronos/<name>/<name>.glb` (gitignored; nothing is committed). Blender imports the same GLB with its own importer, so Cycles is the reference for the file and not for our reading of it. The run uses its own work directory and writes `khronos.json` and `images/khronos-<name>.jpg`; `baseline.json` stays as it is. The sky fills most of each frame and both sides draw it alike, so the whole-frame FLIP score is about 0.05 for every asset and says little. The `asset-` columns score only the pixels the asset changes (a second render of the empty sky decides which, threshold 0.03). Licences, checked in each model's `LICENSE.md`: ClearCoatTest and AnisotropyBarnLamp are CC BY 4.0 (Analytical Graphics, Inc. and Wayfair, LLC), TransmissionTest and AnisotropyDiscTest are CC0 1.0. Measured 2026-11-01 on the RTX 3060 (SwiftShader within 0.0004 on the whole frame):

| Asset | Pixels covered | 67js against Cycles (asset only) | 67js against EEVEE | EEVEE against Cycles | What differs |
| --- | --- | --- | --- | --- | --- |
| `ClearCoatTest` | 0.1353 | 0.2306 (was 0.2344) | 0.1808 | 0.1335 | The coat, coat roughness and coat normal textures are read; most of the gap is outside the coat |
| `TransmissionTest` | 0.1356 | 0.2708 | 0.2371 | 0.1656 | Refraction through the front surface only, no roughness-blurred background |
| `AnisotropyDiscTest` | 0.1074 | 0.2808 (was 0.3481) | 0.2772 | 0.1534 | `anisotropyTexture` is read: the disc pattern now draws, but the tiles are darker than Cycles; 0.2773 with anisotropy switched off |
| `AnisotropyBarnLamp` | 0.0733 | 0.3584 (was 0.4758) | 0.4318 | 0.3765 | `anisotropyTexture` and the coat normal texture are read, and it now scores better than anisotropy switched off (0.3945) |

Reading `anisotropyTexture` (strength in blue, direction in red and green) fixed the shade: the factor alone spread a highlight over everything, and it scored worse than no anisotropy. The disc test is still level with anisotropy switched off, so the remaining gap there is not the texture. `TransmissionTest` is unchanged at 0.2708: its `transmissionTexture` is not read, because transmission draws in the liquid pass, which has no feature code, and the scores do not show that the other slots (iridescence, specular) matter. `SheenChair` still cannot be scored: its occlusion texture on TEXCOORD_1 now loads, but its fabric gives the base color and normal textures different `KHR_texture_transform` values, and one UV transform is baked per material. Both Blender's engines disagree on the lamp by 0.3761, so part of that gap is Blender's own anisotropy and clear coat. Two importer bugs the assets found are fixed: `KHR_xmp` and `KHR_xmp_json_ld` (metadata) stopped the whole import, and `KHR_materials_variants` is now accepted with a warning and draws the default material.

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

The mean against Cycles is 0.171 for the path tracer and 0.189 for the rasterizer (the light bake gets `lit-interior` to 0.1444, better than the tracer's 0.1993). The tracer is worse on `outdoor-hdri` and `character`: in the images the floor is darker than in Cycles (the cause is not found), and `fog` shows the missing volume. The denoiser blurs some soft shadows. Cycles used 256 samples. See `docs/path-tracer.md` for what the tracer draws and skips.

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
