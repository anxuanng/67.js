<p align="center">
  <a href="https://67js.codepawl.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://67js.codepawl.com/brand/wordmark-dark.svg?v=0.10.0" />
      <img src="https://67js.codepawl.com/brand/wordmark-light.svg?v=0.10.0" alt="67.js" width="260" />
    </picture>
  </a>
</p>

<p align="center"><strong>A WebGL2 engine for 3D scenes that people and agents can build, inspect and render.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@codepawlhq/67js"><img src="https://img.shields.io/npm/v/@codepawlhq/67js?color=3b6e22&label=npm" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b6e22" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520.19-3b6e22" alt="Node.js 20.19 or later" />
</p>

<p align="center">
  <a href="https://67js.codepawl.com">Showcase</a> ·
  <a href="https://67js.codepawl.com/docs.html">Documentation</a> ·
  <a href="https://67js.codepawl.com/llms.txt">Guide for agents</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="https://67js.codepawl.com/previews/forest.webp?v=0.10.0" alt="Birch, beech and fir trees with scanned leaves over a grassy slope, rendered by 67.js" width="100%" />
</p>

67.js is a custom WebGL2 renderer with addons for terrain, vegetation, liquid, vehicles, characters and media export.
Every scene is plain data: geometry, a matrix and a material for each part.
The renderer batches parts that share geometry into instanced draws, and it plans GPU memory before it allocates.
An MCP server lets an agent author a scene as a JSON recipe, look at PNG previews and render images or video.

<table>
  <tr>
    <td width="50%"><a href="docs/terrain.md"><img src="https://67js.codepawl.com/previews/terrain.webp" alt="Rolling hills of scanned grass and mud rising to rocky ridges" /></a><br /><b>Terrain</b>: chunked heightfield, four scanned ground layers</td>
    <td width="50%"><a href="docs/spume.md"><img src="https://67js.codepawl.com/previews/spume.webp" alt="A jet of baked liquid hitting a concrete slab" /></a><br /><b>Spume liquid</b>: baked water that refracts and sprays</td>
  </tr>
  <tr>
    <td><a href="docs/vehicle.md"><img src="https://67js.codepawl.com/previews/vehicle.webp" alt="A jeep leaning into a bend on a marked path" /></a><br /><b>Vehicles</b>: steering, body roll and wheels on a path</td>
    <td><a href="docs/lighting.md"><img src="https://67js.codepawl.com/previews/lighting.webp" alt="Metal spheres of rising roughness lit by an HDR environment" /></a><br /><b>HDRI lighting</b>: reflections that blur with roughness</td>
  </tr>
  <tr>
    <td><a href="https://67js.codepawl.com/object.html"><img src="https://67js.codepawl.com/previews/wall-e-exploded.webp" alt="An exploded robot study with 574 separate parts" /></a><br /><b>Assembly studio</b>: 574 parts that explode apart</td>
    <td><a href="https://67js.codepawl.com/nature.html"><img src="https://67js.codepawl.com/previews/nature.webp" alt="A valley with a river, a wooden bridge and stylized trees" /></a><br /><b>Nature world</b>: viewpoints, daylight, wind and water</td>
  </tr>
</table>

## Install

```sh
npm install 67js@npm:@codepawlhq/67js
```

The registry name is `@codepawlhq/67js`. The command installs it under the alias `67js`, so imports stay short.
The package is ESM and bundles its runtime dependencies. It needs Node.js 20.19 or later for the tools, and a WebGL2 browser for rendering.

## Quick start

```js
import { Renderer67, box, sphere } from '67js';

// Column-major 4x4 matrix: scale, then move.
const placed = ([x, y, z], [width, height, depth] = [1, 1, 1]) =>
  new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);

const parts = [
  {
    name: 'Floor',
    geometry: box(),
    matrix: placed([0, 0, 0], [8, 0.1, 8]),
    material: { color: [0.4, 0.42, 0.45], metallic: 0, roughness: 0.9, emission: 0 },
  },
  {
    name: 'Ball',
    geometry: sphere(48, 24),
    matrix: placed([0, 1, 0]),
    material: { color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.35, emission: 0 },
  },
];

const canvas = document.querySelector('canvas');
const renderer = new Renderer67(canvas, parts, { samples: 4, memoryBudgetMiB: 256 });
renderer.render({ eye: [4, 3, 6], target: [0, 1, 0] });
```

Call `renderer.resize()` after the canvas changes size, and `renderer.dispose()` before you replace the renderer.
Use `renderer.updateParts(parts)` to move or recolour parts without a new upload.
The [guide](docs/guide.md) covers cameras, lights, effects and every material field.

A forest on scanned terrain takes a few more lines:

```js
import { createTerrain } from '67js/addons/terrain';
import { loadLeafTextures } from '67js/addons/texture-set';
import { scatterVegetation, selectLevels } from '67js/addons/vegetation';

const eye = [0, 4, 22];
const terrain = createTerrain({ size: 400, chunks: 8, seed: 11 });
const forest = scatterVegetation({
  area: { minX: -60, maxX: 60, minZ: -80, maxZ: 20 },
  terrainHeight: terrain.heightAt,
  leafTextures: await loadLeafTextures('https://67js.codepawl.com/textures/leaves'),
  seed: 23,
});
const trees = selectLevels(forest.instances, eye, { cullDistance: 160 }).parts;
```

The scanned textures are not in the npm package. The site serves them with open CORS, or you can copy `public/textures` from this repository to your own host.

## What is in the box

The core export is the renderer with geometry primitives, cameras, lights, effects and GLB export.
Each addon is a separate import, so a page loads only what it uses.

