# Local lighting

Available from version `0.4.0`.

`Renderer67` accepts lighting in its existing `environment` option. `frame.environment` overrides selected fields for each frame. Lights use world-space positions and linear RGB colors. Use meters consistently when authoring a physically scaled scene.

```js
const renderer = new Renderer67(canvas, parts, {
  ground: false,
  world: true,
  hdr: true,
  environment: {
    lightDirection: [-0.8, 0.5, 0.3],
    keyIntensity: 0.7,
    fillIntensity: 0.35,
    ambientIntensity: 0.45,
    pointLights: [{
      position: [0, 3.34, -1],
      color: [1, 0.71, 0.43],
      intensity: 18,
      radius: 0.08,
      range: 9,
    }],
  },
});

renderer.render({ eye: [0, 2, 5], target: [0, 1, 0], fov: 40 });
```

## Light controls

`keyIntensity` scales the existing shadowed directional light. `keyColor` optionally replaces its linear RGB radiance color. `fillIntensity` scales the two existing fill/rim lights. `ambientIntensity` scales procedural reflection and hemisphere fill. Each intensity defaults to one, preserving previous lighting when no controls are supplied. Set all three to zero to isolate local lights on standard PBR surfaces.

These controls do not disable the sky, emission, fog or special procedural floor/fire/smoke shading. They also scale foliage transmission, water reflection and the directional water glint. Without an environment map, reflections remain the procedural studio approximation. See [Environment maps (IBL)](#environment-maps-ibl) to light from a loaded HDR.

## Environment maps (IBL)

An equirectangular HDR image can replace the procedural studio reflection and the fixed ambient term. Poly Haven CC0 HDRIs at 1k or 2k work well; larger files only cost load time.

```js
import { Renderer67 } from '67js';
import { loadHdri } from '67js/addons/hdri';

const map = await loadHdri('/studio_small_09_1k.hdr', { intensity: 1, rotation: 0.6 });
const renderer = new Renderer67(canvas, parts, { hdr: true, environment: { map } });
```

`loadHdri(url, options)` fetches and parses a Radiance `.hdr` (RGBE, `-Y height +X width`, flat or run-length scanlines) and returns the descriptor. To build one from your own data, call `createEnvironmentMap({ width, height, data, intensity, rotation, showBackground, backgroundBlur })`, where `data` is a `Float32Array` of linear RGB or RGBA, top row first. The image centre looks toward -Z, `rotation` turns it about +Y in radians (0 to 1,000,000 as a finite number), `intensity` is 0 to 1000, `backgroundBlur` is 0 to 1.

Set `environment.map` in the constructor or in `frame.environment`. Maps spread from one created map, such as `{ ...map, rotation: time }`, reuse its GPU textures, so rotation animates for free. Passing a different map prefilters it on first use, and `map: null` returns to studio lighting. With no map the output is pixel-identical to before.

When a map is set:

- Standard PBR surfaces take specular reflection by roughness from a GGX-prefiltered chain and diffuse ambient from L2 spherical harmonics, with a split-sum BRDF lookup. `ambientIntensity` and occlusion maps still scale it.
- Liquid reflections sample the same chain.
- `showBackground: true` draws the map behind the scene in studio and world mode, blurred by `backgroundBlur`. It is skipped on transparent canvases.
- Key, fill and point lights still add direct light. Set `keyIntensity` and `fillIntensity` to zero to light a scene from the map alone.
- The procedural floor, water tag, fire and smoke keep their own shading.

Cost and memory: prefiltering runs once when a map is first used, not per frame (about 30 ms for a 512x256 map on an RTX 3060 after shader compilation, plus about 0.6 s of first-use shader compile). The renderer keeps a half-float chain of at most 1024 wide (about 8 MB for 1024x512, 1.4 MB for 512x256) and a 128x128 BRDF lookup, and counts both in the memory budget. The source upload is freed after prefiltering. A 2048x1024 source briefly needs about 11 MB of GPU memory and 32 MB of CPU memory while loading. Maps need `EXT_color_buffer_float`; without it the constructor throws.

Limits: the diffuse term uses L2 spherical harmonics, so a very small intense sun gives soft, slightly ringing diffuse light and no shadow. Use the key light for sun shadows. Reflections have no parallax or occlusion, and the procedural water tag does not use the map.

## Point lights

At most eight lights are supported per frame. Each light supplies `position`. Optional fields default to white `color`, `intensity: 1`, `radius: 0.05` and unlimited `range: 0`.

The light uses inverse-square falloff outside its radius. Doubling distance reduces incoming illumination to one quarter before material response. Intensity follows the candela convention for a point source, but the renderer's existing exposure and environment are not a calibrated photographic pipeline.

Radius limits near-source attenuation to avoid a singularity. It does not create an area emitter or soften shadows. Range zero preserves unlimited falloff. A positive range smoothly fades the light to zero using `(max(1 - (distance / range)^4, 0))^2`. This artistic cutoff changes physical falloff near the range boundary.

Inputs must be finite numbers. Positions are within ±1,000,000 scene units. Colors are within zero and one. Intensity is within zero and 100,000. Radius is between 0.001 and 1,000,000. Range is zero or between 0.001 and 1,000,000.

Key/fill/ambient intensity is between zero and 100. Key color components are between zero and 1,000. Large coordinates still inherit Float32 rendering precision limits.

Lights currently cast no local shadows and can illuminate through opaque walls. The original directional shadow map remains in use. Source-only [volume fog](volumetric.md) receives directional scattering and shadows. Point-light shadows and scattering, spotlights, area lights and indirect bounces remain unfinished.

## Animation and resources

Pass the entire point-light list in `frame.environment.pointLights` to replace the constructor list. An empty list removes all local lights. Omitted fields continue using constructor defaults.

```js
renderer.render({
  eye: [0, 2, 5], target: [0, 1, 0], fov: 40,
  environment: {
    pointLights: [{ position: [Math.sin(time), 2, 0], intensity: 4 }],
  },
});
```

Absolute-time animation keeps light movement independent of seek order. Each renderer retains one set of light uniform arrays, containing 75 floats. Light updates add no geometry, texture, framebuffer or draw pass. Shading cost grows with active lights and covered pixels. Excessive brightness clips at the finite half-float HDR target limit of 65,504 before bloom and tone mapping.

Validation runs before light arrays or the framebuffer change. Invalid later lights leave the previous lighting state intact. This guarantee applies to ordinary data objects. Caller-defined getters and proxies are not a supported scene format.

## Design and references

Two shapes were considered: mutable light nodes with independent scene ownership, and serializable lights in the existing environment contract. Environment data was chosen because film samples already provide absolute-time frame overrides. Light hierarchy nodes and editor handles require a later authoring contract.

[Three.js PointLight](https://threejs.org/docs/pages/PointLight.html) documents candela intensity, inverse-square attenuation and a smooth finite cutoff. [Blender light objects](https://docs.blender.org/manual/en/dev/render/lights/light_object.html) distinguish source size and emitted power. 67.js radius currently regularizes attenuation. It does not reproduce Blender's spherical emitter or watt-based power.

Run `node --test tests/lighting.test.js` for retained-state checks and `node scripts/smoke-lighting.mjs` with the development server running for linear HDR pixel checks, native GPU timing and before/after laboratory images.
