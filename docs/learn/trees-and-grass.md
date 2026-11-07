# Trees and grass

`67js/addons/vegetation` grows seeded trees with real branches and leaf cards, plus grass and flowers. It is available from version `0.10.0`. It scatters instances with Poisson-disk spacing, shares a few variants per species so the renderer can batch them, and picks a level of detail per instance from the camera.

## Scatter, then pick detail by distance

The docs run with the core module only, so this example scatters trees by hand and mirrors what the addon returns: a seeded scatter with a slope limit and an exclusion zone, and a per-camera level choice. Drag to orbit and the near trees get the detailed crown while the far ones get a coarse one. The slider changes the density. The console prints what `selectLevels` reports: level counts and triangles.

```js live poster=trees-scatter
import { Renderer67, cylinder, sphere } from '67js';

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
const terrainHeight = (x, z) => 1.5 * Math.sin(x * 0.18) * Math.cos(z * 0.15);
const slopeAt = (x, z) => Math.atan(Math.hypot(terrainHeight(x + 0.6, z) - terrainHeight(x - 0.6, z), terrainHeight(x, z + 0.6) - terrainHeight(x, z - 0.6)) / 1.2) * 180 / Math.PI;
const exclusion = (x, z) => Math.hypot(x, z) < 3.5;

// Jittered grid: each cell holds at most one tree, so spacing is at least about half a cell.
function scatter({ area, density, slopeLimit, seed }) {
  const next = random(seed);
  const cell = Math.sqrt(1 / density);
  const instances = [];
  for (let x = -area / 2; x < area / 2; x += cell) {
    for (let z = -area / 2; z < area / 2; z += cell) {
      const px = x + next() * cell;
      const pz = z + next() * cell;
      if (exclusion(px, pz) || slopeAt(px, pz) > slopeLimit) continue;
      instances.push({ x: px, z: pz, y: terrainHeight(px, pz), scale: 0.8 + next() * 0.6, variant: Math.floor(next() * 3) });
    }
  }
  return instances;
}

const trunk = cylinder(12, 0.02, 2);
const crownLevels = [sphere(20, 14), sphere(8, 6)];
const crownMaterials = [0, 1, 2].map(variant => ({ color: [0.12 + variant * 0.04, 0.38 + variant * 0.05, 0.14], metallic: 0, roughness: 0.8 }));
const trunkMaterial = { color: [0.3, 0.2, 0.12], metallic: 0, roughness: 0.9 };
const triangles = geometry => geometry.indices.length / 3;

const state = { density: 0.35, yaw: 0.7, distance: 24, pitch: 0.5 };
let instances = scatter({ area: 40, density: state.density, slopeLimit: 14, seed: 11 });
let levels = [];

function eye() {
  const flat = Math.cos(state.pitch) * state.distance;
  return [Math.sin(state.yaw) * flat, Math.sin(state.pitch) * state.distance + 2, Math.cos(state.yaw) * flat];
}

// Level 0 within 14 m of the camera, level 1 beyond it. Part objects are cached, so unchanged instances keep their identity.
function selectLevels(position) {
  let changed = false;
  const counts = [0, 0];
  let totalTriangles = 0;
  instances.forEach((tree, index) => {
    const level = Math.hypot(tree.x - position[0], tree.z - position[2]) < 14 ? 0 : 1;
    if (levels[index] !== level) changed = true;
    levels[index] = level;
    counts[level]++;
    totalTriangles += triangles(trunk) + triangles(crownLevels[level]);
  });
  return { changed, counts, totalTriangles };
}

function partsFor() {
  return instances.flatMap((tree, index) => [
    { name: `Trunk ${index}`, geometry: trunk, matrix: new Float32Array([0.18 * tree.scale, 0, 0, 0, 0, 1.2 * tree.scale, 0, 0, 0, 0, 0.18 * tree.scale, 0, tree.x, tree.y + 0.6 * tree.scale, tree.z, 1]), material: trunkMaterial },
    { name: `Crown ${index}`, geometry: crownLevels[levels[index]], matrix: new Float32Array([0.9 * tree.scale, 0, 0, 0, 0, 1.1 * tree.scale, 0, 0, 0, 0, 0.9 * tree.scale, 0, tree.x, tree.y + 1.7 * tree.scale, tree.z, 1]), material: crownMaterials[tree.variant] },
  ]);
}

const canvas = document.querySelector('#scene');
canvas.style.touchAction = 'none';
const first = selectLevels(eye());
console.log(`scattered ${instances.length} trees, 3 variants, slope limit 14°`, first);
const renderer = new Renderer67(canvas, partsFor(), { world: true });

function draw() {
  const position = eye();
  const result = selectLevels(position);
  if (result.changed) {
    renderer.replaceParts(partsFor());
    console.log('levels changed:', { levelCounts: result.counts, triangles: result.totalTriangles });
  }
  renderer.render({ eye: position, target: [0, 1, 0], fov: 45 });
}

canvas.addEventListener('pointerdown', event => canvas.setPointerCapture(event.pointerId));
canvas.addEventListener('pointermove', event => {
  if (!canvas.hasPointerCapture(event.pointerId)) return;
  state.yaw -= event.movementX * 0.01;
  state.pitch = Math.min(1.3, Math.max(0.1, state.pitch + event.movementY * 0.01));
  draw();
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  state.distance = Math.min(40, Math.max(6, state.distance * Math.exp(event.deltaY * 0.001)));
  draw();
}, { passive: false });

const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0.1;
slider.max = 0.8;
slider.step = 0.05;
slider.value = state.density;
slider.setAttribute('aria-label', 'Trees per square metre');
slider.style.cssText = 'position:fixed;left:8px;bottom:8px;width:40%';
slider.addEventListener('change', () => {
  state.density = Number(slider.value);
  instances = scatter({ area: 40, density: state.density, slopeLimit: 14, seed: 11 });
  levels = [];
  selectLevels(eye());
  renderer.replaceParts(partsFor());
  console.log(`density ${state.density} per m²: ${instances.length} trees`);
  draw();
});
document.body.append(slider);
new ResizeObserver(() => { renderer.resize(); draw(); }).observe(canvas);
draw();
addEventListener('pagehide', () => renderer.dispose());
```

