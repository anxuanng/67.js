# Baked liquid

`67js/addons/spume` plays back liquid that the Spume GPU solver baked offline. It is available from version `0.10.0`. The browser does not simulate anything: it loads a cache of frames and shows the frame for a time, so scrubbing and looping are free.

## Cache, frame, time

The docs run with the core module only and cannot load a Spume cache, so this example bakes a tiny cache itself, packs every frame into int16 (the way Spume stores frames), and plays it back with a `partsAt(seconds)` function shaped like the addon's. Drag the slider to scrub. Tick Loop to wrap time instead of holding the last frame. The console prints the cache size, the frame index for a time and how long each `replaceParts` took.

```js live poster=spume-playback
import { Renderer67, sphere, box } from '67js';

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

// Bake: droplets leave a spout and bounce on the floor. Done once, offline in the real workflow.
const fps = 30;
const frameCount = 75;
const dropletCount = 180;
const next = random(5);
const droplets = Array.from({ length: dropletCount }, () => ({
  start: next() * 1.2,
  velocity: [1.5 + next() * 2.2, 2.2 + next() * 2, (next() - 0.5) * 1.6],
  position: null,
  speed: null,
}));
const baked = [];
for (let frame = 0; frame < frameCount; frame++) {
  const time = frame / fps;
  const positions = new Float32Array(dropletCount * 3);
  droplets.forEach((droplet, index) => {
    const age = Math.max(0, time - droplet.start);
    let y = 1.4 + droplet.velocity[1] * age - 4.9 * age * age;
    let bounces = 0;
    let vy = droplet.velocity[1] - 9.8 * age;
    while (y < 0.05 && bounces < 3) { y = 0.05 - (y - 0.05) * 0.45; vy = -vy * 0.45; bounces++; }
    const x = -3 + droplet.velocity[0] * age;
    const z = droplet.velocity[2] * age;
    positions.set(age === 0 ? [-3, 1.4, 0] : [x, Math.max(0.05, y), z], index * 3);
  });
  baked.push(positions);
}

// Pack each frame over its own min..max box into int16, like Spume's frame files.
function pack(positions) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index++) {
    low[index % 3] = Math.min(low[index % 3], positions[index]);
    high[index % 3] = Math.max(high[index % 3], positions[index]);
  }
  const packed = new Int16Array(positions.length);
  for (let index = 0; index < positions.length; index++) {
    const span = high[index % 3] - low[index % 3] || 1;
    packed[index] = Math.round(((positions[index] - low[index % 3]) / span - 0.5) * 65534);
  }
  return { packed, low, high };
}
function unpack({ packed, low, high }) {
  const positions = new Float32Array(packed.length);
  for (let index = 0; index < packed.length; index++) positions[index] = low[index % 3] + (packed[index] / 65534 + 0.5) * (high[index % 3] - low[index % 3]);
  return positions;
}
const cache = baked.map(pack);
const packedBytes = cache.reduce((sum, frame) => sum + frame.packed.byteLength, 0);
const floatBytes = baked.reduce((sum, frame) => sum + frame.byteLength, 0);
console.log(`cache: ${frameCount} frames at ${fps} fps, ${dropletCount} droplets, ${(packedBytes / 1024).toFixed(1)} KiB packed vs ${(floatBytes / 1024).toFixed(1)} KiB as floats`);

const state = { loop: false };
const duration = frameCount / fps;
function frameIndexAt(seconds) {
  const frame = Math.floor(seconds * fps);
  return state.loop ? ((frame % frameCount) + frameCount) % frameCount : Math.min(frameCount - 1, Math.max(0, frame));
}

const decoded = new Map();
function partsAt(seconds) {
  const index = frameIndexAt(seconds);
  if (!decoded.has(index)) {
    decoded.set(index, unpack(cache[index]));
    if (decoded.size > 4) decoded.delete(decoded.keys().next().value);
  }
  const positions = decoded.get(index);
  return Array.from({ length: dropletCount }, (unused, droplet) => ({
    name: `Droplet ${droplet}`,
    geometry: dropletShape,
    matrix: new Float32Array([0.07, 0, 0, 0, 0, 0.07, 0, 0, 0, 0, 0.07, 0, positions[droplet * 3], positions[droplet * 3 + 1], positions[droplet * 3 + 2], 1]),
    material: dropletMaterial,
  }));
}

const dropletShape = sphere(10, 8);
const dropletMaterial = { color: [0.45, 0.78, 0.9], metallic: 0, roughness: 0.15 };
const scenery = [{ name: 'Spout', geometry: box(0.08, 3), matrix: new Float32Array([0.5, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0.5, 0, -3.3, 1.4, 0, 1]), material: { color: [0.5, 0.5, 0.55], metallic: 0.6, roughness: 0.4 } }];

const canvas = document.querySelector('#scene');
const renderer = new Renderer67(canvas, [...scenery, ...partsAt(0)]);
const timings = [];
let seconds = 1;
let playing = true;
let last = performance.now();

function draw() {
  const start = performance.now();
  renderer.replaceParts([...scenery, ...partsAt(seconds)]);
  timings.push(performance.now() - start);
  renderer.render({ eye: [0, 3, 8], target: [0, 0.8, 0], fov: 40 });
}

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;left:8px;bottom:8px;display:flex;gap:10px;align-items:center;color:#dde;font:12px system-ui;background:#000a;padding:6px 8px;border-radius:6px';
const toggle = document.createElement('button');
toggle.textContent = 'Pause';
const slider = document.createElement('input');
slider.type = 'range';
slider.min = 0;
slider.max = duration;
slider.step = 0.01;
slider.value = seconds;
const loopLabel = document.createElement('label');
const loopBox = document.createElement('input');
loopBox.type = 'checkbox';
loopLabel.append(loopBox, 'loop');
bar.append(toggle, slider, loopLabel);
document.body.append(bar);
toggle.addEventListener('click', () => { playing = !playing; toggle.textContent = playing ? 'Pause' : 'Play'; last = performance.now(); });
loopBox.addEventListener('change', () => { state.loop = loopBox.checked; console.log('loop', state.loop); });
slider.addEventListener('input', () => { playing = false; toggle.textContent = 'Play'; seconds = Number(slider.value); draw(); });
slider.addEventListener('change', () => console.log(`t=${seconds.toFixed(2)} s -> frameIndexAt ${frameIndexAt(seconds)}`));

let nextReport = 1;
function frame(now) {
  if (playing) {
    seconds += (now - last) / 1000;
    if (!state.loop) seconds = Math.min(seconds, duration);
    else seconds %= duration;
    slider.value = seconds % duration;
    draw();
  }
  last = now;
  if (playing && seconds >= nextReport) {
    const average = timings.reduce((sum, value) => sum + value, 0) / timings.length;
    console.log(`replaceParts averaged ${average.toFixed(2)} ms over ${timings.length} frames`);
    timings.length = 0;
    nextReport = seconds + 1;
  }
  requestAnimationFrame(frame);
}
new ResizeObserver(() => renderer.resize()).observe(canvas);
requestAnimationFrame(frame);
addEventListener('pagehide', () => renderer.dispose());
```

