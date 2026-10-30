# Agent scene authoring

This addon is included in npm release `0.5.0` and later.

The optional `agent-scene` addon creates bounded CPU scenes from JSON recipes and applies atomic editing commands.
It returns retained renderer parts with shared geometry and material resources.
It does not execute JavaScript, access the DOM, or provide an MCP transport.
Recipes also retain [lighting, fog, effects and directional shadow coverage](agent-look.md).
Their patches and checkpoints share the same atomic revision contract as model edits.

Release `0.7.0` adds optional [procedural motion](agent-motion.md) and transient `sampleMotion(time)` seeks.
Recipe edits retain authored keyframes. Sampling preserves revisions and geometry while updating rendered transforms, materials and camera.

```js
import { Renderer67 } from '67js';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '67js/addons/agent-scene';

const scene = createAgentScene({
  format: '67js.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
  nodes: [
    { id: 'group', label: 'Assembly' },
    { id: 'mesh', parent: 'group', geometry: 'cube', material: 'blue' },
  ],
});

const renderer = new Renderer67(canvas, scene.parts, { ground: false });
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-node', id: 'group', translation: [1, 0, 0] },
  { type: 'set-material', id: 'blue', roughness: 0.3 },
], { expectedRevision: scene.revision });
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.restore(checkpoint, { expectedRevision: scene.revision });
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.releaseCheckpoint(checkpoint);
```

`AGENT_SCENE_CAPABILITIES` and `scene.capabilities` describe the same frozen capability object.
The renderer owns GPU allocation and disposal.
The authoring session does not allocate GPU resources.
The normal frame loop can render retained parts without calling inspection or exporting the recipe.

## Recipe contract

The recipe must contain `format`, `schemaVersion`, `geometries`, `materials`, and `nodes`.
The optional `camera` object supplies a perspective camera.
All objects reject unknown keys.
Inputs must contain plain, finite, acyclic JSON data without accessors, sparse arrays, or executable values.
JSON nesting has a fixed maximum of 64 levels.

Each resource and node has a unique `id` within its collection.
IDs contain 1 to 128 characters and must contain a non-space character.
Node labels contain at most 256 characters.
Labels can repeat and change without changing identity.
Renderer `part.name` contains the stable node ID.

Geometry records contain `id`, `type`, and the flat fields below.
Omitted parameters use the existing generator defaults.
The generators also enforce their existing numeric and modeling constraints.

| Type | Fields | Defaults |
| --- | --- | --- |
| `box` | `bevel`, `subdivisions` | `0.08`, `6` |
| `cylinder` | `segments`, `bevel`, `bevelSegments` | `80`, `0.025`, `6` |
| `sphere` | `segments`, `rings` | `64`, `40` |
| `torus` | `tubeRadius`, `segments`, `sides`, `arc`, `start` | `0.08`, `96`, `24`, `2π`, `0` |
| `lathe` | `profile`, `segments`, `startAngle`, `sweep` | Required XY profile, `64`, `0`, `2π` |
| `extrude` | `contour`, `holes`, `depth`, `steps`, `bevel`, `bevelThickness`, `bevelSegments` | Required XY contour, `[]`, `1`, `1`, `0`, bevel, `3` |
| `tube` | `path`, `radius`, `segments`, `radialSegments`, `closed` | Required XYZ path, `0.1`, `64`, `12`, `false` |

Modeling point inputs have a maximum of 4096 points.
An extrusion has at most 128 holes and 4096 total contour points.
Shared resource IDs generate geometry once, regardless of the number of mesh nodes.

Materials contain `id`, `tag`, `color`, `metallic`, `roughness`, `emission`, optional `emissiveColor`, `opacity`, `alphaMode`, `doubleSided` and `pattern`.
The defaults are `surface`, `[0.5, 0.5, 0.5]`, `0`, `0.5`, `0`, opacity `1`, `opaque` and `false`.
The tag can be `surface`, `unlit`, `liquid` or `foam` and remains fixed during editing.
`liquid` refracts and tints what lies behind it: its color is the light one metre lets through, so `[0.56, 0.84, 0.88]` is clear water. `foam` draws soft blended droplets.
Any `opacity` below one draws the material blended after opaque geometry, which suits glass, windows and visors. `alphaMode` accepts `opaque` or `blend`; cutout masking needs a texture and is not available in procedural recipes.
`doubleSided` draws and lights both faces of thin sheets.
Changing the tag, opacity, blending, sidedness or pattern replaces the affected parts in the renderer; color, metallic, roughness and emission edits keep them.
Set liquid optics with `environment.liquid`: `thickness`, `ior`, `refraction`, `scattering`, `foamOpacity` and `foamSoftness`.
Colors use linear RGB.

