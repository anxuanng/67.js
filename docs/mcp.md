# MCP scene authoring

The `67js-mcp` stdio server is included in npm release `0.5.0` and later.
It uses the maintained MCP TypeScript SDK v2 server and a local browser runtime.
The [official SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/) describes its transport and protocol APIs.

Release `0.5.0` exposes twelve tools for bounded JSON scene authoring and local GLB imports.
Release `0.6.0` adds five render job tools for PNG images, still sequences and MP4 video.
Release `0.7.0` adds [procedural motion](agent-motion.md), transient preview seeks and motion sampling in snapshot jobs.
Release `0.8.0` adds [imported character motion](agent-character-motion.md) with source joints and independent clip timing.
Release `0.9.0` adds [visual review](agent-review.md) for several labeled views or poses from one isolated snapshot.

It renders one active scene and returns PNG images through MCP image content.
Tool results also contain JSON text and structured metadata.
The image bytes appear only in the image content block.

## Requirements and launch

The server requires Node.js 20.19 or later and an installed Chrome or Chromium executable.
The npm package contains a prebuilt server and browser preview. A source checkout and Vite are unnecessary.
The browser driver loads when `scene_create` or `scene_create_asset` runs. It does not download a browser.

The runtime serves its bundled scene page on the loopback interface.
The MCP connection uses stdin and stdout, without an HTTP MCP listener.

1. Install the package in your project:

   ```powershell
   npm install 67js@npm:@codepawlhq/67js
   ```

   Run the installed command with `npx 67js-mcp --backend gpu --memory 192`.
   For a standalone launch, use `npx --package @codepawlhq/67js@0.9.0 67js-mcp --backend gpu --memory 192`.
   `67js-mcp --help` lists options. `67js-mcp --version` reports the installed version.

2. Configure your MCP client with absolute paths to Node and the installed CLI:

   ```json
   {
     "mcpServers": {
       "67js-scene": {
         "command": "C:/Program Files/nodejs/node.exe",
         "args": [
           "C:/projects/my-scene/node_modules/67js/bin/67js-mcp.mjs",
           "--backend", "gpu",
           "--memory", "192",
           "--browser", "C:/Program Files/Google/Chrome/Application/chrome.exe"
         ]
       }
     }
   }
   ```

The browser path is optional for a standard Google Chrome installation. Pass `--browser` for another Chromium executable.
Using Node directly also avoids shell-specific npm launcher behavior in MCP clients on Windows.
`--backend` accepts `gpu` or `cpu` and defaults to `gpu`.
`--memory` accepts an integer from 32 to 256 MiB and defaults to 192.

`--assets` selects an absolute directory containing self-contained GLB files.
The asset catalog reads regular files directly inside that directory, with limits of 64 files and 16 MiB per file.
Asset IDs bind file contents through SHA-256. Changed files require a runtime restart before they receive refreshed IDs.
Catalog imports retain supported textures, skins, morphs and animation clips.

These launch options remain outside tool arguments.
The process runs below normal priority to reduce interference with other work.

Stdout contains only MCP protocol messages, while errors go to stderr.
Closing stdin or sending `SIGINT` or `SIGTERM` closes the runtime and releases its browser resources.

## Workflow

