# Scene contract

<!-- skill-navigation:start -->
Read the complete [scene contract](#scene-contract) before creating parts or changing materials. It covers identities, transforms, materials, lighting, fog, animation, cameras and resources in order.
<!-- skill-navigation:end -->

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
Each geometry and texture descriptor identity pair becomes one instanced batch.

Explodable parts also provide `assembly: { layer: 'exterior' | 'interior', section: 'front-panel', offset: [0, 0, 1.7], detailOffset: [0.1, 0.05, 0.3] }`.
Both offsets are world-space translations. The shader applies `offset * amount + detailOffset * smoothstep(0.3, 1, amount)`.
The group separates first. Small components separate during the second stage.

Keep each section's offsets consistent so fasteners follow their panel. Base matrices remain assembled.

Changing assembly amount refreshes shadows while reusing the same shadow texture and geometry buffers.
For an exploded GLB, use `assemblyOffset(part, amount)` from `67js` for matrix translation entries 12, 13 and 14.

The material tags select renderer behavior.

| Tag | Behavior |
| --- | --- |
| `armor` | Studio finish color and surface overrides. |
| `floor` | Studio floor shading. |
| `water` | Animated surface normals and interaction ripples. |
| `foliage`, `grass` | Wind movement and backlighting. |
| `terrain` | Subtle natural surface variation. |
| `fire`, `smoke` | Film ignition expansion and procedural shading. |
| `unlit` | Flat linear color for vector scenes. |
| Other tags | Standard metallic/roughness shading. |

Material tags and colors use flat varyings.
Interpolated numeric tags can change by tiny amounts and select the wrong shading branch.

An outdoor renderer receives `world: true`, `ground: false` and the scene environment.
The environment provides `fogColor`, `fogDensity`, `skyTop`, `skyBottom`, `lightDirection` and optional `daylight`.
The sky colors are display RGB. Fog colors are linear RGB.

Local `environment.pointLights` support eight world-space sources with inverse-square falloff.
Each light provides `position` and optional `color`, `intensity`, `radius` and `range`.
`keyIntensity`, `fillIntensity` and `ambientIntensity` independently scale existing lighting.
Read the checkout's `docs/lighting.md` for defaults, numeric limits and frame overrides.
Point lights currently cast no local shadows. Radius limits attenuation without creating an area emitter.

Source-only `environment.volumeFog` receives directional scattering and shadows in one bounded volume.
It requires an opaque renderer with `{ hdr: true, depth: true }` and negotiated HDR support.
Read `docs/volumetric.md` for controls, resource cost and limitations before authoring fog.
`frame.environment.volumeFog` replaces the entire constructor fog object, with defaults for omitted fields.
Use absolute frame time for reproducible density drift. Local point lights do not scatter in fog yet.

`part.castShadow: false` omits a mesh from shadows while leaving it visible and opaque.
Changing its casting regime requires a new renderer. Shadow-casting groups use separate batches.

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

Animation changes existing part matrices and materials. `renderer.updateParts(changedParts)` uploads them through retained instance buffers.
New part, geometry or texture descriptor identities require a new renderer.

Source morph parts add `geometry.morphTargets: [{ positions, normals }]` and `morph: createMorphPose(count)`.
Targets contain static relative Float32 XYZ deltas, not absolute vertices. At least one channel is present.
Change retained `part.morph.weights`, then call `renderer.updateParts()` to commit the pose.
Separate pose identities split batches. Repeated parts can share static target geometry.

Morphs run before skinning and use standard materials. Read `docs/morph-targets.md` for numeric limits and memory costs.

Source `exportGlb(parts)` preserves relative morph targets and current weights as a static GLB snapshot.
It preserves opaque linear RGB vertex colors, UVs and active independent HDR emission. Read `docs/export-glb.md` for limits.
It does not serialize animation clips, procedural shaders or scene environments.
Skinning and textured materials still reject at export. Check the decoder's capabilities before importing shape keys.

The optional `{ shadows: false }` update option suits flat scenes without moving shadow casters.

Static `sculptGeometry` strokes return new geometry before renderer upload. Read `docs/sculpt.md` for seam and work limits.
`createSurfacePatch` clips a curved overlay with target-local clearance. Read `docs/surface.md` and share the target's retained matrix.
It rejects skin, morph, assembly and procedural targets. It does not detect arbitrary mesh penetration or provide animated shrinkwrap.

Static `createMeshQueryIndex` copies geometry into an owned disposable BVH. Read `docs/mesh-query.md` for numerical and work limits.
Pass current affine matrices to `createMeshPairQuery(...).evaluate()`; rebuild indices after editing geometry.
Closed-solid containment requires two `solid: true` indices. Surface contact does not prove volume penetration or z-fighting.
Use `docs/primitives.md` for exact seam closure and preallocation bounds. Preserve indeterminate and budget errors rather than reporting a miss.

`cameraView('front' | 'right' | 'top')` returns an orthographic camera with the correct up vector.
`fitOrthographicHeight(bounds, view, aspect)` frames both model width and height.
The `unlit` tag and a front orthographic camera produce flat XY geometry.

An HDR renderer sets `{ hdr: true }` at construction. `capabilities.hdr` reports the negotiated result.
`frame.effects` accepts `bloom`, `saturation`, `contrast`, `temperature`, `vignette` and `grain`.
The renderer reuses bloom targets and includes them in `memoryPlan`.

Imported GLB parts can include `geometry.uvs`, opaque linear `geometry.colors` and `material.map`.
The optional decoder preserves `material.emissiveColor` independently of its base color.
`asset.applyAnimation(time, clipIndex)` mutates existing matrices before `renderer.updateParts()`.
After closing an imported scene, dispose the renderer before the asset to release GPU textures before decoded images.