Base color, metallic, and roughness range from zero to one.
Emission and independent emissive color must be nonnegative finite Float32 numbers.
Their component products must also remain finite at Float32 precision.
Unlit emissive radiance is capped at 65500 per component to fit the half-float HDR target.
Image textures and the other procedural material tags are outside this version.

### Material patterns

`pattern` gives a `surface` material a procedural texture, baked once and shared by every material with the same definition:

```json
{ "id": "oak", "pattern": { "type": "wood", "size": 0.6, "axis": "z" }, "roughness": 1 }
```

| Field | Meaning |
| --- | --- |
| `type` | `noise`, `wood`, `planks`, `bricks`, `tiles`, `marble`, `stone`, `concrete`, `metal`, `rust` or `fabric` |
| `colors` | Two linear RGB colours to mix, darker first. `bricks` also takes a third, for the mortar. Each type has defaults |
| `size` | Metres per repeat of the texture, from 0.01 to 100 |
| `count` | Features per repeat, from 1 to 64: planks, bricks or tiles across, wood rings, or noise cells |
| `bump` | Relief strength, from 0 (flat) to 4 |
| `seed` | Nonnegative whole number. The same definition always bakes the same pixels |
| `axis` | Object axis the grain runs along: `x`, `y` (default) or `z` |
| `resolution` | Texture size: 256, 512 (default) or 1024 |

A pattern needs no UVs. The texture is projected along the object's three axes and blended by the surface normal, so it
works on every geometry type and after mesh edits. Coordinates are in metres on the object, after its node scale, so a
stretched box keeps the texture's real size and the pattern moves with the node. Corners between faces show where one
projection meets another; `uv_unwrap` results are not used by patterns.

`color` defaults to white and tints the pattern. `roughness` and `metallic` scale what the pattern stores, so use
`roughness: 1` for its own surface and `metallic: 1` for `metal` and `rust` (rust stores where it is no longer metal).

A scene holds at most 16 different patterns, and materials that differ only in `color`, `roughness` or `metallic`
share one. Each takes about 4 MiB of texture memory at 512. Measured in Node on a Ryzen 5 5600X, baking at 512 took
about 0.2 to 0.55 s per pattern, which happens when the scene first renders it. Changing a pattern rebuilds the
renderer.

Nodes contain `id`, optional `label`, `parent`, `translation`, `rotation`, and `scale`.
Mesh nodes also require both `geometry` and `material` resource IDs.
Group nodes have neither resource reference.
The default parent is `null`.
The default transform is `[0, 0, 0]`, `[0, 0, 0, 1]`, and `[1, 1, 1]`.
Rotation uses an XYZW quaternion that the session normalizes.

Quaternions must be finite and nonzero.
Scales must remain positive at Float32 precision.
The scene graph rejects missing parents, cycles, excessive depth, singular transforms, and world transforms that overflow Float32.
Normal transforms must also remain finite.
Cached local geometry bounds provide a conservative world Float32 check from eight corners per mesh.
The check bounds the sum of absolute matrix products, so intermediate shader arithmetic cannot overflow before cancellation.

The camera contains `eye`, `target`, `up`, `fov`, `near`, and `far`.
Its defaults are `[4, 3, 5]`, `[0, 0, 0]`, `[0, 1, 0]`, `45`, `0.1`, and `1000`.
FOV uses degrees and ranges between zero and 180.
The clipping range must satisfy `0 < near < far` at Float32 precision.
Eye and target must differ at Float32 precision.
The session normalizes the nonzero up vector and rejects collinear view directions.