## Grow the real forest

```js
import { Renderer67 } from '67js';
import { scatterVegetation, selectLevels } from '67js/addons/vegetation';
import { loadLeafTextures } from '67js/addons/texture-set';

const forest = scatterVegetation({
  area: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  density: 0.04,
  terrainHeight: terrain.heightAt,
  slopeLimit: 30,
  exclusion: (x, z) => Math.hypot(x, z) < 4,
  mix: { broadleaf: 3, birch: 1, bush: 2 },
  leafTextures: await loadLeafTextures('/textures/leaves'),
});
let view = selectLevels(forest.instances, eye);
const renderer = new Renderer67(canvas, view.parts, { world: true });
console.log(forest.counts, view.levelCounts, view.triangles);
```

1. Scatter with `scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, mix, leaves })`.
2. Pick detail per camera with `selectLevels(forest.instances, eye)`.
3. Pass `view.parts` to `Renderer67` and rebuild when `view.changed` is true.

Cards (`leaves: 'cards'`, the default) are single-sided, alpha-masked, double-sided `foliage` textures that sway with the wind. `'mesh'` leaves cost about twice the triangles. Pass `barkTextures` for scanned bark and `leafTextures: await loadLeafTextures('/textures/leaves')` for scanned leaf cards.

## Options

`scatterVegetation({ area, density, terrainHeight, slopeLimit, exclusion, seed, mix, variants, leaves, scale, spacing })` returns `{ instances, parts, variants, counts }`.

| Option | Meaning |
| --- | --- |
| `area` | The ground rectangle. |
| `density` | Instances per square metre. Spacing defaults to `sqrt(0.6 / density)` (Poisson-disk, Bridson with restarts, so exclusion zones cannot strand regions). |
| `terrainHeight` | `(x, z) => y`. Pass `terrain.heightAt`. |
| `slopeLimit` | Degrees, measured from `terrainHeight` over a 1.2 m span. |
| `exclusion(x, z)` | Returns true to keep a spot clear. |
| `mix` | Weights per species: `broadleaf`, `birch`, `conifer`, `palm`, `bush`, `grass`, `flowers`. Low-frequency noise groups species into stands. |
| `variants` | Default 3 variants per species, shared by every instance so the renderer batches by geometry identity. Instances differ by yaw, scale and tint. |
| `leaves` | `'cards'` (default) or `'mesh'`. |

`selectLevels(instances, eye, { distanceScale, hysteresis, cullDistance })` returns `{ parts, changed, levelCounts, culled, triangles }`. A level changes only after the distance passes its threshold by `hysteresis` (default 0.12), so instances on a boundary do not flicker. Grass switches at 24 m. Set `cullDistance` to drop far instances, `fade` for a screen-door cross-fade, and `impostors` for a last level that draws one baked card per tree. `vegetationParts(variant, matrix, level, name)` places one tree or clump yourself.

## Cost

On the demo clearing (125 trees and bushes, 1,941 grass clumps and 129 flower patches, camera at the clearing edge, headless Chrome with a GPU), `mesh` leaves with level of detail drew 2.28M triangles in 65 draws, against 3.78M without level of detail. `cards` drew 1.15M. Building the scene took about 1 s and a frame took under 0.2 s (docs/vegetation.md). The [vegetation contract](https://github.com/codepawl/67.js/blob/main/docs/vegetation.md) lists species, triangle budgets and limits.

## Common mistakes

- Making a new geometry per tree. Share the variants, or every tree is its own draw.
- Calling `replaceParts` when `changed` is false.
- Expecting wind-bent skeletons or collisions between trees. Species are fixed presets without either.
- Using cards for a close-up. Without `leafTextures` the leaf sprites are 128 px and look flat from under a few metres; scanned cards hold up to about 1 m.
- Forgetting `exclusion` on a path or a house, and finding trees growing through it.
