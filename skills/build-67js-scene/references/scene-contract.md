# Scene contract

Each part has these fields.

```js
{
  name: 'Birch canopy',
  geometry: {
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(),
  },
  matrix: new Float32Array(16),
  material: {
    color: [0.16, 0.30, 0.08],
    metallic: 0,
    roughness: 0.8,
    emission: 0,
    tag: 'foliage',
  },
}
```

The transform is a column-major matrix. Colors are linear RGB.
Normals are unit vectors. Triangle winding faces outward.
Each geometry identity becomes one instanced batch.

Explodable parts also provide `assembly: { layer: 'exterior' | 'interior', section: 'front-panel', offset: [0, 0, 1.7] }`.
The offset is a world-space translation at full explosion. `render({ assemblyAmount: 0.5, ...camera })` applies half the offset in the vertex shader.
Keep each section's offsets consistent so fasteners follow their panel. Base matrices remain assembled.

Changing assembly amount refreshes shadows while reusing the same shadow texture and geometry buffers.
For an exploded GLB, add the current offset to matrix translation entries 12, 13 and 14 before export.

The material tags select renderer behavior.

| Tag | Behavior |
| --- | --- |
| `armor` | Studio finish color and surface overrides. |
| `floor` | Studio floor shading. |
| `water` | Animated surface normals and interaction ripples. |
| `foliage`, `grass` | Wind movement and backlighting. |
| `terrain` | Subtle natural surface variation. |
| `fire`, `smoke` | Film ignition expansion and procedural shading. |
| Other tags | Standard metallic/roughness shading. |

Material tags and colors use flat varyings.
Interpolated numeric tags can change by tiny amounts and select the wrong shading branch.

An outdoor renderer receives `world: true`, `ground: false` and the scene environment.
The environment provides `fogColor`, `fogDensity`, `skyTop`, `skyBottom`, `lightDirection` and optional `daylight`.
The sky colors are display RGB. Fog colors are linear RGB.

```js
const renderer = new Renderer67(canvas, world.parts, {
  world: true,
  ground: false,
  environment: world.environment,
  samples: 4,
  pixelRatio: 1.25,
  memoryBudgetMiB: 256,
});
renderer.render({ ...world.camera, time: 0, wind: 0.3 });
```

The renderer owns its GPU buffers and targets. Call `dispose()` before replacing it.
Call `resize()` when CSS dimensions change.
Check `memoryPlan` for the actual render size and estimated allocation.
The planner can reduce resolution to stay within its target budget.

Films sample their timeline through `sampleFilm(time)`.
Camera FOV uses degrees. Film time must be finite and independent of the wall clock.
`renderAt(time)` must produce the same frame when called in a different order.
