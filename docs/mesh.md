# Polygon mesh core

Unreleased. `67js/addons/mesh` is the first phase of agent-oriented polygon modeling
(plan: `.agents/plans/modeling-parity.md`). It holds polygon topology, converts to and from renderer geometry, and
checks meshes. Editing operators (extrude, inset, booleans and so on) build on it in the next phase.

```js
import { box } from '67js';
import { meshFromGeometry, editMesh, meshData, validateTopology, extractRender, lintMesh, facesWithTag } from '67js/addons/mesh';

const mesh = meshFromGeometry(box(0, 1));   // 8 vertices, 12 edges, 6 quads, tagged top/bottom/side/...
lintMesh(mesh).ok;                          // true: closed, consistently wound, no degenerate faces
facesWithTag(mesh, 'top');                  // [face index]

const edit = editMesh(mesh);                // half-edge topology for local edits
validateTopology(edit);                     // { vertices, edges, faces, loops, euler }
const back = meshData(edit);                // compact again

const { geometry } = extractRender(back);   // positions, normals, uvs, indices for Renderer67
```

## MeshData

`createMeshData({ positions, faceOffsets, cornerVertices, attributes })` returns a frozen mesh in the layout Blender
uses for evaluated meshes:

| Field | Type | Meaning |
| --- | --- | --- |
| `positions` | `Float32Array`, 3 per vertex | Vertex positions |
| `faceOffsets` | `Uint32Array`, faces + 1 | Face `f` owns corners `faceOffsets[f]` to `faceOffsets[f + 1]` |
| `cornerVertices` | `Uint32Array` | Vertex of each corner, in winding order |
| `edgeVertices` | `Uint32Array`, 2 per edge | Derived unique edges |
| `cornerEdges` | `Uint32Array` | Edge from each corner to the next corner of its face |
| `attributes` | `{ point, edge, face, corner }` | Named `{ data, size }` arrays per domain |

Faces are polygons with three or more corners; consecutive corners cannot repeat a vertex. Inputs are not copied.
Attribute arrays may be `Float32Array`, `Uint8Array`, `Uint16Array`, `Uint32Array` or `Int32Array` with 1 to 16
components. Edge attributes need explicit `edgeVertices` and `cornerEdges`, because derived edge order is internal.

Conventions used by the other functions:

- Corner `uv` (size 2) and `color` (size 3) are UV channel zero and vertex colour.
- Edge `sharp` (`Uint8Array`) marks hard edges.
- Face `tag:<name>` (`Uint8Array`, 0 or 1) marks a face as carrying a tag. `meshTags`, `facesWithTag` and
  `tagCounts` read them. A face can carry several tags.

Limits: 4,000,000 vertices and 16,000,000 corners per mesh.

## EditMesh

`editMesh(meshData)` builds a mutable half-edge mesh in BMesh's model, stored in typed arrays:

- Each edge has two endpoint slots; the slots around a vertex form its disk cycle.
- Each face corner is a loop with `next`/`prev` around its face and `radialNext`/`radialPrev` around its edge.
- Polygons of any size and non-manifold edges are representable.

Element indices start equal to the MeshData vertex, edge, face and corner indices. Methods:
`createVertex`, `createFace(vertices)` (creates missing edges), `ensureEdge`, `findEdge`, `removeFace`, `removeEdge`,
`removeVertex`, `vertexEdges`, `vertexDegree`, `edgeLoops`, `edgeFaceCount`, `faceLoops`, `faceVertices`,
`faceNeighbors`, `liveIndices(domain)`, and `ensureAttribute(domain, name, type, size)` for attributes that grow with
the mesh. Removed indices are reused. `meshData(edit)` compacts the result; wire edges are dropped and loose vertices
kept.

`validateTopology(edit)` checks every disk, radial and face cycle and throws a `RangeError` that names the first
broken element.

## Conversion and rendering

`meshFromGeometry(geometry, { weld, quads = true, tags = 'axis' })` converts renderer geometry (indexed triangles
with vertices split at seams):

- Vertices within `weld` merge; the default is 1e-6 of the bounds diagonal.
- UVs and colours become corner attributes, so seams survive welding.
- Edges where the input normals were split become `sharp`, so hard edges survive.
- With `quads`, flat triangle pairs that agree on every attribute join into convex quads, best-shaped first.
- With `tags: 'axis'`, faces whose normal is within 45 degrees of an axis get `top`, `bottom`, `right` (+X),
  `left` (-X), `front` (+Z) or `back` (-Z); the four horizontal ones also get `side`.

`extractRender(mesh, { sharpAngle })` returns `{ geometry, renderVertexSource, cornerRenderVertex, triangleFaces }`.
Corner normals are angle-weighted and smoothed across an edge unless it is `sharp`, a boundary, non-manifold,
inconsistently wound, or bends more than `sharpAngle`. Render vertices split at hard edges and at UV or colour
seams. Quads split along the shorter diagonal and larger polygons use ear clipping in their own plane (up to 4096
corners). After a deform-only change, `gatherRenderPositions(mesh, renderVertexSource)` re-gathers positions without
rebuilding the topology.

`faceNormals`, `cornerNormals`, `triangulateMesh`, `joinTriangles`, `tagFacesByAxis`, `weldVertices` and
`rebuildFromCorners` are exported for operators that need one step.

## Lint

`lintMesh(mesh)` returns `{ ok, counts, parts, tags, bounds, problems }`. Each problem has `kind`, `severity`,
`count`, up to eight sample indices and a suggested `fix`:

| Kind | Severity | Sample indices |
| --- | --- | --- |
| `non-manifold-edge` | error | edges used by three or more faces |
| `inconsistent-winding` | error | edges whose two faces wind the same way |
| `inverted-part` | error | closed parts with negative volume |
| `degenerate-face` | error | faces with near-zero area |
| `boundary-edge` | warning | edges with one face (open surfaces) |
| `loose-vertex` | warning | vertices used by no face |

`ok` is false when any error is present. Self-intersections and wall thickness are not checked yet.

## Measured speed

`node scripts/benchmark-mesh-core.mjs 1000` on a 1000 x 1000 quad grid (one million faces), Node 24, Ryzen 5 5600X,
one thread at below-normal priority on a shared machine, medians of five runs. Runs varied by about 25%.

| Step | Median |
| --- | --- |
| `createMeshData` (derive edges) | 61–63 ms |
| `editMesh` + `meshData` round trip | 234–296 ms |
| `validateTopology` | 188–192 ms |
| `cornerNormals` | 318 ms |
| `extractRender` | 380 ms |
| `lintMesh` | 191–210 ms |
| `meshFromGeometry`, sphere with 1M triangles | 1.3–1.5 s |

The `EditMesh` arrays take about 200 bytes per quad face without attributes. These numbers are this machine only
and say nothing about Blender's speed.
