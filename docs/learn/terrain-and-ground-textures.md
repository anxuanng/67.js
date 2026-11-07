# Terrain and ground textures

`67js/addons/terrain` builds a chunked, seeded heightfield with distance level of detail. `67js/addons/texture-set` loads CC0 scans and a four-layer ground material draws them with slope, height and mask rules, height-based edge blending, triplanar cliffs and anti-tiling. Both are available from version `0.10.0`.

## The idea: a height function and rules

The docs run in the browser with the core module only, so the example builds a small heightfield by hand and sorts its triangles with the same kind of rules that the splat material uses: a slope range and a height range per layer. Drag the sliders. Grass takes what the other layers leave, rock takes the steep triangles and snow takes the high, flat ones. The console prints how many triangles each layer got and what `heightAt` returns for the ball.

```js live poster=terrain-rules
import { Renderer67, sphere } from '67js';

// The docs frame shares the engine of the page, so take the typed arrays that the engine checks for. In your own project this line changes nothing.
const { Float32Array, Uint16Array, Uint32Array } = window.parent;

const size = 40;
const cells = 64;
const heightAt = (x, z) => 2.2 * Math.sin(x * 0.22 + 0.5) * Math.cos(z * 0.19) + 1.1 * Math.sin(x * 0.5 + z * 0.4)
  + 0.5 * Math.sin(z * 0.9 - x * 0.3) + 4.5 * Math.exp(-((x - 7) ** 2 + (z + 5) ** 2) / 70);

function build(slopeLimit, snowLine) {
  const layers = { grass: [], rock: [], snow: [] };
  const step = size / cells;
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const x0 = -size / 2 + column * step;
      const z0 = -size / 2 + row * step;
      const corner = (dx, dz) => [x0 + dx * step, heightAt(x0 + dx * step, z0 + dz * step), z0 + dz * step];
      for (const triangle of [[corner(0, 0), corner(0, 1), corner(1, 0)], [corner(1, 0), corner(0, 1), corner(1, 1)]]) {
        const [a, b, c] = triangle;
        const edgeA = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const edgeB = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const normal = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
        const length = Math.hypot(...normal);
        const unit = normal.map(value => value / length);
        const slope = Math.acos(unit[1]) * 180 / Math.PI;
        const height = (a[1] + b[1] + c[1]) / 3;
        const layer = slope > slopeLimit ? 'rock' : height > snowLine ? 'snow' : 'grass';
        layers[layer].push({ triangle, unit });
      }
    }
  }
  return layers;
}

function geometryOf(entries) {
  const positions = new Float32Array(entries.length * 9);
  const normals = new Float32Array(entries.length * 9);
  entries.forEach(({ triangle, unit }, index) => {
    triangle.forEach((point, corner) => {
      positions.set(point, index * 9 + corner * 3);
      normals.set(unit, index * 9 + corner * 3);
    });
  });
  return { positions, normals, indices: Uint32Array.from({ length: entries.length * 3 }, (unused, index) => index) };
}

const materials = {
  grass: { color: [0.25, 0.5, 0.18], metallic: 0, roughness: 0.9 },
  rock: { color: [0.42, 0.4, 0.38], metallic: 0, roughness: 0.85 },
  snow: { color: [0.92, 0.94, 0.97], metallic: 0, roughness: 0.6 },
};
const marker = { name: 'Marker', geometry: sphere(24, 16), matrix: new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, heightAt(0, 0) + 0.5, 0, 1]), material: { color: [0.9, 0.2, 0.2], metallic: 0, roughness: 0.4 } };

function partsFor(slopeLimit, snowLine) {
  const layers = build(slopeLimit, snowLine);
  const parts = Object.entries(layers).filter(([unused, entries]) => entries.length).map(([name, entries]) => ({
    name: `Terrain ${name}`, geometry: geometryOf(entries), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: materials[name],
  }));
  console.log(`slope limit ${slopeLimit}°, snow line ${snowLine} m:`, Object.fromEntries(Object.entries(layers).map(([name, entries]) => [name, entries.length])));
  return [...parts, marker];
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const state = { slope: 32, snow: 3.2, yaw: 0.6, pitch: 0.55, distance: 54 };
const renderer = new Renderer67(canvas, partsFor(state.slope, state.snow), { world: true });
console.log(`heightAt(0, 0) = ${heightAt(0, 0).toFixed(3)} m, ${cells * cells * 2} triangles`);

function draw() {
  const flat = Math.cos(state.pitch) * state.distance;
  renderer.render({ eye: [Math.sin(state.yaw) * flat, Math.sin(state.pitch) * state.distance, Math.cos(state.yaw) * flat], target: [0, 1, 0], fov: 40 });
}
function rebuild() {
  renderer.replaceParts(partsFor(state.slope, state.snow));
  draw();
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:12px;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
for (const [label, key, min, max] of [['slope limit', 'slope', 10, 70], ['snow line', 'snow', 0, 6]]) {
  const wrap = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = 0.5;
  input.value = state[key];
  input.addEventListener('change', () => { state[key] = Number(input.value); rebuild(); });
  wrap.append(label + ' ', input);
  bar.append(wrap);
}
document.body.append(bar);
canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  state.yaw -= event.movementX * 0.01;
  state.pitch = Math.min(1.3, Math.max(0.15, state.pitch + event.movementY * 0.01));
  draw();
});
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
addEventListener('pagehide', () => renderer.dispose());
```

The sliders apply on release (the `change` event), because each change rebuilds the triangle lists. The real addon does this per vertex in the shader, so the rules cost nothing on the CPU and blend smoothly instead of switching per triangle.

## Build the real terrain