The droplets are plain parts, replaced each frame. The real cache holds a liquid mesh per frame and whitewater points, and draws them with the `liquid` and `foam` materials that refract opaque parts.

## Play a real cache

1. Bake a cache folder with Spume's `run.py` or its Blender add-on.
2. Load it with `loadSpumeCache(folderUrl)`.
3. Create a player with `createSpumePlayer(cache, { matrix, loop })`.
4. Each frame, call `renderer.replaceParts([...sceneParts, ...player.partsAt(seconds)])` and render.

```bash
uv run python run.py --out out/geyser --name geyser --pressure cg --iterations 20
```

A low-resolution check takes seconds after the first kernel compile: `uv run python run.py --out out/test --cell 0.2 --width 6 --height 12 --frames 40 --mesh-cell 0.25`. Units are metres with +Y up and the floor at y = 0, which matches 67js. Serve the output folder next to the page. It holds `meta.json`, one `frame_NNNN.glb` per frame and the whitewater files `spray.bin`, `spray_ids.bin` and `spray_kinds.bin`.

```js
import { Renderer67 } from '67js';
import { loadSpumeCache, createSpumePlayer } from '67js/addons/spume';

const cache = await loadSpumeCache('/caches/geyser/');
const player = createSpumePlayer(cache, { matrix: placeAt(0, 0, 0), loop: true });
console.log(player.frameCount, player.fps, player.duration);
const renderer = new Renderer67(canvas, [...sceneParts, ...player.partsAt(0)]);
function draw(seconds) {
  renderer.replaceParts([...sceneParts, ...player.partsAt(seconds)]);
  renderer.render({ eye, target });
}
```

