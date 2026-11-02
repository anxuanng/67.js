# Depth-clipped volume fog

Available from version `0.4.0`.

Enable `{ hdr: true, depth: true }` when constructing an opaque, non-benchmark `Renderer67`. Active fog requires WebGL 2 `EXT_color_buffer_float`. Unsupported HDR negotiation rejects active fog. The depth option retains a resolved depth texture across frames and includes it in `memoryPlan`.

```js
const renderer = new Renderer67(canvas, parts, {
  hdr: true,
  depth: true,
  ground: false,
  environment: {
    lightDirection: [-0.35, 0.55, -0.85],
    volumeFog: {
      density: 0.065,
      minimum: [-5.7, 0.03, -4.7],
      maximum: [5.7, 4.5, 5.5],
      color: [0.9, 0.83, 0.7],
      steps: 24,
      maxDistance: 15,
    },
  },
});
renderer.render({ eye: [0, 2, 5], target: [0, 1, 0], time: 0 });
```

## Controls

`environment.volumeFog` defines one axis-aligned world-space volume. `frame.environment.volumeFog` replaces the whole constructor fog object for that frame. Omitted fields use the following defaults. Set `density: 0` to disable it.

| Field | Default | Accepted range |
| --- | --- | --- |
| `density` | `0` | `0…10`, extinction per scene unit |
| `minimum` | `[-100, 0, -100]` | Three components within ±100,000 |
| `maximum` | `[100, 20, 100]` | Three components within ±100,000; greater than minimum after Float32 rounding |
| `color` | `[0.8, 0.85, 0.9]` | Linear RGB, `0…1` |
| `ambient` | `[0.03, 0.035, 0.04]` | Linear RGB, `0…10` |
| `steps` | `16` | Integer `8…48` |
| `anisotropy` | `0.3` | `-0.9…0.9`; positive favors forward scattering |
| `noiseAmount` | `0.5` | `0…1`; zero gives uniform density |
| `noiseScale` | `0.3` | `0.001…100`, inverse scene units |
| `drift` | `[0.03, 0, 0]` | Three components within ±100, scene units per second |
| `maxDistance` | `100` | `0.01…10,000`, ray distance in scene units |
| `shadowAmbient` | derived | `0…1`; the share of `ambient` the fog keeps where the sun's shadow covers it. Left unset, 32 upward rays from the middle of the fog box decide: a closed room keeps 0.15, open ground under a sky keeps 1, and a partly covered scene lands between. Set it to override |

Values must be finite numbers. Active volume fog accepts finite frame time within ±1,000,000 seconds and a nonzero light direction with components within ±1,000,000. Noise samples absolute time, so backward seeks reproduce earlier density.

## Sky visibility of the fog

Pass `fogSkyVisibility` from `src/fog-sky-visibility.js` to `Renderer67` (the agent preview and the reference harness do) and the fog's ambient follows a per-point sky visibility instead of one share for the whole box. `skyVisibilityGrid` in `src/closed-room.js` shoots 24 fixed upward rays from the centre of each cell of a grid over the fog box (at most 2,048 cells and 32 along an axis), once per scene and fog box, and the result is uploaded as one 8-bit 3D texture. The post shader samples it with trilinear filtering in the shadowed fog: a point that sees any sky keeps all of the ambient, a point that sees none keeps 0.1 of it, and fog the sun reaches keeps all of it as before. Without the option, or when volume fog is off, the sampling is compiled out of the post shader and the frame is drawn by the program it had before. A scene of more than 150,000 triangles has no grid and draws as before. The rays run on the CPU: 0.03 s for `dark-shaft` (1,120 triangles) and 1.7 s for `temple-hall` (11,892 triangles) at scene build. A recipe that sets `shadowAmbient` keeps it and gets no grid.

The same option carries a second term, the light that surfaces give the fog. The renderer passes its frame `environment` to the option, and `fogBounceGrid` (`src/fog-bounce.js`) shoots 64 fixed rays from the centre of each cell of the same grid, takes the nearest surface each ray hits, and sums what that surface sends back: its emission plus the point lights that reach it times its albedo over pi (the light bake's `createDirectIrradiance`, with shadow rays). The mean over the rays is the radiance isotropic scattering at the cell sends to the eye. The grid is one `RGBA16F` texture, sky visibility in red and the bounce in green, blue and alpha, and the shader adds 0.6 of the bounce to the fog's scattering. A glowing window or a lamp therefore lights the fog around it, which the sky grid could not. Parts with an emissive map (a baked part carries its lightmap there) and the sun add nothing: the sun's bounce made `dark-shaft` worse (fog region 0.1282 to 0.1764 against Cycles), because the fog's ambient already stands in for it in a lit room. The scalar grid is isotropic, so it cannot follow the forward-scattering lobe (`anisotropy`) toward a window the camera looks at; that is why the weight is below 1. A scene with no emissive part and no point light builds an all-zero bounce and draws as before. Building it costs 0.3 s for `temple-hall` (11,892 triangles) and 0.07 s for `dark-shaft`, on top of the sky rays.

## Lighting and depth

The fullscreen march clips against resolved opaque depth, supports perspective and orthographic cameras, and stops at the volume boundary or maximum distance. It integrates Beer-Lambert extinction and directional single scattering with a Henyey-Greenstein phase function. It uses the existing directional shadow map and key-light color. Keep authored shadow bounds aligned with the light direction and covering the medium.

`part.castShadow: false` excludes a mesh from shadow rendering while keeping it visible and opaque in the color/depth pass. The flag defaults to true and must be boolean. Shadow-casting groups use separate batches. Changing a part's casting regime requires a new renderer. `updateParts()` rejects that change. A luminous window can omit its shadow, but remains an opaque emissive surface rather than transparent glass.

## Cost and limits

Resolved depth adds four estimated bytes per rendered pixel, or 2,073,600 bytes at 960 × 540. The planner reduces render dimensions when needed. The target is allocated at construction/resize, reused across frames and released by `dispose()`. The march adds no additional volume textures or geometry, but shading cost grows with covered pixels and step count.

This implements one bounded medium and one directional scattering source. Point-light scattering, multiple scattering, attenuation toward the source, transparent depth, volume grids, particles, temporal accumulation and half-resolution rendering remain unfinished. The legacy film explosion is separate and does not use this depth-clipped medium. Fog runs after bloom extraction, so scattering itself does not feed bloom.

Run `node scripts/smoke-volumetric.mjs` with the development server running for native GPU extinction, foreground clipping, directional shadow, long-distance ray, resource reuse and disposal checks. Run `node scripts/benchmark-volumetric.mjs` for a fixed laboratory comparison and deterministic noise seeking. These fixtures establish behavior, not cinematic trailer quality.
