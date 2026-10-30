# Mesh modeling for agents

<!-- skill-navigation:start -->
This is the [mesh modeling guide](#mesh-modeling-for-agents). Read [Workflow](#workflow) and
[Choosing faces and edges](#choosing-faces-and-edges) completely before the first edit. Read the
[Recipes](#recipes) entry closest to the shape you are building, and [Errors and fixes](#errors-and-fixes) when a
call fails. The full contract (every op, field and default) is the checkout's `docs/mesh.md`; `docs/mcp.md` lists
the tools.
<!-- skill-navigation:end -->

Every `json` block in this file is a complete recipe geometry. `tests/skill-mesh-recipes.test.js` builds each one and
requires a clean lint, so keep them valid when the API changes.

## Workflow

1. Name the parts and their rough sizes first. One part is one `mesh` geometry: a `base` primitive, an `edits` log and
   an optional `stack`. Separate parts (a lid, a handle) are separate geometries placed by nodes.
2. Start from the closest base. `box` is a unit cube from -0.5 to 0.5 (`bevel: 0` for crisp edits); `cylinder` has
   radius 1 and height 1 centred on the origin (`bevel: 0`); `sphere` has radius 1; `lathe` turns a profile;
   `extrude` makes outlines with holes. Set proportions first by translating tagged faces, so later widths and offsets
   stay in real units: a 0.5 x 0.6 x 1.0 box is `right` by -0.25, `left` by 0.25, `top` by -0.4.
3. Add edits in small batches with `mesh_edit` (or in the recipe). Name every edit (`name: "lid"` gives `lid.cap`,
   `lid.side`); an unnamed one gets `<op>-<index>`, which is hard to predict. Select faces by tags, never by index.
4. After each batch read the `mesh_edit` result: `edits[i].selected`, `tags` and `edges` say what each edit touched;
   `problems` lists lint errors with a fix. `ok: false`, a lower count than expected, or `clamped: true` on a bevel
   means stop and correct before adding more.
5. Look at it with `scene_look` (or `scene_review` for several angles). Lint proves the mesh is valid, not that it
   looks right.
6. Put symmetry, repetition and wall thickness in the `stack` (`mirror`, `array`, `solidify`, `bevel`) so they stay
   adjustable. `mesh_stack` with `apply: n` bakes the first nodes into the edit log when later edits need them.
7. Bevel big shaping edges (an arched top, rounded corners of the body) before insets and extrusions near them:
   those edits put untagged rim and side faces next to the edge, so a later `between` rule misses it or the narrow
   rim clamps the width. Small finishing bevels go last, selected with `boundaryOf` or `angle`.

Tag rules worth knowing: caps keep the tags their faces had (an inset on `right` gives a cap tagged `right` and
`flag.cap`); rim, side, strip and corner faces start with only their own new tag.

Outside MCP, the same recipe runs in Node:

```js
import { createAgentScene } from './src/agent-scene.js'; // or '@codepawlhq/67js/addons/agent-scene' once released
const scene = createAgentScene({
  format: '67js.scene', schemaVersion: 1,
  geometries: [mesh], materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
  nodes: [{ id: 'part', geometry: mesh.id, material: 'paint' }],
});
const [report] = scene.inspectMeshes().meshes; // { ok, counts, faces, parts, tags, bounds, problems, edits, stack }
```

Booleans first need `await loadMeshBooleans()` from the same module (and the `manifold-3d` peer installed).

Use checkpoints before risky batches. A failed `mesh_edit` changes nothing, so retrying with a corrected edit is safe.

## Choosing faces and edges

Faces carry tags. A base gets `top`, `bottom`, `side`, `left` (-X), `right` (+X), `front` (+Z), `back` (-Z).
Edits add `<name>.cap`, `<name>.side`, `<name>.rim`, `<name>.cut`, `<name>.band-<k>`, `<name>.strip`, and so on.
`mesh_inspect` lists every tag with its face count.

| Need | Face rule |
| --- | --- |
| A tagged region | `{ "tag": "top" }` |
| Faces facing a way | `{ "normal": [0, 1, 0], "maxAngle": 10 }` |
| Faces in a box | `{ "inside": { "min": [-1, 0.4, -1], "max": [1, 1, 1] } }` |
| Combinations | `{ "and": [...] }`, `{ "or": [...] }`, `{ "not": rule }` |
| A ring around a region | `{ "grow": { "tag": "top" }, "steps": 1 }` |

Edge rules (for `bevel` and `loop_cut`):

| Need | Edge rule |
| --- | --- |
| The rim between two regions | `{ "between": [{ "tag": "top" }, { "tag": "side" }] }` |
| Only some of that rim | `{ "between": [{ "tag": "top" }, { "or": [{ "tag": "left" }, { "tag": "right" }] }] }` |
| Every sharp edge | `{ "angle": 30 }` |
| The border of a region | `{ "boundaryOf": { "tag": "lid.cap" } }` |
| Edges parallel to an axis (loop cut rings) | `{ "along": [0, 1, 0] }` |

Choosing the extrude: `extrude_face_region` moves each connected group along its average normal;
`extrude_individual` moves each face along its own; `extrude_face_region` with `alongNormals: true` keeps a ring or
curved band joined (a hoop around a cylinder). Faces facing opposite ways in one group need one of the last two.

## Recipes

A crate with recessed panels and a raised lid:

```json
{ "id": "crate", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "inset_individual", "select": { "tag": "side" }, "thickness": 0.07, "name": "panel" },
  { "op": "extrude_individual", "select": { "tag": "panel.cap" }, "offset": -0.04 },
  { "op": "inset_region", "select": { "tag": "top" }, "thickness": 0.08, "name": "lid" },
  { "op": "extrude_face_region", "select": { "tag": "lid.cap" }, "offset": 0.06 }
] }
```

A mailbox: proportions first, the arched top bevelled before anything touches its edges, a loop cut to carve a
vertical strip out of the side, then a door and a flag built by chaining extrusions (each edit selects faces the
previous one created):

```json
{ "id": "mailbox", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "right" }, "offset": [-0.25, 0, 0] },
  { "op": "translate", "select": { "tag": "left" }, "offset": [0.25, 0, 0] },
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.4, 0] },
  { "op": "bevel", "name": "arch", "edges": { "between": [{ "tag": "top" }, { "or": [{ "tag": "left" }, { "tag": "right" }] }] }, "width": 0.2, "segments": 5 },
  { "op": "loop_cut", "name": "slice", "edges": { "along": [0, 0, 1] }, "cuts": 5 },
  { "op": "inset_region", "select": { "tag": "front" }, "thickness": 0.07, "name": "door" },
  { "op": "extrude_face_region", "select": { "tag": "door.cap" }, "offset": -0.03, "name": "recess" },
  { "op": "inset_region", "select": { "and": [{ "tag": "right" }, { "tag": "slice.band-1" }] }, "thickness": 0.03, "name": "flagbase" },
  { "op": "extrude_face_region", "select": { "tag": "flagbase.cap" }, "offset": 0.04, "name": "arm" },
  { "op": "extrude_face_region", "select": { "and": [{ "tag": "arm.side" }, { "normal": [0, 1, 0], "maxAngle": 10 }] }, "offset": 0.35, "name": "pole" },
  { "op": "extrude_face_region", "select": { "and": [{ "tag": "pole.side" }, { "normal": [0, 0, 1], "maxAngle": 10 }] }, "offset": 0.14, "name": "flag" }
] }
```

A pillar with raised bands (loop cut, then extrude every other band):

```json
{ "id": "pillar", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, 2, 0] },
  { "op": "loop_cut", "edges": { "along": [0, 1, 0] }, "cuts": 5, "name": "ring" },
  { "op": "extrude_face_region", "select": { "or": [{ "tag": "ring.band-1" }, { "tag": "ring.band-3" }] }, "offset": 0.05, "alongNormals": true }
] }
```

A drum with a hoop:

```json
{ "id": "drum", "type": "mesh", "base": { "type": "cylinder", "segments": 32, "bevel": 0 }, "edits": [
  { "op": "loop_cut", "edges": { "along": [0, 1, 0] }, "cuts": 2, "name": "hoop" },
  { "op": "extrude_face_region", "select": { "tag": "hoop.band-1" }, "offset": 0.04, "alongNormals": true }
] }
```

A bracket with a boss and a through bore (booleans need the optional `manifold-3d` peer):

```json
{ "id": "bracket", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.5, 0] },
  { "op": "boolean", "operation": "union", "name": "boss", "cutter": { "type": "cylinder", "segments": 48, "bevel": 0 }, "translation": [0, 0.15, 0], "scale": [0.42, 0.3, 0.42] },
  { "op": "boolean", "operation": "difference", "name": "bore", "cutter": { "type": "cylinder", "segments": 48, "bevel": 0 }, "scale": [0.28, 2, 0.28] }
] }
```

A bench row: model half a bench, mirror it, array the result:

```json
{ "id": "bench", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "offset": [0.5, 0, 0] },
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.8, 0] },
  { "op": "translate", "select": { "tag": "right" }, "offset": [0.4, 0, 0] },
  { "op": "inset_region", "select": { "tag": "bottom" }, "thickness": 0.05, "name": "underside" },
  { "op": "extrude_face_region", "select": { "and": [{ "tag": "underside.rim" }, { "inside": { "min": [1.2, -1, -1], "max": [2, 1, 1] } }] }, "offset": 0.6 }
], "stack": [{ "op": "mirror" }, { "op": "array", "count": 3, "offset": [0, 0, -1.4], "relativeOffset": [0, 0, 0] }] }
```

UVs for a textured part: finish the shape, then `uv_unwrap` as the last edit (or the last stack node, after mirror or
array). Seams default to edges sharper than 60 degrees; closed smooth shapes are split into charts on their own.
Check the result: `flipped` must be 0, and `areaDistortion` above about 0.15 means texture will visibly stretch, so
add seams with `boundaryOf` around the part that stretches.

```json
{ "id": "barrel", "type": "mesh", "base": { "type": "cylinder", "segments": 32, "bevel": 0 }, "edits": [
  { "op": "loop_cut", "edges": { "along": [0, 1, 0] }, "cuts": 2, "name": "hoop" },
  { "op": "extrude_face_region", "select": { "or": [{ "tag": "hoop.band-0" }, { "tag": "hoop.band-2" }] }, "offset": 0.03, "alongNormals": true },
  { "op": "uv_unwrap" }
] }
```

A planter (open box with walls) and a rounded soap bar:

```json
{ "id": "planter", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "delete", "select": { "tag": "top" } }
], "stack": [{ "op": "solidify", "thickness": 0.06 }] }
```

```json
{ "id": "soap", "type": "mesh", "base": { "type": "box", "bevel": 0 }, "edits": [
  { "op": "translate", "select": { "tag": "top" }, "offset": [0, -0.4, 0] },
  { "op": "bevel", "edges": { "all": true }, "width": 0.12, "segments": 4 }
] }
```

## Errors and fixes

| Message contains | Do |
| --- | --- |
| `Unknown tag x. Known tags: ...` | Pick a listed tag; earlier edits may have used another name |
| `selects no faces` / `selects no edges` | Loosen the rule (`maxAngle`, box) or check tags with `mesh_inspect` |
| `average normal cancels out` | Use `alongNormals: true`, an `_individual` op, or a `direction` |
| `must be closed for a boolean` | Fix the open or non-manifold edges it counts, or `merge_by_distance` first |
| `need the optional peer dependency manifold-3d` | Booleans are unavailable here; model the cut another way or ask for the peer |
| `rings cross` | Cut each direction in its own `loop_cut` edit |
| bevel `edges` lower than expected | An earlier inset or extrude left untagged rim faces at the edge; bevel earlier, or widen the rule |
| bevel `clamped: true` | A neighbouring face is narrower than the width; bevel before the narrow inset, or use a smaller width |
| `over the limit of N vertices` | Fewer segments, fewer array copies, or split the part |
| lint `inverted-part` | `flip_normals` on that part |
| lint `degenerate-face` | An offset or width of 0, or a clamp at the edge length; change the value |

Bevel with 2 segments on a right angle renders faceted at the default `smoothAngle` of 30; use 3 or more segments
or raise `smoothAngle` on the geometry.
