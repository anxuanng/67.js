# Outlines, toon light and lines

Diagrams, cutaways and toon films need lines and a banded shade. One recipe edit turns them on:

```json
{ "environment": { "lines": { "width": 2 } } }
```

That draws a dark outline at silhouettes, part boundaries, creases and depth jumps. Add `"toon": 3` to `lines` to band the light of every material into three steps, or `"toon": 4` on one material. Remove the field (or set `"lines": null` in `set-environment`) and the scene renders as before.

## Fields of `environment.lines`

| Field | Default | What it does |
| --- | --- | --- |
| `width` | 1.5 | Line width in output pixels, 0.25 to 16. Fractions draw a fainter line. |
| `color` | `[0.02, 0.02, 0.02]` | Linear RGB of the line, 0 to 4. The colour is drawn before tone mapping, so a bright line reads a little darker than written. |
| `boundaries` | `true` | A line where the object ID changes: silhouettes and the edge between two parts. |
| `creaseAngle` | 35 | Degrees. A line where the surface normal turns by more than this between neighbouring pixels. 0 turns creases off. |
| `depthJump` | 0.08 | A line where one surface sits in front of another of the same part. Relative step of the inverse depth. 0 turns it off. |
| `toon` | 0 | Light steps for every material that sets no `toon` of its own, 0 to 8. 0 leaves the smooth light. |
| `polylines` | none | Lines drawn in the world with a screen width, see below. |

The width is in pixels of the output, so a 480 pixel preview and a 1920 pixel render carry lines of the same thickness. A scene that wants the same look at every size should scale `width` with the image height itself.

## Toon light

`toon` on a material (also a layer field, 0 to 8, 0 off) steps the cosine of each light that reaches it. The sun, a point light and a spot light each make their own bands, and the edge between two bands is 0.02 of the light range wide. Shadows keep their own softness, and the sky light that fills the dark side is not banded. A material with `toon` set wins over `lines.toon`.

## Polylines

```json
{ "environment": { "lines": { "polylines": [
  { "points": [[0.2, 1.0, 0.6], [0.2, 1.8, 0.6], [-1.2, 1.8, 0.6]], "color": [0.8, 0.1, 0.1], "width": 3, "depthTest": false }
] } } }
```

Each polyline has 2 to 256 `points` (`closed: true` joins the last to the first), and its own `color`, `width` and `depthTest` (default `true`: the scene hides what lies behind a surface). Use `depthTest: false` for leader lines and annotations that stay in front. At most 64 polylines and 4,096 segments per recipe. Ends and joins are round.

## Limits

- Outlines and polylines draw only for a frame that carries `lines`. They read the opaque and cutout geometry only (like render passes), so blended and translucent parts get no outline.
- An outline costs two extra draws of the opaque geometry (the object ID and normal passes) plus one full-screen pass. Frames without lines cost nothing.
- Outlines need `depth: true` on the renderer and `installRenderPasses` first. A render job writes the pass files without lines.
- Creases are found from the picture, not from the mesh: a bevel wider than a few pixels turns its normal slowly and draws no line. Lower `creaseAngle` or use a sharper edge.
- Through the MCP server, `scene_create` and `set-environment` take `environment.lines`, and a material takes `toon`. `scene_capabilities` reports both.

## Code

```js
import { Renderer67 } from '@codepawlhq/67js';
import { installRenderPasses } from '@codepawlhq/67js/addons/render-passes';
import { installLineArt, resolveLineArt } from '@codepawlhq/67js/addons/line-art';

const renderer = installLineArt(installRenderPasses(new Renderer67(canvas, parts, { depth: true, hdr: true })));
renderer.render({ ...camera, lines: resolveLineArt({ width: 2, toon: 3 }) });
```

A recipe host loads the code with `await loadAgentSceneModules(recipe)`. The preview and render jobs install it themselves.
