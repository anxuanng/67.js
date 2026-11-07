# Grass fields

`67js/addons/grass` is in the current source and not yet published. It covers terrain with clumped, curved blades in tiles, with distance level of detail. Each tile is one part and one draw, and a coarser level keeps a fixed subset of the same blades, so a tile that changes level does not reshuffle.

## Tiles and levels of detail

The docs run with the core module only, so this example draws flat blade strips by hand with the same tile rule as the addon: three levels that keep all, 35 percent and 12 percent of the blades, at up to 10 m, 26 m and 60 m, with wider blades farther out. Move the slider to walk the eye across the field and watch tiles change level. The console prints what `grass.stats()` would: tiles per level, triangles and an estimate of geometry bytes.

```js live poster=grass-tiles
import { Renderer67 } from '67js';

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const fieldSize = 48;
const tileSize = 4;
const levels = [
  { distance: 10, keep: 1, widthScale: 1 },
  { distance: 26, keep: 0.35, widthScale: 2 },
  { distance: 60, keep: 0.12, widthScale: 4.5 },
];
const density = 4;
const bladesPerTile = Math.round(density * tileSize * tileSize);

// One blade is a two-sided strip: a quad of two triangles, front and back.
const blade = {
  positions: new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0, -0.5, 0, 0, 0, 1, 0, 0.5, 0, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
  indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
};
const triangles = 2;
const material = { color: [0.3, 0.55, 0.16], metallic: 0, roughness: 0.8 };

// Blades of a tile come from the tile's own seed, in a fixed order, so keeping the first N keeps the same blades.
const tiles = [];
for (let row = 0; row < fieldSize / tileSize; row++) {
  for (let column = 0; column < fieldSize / tileSize; column++) {
    const next = random(row * 1000 + column + 7);
    const blades = Array.from({ length: bladesPerTile }, () => ({
      x: -fieldSize / 2 + (column + next()) * tileSize,
      z: -fieldSize / 2 + (row + next()) * tileSize,
      yaw: next() * Math.PI,
      height: 0.25 + next() * 0.3,
    }));
    tiles.push({ centerX: -fieldSize / 2 + (column + 0.5) * tileSize, centerZ: -fieldSize / 2 + (row + 0.5) * tileSize, blades, level: -1 });
  }
}

function levelFor(tile, eyeX) {
  const distance = Math.hypot(tile.centerX - eyeX, tile.centerZ);
  const boundary = levels.findIndex(entry => distance < entry.distance);
  const target = boundary === -1 ? levels.length : boundary;
  // Hysteresis: a tile moves to a coarser level only when it is 10 percent past the boundary.
  if (tile.level >= 0 && target > tile.level && distance < levels[tile.level].distance * 1.1) return tile.level;
  return target;
}

function update(eyeX) {
  let changed = false;
  const stats = { tiles: [0, 0, 0], culled: 0, triangles: 0 };
  for (const tile of tiles) {
    const level = levelFor(tile, eyeX);
    if (level !== tile.level) changed = true;
    tile.level = level;
    if (level >= levels.length) stats.culled++;
    else {
      stats.tiles[level]++;
      stats.triangles += Math.ceil(bladesPerTile * levels[level].keep) * triangles;
    }
  }
  stats.geometryBytes = stats.triangles * 3 * 24;
  return { changed, stats };
}

function partsFor() {
  const parts = [];
  for (const [tileIndex, tile] of tiles.entries()) {
    if (tile.level >= levels.length) continue;
    const { keep, widthScale } = levels[tile.level];
    for (const [bladeIndex, entry] of tile.blades.slice(0, Math.ceil(bladesPerTile * keep)).entries()) {
      const c = Math.cos(entry.yaw);
      const s = Math.sin(entry.yaw);
      const width = 0.03 * widthScale;
      parts.push({ name: `Blade ${tileIndex}-${bladeIndex}`, geometry: blade, material, matrix: new Float32Array([c * width, 0, -s * width, 0, 0, entry.height, 0, 0, s, 0, c, 0, entry.x, 0, entry.z, 1]) });
    }
  }
  return parts;
}

const canvas = document.querySelector('#scene');
let eyeX = -12;
let { stats } = update(eyeX);
console.log('tiles', tiles.length, 'blades per tile at full detail', bladesPerTile);
console.log('stats()', stats);
const renderer = new Renderer67(canvas, partsFor(), { world: true });

function draw() {
  renderer.render({ eye: [eyeX, 1.3, 0], target: [eyeX + 12, 0.3, 4], fov: 60, wind: 0.3 });
}

const slider = document.createElement('input');
slider.type = 'range';
slider.min = -16;
slider.max = 16;
slider.step = 0.5;
slider.value = eyeX;
slider.setAttribute('aria-label', 'Eye position along the field');
slider.style.cssText = 'position:fixed;left:8px;bottom:8px;width:40%';
slider.addEventListener('input', () => {
  eyeX = Number(slider.value);
  const result = update(eyeX);
  if (result.changed) {
    renderer.replaceParts(partsFor());
    console.log('update(eye) = true', result.stats);
  }
  draw();
});
document.body.append(slider);
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
draw();
addEventListener('pagehide', () => renderer.dispose());
```

