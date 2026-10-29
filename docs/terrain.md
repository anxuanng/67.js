# Terrain and splat ground

`67js/addons/terrain` and `67js/addons/texture-set` are in the current source and not yet published.
Together they replace a flat, noise-tinted ground with a chunked heightfield and a four-layer ground material made from real scanned textures.

```js
import { Renderer67 } from '67js';
import { loadHdri } from '67js/addons/hdri';
import { createTerrain } from '67js/addons/terrain';
import { loadTextureSet } from '67js/addons/texture-set';
import { scatterVegetation } from '67js/addons/vegetation';

const terrain = createTerrain({ size: 600, chunks: 10, resolution: 32, levels: 4, seed: 11 });
const [grass, forest, mud, rock] = await Promise.all(
  ['leafy_grass', 'forest_ground_04', 'brown_mud_leaves_01', 'aerial_rocks_02'].map(name => loadTextureSet(`/textures/${name}`)),
);
const material = {
  color: [1, 1, 1], metallic: 0, roughness: 1,
  layers: [
    { ...grass, scale: 3.2, tint: [0.58, 0.88, 0.38] },
    { ...forest, scale: 3.5 },
    { ...mud, scale: 2.6 },
    { ...rock, scale: 6, triplanar: true },
  ],
  splat: {
    rules: [undefined, { height: [-9, -2] }, { mask: 'r' }, { slope: [31, 90] }],
    maskMap: pathWeights, maskBounds: [-300, -300, 300, 300],
  },
};
for (const part of terrain.parts) part.material = material;

const trees = scatterVegetation({ area, terrainHeight: terrain.heightAt, slopeLimit: 24, leaves: 'cards' });
const renderer = new Renderer67(canvas, [...terrain.parts, ...treeParts], { world: true, ground: false, hdr: true, environment: { map: await loadHdri('/hdri/sky.hdr') } });
```

Each frame, `if (terrain.update(eye).length) renderer.replaceParts(sceneParts)` swaps the chunks whose level of detail changed.
Textured parts such as leaf cards must stay unchanged in `replaceParts`, so rebuild the renderer when the vegetation levels change.

## loadTextureSet

`loadTextureSet(baseUrl, { channels, extension = 'webp', colorSpaces, fetchBlob, decodeBlob })` fetches `<baseUrl>/color.webp`, `normal.webp`, `roughness.webp` and `height.webp` and returns `{ color, normal, roughness, height }` texture descriptors (`{ image, colorSpace }`).

- `color` is `srgb`; `normal`, `roughness` and `height` are `linear`. Normal maps use the OpenGL convention (green up), as the Poly Haven files in `public/textures/` do.
- Without `channels`, every channel that exists loads and a missing file is skipped (the bark scans have no height). With `channels: [...]`, a missing file throws.
- Decoding uses `createImageBitmap` with colour conversion off. In Node, pass `fetchBlob` and `decodeBlob`; the splat code also accepts `{ width, height, data }` pixel objects.
- The result spreads into a layer: `{ ...set, scale: 4 }`.

## Splat material

A material with `layers` (1 to 4) draws as splat ground. It needs a standard PBR tag (no `terrain`, `floor` and the like) and no `map`, `normalMap`, `metallicRoughnessMap` or `occlusionMap`; the layers replace them. `color` multiplies the result.

| Layer field | Meaning |
| --- | --- |
| `color`, `normal`, `roughness`, `height` | Descriptors from `loadTextureSet`. Missing ones fall back to mid grey, a flat normal, roughness 1 and height 0.5. |
| `scale` | Metres per texture tile (default 4). |
| `tint` | RGB multiplier on colour. |
| `normalStrength` | Scales the normal map tilt (default 1). |
| `triplanar` | Project from the sides on steep slopes, so cliffs do not stretch. |

`material.splat` holds `rules`, one entry per layer (or `undefined`):

- `slope: [minimum, maximum]` in degrees from horizontal, `height: [minimum, maximum]` in world metres, each with `slopeSoftness` (default 4) and `heightSoftness` (default 1.5) as the half-width of the fade.
- `mask: 'r' | 'g' | 'b' | 'a'` multiplies by a weight channel. `invertMask: true` flips it. The weights come from vertex colours (`r`, `g`, `b` only) or, when `splat.maskMap` is set, from a linear texture stretched over `splat.maskBounds = [minimumX, minimumZ, maximumX, maximumZ]`. The first image row is `minimumZ`.
- A layer with no rule takes what the other layers leave, so put grass first with no rule.

