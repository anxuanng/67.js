# Editable static GLB export

`exportGlb(parts)` returns a self-contained GLB `ArrayBuffer` for the current static scene.
`downloadGlb(parts)` saves that same snapshot through the browser.
The exporter stores each part matrix as a root node transform.
It preserves shared geometry accessors and shared meshes when materials match.
Available from version `0.4.0`.

```js
const geometry = box();
geometry.colors = new Float32Array(geometry.positions.length).fill(0.5);
geometry.uvs = new Float32Array(geometry.positions.length / 3 * 2);
const part = {
  name: 'Editable surface',
  geometry,
  matrix: mat4.create(),
  material: {
    color: [0.2, 0.4, 0.6],
    metallic: 0,
    roughness: 0.7,
    emissiveColor: [1, 0.1, 0.05],
    emission: 8,
  },
};
const binary = exportGlb([part]);
```

## Stored channels

| Input | GLB data | Rules |
| --- | --- | --- |
| `geometry.positions` | `POSITION`, Float32 `VEC3` | Nonempty finite XYZ vectors. |
| `geometry.normals` | `NORMAL`, Float32 `VEC3` | One finite unit vector per vertex, with length tolerance `0.001`. |
| `geometry.indices` | Unsigned integer `SCALAR` | Nonempty `Uint32Array` of triangles with valid vertex indices. |
| `geometry.colors` | `COLOR_0`, Float32 `VEC3` | Optional opaque linear RGB multipliers within `[0,1]`. |
| `geometry.uvs` | `TEXCOORD_0`, Float32 `VEC2` | Optional finite coordinates, including values outside `[0,1]`. |
| `geometry.morphTargets` | Relative `POSITION` and `NORMAL` accessors | One to 64 targets with matching Float32 channel counts. |
| `part.morph.weights` | Independent `node.weights` | Current finite signed Float32 weights. |

Every vertex channel must match the position count.
Typed arrays can reference a subsection of a larger buffer.
The exporter stores only that subsection and preserves its Float32 values.
Colors multiply the base material color in linear space, following the [glTF geometry specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes).
UV coordinates remain editable even though this exporter rejects textures.

## Materials and emission

`material.color` and `material.emissiveColor` contain three linear RGB components within `[0,1]`.
`metallic` and `roughness` must each lie within `[0,1]`.
`emission` defaults to zero and must be finite, nonnegative, and representable as Float32.
An omitted `emissiveColor` uses `material.color`.

Positive emission keeps the emissive RGB factor separate from its scalar intensity.
A positive intensity other than one uses [KHR_materials_emissive_strength](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_emissive_strength).
The file requires that extension so unsupported viewers cannot silently reinterpret its radiance.
An intensity of one uses the core emissive factor without an extension.
Zero emission writes a black emissive factor without an extension.
The snapshot does not preserve a dormant emissive color when its intensity is zero.

The exporter validates every part before constructing accessors or allocating the GLB binary.
Malformed channels, factors, matrices, morph pairs, and indices throw errors instead of undergoing conversion or clamping.

Matrices must contain 16 finite Float32-representable values and have an affine last row.
Their Float32 linear columns must have nonzero lengths and represent rotation with independent scales.
Shear fails when normalized column dot products exceed `8 * 2 ** -23`, allowing Float32 rotation rounding.
Zero scales and scales that collapse to Float32 zero fail before allocation.
Negative scales remain valid.

## Design choice

| Design | Editing and fidelity | Cost |
| --- | --- | --- |
| Vertex accessors and standard material factors | Preserves RGB, UV, morph channels, and active emission independently. | Stores the authored channels once per shared geometry. |
| Bake appearance into textures | Requires a texture bake and obscures authored vertex colors and material factors. | Requires texture support, UV baking, and image storage. |

The exporter uses accessors because its callers already supply editable vertex data.
A texture bake introduces a separate asset pipeline and cannot preserve the same source channels.

## Limits

Skinning and all material texture channels throw explicit unsupported errors.
The snapshot retains current morph weights but does not serialize animation clips or skeletons.
It stores opaque metallic roughness materials without renderer tags, procedural weathering, custom shaders, lighting, cameras, or postprocessing.
It does not promise identical rendered pixels across tools.
Materials tagged `unlit` still export through this documented metallic roughness snapshot contract.

The [Blender glTF workflow](https://docs.blender.org/manual/en/5.3/addons/scene_gltf2.html) supports vertex colors, UV coordinates, shape keys, and emissive strength.
These editable fields remain available to compatible tools after import.

## Render verification

`node scripts/smoke-glb-fidelity.mjs 960 540` compares source parts and imported GLB parts through the built modules in native Chrome.
The fixture covers the film head, a cube with RGB multipliers and UVs outside `[0,1]`, and independent HDR emission.
At 960 by 540 and 540 by 960, all three source and imported images matched exactly on the RTX 3060.
Every draw reported zero WebGL errors.

The original exporter lost vertex channels and produced maximum channel differences of 31, 194 and 185 in those respective fixtures.
Each draw uses one renderer, which is disposed before the next draw.
These measurements establish fidelity for the fixtures, not identical rendering across tools or recognizable character quality.