View and projection matrices must remain finite and nonsingular at Float32 precision.
Projection validation uses aspect one because the renderer owns the actual target aspect.
An explicit top view can use `eye: [0, 3, 0]`, `target: [0, 0, 0]`, and `up: [0, 0, -1]`.

## Transactions and ownership

`apply(operations, { expectedRevision })` requires the current revision and returns the new revision.
It rejects an empty command list.
Each successful application increments the revision once, including a command that retains existing values.
Stale revisions and invalid commands leave canonical state, published matrices, materials, and the revision unchanged.
Every command in a batch stages before any command publishes.

Commands run sequentially against a private candidate recipe.
Final resource references and hierarchy must be valid before publication.

| Operation | Fields |
| --- | --- |
| `set-node` | `id`, optional `translation`, `rotation`, `scale`, `parent`, `label`, `geometry`, `material` |
| `set-material` | `id`, optional `color`, `metallic`, `roughness`, `emission`, `emissiveColor`, `pattern` |
| `set-camera` | Optional `eye`, `target`, `up`, `fov`, `near`, `far` directly on the command |
| `add-geometry` | `geometry`, containing a complete geometry record |
| `remove-geometry` | `id` |
| `add-material` | `material`, containing a complete material record |
| `remove-material` | `id` |
| `add-node` | `node`, containing a complete node record |
| `remove-node` | `id`, optional boolean `recursive`, default `false` |

Reparenting changes hierarchy while preserving each node's local transform.
Commands can add or remove nodes and resources.
Adding a duplicate ID or removing a missing ID fails.
Resource removal can precede rebinding or dependent node removal in the same batch.
The final recipe must contain every resource and parent referenced by surviving nodes.
Mesh nodes require both geometry and material IDs in the final recipe.

Nonrecursive removal rejects a node that has children at that command's position in the batch.
Child removal or reparenting must precede nonrecursive parent removal.
Recursive removal explicitly removes that node and its entire current subtree.
Node removal leaves geometry and materials intact until explicit resource removal.
Changing a geometry definition or material tag requires removing and adding its resource record.
Direct `set-material` commands still reject tag changes.

The session copies input recipes and commands.
`exportRecipe()` and `camera` return detached JSON snapshots.
Published material objects are frozen and expose immutable arrays through retained getters.
Material reads do not allocate arrays or scan resource collections.

Surviving nodes retain their part and matrix identities when geometry and material bindings retain their resource identities.
Rebinding replaces the part and its matrix.
Removing and adding the same node ID also replaces its part.

Geometry identity survives when its ID and complete definition match an active or checkpoint resource.
Object key order does not affect that comparison.
Omitted parameters and explicit defaults remain distinct definitions.
A changed definition creates new immutable geometry and replaces parts bound to that resource.
Multiple nodes referencing the same resource ID share its geometry.

`parts` returns a frozen current list.
The list retains its identity while its ordered part identities remain unchanged.
Transform, material value, camera, and group-only edits can retain the list.
Removed parts leave the current list and are no longer renderer update targets.
Removed material handles remain readable with their last committed snapshot.

`parts` is a privileged renderer adapter surface.
Its geometry typed arrays follow the engine's immutable geometry contract and must never change or detach.
The session does not duplicate geometry buffers or regenerate unchanged geometry during transactions.
Writes to retained matrices cannot poison the private recipe or inspection transforms.

A successful transaction overwrites those matrices from canonical state.
Detached matrices reject publication before canonical state changes.
An agent adapter must expose JSON commands and snapshots rather than renderer typed arrays.

`topologyRevision` starts at zero and increments only when ordered part identities or membership change.
Restore follows the same rule.
Failed transactions leave both revisions unchanged.
Unused resource or group-only edits do not increment `topologyRevision`.
Renderer adapters can compare it to choose topology replacement or retained instance updates.
The session does not replace renderer GPU resources itself.

`checkpoint()` returns an opaque, frozen handle that belongs to its session.
Checkpoint snapshots are private and cannot change through the handle.
Checkpoints retain recipe snapshots and references to their geometry, material handles, and parts.
Restore reuses those resources without regenerating geometry.
Unchanged active parts take priority when their bindings still match.
Otherwise, restore can recover the checkpoint's original part and matrix identities.