Other `splat` options: `heightBlend` (0.22) and `heightInfluence` (1) control how strongly the height maps decide who wins at layer edges, so grass fills the gaps between rocks instead of fading linearly; `triplanarStart` and `triplanarEnd` (38 and 52 degrees) set where side projection fades in; `antiTiling` (0 to 1, default 1); `cavity` (0 to 1, default 0.55) darkens low parts of the height map; `textureSize` caps the common layer size.

Shading: world-space XZ UVs, a second rotated sample at 0.58 times the scale mixed by low-frequency noise (with contrast restored) so repetition is not visible from afar, normal tilts added in world space, roughness from the maps, and a slow macro brightness and dryness variation.
Materials batch together only when they share the same `layers` array and `splat` object, so build them once and assign them to every chunk.

Memory: three `TEXTURE_2D_ARRAY`s on units 11 to 13 (sRGB colour, normal, roughness in red with height in green), all layers resized to the largest source (at most `MAX_TEXTURE_SIZE`), with mipmaps and up to 8x anisotropic filtering when the extension exists. The weight texture uses unit 14. The renderer counts them in `memoryBudgetMiB` and reports them as `renderer.splatBytes`. Four 1K layers take 64 MiB; set `textureSize: 512` to quarter that.

## createTerrain

`createTerrain({ size = 512, resolution = 32, chunks = 8, levels = 4, height, seed = 1, material, lodDistance, eye })` returns `{ parts, heightAt, normalAt, bounds, update, triangleCount, chunkSize, chunkLevels }`.

- The ground spans x and z from `-size / 2` to `size / 2`. `chunks` per side, each with `resolution` cells at level 0 (so `resolution` must divide by `2 ** (levels - 1)`). Level `n` uses `resolution / 2 ** n` cells.
- `height` is a function `(x, z) => metres`, a square `Float32Array` of metres stretched over the ground (`heightmapFromImageData(imageData, amplitude)` builds one from an image), or noise options: `amplitude` (hills, 14), `mountainAmplitude` (46), `featureSize` (160 m), `octaves`, `gain`, `lacunarity`, `warp` (domain warp in metres), `baseHeight` and `mountainMask(x, z)` (0 to 1, where ridged mountains replace hills). Hills use slope-damped octaves and mountains use ridged multifractal noise, which gives smooth flanks, sharp crests and carved valleys. The same `seed` always gives the same ground.
- `heightAt(x, z)` walks the same triangles as the level 0 mesh, so it matches the rendered surface there (coarser levels differ by their simplification). Coordinates outside the ground clamp to its edge. `normalAt` interpolates smooth grid normals.
- `update(eye)` picks a level per chunk from its distance (`lodDistance`, default 1.6 chunk sizes, doubling per level) and returns the parts whose geometry changed. Edges shared with a coarser neighbour are snapped onto the neighbour's edge, so there are no cracks and no skirts.
- UVs are world metres `(x, z)`. Vertex normals are smooth and shared across chunk borders.

## Measured

Windows, RTX 3060, headless Chrome, 1600x900, 4x MSAA, HDRI, shadows, bloom, 600 m terrain with 10x10 chunks at resolution 32 and about 1,000 to 1,750 trees:

| Camera | Terrain triangles | Scene triangles | Batches | Frame |
| --- | --- | --- | --- | --- |
| Low, close to the path | 50,432 | 1.23 M | 164 | 13.8 ms |
| High, whole scene | 12,896 | 0.53 M | 124 | 9.0 ms |

Splat textures take 68 MiB of 74 MiB texture memory at 1K per layer.

## Limits

- Up to four layers; one splat material per draw (chunks share one).
- Overhangs are not represented: the terrain is a heightfield.
- Changing `layers` or `splat` after the renderer exists needs a new renderer.
- The weight texture follows its descriptor's filtering (mipmapped by default); 1024 square over 600 m gives 0.6 m texels.
- Normal-map tilt is added to the geometric normal in world space, which is cheap and stable but not a full tangent-space blend.
