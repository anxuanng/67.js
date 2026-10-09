# MCP scene authoring

The stdio server is available in the source checkout after npm release `0.4.1`.
The published `0.4.1` package does not include this server.
It uses the maintained MCP TypeScript SDK v2 server and a local browser runtime.
The [official SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/) describes its transport and protocol APIs.

The server exposes ten tools for bounded JSON scene authoring.
It renders one active scene and returns PNG images through MCP image content.
Tool results also contain JSON text and structured metadata.
The image bytes appear only in the image content block.

## Requirements and launch

The server requires Node.js 20 or later, installed project dependencies, and a local Chrome or Chromium executable.
The browser starts when `scene_create` runs.
The runtime serves its generated scene page on the loopback interface.
The MCP connection uses stdin and stdout, without an HTTP MCP listener.

1. Run the server from the source checkout:

   ```powershell
   node scripts/mcp-server.mjs --backend gpu --memory 192
   ```

2. Configure your MCP client with absolute paths:

   ```json
   {
     "mcpServers": {
       "67js-scene": {
         "command": "C:/Program Files/nodejs/node.exe",
         "args": [
           "C:/projects/67js/scripts/mcp-server.mjs",
           "--backend", "gpu",
           "--memory", "192",
           "--browser", "C:/Program Files/Google/Chrome/Application/chrome.exe"
         ]
       }
     }
   }
   ```

The browser path is optional when the runtime can locate a supported browser.
`--backend` accepts `gpu` or `cpu` and defaults to `gpu`.
`--memory` accepts an integer from 32 to 256 MiB and defaults to 192.
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
| `scene_inspect` | `sessionId`, optional `ids`, `limit`, `includeBounds` | Compact node records and revision |
| `scene_apply` | `sessionId`, `expectedRevision`, `operations` | Updated revision, inspection, and render status |
| `scene_look` | `sessionId`, optional `width`, `height` | PNG image and metadata |
| `scene_checkpoint` | `sessionId` | Checkpoint ID, session ID, and revision |
| `scene_restore` | `sessionId`, `checkpointId`, `expectedRevision` | Updated revision, inspection, and render status |
| `scene_release_checkpoint` | `sessionId`, `checkpointId` | Release confirmation |
| `scene_export_recipe` | `sessionId` | Canonical recipe and revision |
| `scene_dispose` | `sessionId` | Disposal confirmation |

The recipe uses `format: '67js.scene'` and `schemaVersion: 1`.
Supported geometry types are `box`, `cylinder`, `sphere`, `torus`, `lathe`, `extrude`, and `tube`.
Geometry fields remain flat inside each geometry record.
Operations use `set-node`, `set-material`, or `set-camera`, with fields directly on each command.
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

Group and mesh membership, geometry definitions, and material tags remain fixed after creation.
Adding nodes or changing geometry requires a new scene.

The tools expose no arbitrary JavaScript execution, URLs, file access, asset ingestion, or render jobs.
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
The scripts save images and metadata under `artifacts/`. They use one isolated browser and close it when finished.