1. Load a texture set per layer, then give the layers to one material: `const set = await loadTextureSet('/textures/leafy_grass')`, `material.layers = [{ ...set, scale: 3 }, ...]` and `material.splat = { rules }`.
2. Create the heightfield: `const terrain = createTerrain({ size, chunks, resolution, levels, seed })`. Give every entry of `terrain.parts` the one shared material.
3. Pass `terrain.heightAt` to `scatterVegetation` and to vehicles, and call `renderer.replaceParts` when `terrain.update(eye)` returns parts.

```js
import { Renderer67 } from '67js';
import { createTerrain } from '67js/addons/terrain';
import { loadTextureSet } from '67js/addons/texture-set';

const material = { color: [1, 1, 1], metallic: 0, roughness: 1, tag: 'standard' };
material.layers = [
  { ...await loadTextureSet('/textures/leafy_grass'), scale: 3 },
  { ...await loadTextureSet('/textures/rock'), scale: 4, triplanar: true },
];
material.splat = { rules: [undefined, { slope: [32, 90], slopeSoftness: 6 }] };

const terrain = createTerrain({ size: 600, chunks: 10, resolution: 32, levels: 4, seed: 7, material });
const renderer = new Renderer67(canvas, terrain.parts, { world: true });
function draw(eye) {
  const changed = terrain.update(eye);
  if (changed.length) renderer.replaceParts(terrain.parts);
  renderer.render({ eye, target: [0, 0, 0] });
}
```

## Options

`createTerrain({ size = 512, resolution = 32, chunks = 8, levels = 4, height, seed = 1, material, lodDistance, eye })` returns `{ parts, heightAt, normalAt, bounds, update, triangleCount, chunkSize, chunkLevels }`.

| Option | Meaning |
| --- | --- |
| `size` | The ground spans x and z from `-size / 2` to `size / 2`. |
| `chunks`, `resolution`, `levels` | `chunks` per side, each with `resolution` cells at level 0. `resolution` must divide by `2 ** (levels - 1)`. Level `n` uses `resolution / 2 ** n` cells. |
| `height` | A function `(x, z) => metres`, a square `Float32Array` of metres (see `heightmapFromImageData(imageData, amplitude)`), or noise options such as `amplitude` (14), `mountainAmplitude` (46), `featureSize` (160 m), `octaves`, `gain`, `lacunarity`, `warp`, `baseHeight` and `mountainMask(x, z)`. |
| `lodDistance` | Distance of the first level change, default 1.6 chunk sizes, doubling per level. |
| `holes` | Up to 64 `{ center: [x, z], radius }` circles that leave no surface. `terrain.isHole(x, z)` tells whether a point is inside one. |

`heightAt(x, z)` walks the same triangles as the level 0 mesh, so it matches the rendered surface there, and coordinates outside the ground clamp to the edge. `normalAt` interpolates smooth grid normals. `update(eye)` returns the parts whose geometry changed, and edges shared with a coarser neighbour snap onto it, so there are no cracks and no skirts. UVs are world metres `(x, z)`.

| Splat layer field | Meaning |
| --- | --- |
| `color`, `normal`, `roughness`, `height` | Descriptors from `loadTextureSet`. Missing ones fall back to mid grey, a flat normal, roughness 1 and height 0.5. |
| `scale` | Metres per texture tile (default 4). |
| `tint` | RGB multiplier on colour. |
| `normalStrength` | Scales the normal map tilt (default 1). |
| `triplanar` | Projects from the sides on steep slopes, so cliffs do not stretch. |

`material.splat.rules` has one entry per layer: `slope: [min, max]` in degrees, `height: [min, max]` in metres, each with `slopeSoftness` (4) and `heightSoftness` (1.5), and `mask: 'r' | 'g' | 'b' | 'a'` with `invertMask`. A layer with no rule takes what the others leave, so put grass first with no rule. Other `splat` options include `heightBlend` (0.22), `heightInfluence` (1), `triplanarStart` and `triplanarEnd` (38 and 52 degrees), `variation` (0 to 2, default 1), `edgeNoise` (0 to 2, default 1) and `parallax` (0 to 0.15 m, default 0.03). The [terrain contract](https://github.com/codepawl/67.js/blob/main/docs/terrain.md) lists every option.

## Cost

Measured on Windows with an RTX 3060, headless Chrome, 1600 by 900, 4x MSAA, HDRI, shadows and bloom, a 600 m terrain with 10 by 10 chunks at resolution 32 and 1,000 to 1,750 trees (docs/terrain.md):

| Camera | Terrain triangles | Scene triangles | Batches | Frame |
| --- | --- | --- | --- | --- |
| Low, close to the path | 50,432 | 1.23 M | 164 | 13.8 ms |
| High, whole scene | 12,896 | 0.53 M | 124 | 9.0 ms |

Splat textures took 68 MiB of 74 MiB of texture memory at 1K per layer. They live in three texture arrays (colour, normal, and roughness with height), resized to the largest source with mipmaps and up to 8x anisotropic filtering.

## Limits

- Up to four layers, and one splat material per draw, so all chunks share one. Eight 1K layers would take about 136 MiB against the 74 MiB above.
- The terrain is a heightfield, so there are no overhangs, caves or bridges, apart from `holes`.
- Changing `layers` or `splat` after the renderer exists needs a new renderer.
- Materials batch together only when they share the same `layers` array and `splat` object. Build them once.

## Common mistakes

- A splat material with a `map`, `normalMap` or a special tag such as `floor`. Use a standard PBR tag and no maps.
- A `resolution` that does not divide by `2 ** (levels - 1)`.
- One material per chunk. Chunks must share one material, or each chunk becomes its own draw.
- Standing something on `heightAt` inside a hole. `heightAt` ignores holes, so check `isHole` first.
- Calling `replaceParts` every frame. Do it only when `update(eye)` returns changed parts.
