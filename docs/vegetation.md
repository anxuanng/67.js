# Vegetation

`67js/addons/vegetation` grows seeded trees, bushes and grass, scatters them on terrain and switches detail by distance.
It is in the current source and not yet published. Everything returns plain renderer parts: geometry, a matrix and a material.

```js
import { Renderer67 } from '67js';
import { scatterVegetation, selectLevels } from '67js/addons/vegetation';

const forest = scatterVegetation({
  area: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 },
  density: 0.016,
  terrainHeight: (x, z) => Math.sin(x * 0.1) * 1.5,
  slopeLimit: 30,
  exclusion: (x, z) => Math.hypot(x, z) < 8,
  mix: { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2.5 },
  leaves: 'cards',
  seed: 11,
});
const view = selectLevels(forest.instances, camera.eye, { cullDistance: 120 });
const renderer = new Renderer67(canvas, [terrain, ...view.parts], options);
```

## Trees

`createTree(species | { species, height, leaves }, seed)` grows one tree. Species: `broadleaf`, `birch`, `conifer`, `palm`, `bush`.
The same species and seed always give the same tree.

The skeleton is a parametric recursive branching model: each generation has a length, wander, tropism (up or droop), taper and child spread.
It was chosen over space colonization because a species is a short readable preset, the cost is known before growing, and conifer whorls and palm fronds fit the same code.
Branches are swept tubes with parallel-transported rings, a taper, a root flare below the ground line and bark UVs (`u` around, `v` along, one tile per 0.6 m).
Leaves sit on terminal twigs, face outward and up with jitter, and carry vertex colors that darken toward the crown center, so the canopy has depth.
Shading normals blend toward the crown, so a flat card lights like part of a rounded crown.

The tree has three levels of detail, each listing parts with a `role`, `geometry`, `material` and `tintable` flag:

| Level | Content | Default switch distance |
| --- | --- | --- |
| 0 | Full skeleton, every leaf site | up to 38 m |
| 1 | Twigs dropped, fewer sides, one third of the leaves 1.7 times larger | 38 to 95 m |
| 2 | Trunk and main limbs, crown as merged clumps (low-poly blobs or crossed cards) | beyond 95 m |

Measured triangle counts for seed 4 (level 0 / 1 / 2):

| Species | `cards` | `mesh` |
| --- | --- | --- |
| broadleaf | 7.4k / 2.4k / 0.7k | 16.0k / 5.3k / 3.0k |
| birch | 10.7k / 3.3k / 0.8k | 21.9k / 7.0k / 2.8k |
| conifer | 26.1k / 7.2k / 2.3k | 63.9k / 19.8k / 3.4k |
| palm | 6.4k / 1.9k / 1.1k | 11.8k / 3.7k / 2.9k |
| bush | 4.7k / 1.7k / 0.5k | 10.9k / 3.7k / 1.9k |

## Leaves: cards or mesh

`leaves: 'cards'` (default) uses a procedural RGBA leaf texture (`material.map`) on crossed, slightly curved cards with `alphaMode: 'mask'`, `alphaCutoff: 0.5` and `doubleSided: true`.
Until the renderer honors alpha masking, cards draw as opaque quads: use `leaves: 'mesh'` there.
Cards also carry both faces in the geometry, so they stay visible with back-face culling. Once `doubleSided` is honored, that duplicate costs triangles you can drop.
`leaves: 'mesh'` builds real leaf silhouettes (ovate, fir spray, palm leaflet) as folded, drooping meshes with the `foliage` tag. It needs no alpha support and costs about twice the triangles.

Wind: the vertex shader sways only the `foliage` and `grass` tags, by local height. Mesh leaves and grass blades therefore sway, and bark (a standard material) stays still.
Textured materials must use a standard tag, so `cards` do not sway yet. A small shader hook that reads the tag for textured materials would add it.

## Grass and flowers

`createGrassClump({ blades, height, radius, style, seed })` builds `blades` (curved tapered blades with the `grass` tag, level 1 has half the blades) or `cards` (three crossed alpha cards).
`createFlowerPatch({ flowers, height, color, seed })` builds stems, six petals and a center; color lives in vertex colors.
`createGrassField(options)` is `scatterVegetation` with a grass and flower mix at 2.5 clumps per square meter.

## Scattering

`scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, seed, mix, variants, leaves, scale, spacing })`:

- Poisson-disk spacing (Bridson with restarts, so exclusion zones cannot strand regions). `density` is instances per square meter; spacing defaults to `sqrt(0.6 / density)`.
- `slopeLimit` is in degrees, measured from `terrainHeight` over a 1.2 m span. `exclusion(x, z)` returns true to keep a spot clear.
- `mix` weighs species (`broadleaf`, `birch`, `conifer`, `palm`, `bush`, `grass`, `flowers`); low-frequency noise groups species into stands.
- `variants` (default 3) variants per species are shared by every instance, so the renderer batches each part by geometry identity. Instances differ by yaw, scale and tint.

It returns `{ instances, parts, variants, counts }`; `parts` shows every instance at level 0.

## Level of detail

`selectLevels(instances, eye, { distanceScale, hysteresis, cullDistance })` sets each instance's level from its distance to `eye`.
A level changes only after the distance passes its threshold by `hysteresis` (default 0.12), so instances on a boundary do not flicker.
It returns `{ parts, changed, levelCounts, culled, triangles }`. Part objects are cached per instance and level, so unchanged instances keep their identity.
When `changed` is true, build a new renderer from the new parts. Grass switches at 24 m; set `cullDistance` to drop far instances.

`vegetationParts(variant, matrix, level, name)` places one tree or clump yourself.

## Measured

On the demo clearing (125 trees and bushes, 1,941 grass clumps and 129 flower patches, camera at the clearing edge), headless Chrome with GPU:
`mesh` leaves with level of detail draw 2.28M triangles in 65 draws (3.78M without level of detail); `cards` draw 1.15M. Building the scene takes about 1 s; a frame takes under 0.2 s.
Meshes and textures are built in plain JavaScript, so tests run in Node.

## Limits

- Cards need the renderer's alpha mask to look right, and do not sway under the current shader.
- Level changes pop; there is no cross-fade. Level 2 crowns are blobs or crossed cards, not baked imposters.
- Species are fixed presets; there is no seasonal color, wind-bent skeleton or collision with other trees.
