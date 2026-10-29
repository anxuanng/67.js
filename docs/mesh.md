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

## Selection and edits

`selectFaces(mesh, rule)` turns a JSON rule into a face mask. `applyMeshEdits(mesh, edits)` runs an edit log and
returns `{ mesh, results }`. Both are what recipe `mesh` geometries and the `mesh_edit` tool use.

Selection rules:

| Rule | Selects |
| --- | --- |
| `{ "all": true }` | every face |
| `{ "tag": "top" }` | faces carrying a tag |
| `{ "normal": [0, 1, 0], "maxAngle": 10 }` | faces facing within `maxAngle` degrees (default 10) of a direction |
| `{ "inside": { "min": [x, y, z], "max": [x, y, z] } }` | faces whose centroid lies in a box |
| `{ "faces": [0, 4] }` | explicit face indices |
| `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": rule }` | combinations |
| `{ "grow": rule, "steps": 1 }` | the selection plus faces sharing an edge, repeated |
| `{ "boundary": rule }` | selected faces that touch an unselected face or an open edge |

Edits (names follow Blender's `bmesh.ops` where they match):

| Op | Fields | Creates tags |
| --- | --- | --- |
| `extrude_face_region` | `select`, `offset`, optional `direction`, `name` | `<name>.cap`, `<name>.side` |
| `extrude_individual` | same | same, per face |
| `inset_region` | `select`, `thickness`, optional `depth`, `name` | `<name>.cap`, `<name>.rim` |
| `inset_individual` | same | same, per face |
| `delete` | `select` (required) | |
| `flip_normals` | `select` | |
| `translate` | `select`, `offset` [x, y, z], optional `falloff` `{ radius, curve, connected }` | |
| `merge_by_distance` | `distance` (default 1e-4) | |
| `tag` | `select`, `name` (required) | `<name>` |
| `boolean` | `operation` (`union`, `difference`, `intersect`), `cutter`, optional `translation`, `rotation` (XYZW), `scale`, `name` | `<name>.cut` |

- `select` defaults to every face, except for `delete` and `tag`.
- `name` defaults to `<op>-<index>`, for example `extrude-1`.
- Extrusions move each group of edge-connected faces along that group's own average normal. Faces in one group
  that face opposite ways (the four sides of a box) cancel out; use the `_individual` op or pass `direction`.
- Caps keep their earlier tags; side and rim faces start without tags.
- Falloff curves follow Blender's proportional editing: `smooth`, `sphere`, `root`, `sharp`, `linear`,
  `constant`, `inverseSquare`. With `connected`, distance is measured along edges.
- An edit that selects no faces, names an unknown tag, or grows the mesh past its limits throws an error naming
  the edit index and op. A log holds at most 64 edits.

Each result records `selected`, the `tags` created with their face counts, op-specific counts (`deletedFaces`,
`movedVertices`, `removedVertices`) and the mesh size `after` the edit.

### Booleans

Booleans run on [Manifold](https://github.com/elalish/manifold) (Apache-2.0), the library behind Blender 4.5's
Manifold solver, compiled to WebAssembly. In a recipe, `cutter` is a primitive or profile record like `base`
(`{ "type": "cylinder", "segments": 32 }`), placed by `scale`, then `rotation`, then `translation` in the mesh's local
space. Faces from the mesh keep their tags; faces the cutter contributes (the walls of a hole, the surface of a
union) get `<name>.cut`. Flat faces come back as polygons; faces with holes come back as triangles, joined into quads
where flat pairs allow.

Both inputs must be closed and consistently wound. A boolean on an open mesh fails with the lint counts and a fix.
A difference that leaves a hollow inside the mesh is valid; `lintMesh` reports it under `parts.cavities` instead of as
an inverted part.

Outside recipes, call `await loadMeshBooleans()` once, then `meshBoolean(mesh, cutter, operation, { cutTag })` or
`applyMeshEdits(mesh, edits, { resolveCutter })`. The library loads `manifold-3d` as an optional peer dependency,
like Rapier for physics: install `manifold-3d@3.5.4` next to `@codepawlhq/67js` to use booleans, in the library and
in the MCP server alike. The MCP runtime serves Manifold's module and binary to its preview page from that
installation, on the page's own origin; the page policy adds only WebAssembly compilation (`'wasm-unsafe-eval'`).
Without the peer, a boolean edit fails with the install command and everything else keeps working. Keeping
Manifold out of the package holds the npm archive under its 1 MiB budget.

Measured on this machine (Node 24, one thread): engine load 26–45 ms; cube minus a 32-sided cylinder 25–30 ms;
a 32,768-face sphere minus a box about 0.6 s including conversion and lint.

### Mirror, array and solidify

These three (and `bevel`, below) work as edits and as stack nodes:

| Op | Fields | Creates tags |
| --- | --- | --- |
| `mirror` | `axis` (`x` default, `y`, `z`), `merge` (default 0.001), `name` | `<name>.mirrored` |
| `array` | `count` (1 to 256, default 2), `offset` [x, y, z], `relativeOffset` [x, y, z] in bounding-box sizes (default [1, 0, 0] unless `offset` is given), `merge`, `name` | `<name>.last` |
| `solidify` | `thickness`, `offset` (-1 inward by default, 1 outward, 0 centred), `evenThickness` (default true), `name` | `<name>.inner`, `<name>.rim` |

- `mirror` reflects across the plane through the local origin. Vertices within `merge` of the plane are shared by
  both halves and faces lying in the plane are removed, so mirroring a closed half that touches the plane gives one
  closed solid. Mirrored faces swap their axis tags (`left` and `right` for x, `top` and `bottom` for y, `front` and
  `back` for z), so tags keep matching where the faces are.
- `array` with `merge` welds touching copies and removes the faces between them, giving one solid.
- `solidify` adds an inner shell and rim quads along open edges. An open surface becomes a closed wall; a closed
  surface becomes a hollow shell (reported as a cavity).

`removeCoincidentFaces(mesh)` is exported for the same cleanup after other operations.

### Modifier stack

A recipe mesh may carry `stack`, a list of `mirror`, `array`, `solidify` and `bevel` nodes (up to 16) evaluated after the
edits without changing them, as Blender's modifier stack. Every prefix (the edit result, then each node) is cached
by its recipe text in a least-recently-used cache bounded at 64 entries and 64 MiB, so changing a late node reuses
the earlier work. Results list one entry per node with `cached: true` when reused. `meshCacheStats()` reports hits
and misses. `evaluateMeshStack(mesh, stack, { cache, cacheKey })` runs a stack outside recipes.

The `mesh_stack` tool sets the whole stack in one revision. `apply: n` moves the first `n` nodes into the edit log,
as Blender's Apply modifier, which leaves the result unchanged.

### Bevel

`bevel` rounds or chamfers edges, as an edit or as a stack node:

| Field | Meaning |
| --- | --- |
| `edges` | `{ "between": [faceRule, faceRule] }` (the rim between two regions, for example top and side), `{ "angle": 30 }` (edges bending at least this many degrees; the default), `{ "boundaryOf": faceRule }`, or `{ "all": true }` |
| `width` | Distance from the edge into each neighbouring face |
| `segments` | 1 to 16; 1 is a flat chamfer, 3 or more reads as round |
| `profile` | 0 flat, 0.5 round (default), 1 boxy |
| `clampOverlap` | Default true: shrink `width` so neighbouring bevels cannot cross; the result reports `clamped` and the `width` used |

Only edges with two consistently wound faces bevel. A face corner next to one beveled edge slides along its other
edge, shared with the face across that edge, so no T-junctions appear. Each beveled edge becomes a strip of
`segments` quads following a quadratic profile around the original edge (tag `<name>.strip`). Where beveled edges meet
at a vertex, the gap is filled (tag `<name>.corner`): a corner where three rounded edges meet gets a quadratic
triangular patch that matches the three profiles exactly; other corners get a flat polygon (chamfers) or a fan to a
raised centre. The quadratic profile is close to, not exactly, a circular arc, so rounded corners shade slightly
differently from Blender's. Edges between strip segments render smooth when the bend per segment is under the mesh's
`smoothAngle`; with 2 segments on a right angle (45 degrees each), raise `smoothAngle` or use 3 or more segments.

Loop cut is planned next.

## MCP

A recipe geometry of type `mesh` starts from a primitive or profile and replays an edit log:

```json
{ "id": "crate", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "smoothAngle": 30,
  "edits": [
    { "op": "inset_individual", "select": { "tag": "side" }, "thickness": 0.07, "name": "panel" },
    { "op": "extrude_individual", "select": { "tag": "panel.cap" }, "offset": -0.04 }
  ] }
```

Edges bending more than `smoothAngle` degrees (default 30) render hard. `mesh_edit` appends edits to such a
geometry (or replaces its log with `replace: true`) as one atomic revision, so checkpoints and `expectedRevision`
work as for `scene_apply`. It returns the render status and the mesh report below, including one result per edit.

`mesh_inspect` runs the same conversion and lint on the geometries of a procedural recipe scene and returns one
compact record per geometry:

```json
{ "geometry": "cube", "ok": true,
  "counts": { "vertices": 8, "edges": 12, "faces": 6, "corners": 24, "triangles": 12, "renderVertices": 24 },
  "faces": { "triangles": 0, "quads": 6, "ngons": 0 },
  "parts": { "count": 1, "closed": 1 },
  "tags": { "right": 1, "left": 1, "top": 1, "bottom": 1, "front": 1, "back": 1, "side": 4 },
  "bounds": { "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5] },
  "problems": [] }
```

Reports are cached per generated geometry, so asking again without edits is free. For `mesh` geometries the report
describes the edited polygon mesh and adds `edits`, the per-edit results. Imported asset scenes are not supported
yet.

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
