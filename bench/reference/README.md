# Reference renders

This suite scores how close a 67.js render is to Blender on 9 fixed scenes. Later work uses these scores as its starting point.

## Run it

Run `npm run reference`. It prints one row for each scene, and it rewrites `baseline.json` and `images/`.

The run needs Chrome, Blender 5.2, `uv` and an NVIDIA GPU, and it takes about 2 minutes on an RTX 3060. Use `CHROME_PATH` and `BLENDER_PATH` to change the program paths.

CI does not run this suite. `tests/reference-baseline.test.js` checks only that the committed baseline is complete.

## Baseline

Measured on 2026-10-30 with an RTX 3060, SwiftShader and Blender 5.2.2. The metric is [FLIP](https://github.com/NVlabs/flip) for LDR images: 0 means identical, and a higher score means a larger visible difference.

| Scene | 67.js against Cycles | EEVEE against Cycles | 67.js against EEVEE | Largest visible gap against Cycles |
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

Rows are the baseline taken before shadows for point lights. The `lit-interior` scene now sets `castShadow` on its three point lights. With shadows, 67.js scores 0.5055 against Cycles (0.4997 before, so 0.0058 worse) and 0.0923 against EEVEE (0.1204 before, better): the shadow shape now matches, but Cycles fills its shadows with indirect light and 67.js leaves them dark. The committed `lit-interior` row stays at the earlier numbers. `spot-area` is new with shadows, a spot light and an area light.

The mean against Cycles is 0.198 for 67.js and 0.160 for EEVEE. The mean difference between the RTX 3060 and SwiftShader is 0.007.

EEVEE against Cycles is a yardstick: it shows what a good rasterizer scores. In `lit-interior` and `fog`, EEVEE scores no better than 67.js. Those two scenes depend on indirect light, and this suite does not use EEVEE light probes. A low score does not mean a good picture on its own, so read each score with its image in `images/`.

`baseline.json` also holds the scores for SwiftShader and each render time in Blender.

## How the two sides stay comparable

- **Geometry:** `scenes.js` builds each scene with the engine's code, and `harness.js` hands the same vertices, normals and textures to Blender. This replaces GLB, because GLB export can not write textures yet (issue #49).
- **Character:** Blender's glTF importer does not reproduce the rest pose of `RobotExpressive.glb`. three.js and 67.js agree on that pose. So `harness.js` skins the vertices first, and Blender gets the result as plain geometry.
- **Lights:** a measurement on a white plane gave the units. Sun strength equals irradiance in both. A Blender point light has 4π watts for each unit of 67.js intensity.
- **Environment:** the same HDRI at the same rotation. The clouds line up in the images.
- **Display:** Blender writes linear pixels, and `score.py` applies the tone curve and gamma from `src/post.js`. Both sides then use one display transform.
- **Lighting tricks:** the 67.js fill lights are off. All light comes from the sun, the environment and point lights.

## Limits

- Scores come from one camera for each scene and one machine. They do not measure motion or speed.
- 67.js reaches an HDRI only from code. A recipe can not set one yet, so these scores are better than what an agent gets today (issue #53).
- The Blender leaf material has no translucency, and the 67.js foliage shader adds it by a trick. `foliage` is therefore partly a difference in materials.
- `render-blender.py` does not read normal maps. No scene uses one yet, so a new scene with a normal map must add that first.
- `glass` compares the 67.js `liquid` material with a Blender glass material. 67.js has no glass material (issue #51).
- `fog` has no noise on either side. EEVEE and 67.js approximate scattering, and Cycles follows 8 volume bounces.
- Sample counts are fixed: 256 for Cycles with denoising, 64 for EEVEE and 4 MSAA samples for 67.js.
