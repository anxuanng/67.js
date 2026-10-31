# glTF asset bridge

`src/gltf.js` converts glTF 2.0 assets into Renderer67 parts.
It decodes GLB and glTF files with its own parser (`src/gltf-decode.js`), so the addon does not import Three.js.
A box with the addon is 67,467 bytes gzip, against 159,422 when it used `GLTFLoader`.
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
| `maxJoints` | 4,096 | Combined declared joints and joint palettes for instantiated meshes. |
| `maxInstances` | 4,096 | Instances of one `EXT_mesh_gpu_instancing` node. |

Every numeric limit must be a positive safe integer.
The importer rejects cyclic hierarchies, multiple parents, and hierarchies deeper than 256 levels.
It checks PNG and JPEG dimensions before browser image decoding.
Decoded accessor data has a separate ceiling of four times `maxBytes`.
These limits bound asset inputs and geometry, rather than the renderer's total GPU allocation.
The renderer retains its separate memory budget.

## Output

The result contains `parts`, `warnings`, `animations`, `applyAnimation`, `dispose`, and `capabilities`.
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
The source [exporter](export-glb.md) preserves opaque colors, UVs and active HDR emission when creating static GLB snapshots.

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

`animations` contains the decoded animation clips, including their names, durations, and tracks. Each track has `name` (`Node.position`, `Node.quaternion`, `Node.scale` or `Node.morphTargetInfluences`), `times`, `values`, `getInterpolation()` and `createInterpolant(result)`, the same fields the Three.js clips had.
`applyAnimation(time, clipIndex = 0)` evaluates node and joint animation at an absolute time in seconds.
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

The current source supports four-influence [GPU skinning](https://67js.codepawl.com/skinning.md). GPU skinning is available from version `0.4.0`.
The current source also supports relative POSITION/NORMAL morph targets and weight animations. See [morph import](https://67js.codepawl.com/gltf-morph.md).
Morph primitives require authored base normals. TANGENT targets and per-target flat normal generation remain unsupported.

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

Alpha masking, alpha blending and double-sided materials import onto `alphaMode`, `alphaCutoff`, `opacity` and `doubleSided` (see the material maps guide). Vertex transparency is still rejected.
It supports base-color, normal, metallic-roughness, occlusion and emissive texture channels.
It rejects unknown extensions, including optional ones.
Line and point primitives are unsupported.

## Extensions

| Extension | Behavior |
| --- | --- |
| `KHR_mesh_quantization`, `KHR_materials_emissive_strength` | Supported. |
| `KHR_texture_transform` | Offset, rotation and scale are baked into `geometry.uvs`. All maps of one material must share one transform, otherwise the import fails. `texCoord` overrides are rejected. |
| `EXT_mesh_gpu_instancing` | The node expands into one part per instance and primitive. Parts of one primitive share one geometry object, so the renderer batches them. Skinned or morphed instancing is rejected. |
| `KHR_draco_mesh_compression` | Needs `options.decoders.draco`. |
| `EXT_meshopt_compression` | Needs `options.decoders.meshopt`. |
| `KHR_texture_basisu` | Needs `options.decoders.ktx2`. |
| `KHR_materials_clearcoat`, `_transmission`, `_ior`, `_specular`, `_sheen`, `_volume`, `_anisotropy`, `_iridescence` | Read as factors and rendered as material layers, see `docs/material-maps.md`. Their textures are ignored, and an iridescent film takes the thickness maximum. Export writes them back. |

`KHR_materials_transmission` with a factor above zero sets `material.transmission` to that factor.
It is a hint only: the renderer does not draw transmission yet.

Without the matching decoder, a file that uses a compression extension fails with `Unsupported glTF extension` and the option name.

### Decoders

The decoders are the Three.js loaders, and they stay yours: only an application that passes one imports Three.js. 67js does not bundle or fetch their wasm files, so you choose where they are served.
A Draco loader needs `decodeDracoFile(buffer, onLoad, attributeIds, attributeTypes, colorSpace, onError)`, a meshopt decoder needs `ready` and `decodeGltfBuffer`, and a KTX2 loader needs `load(url, onLoad, onProgress, onError)`.

```js
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const draco = new DRACOLoader().setDecoderPath('/vendor/draco/');   // copy three/examples/jsm/libs/draco/
const ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/');  // copy three/examples/jsm/libs/basis/
// Transcode to RGBA8 only: the renderer uploads plain pixels, not GPU-compressed formats.
ktx2.workerConfig = { astcSupported: false, astcHDRSupported: false, etc1Supported: false, etc2Supported: false, dxtSupported: false, bptcSupported: false, pvrtcSupported: false };

const asset = await loadGltf('/models/car.glb', { decoders: { draco, ktx2, meshopt: MeshoptDecoder } });
```

Any subset works. Draco and KTX2 decode in browser workers. Dispose the loaders yourself when done (`draco.dispose()`, `ktx2.dispose()`).
A KTX2 texture that decodes to a GPU-compressed format fails with a message that points back to this setting.
KTX2 dimensions count toward `maxTexturePixels` before decoding.

### Instancing limits

`maxInstances` (default 4,096) caps the instances of one node, and `maxParts` still caps the total number of parts.
Both are checked from the accessor counts before any data is decoded.
The bridge does not import cameras, lights or scene environments into Renderer67.
The caller supplies its own camera and lighting.

## Verification

`node --test tests/gltf.test.js` covers generated GLB triangles and the existing `exportGlb` roundtrip.
The tests cover parent transforms, missing normals, UVs, shared geometry, PBR factors, mirrored winding, and animation seeks.
The tests also cover input limits, unsupported features, compressed image dimensions, and oversized fetch cancellation.

`node --test tests/gltf-extensions.test.js` covers texture transform baking, instancing, ignored material extensions and the decoder options.
The meshopt test decodes a real encoded buffer with the Three.js decoder.
The Draco and KTX2 tests use stand-in loaders, because no encoder is installed: they prove the wiring, not the wasm decoders.

`tests/fixtures/textured-triangle.gltf` contains an original triangle and a generated two-pixel-square PNG.
Chrome loading preserved its UVs, linear material factors, sampler values, and decoded image dimensions.
Renderer integration owns the final textured rendering check.
