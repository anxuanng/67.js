# Material maps

`Renderer67` supports five texture channels on standard metallic/roughness materials.
Each channel uses an image descriptor. All channels sample `geometry.uvs`, which contains two finite values per vertex.

```js
const colorTexture = { image: colorImage, colorSpace: 'srgb' };
const surfaceTexture = { image: packedImage, colorSpace: 'linear' };
const material = {
  color: [1, 1, 1],
  metallic: 0.8,
  roughness: 0.6,
  emission: 1,
  emissiveColor: [0.1, 0.2, 0.3],
  map: colorTexture,
  normalMap: { image: normalImage, colorSpace: 'linear' },
  normalScale: [1, 1],
  metallicRoughnessMap: surfaceTexture,
  occlusionMap: surfaceTexture,
  occlusionStrength: 0.7,
  emissiveMap: { image: emissionImage, colorSpace: 'srgb' },
};
```

The packed image can contain occlusion in R, roughness in G, and metallic in B.
The renderer applies the following channel rules from the [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials).

| Field | Input | Effect |
| --- | --- | --- |
| `map` | sRGB by default, or explicit linear RGB | Multiplies the linear base color and vertex tint. |
| `normalMap` | Explicit linear RGB | Decodes tangent-space XYZ from `[0, 1]` to `[-1, 1]`. |
| `metallicRoughnessMap` | Explicit linear RGB | Multiplies roughness by G and metallic by B. |
| `occlusionMap` | Explicit linear RGB | Uses R to attenuate indirect lighting. |
| `emissiveMap` | sRGB | Multiplies linear `emissiveColor * emission`. |

WebGL sRGB texture storage decodes color maps before shading. Data maps use linear texture storage.
Occlusion uses `mix(1, R, occlusionStrength)`. It does not attenuate direct lights or emission.
Roughness retains the renderer's minimum of `0.075` and derivative-based specular filtering.

`normalScale` contains two finite floats for X and Y. Negative values can invert either tangent axis.
The renderer derives an orthogonal tangent basis from position and UV screen derivatives, including mirrored UV handedness.
Degenerate UVs retain the geometric normal because they have no tangent basis.

Explicit vertex tangents are not consumed. Derivative tangents can differ from authored tangent bases on curved meshes.

## Descriptors and batching

A descriptor contains `image`, `uvChannel`, `colorSpace`, `flipY`, `wrapS`, `wrapT`, `minFilter`, and `magFilter`.
`uvChannel` defaults to zero. `flipY` defaults to false.

Sampler fields use WebGL enum values. Wrapping supports repeat, clamp-to-edge, and mirrored repeat.
Magnification supports nearest and linear. Minification also supports all four mipmap filters.

Descriptor identity determines GPU texture reuse. Repeated parts can share descriptors without duplicating GPU textures or texture-budget charges.
Different descriptors allocate separately even when they reference the same decoded image.
Every channel and its mipmaps contributes to `textureBytes` and the render memory plan.

A batch groups geometry identity, all five map identities, `normalScale` values, and `occlusionStrength`.
The renderer uses batch uniforms for scale and strength because its instance attributes already occupy 16 vertex locations.
Changing any of these batch fields requires a new renderer. `updateParts()` rejects changes before uploading instance data.
Color, metallic, roughness, emission, emissive color, and transforms retain their existing update behavior.
Descriptors and decoded image contents must remain unchanged while a renderer uses them.

Two API shapes were considered. A nested channel registry could carry arbitrary channel packing and transforms.
Named per-channel descriptors reuse the existing `material.map` contract and make channel semantics explicit.
The current API uses named descriptors. Arbitrary channel routing and texture transforms remain unsupported.

## glTF import and lifetime

`parseGltf()` and `loadGltf()` import base color, normal, metallic/roughness, occlusion, and emissive textures.
The importer preserves `normalTexture.scale`, `occlusionTexture.strength`, color spaces, samplers, and shared descriptor identities.
A texture reused for color and data receives separate descriptors with the appropriate color spaces.
Existing byte, resource, vertex, and combined image-pixel limits apply before decoding.
Invalid sampler values, texture indices, scales, or missing UVs fail before resources load.

1. Dispose the renderer before disposing its imported asset.
2. Call `asset.dispose()` to release decoded textures and images.

Renderer disposal deletes every cached GPU texture. Asset disposal closes each shared decoded image once.

## Alpha and double-sided materials

| Field | Default | Meaning |
| --- | --- | --- |
| `alphaMode` | `'opaque'` | `'opaque'`, `'mask'` (cutout) or `'blend'` (translucent). |
| `alphaCutoff` | `0.5` | Mask only. Fragments with alpha below it are discarded. |
| `opacity` | `1` | Multiplies the base map alpha. Ignored by `opaque`. |
| `doubleSided` | `false` | Draws both faces and flips the normal on back faces so each side lights correctly. |

Final alpha is the base map alpha (when `material.map` is set) times `opacity`. Vertex colors stay RGB.

- `mask` discards below `alphaCutoff` in the color pass and in the shadow pass, so shadows follow the cutout shape. With MSAA the edge uses alpha-to-coverage, sharpened by `fwidth`, so leaf edges stay smooth.
- `blend` draws after all opaque and masked batches, with depth writes off. Batches sort back to front by their mean distance to the eye, and instances inside one batch sort by translation distance each frame. Intersecting translucent surfaces and large meshes can still show ordering artifacts. Blend parts skip shadows unless `castShadow: true` is set, and then they cast a fully opaque shadow.
- `alphaMode`, `alphaCutoff`, `opacity` and `doubleSided` are batch state like `castShadow`. Parts that differ never share a draw call, and `updateParts` rejects changes after upload. Rebuild the renderer to change them.
- Invalid values (unknown mode, cutoff or opacity outside zero to one, a non-boolean `doubleSided`) throw.
- The benchmark preset ignores alpha.

glTF import maps `alphaMode` MASK and BLEND, `alphaCutoff`, `doubleSided` and `baseColorFactor[3]` (to `opacity`) onto these fields, and keeps the base color texture alpha. `exportGlb` writes them back.

## Splat layers

A standard-tag material can carry `layers` (up to four `{ color, normal, roughness, height, scale, tint, triplanar }` entries built from `loadTextureSet`) and a `splat` rule object instead of these single maps. The layers are blended by slope, height and a weight mask, sampled in world space and packed into texture arrays on units 11 to 14. They replace `map`, `normalMap`, `metallicRoughnessMap` and `occlusionMap`, which must be absent, and parts batch only when `layers` and `splat` are the same objects. See [Terrain](/terrain.md).

## Limits

Texture transforms, UV channels beyond zero, and vertex alpha below one remain unsupported.
Skinning, morph targets, compressed texture formats, and unsupported glTF extensions fail explicitly.
The new PBR maps require a standard material tag, including `gltf` or `armor`.
Procedural tags such as water, terrain, foliage, floor, fire, and smoke reject the new channels.
Unlit materials accept base and emissive maps only.
Texture alpha is ignored for opaque materials, as required by glTF's opaque mode.

This feature does not complete the full material system.
Extensions such as clearcoat, transmission, anisotropy, and sheen, material layers, node graphs, and authored tangent support remain missing.
GLB export of these material maps is outside this feature.
