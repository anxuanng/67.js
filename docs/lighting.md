# Local lighting

These controls exist in the source checkout and next library build. Published version `0.3.3` does not include them yet.

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

These controls do not disable the sky, emission, fog or special procedural floor/fire/smoke shading. They also scale foliage transmission, water reflection and the directional water glint. Environment reflections remain the existing procedural studio approximation, not a loaded HDR environment.

## Point lights

At most eight lights are supported per frame. Each light supplies `position`. Optional fields default to white `color`, `intensity: 1`, `radius: 0.05` and unlimited `range: 0`.

The light uses inverse-square falloff outside its radius. Doubling distance reduces incoming illumination to one quarter before material response. Intensity follows the candela convention for a point source, but the renderer's existing exposure and environment are not a calibrated photographic pipeline.

Radius limits near-source attenuation to avoid a singularity. It does not create an area emitter or soften shadows. Range zero preserves unlimited falloff. A positive range smoothly fades the light to zero using `(max(1 - (distance / range)^4, 0))^2`. This artistic cutoff changes physical falloff near the range boundary.

Inputs must be finite numbers. Positions are within ±1,000,000 scene units. Colors are within zero and one. Intensity is within zero and 100,000. Radius is between 0.001 and 1,000,000. Range is zero or between 0.001 and 1,000,000.

Key/fill/ambient intensity is between zero and 100. Key color components are between zero and 1,000. Large coordinates still inherit Float32 rendering precision limits.

Lights currently cast no local shadows and can illuminate through opaque walls. The original directional shadow map remains in use. Point-light shadows, spotlights, area lights, indirect bounces and volumetric scattering remain unfinished.

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