| Area | Import | What it does |
| --- | --- | --- |
| Rendering | `67js` | Instanced PBR renderer, shadows, MSAA, HDR, bloom, alpha masks and blending, render budgets. See [lighting](docs/lighting.md) and [material maps](docs/material-maps.md). |
| Environment | `67js/addons/hdri` | Image-based lighting from Radiance `.hdr` files, with blurred reflections. |
| Terrain | `67js/addons/terrain`, `67js/addons/texture-set` | [Chunked terrain](docs/terrain.md) with level of detail and a four-layer splat material from scanned textures. |
| Grass | `67js/addons/grass` | [Grass fields](docs/grass.md) of clumped, curved blades with rolling wind gusts, paths and level of detail. |
| Clutter | `67js/addons/clutter` | [Pebbles, rocks, twigs and fallen leaves](docs/clutter.md) scattered over terrain in streamed tiles. |
| Vegetation | `67js/addons/vegetation` | [Seeded trees, bushes and grass](docs/vegetation.md) with scanned leaves and bark, wind and level of detail. |
| Liquid | `67js/addons/spume` | [Baked liquid playback](docs/spume.md) with refraction and spray from the Spume solver. |
| Vehicles | `67js/addons/vehicle` | [Wheeled vehicles on a path](docs/vehicle.md): wheel spin, steering, roll, pitch and ground following. |
| Characters | `67js/addons/gltf`, `67js/addons/retarget` | [glTF import](docs/gltf.md) with skins, morphs and compressed meshes, and [clip retargeting](docs/retarget.md) between rigs. |
| Physics | `67js/addons/physics` | [Rapier contacts and joints](docs/physics.md) recorded into a timeline for repeatable seeks. |
| Modeling | `67js/addons/modeling`, `sculpt`, `surface`, `shrinkwrap`, `mesh-query` | [Modeling](docs/modeling.md), [sculpt brushes](docs/sculpt.md), [surface patches](docs/surface.md), [shrinkwrap](docs/shrinkwrap.md) and [mesh queries](docs/mesh-query.md). |
| Agents | `67js/addons/agent-scene`, `67js/addons/agent-asset` | [Scene sessions](docs/agent-scene.md) with revisions, checkpoints and atomic edits. |

The full list of guides is on the [documentation page](https://67js.codepawl.com/docs.html).

## For agents

The package includes an MCP server that connects an agent to a persistent browser renderer.

```sh
npx 67js-mcp --backend gpu --memory 192
```

The server needs Node.js 20.19 or later and a local Chrome installation.
Agents author [JSON recipes](docs/agent-scene.md), set [lights and fog](docs/agent-look.md), import [GLB assets](docs/agent-asset.md) and author [motion](docs/agent-motion.md).
They get PNG previews back, compare up to four views in one [review grid](docs/agent-review.md) and run [render jobs](docs/agent-render-jobs.md) for stills and MP4 video.
The server accepts no arbitrary code and no remote asset URLs. The [MCP reference](docs/mcp.md) lists its tools.

Two skills teach an agent the engine: [build-67js-scene](skills/build-67js-scene/SKILL.md) for scenes and materials, and [render-67js-media](skills/render-67js-media/SKILL.md) for image and video export.
Give an agent [llms.txt](https://67js.codepawl.com/llms.txt) for the plain-text guide.

## Render images and video

The render command exports a scene to PNG or MP4 through headless Chrome, on the GPU or on the CPU.

```sh
npm run render -- --kind image --scene nature --backend gpu --preset high --output artifacts/nature.png
npm run render -- --kind video --scene motion --aspect portrait --backend gpu --encoder gpu --output artifacts/short.mp4
```

Video export streams one frame at a time and waits for encoder backpressure, so a film never sits in memory.
NVENC is used when its preflight succeeds, with libx264 as the fallback.
Each export writes a JSON report with render, capture and encoder time and peak memory.
The [render skill](skills/render-67js-media/SKILL.md) lists every preset and flag.

## Run the showcase locally

1. Install Node.js 22.12 or later.
2. Run `npm ci`.
3. Run `npm run dev`. Vite prints the local URL.

| Page | What you see |
| --- | --- |
| `/` | Home page with examples, install commands and release data. |
| `/object.html` | Assembly studio with orbit, explosion, layers, finishes and GLB export. |
| `/nature.html` | A valley with viewpoints, daylight, wind and water ripples. |
| `/film.html` | A 187-second procedural trailer with playback controls. |
| `/motion.html` | A 12-second keyframe animation with HDR. |
| `/view2d.html` | Flat vector scenes and orthographic model views. |
| `/assets.html` | A GLB viewer with textures, clips and PNG capture. |

## Performance claims

Measured results and their limits are in [verification.md](docs/verification.md).
They compare matching scenes on the same hardware. They do not show a general speed advantage over Three.js or visual parity with Blender.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. It covers setup, checks, code style and the release flow.

## Credits

- [gl-matrix](https://github.com/toji/gl-matrix) supplies the matrix math.
- The glTF addon bundles the [Three.js](https://threejs.org/) glTF decoder under its MIT license. The core renderer does not depend on Three.js.
- Textures, leaf atlases and the HDRI on the site are CC0 scans from [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com). See [the texture credits](public/textures/CREDITS.md).
- WALL·E is a Disney/Pixar character. The study is procedural geometry with no external model assets.
- The trailer study follows the shot order of [a Universal Pictures trailer](https://www.youtube.com/watch?v=uYPbbksJxIg) with procedural sets and an original score. It contains no film footage or soundtrack samples.

[MIT](LICENSE) © CodePawl