`loadSpumeCache(source)` accepts a folder URL or an `async (fileName) => ArrayBuffer | null` reader, so the same cache loads from a server, from disk in Node or from a dropped folder. It validates `meta.json`, reads every frame file and keeps frames int16-packed until they are played, which is about a fifth of the decoded size. The frame files are not general glTF: positions are int16 spread over each frame's own min..max box, so standard loaders, including `67js/addons/gltf`, read them at the wrong scale. Use `decodeSpumeFrame(bytes)` for one frame.

Skinned and morphed parts may stay in the list unchanged while frames are replaced. Adding or removing them needs a new renderer. Textured parts can be added and removed once `import '@codepawlhq/67js/addons/replace-textured-parts'` has run. Without it they must stay unchanged. The addon deletes a texture when no part uses it any more and keeps one another part still binds.

## Options

| Member or option | Meaning |
| --- | --- |
| `partsAt(seconds)` | Parts for the frame shown at that time: the liquid mesh, plus whitewater when the frame has any. |
| `partsForFrame(index)` | The same by frame number. |
| `frameIndexAt(seconds)` | The frame number for a time, clamped or wrapped. |
| `frameCount`, `fps`, `duration` | From `meta.json`. |
| `matrix` | Default identity. Places the bake; positions are relative to the first opening's centre on the floor (`meta.origin`). |
| `waterMaterial` | Default `DEFAULT_WATER_MATERIAL`, any rigid untextured material. The default uses the `liquid` tag with `color: [0.56, 0.84, 0.88]`. |
| `sprayMaterial` | Default `DEFAULT_SPRAY_MATERIAL`. The default uses the `foam` tag, with per-point vertex colours for foam and bubbles. |
| `spray` | Default `{ radius: 0.014, shutter: 1 / 60, kinds: ['spray', 'foam'], maxPoints: 12000 }`, or `null` for liquid only. Bubbles are hidden by default. |
| `loop` | Default `false`. Wraps time instead of holding the last frame. |
| `cachedFrames` | Default `4`. Decoded frames kept for reuse, so scrubbing over a few frames costs nothing after the first decode. |

## Cost

Measured on the slab bake (the README example at 10 cm cells, 60 frames, 79 thousand liquid particles, up to 12,177 liquid vertices and 12,000 droplets shown) on an RTX 3060 in Chrome: `replaceParts` with a fresh frame took 7 to 13 ms and the render about 0.5 ms. The cache is 7.1 MB of frames. Decoding a frame takes about 1.3 ms and building its droplets about 4.5 ms in Node. Lower `maxPoints` first when a large bake drops frames, and raise `cachedFrames` for scrubbing (docs/spume.md).

## Limits

- A liquid refracts only opaque parts, not other liquids or itself, and its thickness is an estimate for convex bodies.
- Frames are shown as stored, without interpolation between them.
- The addon does not run, schedule or cancel bakes. Bake with Spume's command line or its Blender add-on.

The [Spume contract](https://github.com/codepawl/67.js/blob/main/docs/spume.md) covers the cache format, whitewater options, placement and measured cost.

## Common mistakes

- Loading a frame file with the glTF loader. The int16 packing needs `decodeSpumeFrame`.
- Forgetting `loop: true` and wondering why the liquid freezes on the last frame.
- Mixing the liquid with parts that change topology without a new renderer.
- Leaving `maxPoints` high on a large bake. Lower it first.
