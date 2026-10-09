# glTF asset bridge

`src/gltf.js` converts glTF 2.0 assets into Renderer67 parts.
It uses the optional Three.js `GLTFLoader` for decoding, without creating a Three.js renderer.
The core renderer does not import this addon.

```js
import { loadGltf } from '67js/addons/gltf';
import { Renderer67 } from '67js';

const asset = await loadGltf('/models/object.glb');
const renderer = new Renderer67(canvas, asset.parts, {
  ground: false,
  samples: 4,
  memoryBudgetMiB: 256,
});
renderer.render({ eye: [0, 2, 5], target: [0, 1, 0] });
```

## Input

`loadGltf(source, options)` accepts a URL string, a `URL`, a local `File`, or a `Blob`.
`parseGltf(data, options)` accepts an `ArrayBuffer` or a glTF JSON string.
Both functions return a promise for the decoded asset.

URL loading derives the resource directory from the asset URL.
An explicit `baseUrl` overrides that directory.
Relative external resources in a local glTF file require `baseUrl`.
GLB files can contain their buffers and images without external resources.

HTTP, HTTPS, blob URLs, and base64 data URIs are supported.
External requests use bounded streaming fetches.
The optional `signal` aborts those fetches.

| Option | Default | Limit |
| --- | ---: | --- |
| `maxBytes` | 33,554,432 | Total encoded input and fetched external resources. |
| `maxVertices` | 2,000,000 | Declared and decoded geometry vertices. Indices have a separate ceiling of twelve times this value. |
| `maxParts` | 20,000 | Declared nodes and decoded mesh parts. |
| `maxResources` | 64 | Unique resource URIs. |
| `maxTexturePixels` | 16,777,216 | Combined texture image pixels, checked before decoding. |

Every numeric limit must be a positive safe integer.
The importer rejects cyclic hierarchies, multiple parents, and hierarchies deeper than 256 levels.
It checks PNG and JPEG dimensions before browser image decoding.
Decoded accessor data has a separate ceiling of four times `maxBytes`.
These limits bound asset inputs and geometry, rather than the renderer's total GPU allocation.
The renderer retains its separate memory budget.

## Output

The result contains `parts`, `animations`, `applyAnimation`, `dispose`, and `capabilities`.
Each part contains `name`, `geometry`, `matrix`, and `material`.
The column-major matrix contains the complete world transform, including parent transforms.
Repeated primitives share geometry objects.
Static mirrored instances reverse triangle winding while preserving their world matrices.

Geometry contains `positions` and `normals` as `Float32Array` values, plus `indices` as a `Uint32Array`.
The importer computes missing normals and normalizes supplied normals.
It rejects non-finite attributes, invalid indices, singular transforms, and unusable normals.
`geometry.uvs` preserves `TEXCOORD_0` as two floats per vertex.
`geometry.colors` preserves opaque `COLOR_0` values as three linear RGB floats per vertex.

Materials preserve linear `color`, `metallic`, `roughness`, and `emissiveColor` factors.
`emission` contains the emissive intensity.
The `gltf` tag uses standard PBR shading without studio finish overrides.
An emissive-strength extension preserves its intensity.

A base color texture adds this descriptor:

```js
material.map = {
  image,                 // Decoded browser image or ImageBitmap.
  uvChannel: 0,
  wrapS: 10497,          // Native WebGL sampler enum.
  wrapT: 33071,
  minFilter: 9729,
  magFilter: 9729,
  flipY: false,
  colorSpace: 'srgb',
};
```

Texture descriptors share identity when materials reuse the same texture.
Texture rendering requires batches grouped by geometry and texture identity.
The image descriptor requires sRGB sampling with conversion to linear RGB before lighting.
The importer rejects a requested texture that fails to decode, rather than returning an untextured material.

## Animation and ownership

`animations` contains the decoded Three.js animation clips, including their names, durations, and tracks.
`applyAnimation(time, clipIndex = 0)` evaluates one rigid node animation at an absolute time in seconds.
Time clamps to the selected clip's duration.
The hook updates the existing part matrices and returns the same `parts` array.
Seeking in a different order produces the same matrices.

```js
const changedParts = asset.applyAnimation(1.25, 0);
renderer.updateParts(changedParts);
renderer.render(camera);
```

Translation, rotation, and scale tracks are supported.
The importer rejects animation poses that become singular or change triangle winding.
It does not support skinning or morph targets.

The caller owns the Renderer67 instance.
`asset.dispose()` releases importer textures, image bitmaps, parser resources, and temporary object URLs.
It does not dispose the renderer.
Disposal is idempotent, and subsequent animation calls fail explicitly.

1. Call `renderer.dispose()` before replacing its imported asset.
2. Call `asset.dispose()` after the renderer finishes using the asset's images.

## Supported subset

`GLTF_CAPABILITIES` lists the supported and unsupported features.
The bridge supports triangle meshes, PNG/JPEG base color textures, rigid animations, and metallic-roughness material factors.
It also supports `KHR_mesh_quantization` and `KHR_materials_emissive_strength`.

The importer rejects alpha blending, alpha masking, double-sided materials, vertex transparency, and additional material texture channels.
It rejects texture transforms, DRACO, KTX2, GPU instancing, and unsupported extensions, including optional extensions.
Line and point primitives are unsupported.
The bridge does not import cameras, lights, scene environments, or skin data into Renderer67.
The caller supplies its own camera and lighting.

## Verification

`node --test tests/gltf.test.js` covers generated GLB triangles and the existing `exportGlb` roundtrip.
The tests cover parent transforms, missing normals, UVs, shared geometry, PBR factors, mirrored winding, and animation seeks.
The tests also cover input limits, unsupported features, compressed image dimensions, and oversized fetch cancellation.

`tests/fixtures/textured-triangle.gltf` contains an original triangle and a generated two-pixel-square PNG.
Chrome loading preserved its UVs, linear material factors, sampler values, and decoded image dimensions.
Renderer integration owns the final textured rendering check.
