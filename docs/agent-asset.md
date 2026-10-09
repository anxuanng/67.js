# Imported asset authoring

`67js/addons/agent-asset` is an optional addon available since 0.5.0. It wraps one
decoded `parseGltf()` asset in a JSON authoring session. It preserves renderer
geometry, texture descriptors, skins, morph targets, and their typed arrays.
The module performs CPU validation and creates no GPU resources.

```js
import { parseGltf } from '67js/addons/gltf';
import { createAgentAssetScene } from '67js/addons/agent-asset';

const asset = await parseGltf(glbBytes);
const scene = createAgentAssetScene(asset, {
  format: '67js.asset',
  schemaVersion: 1,
  assetId: sha256Hex,
});
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-root', translation: [0, 1, 0] },
  { type: 'set-animation', clip: 0, time: 0.5 },
], { expectedRevision: scene.revision });
scene.restore(checkpoint, { expectedRevision: scene.revision });
scene.releaseCheckpoint(checkpoint);
```

## Recipe and IDs

The recipe requires `format: '67js.asset'`, `schemaVersion: 1`, and a 64-character
SHA256 hexadecimal `assetId`. The caller binds that digest to the decoded bytes.
This helper validates its spelling and retains it in lowercase. It does not
hash or fetch assets. Ordinary finite JSON is required: unknown keys, accessors,
sparse arrays, cycles, and non-JSON objects reject.

| Field | Default and meaning |
| --- | --- |
| `root.translation` | `[0,0,0]`, applied to all decoded world matrices |
| `root.rotation` | `[0,0,0,1]`, XYZW quaternion; nonzero input is normalized |
| `root.scale` | `[1,1,1]`, positive values representable at Float32 precision |
| `animation` | `null`, the pose captured when the session was created |
| `animation.clip` | Integer index into decoded animation clips |
| `animation.time` | Absolute seconds, from zero through that clip's duration |
| `materialOverrides` | `[]`, unique overrides keyed by `material-N` |
| `camera` | Automatically frames conservative authored base bounds when omitted |
| `environment`, `effects`, `shadow` | Complete defaults from [agent look](agent-look.md) |

The camera uses a 45-degree perspective lens, square aspect assumption, and
20% fit padding when generated. Its target follows the initial root and decoded
node pose. Skin deformation and morph displacement are excluded from that fit.
Later root or animation edits preserve the canonical camera. Use `set-camera`
to change the view. Explicit cameras use the same defaults and validation as
[agent scenes](agent-scene.md).

Parts receive stable IDs `mesh-0`, `mesh-1`, and so on in decoded order. Labels
remain display metadata. Geometry IDs identify shared decoded geometry.
Material IDs `material-0`, `material-1`, and so on identify unique decoded
material objects in first-use order. Overrides accept `color`, `metallic`,
`roughness`, `emission`, and `emissiveColor`, with the agent scene material
domains.

Other glTF material fields and texture descriptors retain their
decoded values. These commands do not edit alpha modes, maps, skin joints,
vertices, indices, mesh membership, or morph target definitions.

## Commands and transactions

`apply(operations, {expectedRevision})` requires 1 to 256 commands. The expected
revision must equal the current revision. Commands form one atomic transaction.
Invalid input, stale revision, invalid pose, or numeric overflow prevents publication.
The recipe, revision, material values, adapter matrices, and accessible decoded
pose arrays remain unchanged.

| Command | Fields |
| --- | --- |
| `set-root` | Optional flat `translation`, `rotation`, `scale` |
| `set-animation` | Optional `clip`, `time`; `clip:null` restores the captured pose |
| `set-material` | Existing `id` plus optional editable material fields |
| `set-camera` | Optional flat `eye`, `target`, `up`, `fov`, `near`, `far` |
| `set-environment` | `{environment: partial}` |
| `set-effects` | `{effects: partial}` |
| `set-shadow` | `{shadow: partial}` |

Animation seeks are absolute. Omitting time preserves time for the same clip.
Changing the clip defaults time to zero. With `clip:null`, omit time.

Environment
`volumeFog` and effects `bloom` merge partial nested records. A supplied
`pointLights` list replaces the full list, including `[]` to clear it.
Geometry and topology commands reject. Imported mesh editing or sculpting
through MCP is outside this module's contract.

`parts` is a frozen, stable list. Part objects, matrices, geometry, skin, morph,
and material wrapper identities survive every successful transaction. Material
factor getters read immutable snapshots. Map descriptors retain their original
references. `topologyRevision` remains zero. Renderer adapters can call their
ordinary update path after edits without replacing geometry resources.

`checkpoint()` returns an opaque private handle. At most eight handles can be
live. `restore(handle, {expectedRevision})` publishes its recipe and increments
revision. `releaseCheckpoint(handle)` frees the slot. Foreign and released
handles reject. Checkpoints contain recipe snapshots, sharing existing asset
resources rather than duplicating geometry or textures.

Recipes and operation
JSON are bounded to 1 MiB, with at most 64 nesting levels. Construction rejects
more than 4096 parts, 4096 unique materials, or 256 clips. Decoder resource
budgets still belong to `parseGltf()`. Configure them before decoding.

## Inspection and ownership

`exportRecipe()` and the camera/look getters return detached JSON.
`inspect({ids?, limit?, includeBounds?})` returns revision, fixed topology
revision, IDs, labels, counts, unique geometry bytes, animation metadata, and
at most 64 nodes by default. The limit can be 1 to 256. Bounds requests scan at
most two million authored base vertices across the selected visible nodes.

Returned bounds are explicitly labelled `authored-base-world`: actual base
positions transformed by the current root and decoded mesh node matrix. Skin
palettes and morph weights are preserved and validated for rendering, but
inspection does not evaluate their vertex deformation. Geometry bytes count
unique static typed arrays and morph delta arrays, excluding texture storage,
pose buffers, renderer allocations, and GPU timing.

The session requires exclusive ownership of the decoded asset's animation
state. Do not call its `applyAnimation()` separately or replace its parts,
matrices, palettes, or morph weights while the session is active. Returning to
`animation:null` restores captured public pose arrays. The decoder's private
animation mixer is not exposed. Subsequent seeks use its absolute pose API.
On failed staging, the adapter restores public arrays and, when available,
replays the preceding successful clip to recover mixer state.

Parts and resource arrays are privileged renderer handles under the existing
read-only geometry contract. External writes to geometry or texture data are
unsupported. Detached adapter matrices or replaced decoded pose buffers reject
before publication. The caller owns disposal: dispose the renderer first, then
call `asset.dispose()` once. The session does not dispose shared imported data.

Two designs were considered: rebuilding imported assets from authoring JSON,
and wrapping the decoder's retained resources. The retained adapter preserves
maps and deformation resources while keeping the JSON surface small. Its
fixed topology and honest base-bounds inspection make ownership and replay
explicit without claiming Blender feature parity.
