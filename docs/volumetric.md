# Depth-clipped volume fog

This API exists in the source checkout and next library build. Published version `0.3.3` does not include it yet.

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

Values must be finite numbers. Active volume fog accepts finite frame time within ±1,000,000 seconds and a nonzero light direction with components within ±1,000,000. Noise samples absolute time, so backward seeks reproduce earlier density.

## Lighting and depth

The fullscreen march clips against resolved opaque depth, supports perspective and orthographic cameras, and stops at the volume boundary or maximum distance. It integrates Beer-Lambert extinction and directional single scattering with a Henyey-Greenstein phase function. It uses the existing directional shadow map and key-light color. Keep authored shadow bounds aligned with the light direction and covering the medium.

`part.castShadow: false` excludes a mesh from shadow rendering while keeping it visible and opaque in the color/depth pass. The flag defaults to true and must be boolean. Shadow-casting groups use separate batches. Changing a part's casting regime requires a new renderer. `updateParts()` rejects that change. A luminous window can omit its shadow, but remains an opaque emissive surface rather than transparent glass.

## Cost and limits

Resolved depth adds four estimated bytes per rendered pixel, or 2,073,600 bytes at 960 × 540. The planner reduces render dimensions when needed. The target is allocated at construction/resize, reused across frames and released by `dispose()`. The march adds no additional volume textures or geometry, but shading cost grows with covered pixels and step count.

This implements one bounded medium and one directional scattering source. Point-light scattering, multiple scattering, attenuation toward the source, transparent depth, volume grids, particles, temporal accumulation and half-resolution rendering remain unfinished. The legacy film explosion is separate and does not use this depth-clipped medium. Fog runs after bloom extraction, so scattering itself does not feed bloom.

Run `node scripts/smoke-volumetric.mjs` with the development server running for native GPU extinction, foreground clipping, directional shadow, long-distance ray, resource reuse and disposal checks. Run `node scripts/benchmark-volumetric.mjs` for a fixed laboratory comparison and deterministic noise seeking. These fixtures establish behavior, not cinematic trailer quality.