`restore(handle, { expectedRevision })` applies the same atomic validation and increments the revision.
Released and foreign handles fail.
`releaseCheckpoint(handle)` frees its slot and does not change the scene revision.
Released geometry references leave session ownership unless the active scene or another checkpoint still needs them.
There is no separate unbounded geometry history cache.

## Budgets and inspection

The optional second constructor argument overrides the following positive integer limits.
`scene.limits` reports the resolved, frozen values.

| Limit | Default |
| --- | --- |
| `maxNodes` | `4096`, also the hard maximum |
| `maxDepth` | `256`, counting a root as depth one |
| `maxGeometries` | `256` |
| `maxMaterials` | `256` |
| `maxVertices` | `250000`, across unique active, checkpoint, and staged geometry allocations |
| `maxGeometryBytes` | `33554432` |
| `maxOperations` | `256`, per application |
| `maxCheckpoints` | `8` |
| `maxRecipeBytes` | `1048576`, also used for each command batch |

Preflight accounts for peak geometry ownership before generating any new resource.
It counts each unique active or checkpoint allocation once, using actual vertices and typed array bytes.
New resources contribute their conservative vertex and byte bounds.
Its byte bound uses 56 bytes per vertex for eight floats and at most six Uint32 indices.
Actual generated geometry bytes must also fit the budget.

Atomic replacement retains the old active geometry until the candidate commits, so both allocations count during preflight.
A single replacement can fail even when the final geometry fits alone.
Checkpoint sharing does not duplicate geometry bytes.
Unused active resources still count until explicitly removed.
Releasing checkpoints can free ownership for later additions.

Byte counts include position, normal, UV, and index typed arrays across unique owned geometry allocations.
They exclude JavaScript objects, temporary generator allocations, transaction matrices, checkpoint recipes, and renderer GPU memory.
External renderer adapters can retain removed arrays beyond the session's ownership accounting.
The JSON budget uses conservative UTF-8 traversal accounting and also checks serialized JSON size.
Normalization can increase serialized size, so normalized recipes also pass the JSON budget.
Each checkpoint stores at most one normalized recipe within that limit.

`inspect({ ids, limit, includeBounds })` returns JSON with both revisions, global counts, and selected node records.
Its default limit is 64, capped by `maxNodes`.
Requested IDs must exist.

`truncated` reports whether the result omitted selected nodes.
Global counts include nodes, render parts, unique geometries, materials, and unique geometry vertices.
`geometryBytes` reports actual unique typed array bytes.
`estimatedGeometryBytes` reports the conservative preflight bound.

Those fields describe active resources, including unused resources.
`residentGeometryBytes` and `residentGeometryVertices` include unique active and checkpoint allocations.
Inspection does not report GPU timing or renderer allocation.

With `includeBounds: true`, each mesh record includes `{ min, max }` from every transformed geometry vertex.
Group bounds are `null`.
Bounds use published canonical world matrices, not externally modified renderer matrices.
They describe the authored mesh surface without shader effects or displacement.

## Design choice

| Design | Benefit | Cost |
| --- | --- | --- |
| Evaluate arbitrary JavaScript scene functions | Full access to existing engine functions | Execution authority, mutable ownership, and replay depend on external isolation |
| Validate JSON recipes and typed commands | Bounded inputs, private ownership, atomic batches, and reproducible snapshots | A deliberately limited geometry and editing vocabulary |

The addon uses validated JSON because ownership and atomic editing form its public contract.
The separate [source MCP adapter](mcp.md) translates tool calls into this API without placing transport logic inside the scene session.
This version does not claim Blender feature parity.

| Geometry ownership design | Benefit | Cost |
| --- | --- | --- |
| Regenerate the full scene after every command | Simple replacement ownership | Repeated geometry allocation and lost renderer identities |
| Retain immutable resource records in active state and bounded checkpoints | Shared geometry, replay, stable parts, and peak allocation preflight | Explicit staging and checkpoint ownership accounting |

The addon retains immutable resource records because topology editing must preserve unaffected geometry and renderer handles.
