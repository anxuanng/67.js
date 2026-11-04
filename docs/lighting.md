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

With `world: true` the default `environment.fogDensity` is 0.006 per unit, which hazes a model 100 to 600 units wide into milky haze. Set a lower `fogDensity` for a large scene.

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

At most 16 lights are supported per frame. Each light supplies `position`. Optional fields default to white `color`, `intensity: 1`, `radius: 0.05` and unlimited `range: 0`.

The light uses inverse-square falloff outside its radius. Doubling distance reduces incoming illumination to one quarter before material response. Intensity follows the candela convention for a point source, but the renderer's existing exposure and environment are not a calibrated photographic pipeline.

Radius limits near-source attenuation to avoid a singularity. It does not create an area emitter or soften shadows. Range zero preserves unlimited falloff. A positive range smoothly fades the light to zero using `(max(1 - (distance / range)^4, 0))^2`. This artistic cutoff changes physical falloff near the range boundary.

Inputs must be finite numbers. Positions are within ±1,000,000 scene units. Colors are within zero and one. Intensity is within zero and 100,000. Radius is between 0.001 and 1,000,000. Range is zero or between 0.001 and 1,000,000.

Key/fill/ambient intensity is between zero and 100. Key color components are between zero and 1,000. Large coordinates still inherit Float32 rendering precision limits.