The `update` function returns `changed` the way `grass.update(eye)` returns `true`: rebuild the part list only then, not every frame.

## Grow a real field

1. Create the field with `createGrass({ preset, area, terrainHeight, mask, eye })`. Presets are `meadow`, `lawn`, `savanna` and `wild`.
2. Add `grass.parts` to the renderer and pass `wind` in each frame.
3. When `grass.update(eye)` returns true, call `renderer.replaceParts` with the new part list.

```js
import { Renderer67 } from '67js';
import { createGrass } from '67js/addons/grass';

const grass = createGrass({
  preset: 'meadow',
  area: { minX: -40, maxX: 40, minZ: -50, maxZ: 50 },
  terrainHeight: terrain.heightAt,
  mask: (x, z) => (Math.abs(x) < 1.5 ? 0 : 1),
  eye,
});
const renderer = new Renderer67(canvas, [...terrain.parts, ...grass.parts], { world: true, memoryBudgetMiB: 512 });
function draw(eye, seconds) {
  if (grass.update(eye)) renderer.replaceParts([...terrain.parts, ...grass.parts]);
  renderer.render({ eye, target, wind: 0.5, time: seconds });
}
console.log(grass.stats());
```

Tint the ground under the grass with `grass.groundColor`. On a splat terrain, darken every layer the grass covers, not only the grass layer, because soil under a sward sits in the blades' shade and a bright floor between blades is what makes a field look fake.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `area` | required | `{ minX, maxX, minZ, maxZ }` in metres. |
| `preset` | `'meadow'` | `meadow`, `lawn`, `savanna` or `wild`. Every other option overrides it. |
| `terrainHeight` | `() => 0` | Ground height at `(x, z)`. |
| `mask` | none | Coverage from 0 to 1. Zero clears paths, and partial values thin and shorten the grass. |
| `density` | from preset | Blades per square metre at full detail. |
| `height`, `bend`, `width` | from preset | `[min, max]` blade height in metres, tip bend 0 to 1, root width in metres. |
| `clumpSize`, `clumpStrength` | from preset | Clump cell size in metres and how strongly blades follow their clump. |
| `dryness`, `patchiness`, `stalks` | from preset | Dry share, field-scale variation (0 gives an even field), seed stalk share (`lawn` has none). |
| `base`, `tip`, `dry` | from preset | Linear RGB colours of the root, the green tip and the dry tip. |
| `tileSize` | `4` | Tile edge in metres. Each tile is one part and one draw. |
| `levels` | `GRASS_LEVELS` | Distance, kept share, segments and width scale per level. |
| `cullDistance` | last level's distance | Tiles farther than this are dropped. |
| `castShadow` | `false` | Blade shadows cost a full extra pass of every blade. Blades still receive shadows. |
| `eye`, `seed` | area centre, `1` | Initial camera position and random seed. |

`createGrass` returns `{ parts, update(eye), material, stats(), groundColor, settings }`. `stats()` returns tile counts per level, triangles, vertices and an estimate of geometry bytes. The default levels are 0 up to 10 m (all blades, 4 segments, 1x width), 1 from 10 to 26 m (35 percent, 2 segments, 2x) and 2 from 26 to 60 m (12 percent, one triangle, 4.5x).

## Cost

On the demo meadow (80 by 100 m, eye 1.3 m above the ground, RTX 3060, headless Chrome), an eye height of 1.3 m showed 344 tiles, 1.21 M triangles and about 94 MB of geometry, built in 3.0 s. At 7 m the field showed 316 tiles, 0.74 M triangles and about 61 MB, built in 2.1 s. Thin patches drop blades, so the default meadow builds about 12 percent faster than the same field with `patchiness: 0` (measured in Node). Set `memoryBudgetMiB` high enough for the grass geometry, and lower `density` or `cullDistance` for phones.

## Clutter and baked light

`67js/addons/clutter` is in the current source and not yet published. It scatters pebbles, rocks, twigs and fallen leaves over terrain in the same streamed tiles. Pick a `preset` (`meadow`, `forest`, `riverbed`, `scree`), pass `terrainHeight`, and add `clutter.parts` next to the grass. The [clutter contract](https://github.com/codepawl/67.js/blob/main/docs/clutter.md) lists options and budgets.

`67js/addons/light-bake` is in the current source and not yet published. `bakeLightmaps(parts, lights, options)` ray traces the light that bounces between surfaces into a lightmap texture for each part, and returns new parts that draw it through the emissive map. Direct light stays live. The [light bake contract](https://github.com/codepawl/67.js/blob/main/docs/light-bake.md) lists the limits.

## Limits

- Blades are flat strips, so seen exactly edge-on they thin out.
- Tiles change level with a pop, not a cross-fade.
- Wind has one fixed direction, and there is no interaction with characters or vehicles.

The [grass contract](https://github.com/codepawl/67.js/blob/main/docs/grass.md) lists options, levels, measured budgets and limits.

## Common mistakes

- Calling `replaceParts` every frame. Call it when `update(eye)` returns true.
- Leaving `castShadow` on for a large field. It doubles the blade cost.
- A `mask` that never reaches 0 on a path, so grass grows on it.
- Forgetting to raise `memoryBudgetMiB` for a dense field.
- Lighting the ground bright under the grass, so the gaps look like bare soil.