1. Call `scene_capabilities` to read supported features and runtime limits.
2. Call `scene_create` with a [scene recipe](agent-scene.md#recipe-contract).
3. Call `scene_inspect` to read node IDs, bounds, counts, and the current revision.
4. Call `scene_checkpoint` before an experiment.
5. Call `scene_apply` with a small batch and the current `expectedRevision`.
6. Call `scene_look` to assess the rendered image.
7. Call `scene_restore` with the current revision if the experiment fails.
8. Call `scene_release_checkpoint` when you no longer need the saved state.
9. Call `scene_export_recipe` to retain the canonical recipe.
10. Call `scene_dispose` to release the scene before creating another one.

`scene_create`, `scene_apply`, and `scene_restore` return the session ID, current revision, inspection, and render status.
`scene_checkpoint` returns a checkpoint UUID scoped to its session UUID.
A restore increments revision and keeps the checkpoint available.
A stale revision or invalid command produces an error without publishing partial edits.
SDK validation rejects unknown tool fields before dispatch.
Backend errors return `isError: true` with a readable message.

Successful apply and restore responses include `committed: true`, the new revision, and `renderSucceeded`.
If rendering fails after the edit commits, the response retains that revision and includes `renderSucceeded: false` and `renderError`.
Its render metadata describes the last successful render, rather than a new frame.
Inspect or export the recipe before retrying. Context loss still permits recipe inspection, export, and disposal.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `scene_capabilities` | None | Features, limits, and backend information |
| `scene_create` | `recipe` | Session ID, revision, inspection, and render status |
| `scene_asset_catalog` | None | Configured catalog and content-bound GLB IDs |
| `scene_create_asset` | `recipe` using `67js.asset` | Imported scene ID, revision, inspection and render status |
| `scene_inspect` | `sessionId`, optional `ids`, `limit`, `includeBounds` | Compact node records and revision |
| `scene_apply` | `sessionId`, `expectedRevision`, `operations` | Updated revision, inspection, and render status |
| `scene_look` | `sessionId`, optional `width`, `height`, `motionTime` | PNG image and metadata |
| `scene_review` | `sessionId`, `expectedRevision`, `shots`, optional `width`, `height` | Labeled PNG grid and metadata from an isolated snapshot |
| `scene_checkpoint` | `sessionId` | Checkpoint ID, session ID, and revision |
| `scene_restore` | `sessionId`, `checkpointId`, `expectedRevision` | Updated revision, inspection, and render status |
| `scene_release_checkpoint` | `sessionId`, `checkpointId` | Release confirmation |
| `scene_export_recipe` | `sessionId` | Canonical recipe and revision |
| `scene_dispose` | `sessionId` | Disposal confirmation |
| `scene_render_submit` | `sessionId`, `expectedRevision`, `settings` | Snapshot job ID and queued record |
| `scene_render_status` | `jobId` | State and durable frame progress |
| `scene_render_cancel` | `jobId` | Cancellation acknowledgement |
| `scene_render_result` | `jobId` | Completed output paths, hashes and metrics |
| `scene_render_release` | `jobId` | Confirmation that owned job files were removed |

The recipe uses `format: '67js.scene'` and `schemaVersion: 1`.
Supported geometry types are `box`, `cylinder`, `sphere`, `torus`, `lathe`, `extrude`, and `tube`.
Geometry fields remain flat inside each geometry record.
Set operations use `set-node`, `set-material`, or `set-camera`, with fields directly on each command.

`set-motion` accepts a complete motion record or `null` to clear it.
`scene_look` can seek procedural `motionTime` without changing revisions. Omission preserves the last preview pose.
An explicit `null` restores the authored base pose. Release `0.8.0` also supports imported source-node motion.
Imported clip sampling remains available through `set-animation`.

`scene_review` compares up to four cameras or motion samples without changing the source recipe, revision or preview pose.
Each shot starts from the authored base pose. The [review guide](agent-review.md) describes separate clocks, dimensions and resource limits.

`set-node` can rebind a mesh to another geometry/material pair.

The recipe also accepts [authored lighting, fog, effects and shadow coverage](agent-look.md).
Use `set-environment`, `set-effects` and `set-shadow` with nested partial records to adjust the look.
Nested `volumeFog` and `bloom` fields merge. `pointLights` replaces the complete list.

The preview allocates depth support at creation so enabling fog does not recreate render targets.
Active volume fog requires HDR support. Unsupported previews reject that edit before committing.

Build from an empty recipe by adding resources and nodes in one revisioned batch:

```js
[
  { type: 'add-geometry', geometry: { id: 'cube', type: 'box', bevel: 0.04 } },
  { type: 'add-material', material: { id: 'paint', color: [0.2, 0.6, 0.8] } },
  { type: 'add-node', node: { id: 'mesh', geometry: 'cube', material: 'paint' } }
]
```

Use `remove-node`, `remove-geometry` and `remove-material` with an `id` to remove entries.
References must resolve after the complete batch. Removing a parent leaves its children unchanged unless `recursive: true` removes its subtree.
Reparent or remove those children before the parent removal command to avoid rejection.
The [scene contract](agent-scene.md) defines the geometry fields, transforms, materials, and atomic validation rules.

## Limits

| Budget | Limit |
| --- | --- |
| Active render scenes | 1 |
| Nodes | 4096 |
| Geometries and materials | 256 each |
| Operations per batch | 256 |
| Checkpoints per session | 8 |
| Geometry input points | 4096 per input, including all extrusion contours |
| Extrusion holes | 128 |
| Unique geometry vertices | 250000 |
| Unique geometry buffers | 32 MiB |
| Recipe or command JSON | 1 MiB |
| Incoming stdio buffer | 2 MiB |
| Preview dimensions | 64 to 1024 pixels per dimension |
| Default preview dimensions | 768 by 512 pixels |
| PNG payload | 1 MiB |

The backend enforces combined budgets and numeric consistency beyond the advertised tool schemas.

Render targets can shrink to fit the configured memory budget.
Image metadata reports actual dimensions alongside requested dimensions and estimated render bytes.

An oversized PNG response returns an error. Request a smaller preview rather than treating the failure as an empty image.
Browser evaluations have a 30-second deadline. A timeout closes the preview browser and makes the runtime unavailable.
Camera matrices must remain finite at every supported preview aspect ratio, from 1:16 to 16:1.

Geometry resources remain immutable. Remove an unused definition and add its replacement in one batch, or add a new resource ID and rebind its nodes.
Checkpoints retain their resource handles for exact restoration. Active, checkpoint and staged geometry share a bounded allocation budget.
Release unused checkpoints to free that ownership before adding detail.

The preview reconciles rigid, untextured parts while retaining shader programs, render targets and shared geometry buffers.
Unchanged draw batches remain allocated. Changed instance groups receive new instance buffers. Retired buffers are released.

Staging must fit alongside the current render allocations, so a replacement can fail its GPU budget even when the final scene alone fits.
The committed revision and separate render failure remain visible in that case.
Request a smaller `scene_look` to release large frame targets before retrying reconciliation.

The [asset scene contract](agent-asset.md) defines root transforms, material overrides and absolute clip/time samples.
Imported scenes retain their decoded topology. Mesh membership edits remain specific to procedural scenes.
Their bounds describe authored base vertices in the sampled world transforms, without claiming deformed skin or morph bounds.

The tools expose no arbitrary JavaScript execution, remote URLs or arbitrary caller-selected file paths.
Release `0.8.0` supports [imported source-node tracks](agent-character-motion.md) through the bounded motion recipe.
Facial morph track authoring and rig creation remain unsupported.
Render jobs use a configured private store and fixed output filenames.

See [render jobs](agent-render-jobs.md) for the snapshot workflow and storage limits.
Embedded texture decoding uses private browser blob URLs. Remote asset requests remain blocked.
The transport supplies a visual feedback loop, but visual quality still depends on the authored scene and image assessment.
MCP support does not establish Blender feature parity.

## Boundary tests

1. Run `node --test tests/mcp-tools.test.js`.

The tests use a real SDK client and linked in-memory transports.
They verify schemas, argument rejection, atomic revision errors, checkpoint behavior, and PNG content with structured metadata.
The adapter uses the real CPU recipe backend and a fixed PNG fixture.
These tests do not prove browser launch, GPU rendering, or final visual quality.

Run `node scripts/smoke-mcp.mjs gpu modern` for a native browser test through real stdio tools.
Run `node scripts/smoke-mcp.mjs cpu legacy` for the software backend and legacy protocol negotiation.
Each checks landscape and portrait PNGs, stale revision rejection, exact PNG restoration, session disposal, and process cleanup.
They build the scene from empty through tool calls, add and remove geometry, and restore the scene after all mesh resources were removed.
The scripts save images and metadata under `artifacts/`. They use one isolated browser and close it when finished.

Run `node scripts/smoke-agent-topology.mjs` to inspect native GPU allocations during a shared-geometry addition and restoration.
Its staging-budget failure must allocate no buffers and retain the previous rendered frame.
Use `node scripts/smoke-agent-topology.mjs cpu` for software rendering. Both modes also verify recovery through a smaller CPU preview under a 32 MiB budget.

Run `node scripts/smoke-agent-assets.mjs` for actual imported WALL-E and textured rig previews through CPU stdio tools.
The script checks content IDs, root edits, retained texture decoding, reverse animation sampling and exact checkpoint restoration.

Run `node scripts/smoke-agent-motion.mjs` for procedural motion through actual CPU MCP previews and jobs.
It checks shuffled PNG seeks, decoded MP4 frames, eight stills, active cancellation, source pose retention and checkpoint restoration.

Run `node scripts/smoke-agent-character.mjs` for a textured nine-joint astronaut through actual CPU previews and snapshot jobs.
