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

A point light casts a shadow only with `castShadow: true` (see [Local shadows](#local-shadows)); without it the light can illuminate through opaque walls. The original directional shadow map remains in use. Source-only [volume fog](https://67js.codepawl.com/volumetric.md) receives directional scattering and shadows. Point-light scattering and indirect bounces remain unfinished.

## Spot lights

`environment.spotLights` holds at most eight lights. Each has `position` and `direction` (any nonzero length). Optional fields: `angle` (outer half angle in radians, 0.01 to just under pi/2, default pi/4), `penumbra` (0 to 1, default 0.15), `color`, `intensity`, `radius`, `range` and `castShadow`, with the point light defaults and limits.

`intensity` is candela, so a spot light and a point light of the same intensity give the same light inside the cone. The cone mask is a smoothstep from the outer cosine to `outer + (1 - outer) * penumbra`, which is Blender's spot blend, so a `bench/reference` Blender spot with `spot_size = 2 * angle` and `spot_blend = penumbra` matches. Falloff, `radius` and `range` work as for point lights.

## Area lights

`environment.areaLights` holds at most four rectangles. Each has `position` (the center), `direction` (the side it emits to), `width` and `height` in scene units, and optional `up`, `color` and `intensity`. The width axis is `up x direction`, so a downward panel with `up: [0, 0, 1]` has its width along X. `intensity` is the candela of the whole rectangle seen head on, and the light has Lambert emission, so it fades with the cosine to the side.

Method: representative point, not a light-transform lookup table. The closest point of the rectangle to the shaded point stands in for the source, and the light is `intensity * cos(emission) / (d^2 + area / pi)`. The `area / pi` term keeps it finite at the surface and equals a disc source on its axis. Measured against Cycles on a white plane, a Blender area light of W watts matches `W / pi` candela, and this formula is within 1.2 percent on the axis for 1 m and 2 m squares from 0.2 m to 2 m away (measured). Off-axis error and the shape of a specular highlight are not measured: the highlight is a point highlight from the representative point, so a large panel does not give a stretched reflection. Area lights cast no shadow and a rectangle seen from behind gives no light.

## Local shadows

`castShadow: true` on a point or spot light draws that light's depth into one shared atlas of 2048 x 3072 texels: 24 tiles of 512 x 512, a 24 MiB depth texture allocated on first use. A spot light takes one tile with a perspective view of `2 * angle + 4` degrees (170 at most). A point light takes six tiles, one per cube face, each 92 degrees wide. Lights are given tiles in order: point lights, then spot lights. A request for more than 24 tiles, for example five shadowed point lights, throws `RangeError` and changes nothing. So the most is four shadowed point lights, or for example two point lights and eight spot lights.

Shadows reach `range`, or 30 units when `range` is zero; farther surfaces are lit. Filtering is one bilinear 2 x 2 comparison, and the receiver is moved off its surface by about two texels, so edges are slightly hard and a very thin wall can leak. The atlas is drawn again only when a light moves, a shadow-casting part changes or sways, so a static scene pays the depth passes once. A scene with no shadow casting lights allocates nothing and compiles none of this code.

## Cascaded sun shadows

The directional light uses one 2048 x 2048 map over the box that `shadowBounds` gives. In a scene as long as a street that box is 100 m or more across, so a texel is 6 to 8 cm and a lamp post near the camera is two texels wide. Cascades cut the camera's view into up to four slices by depth and fit one map to each, so the slice near the camera has texels of about 1 cm.

```js
import { Renderer67 } from '@codepawlhq/67js';
import { createCascadedShadows } from '@codepawlhq/67js/addons/cascaded-shadows';

const renderer = new Renderer67(canvas, parts, {
  world: true,
  shadowBounds, // still gives the light direction (eye minus target)
  shadowCascades: createCascadedShadows({ count: 3 }),
});
```

Options: `count` (1 to 4, default 3), `resolution` (256 to 4096, default 2048), `maximumDistance` (default 150 m; farther surfaces are lit), `splitLambda` (0 uniform to 1 logarithmic, default 0.7) and `casterReach` (how far toward the light a caster may stand, default 200 m). Each slice is a bounding sphere, so turning the camera does not change its size, and its centre snaps to whole texels, so edges do not crawl. The last tenth of a slice blends into the next. The slice maps are drawn again when the camera, the light or a caster moves, so a still camera pays the depth passes once and a moving one pays `count` passes per frame; the measured cost is in `bench/reference/README.md`. Three slices of 2048 x 2048 are a 48 MiB depth array. The single map is still drawn for volume fog and water, which do not read the cascades. A scene without cascades compiles none of this code, and recipes do not reach it yet.

## Light linking

A light can be limited to some parts, as Blender's receiver collection does. Give a light an `affects` list of part names (and `environment.keyAffects` for the sun) and pass the parts through `applyLightLinks`:

```js
import { applyLightLinks } from '@codepawlhq/67js/addons/light-linking';

const environment = { pointLights: [{ position: [-1.8, 2.4, 1.2], intensity: 14, affects: ['sphere-left'] }], keyAffects: ['floor'] };
const renderer = new Renderer67(canvas, applyLightLinks(parts, environment), { environment });
```

A part gets a bit mask in `material.lightMask` (bit 0 the sun, bits 1 to 8 the point lights, 9 to 16 the spot lights, 17 to 20 the area lights, in list order); the shader skips a light whose bit is clear. Linking changes what a light adds, not what it shadows: a part a light does not reach still blocks that light for the others, and in Blender too. Parts with different masks are different batches. The path tracer and the light bake ignore linking, and recipes do not reach it yet (`lightLinking: false` in `scene_capabilities`). A scene without links compiles none of this code. The reference scene `light-linking` is the measured case.

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

[Three.js PointLight](https://threejs.org/docs/pages/PointLight.html) documents candela intensity, inverse-square attenuation and a smooth finite cutoff. [Blender light objects](https://docs.blender.org/manual/en/dev/render/lights/light_object.html) distinguish source size and emitted power. 67js radius currently regularizes attenuation. It does not reproduce Blender's spherical emitter or watt-based power.

Run `node --test tests/lighting.test.js` for retained-state checks and `node scripts/smoke-lighting.mjs` with the development server running for linear HDR pixel checks, native GPU timing and before/after laboratory images.