A point light casts a shadow only with `castShadow: true` (see [Local shadows](#local-shadows)); without it the light can illuminate through opaque walls. The original directional shadow map remains in use. Source-only [volume fog](https://67js.codepawl.com/volumetric.md) receives directional scattering and shadows. Point-light scattering and indirect bounces remain unfinished.

## Spot lights

`environment.spotLights` holds at most eight lights. Each has `position` and `direction` (any nonzero length). Optional fields: `angle` (outer half angle in radians, 0.01 to just under pi/2, default pi/4), `penumbra` (0 to 1, default 0.15), `color`, `intensity`, `radius`, `range` and `castShadow`, with the point light defaults and limits.

`intensity` is candela, so a spot light and a point light of the same intensity give the same light inside the cone. The cone mask is a smoothstep from the outer cosine to `outer + (1 - outer) * penumbra`, which is Blender's spot blend, so a `bench/reference` Blender spot with `spot_size = 2 * angle` and `spot_blend = penumbra` matches. Falloff, `radius` and `range` work as for point lights.

## Area lights

`environment.areaLights` holds at most seven rectangles. Each has `position` (the center), `direction` (the side it emits to), `width` and `height` in scene units, and optional `up`, `color` and `intensity`. The width axis is `up x direction`, so a downward panel with `up: [0, 0, 1]` has its width along X. `intensity` is the candela of the whole rectangle seen head on, and the light has Lambert emission, so it fades with the cosine to the side.

Method: representative point, not a light-transform lookup table. The closest point of the rectangle to the shaded point stands in for the source, and the light is `intensity * cos(emission) / (d^2 + area / pi)`. The `area / pi` term keeps it finite at the surface and equals a disc source on its axis. Measured against Cycles on a white plane, a Blender area light of W watts matches `W / pi` candela, and this formula is within 1.2 percent on the axis for 1 m and 2 m squares from 0.2 m to 2 m away (measured). Off-axis error and the shape of a specular highlight are not measured: the highlight is a point highlight from the representative point, so a large panel does not give a stretched reflection. Area lights cast no shadow and a rectangle seen from behind gives no light.

## Light counts and frame cost

A frame takes at most 16 point lights, 8 spot lights and 7 area lights, and `agent-look`, the scene capabilities (`maxPointLights`, `maxSpotLights`, `maxAreaLights`) and the light bake use the same numbers. The three limits and the sun share the 32 bits of the light-linking mask, which is why the area limit is 7 and not 8. Every light is added in a loop in the fragment shader, so a frame costs about the same for each light whether or not it reaches a pixel; a `range` lets the loop skip a light that is out of reach.

Measured on an RTX 3060 at 960x540 with 4 samples, a server hall of 49 boxes drawn with the lights spread over the ceiling (`node bench/lighting/frame-time.mjs gpu`, median of 3 runs of 200 frames each, below-normal priority; the machine was shared with other jobs, so read the spread as load). The 32 point light and 8 area light rows come from a run with the limits raised for the measurement:

| Lights | Median frame time |
| --- | --- |
| none | 1.07 ms |
| 8 point | 1.42 ms |
| 16 point | 1.81 ms |
| 32 point | 2.38 ms |
| 4 area | 1.28 ms |
| 7 area | 1.32 ms |
| 8 area | 1.38 ms |
| 12 point and 7 area | 1.88 ms |
| 16 point and 7 area | 1.92 ms |
| 32 point and 8 area | 2.53 ms |
| 32 point with `range: 6` | 1.63 ms |

A point light costs about 0.04 to 0.05 ms and an area light about 0.04 ms at this size, and a software rasterizer (SwiftShader, one run) shows the same order: 134 ms with no lights, 172 ms with 16 point lights and 246 ms with 12 point and 7 area lights. 32 point lights would have cost 2.4 ms and fit the GPU's 1,024 fragment uniform vectors, but they do not fit the mask without dropping spot or area lights, so the limit stays at 16. Point lights are not culled by tile or cluster; that would pay off at hundreds of lights, which the bit mask and the uniform arrays could not hold anyway.

`node bench/lighting/frame-time.mjs gpu --each-light` draws the hall with 12 point and 7 area lights and again without each light in turn; every removal changes the picture (checked on the software rasterizer).

## Bounced light in a lamp-lit room

A closed room lit by point, spot or area lights gets the light its walls bounce without a bake and at no cost per frame. `groundBounceEnvironment(parts, environment)` (`67js/addons/ground-bounce`, the same call that adds the floor's bounce) finds the room with the closed-room ray test, measures the area of the faces that look at the middle of the scene and their mean albedo (colour times texture mean, per channel), and sets `bounce` on the environment map. With lamp flux `F` (point `4 pi I`, spot `2 pi (1 - cos angle) I`, area `pi I`, summed over the lamps inside the room), area `A` and albedo `rho`, the bounce is `0.8 * F / pi * rho / (A * (1 - rho))` in each colour channel, so red walls bounce red light. The renderer adds it to the diffuse light: it is one constant in the first irradiance coefficient, the map's data is shared, and a lamp that changes every frame rebuilds nothing. The 0.8 is fitted: at 1.0 `lit-interior` came out 10 percent brighter than Cycles.

It is left out when the scene has a bake (its light map holds the bounce), a sun (`keyColor` above zero or unset, as in `temple-hall` and `dark-shaft`, which already read lighter than Cycles in their shadows), no map, or `environment.roomBounce` is `false`. It is one average colour for the whole room, with no brighter corner beside a lamp and no colour bleeding next to a wall; a bake gives those, and `scene_inspect` names it (`closed-room-without-bake`, with the `standard` preset) for a closed room lit by lamps only.

Emissive parts light their surroundings too (issue #392). In an open scene without a bake, `groundBounceEnvironment` adds their emitted power (emissive colour times `emission` times area, per channel) over the area of everything but the ground, times the mean albedo over one minus it, times a gain of 1.6, to the same `bounce` colour. Mapped emission, a closed room and a faint emitter (under 0.002) add nothing, and `environment.emissiveSpill: false` turns it off. On `megacity-dusk` against a Cycles render with its own emission on, the facades are 0.96 to 1.07 of Cycles' luminance where they were 0.75 to 0.77, and FLIP goes from 0.1580 to 0.1364 (SwiftShader). One colour for the whole scene cannot follow the fall-off from a window, so the darkest fifth of the picture ends 1.4 times too light; a per-position grid would fix that.

Luminance of the 67js picture over Cycles (linear, whole frame and 20th percentile, `bench/reference/luminance-ratio.py`, GPU renders against the committed Cycles panels):

| Scene | Mean before | Mean after | p20 before | p20 after |
| --- | --- | --- | --- | --- |
| `lit-interior` | 0.51 | 0.98 | 0.33 | 1.00 |
| `metal-room` | 0.49 | 0.88 | 0.32 | 0.85 |
| `brick-room` | 0.57 | 0.86 | 0.37 | 0.95 |
| `temple-hall` | 0.97 | 0.97 | 1.62 | 1.64 |

The two `temple-hall` p20 values differ only by the rescaling of the picture (the scene has a sun, so no bounce is added). The outdoor shadow fill of the issue is not done.

## Sky seen from the floor

`applyFloorSkyVisibility(parts, { strength, includeClosedRooms })` (`67js/addons/floor-sky-visibility`) is opt-in and returns `{ parts, report }`. It cuts the floor parts into texels, shoots 64 cosine-weighted rays from each against the other opaque parts and stores the share that escapes as the floor's `skyVisibility`, so the world and sky light on a floor under a roof or between walls is scaled down and open ground is not. Pass the returned parts to the renderer. `strength` 1 uses the traced share, 0.5 keeps half of what it hides. A closed room is left alone unless `includeClosedRooms` is `true`, and a scene that is too large (over 200,000 triangles), has no floor or runs past `maxSeconds` (20) comes back unchanged with `report.reason`. It is not on by default: it moves the dark end of halls and studio floors toward Cycles, and makes sunlit streets too dark (`long-street` +0.0135 FLIP at 0.5). The trace takes 0.5 to 1.7 s, and the floor grows to about 66,000 triangles, which adds 0.1 to 0.3 ms per frame in the reference scenes. Numbers: `bench/reference/README.md`, "Sky visibility traced from the floor texels".

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

Options: `count` (1 to 4, default 3), `resolution` (256 to 4096, default 2048), `maximumDistance` (default 150 m; farther surfaces are lit), `splitLambda` (0 uniform to 1 logarithmic, default 0.7) and `casterReach` (how far toward the light a caster may stand, default 200 m). Each slice is a bounding sphere, so turning the camera does not change its size, and its centre snaps to whole texels, so edges do not crawl. The last tenth of a slice blends into the next. The slice maps are drawn again when the camera, the light or a caster moves, so a still camera pays the depth passes once and a moving one pays `count` passes per frame; the measured cost is in `bench/reference/README.md`. Three slices of 2048 x 2048 are a 48 MiB depth array. The single map is still drawn for volume fog and water, which do not read the cascades. A scene without cascades compiles none of this code.

Recipes reach it through `environment.shadowCascades` (an integer from 1 to 4, or 0 for the single map). Without the field a scene gets three cascades when `shadow.extent` is above 40, because the single map then covers more than 80 m and a texel is 4 cm or wider (`extent / 1024` metres); a scene with the default extent of 3.5 and any scene at or below 40 draws exactly as before. The rule reads only recipe numbers, so a recipe always resolves the same way; set `shadowCascades: 0` to keep the single map on a wide scene. The preview loads the cascade code only for a scene that gets cascades, and rebuilds its renderer when the count changes.

### View transform and look

`environment.viewTransform` picks the display curve: `aces` (default, contrasty), `agx` (Blender's default, keeps bright saturated colour without clipping; pick it for a lit scene or to compare with Blender) or `neutral` (Khronos PBR Neutral, base colours show as authored; pick it for product shots and brand colours). `environment.look` adds a graded look after the curve: `warm`, `cool`, `contrast` or `faded`. In code, `new Renderer67(canvas, parts, { viewTransform: 'agx', look })` takes a look from `parseCube(text)` (a 3D `.cube` file, up to size 65) in `@codepawlhq/67js/addons/view-transform`; recipes and MCP never take a file path. The curves and the look live in `@codepawlhq/67js/addons/view-transform-shader`, which a recipe loads through `loadAgentSceneModules`; the default curve costs nothing extra. The path tracer takes the same `viewTransform` and `look` options, so a still and its path-traced image match. The look is not applied to Gaussian splats.

## Light linking

A light can be limited to some parts, as Blender's receiver collection does. Give a light an `affects` list of part names (and `environment.keyAffects` for the sun) and pass the parts through `applyLightLinks`:

```js
import { applyLightLinks } from '@codepawlhq/67js/addons/light-linking';

const environment = { pointLights: [{ position: [-1.8, 2.4, 1.2], intensity: 14, affects: ['sphere-left'] }], keyAffects: ['floor'] };
const renderer = new Renderer67(canvas, applyLightLinks(parts, environment), { environment });
```

A part gets a bit mask in `material.lightMask` (bit 0 the sun, bits 1 to 16 the point lights, 17 to 24 the spot lights, 25 to 31 the area lights, in list order); the shader skips a light whose bit is clear. Linking changes what a light adds, not what it shadows: a part a light does not reach still blocks that light for the others, and in Blender too. Parts with different masks are different batches. The path tracer ignores linking and says so in `report.ignored`; the light bake honours it, so a lamp linked to some parts bakes no light onto the others, not even as a bounce off a part it lights.

Recipes reach it through `affects` (a list of node IDs) on a point, spot or area light and `environment.keyAffects` for the sun; a light without the list lights every node. A name that is not a node of the recipe is refused with the list of names to check (`scene_inspect`), and removing a node that a list names is refused until the list changes. `set-environment` carries the lists, `scene_export_recipe` keeps them, and the code loads on demand only for a recipe that names them. A scene without links compiles none of this code. The reference scene `light-linking` is the measured case.

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
