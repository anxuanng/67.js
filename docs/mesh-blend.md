# Mesh blend

Where a rock sinks into terrain or a trunk into the ground, the two meshes meet in a hard, straight seam. Mesh blend is a screen-space pass (the idea of the MeshBlend plugin for Unreal) that mixes the colour of the surface a part cuts into over a short distance. A part opts in with `blend: { radius }`, the distance in metres:

```json
{ "id": "rock-1", "geometry": "rock", "material": "stone", "blend": { "radius": 0.15 } }
```

Mark the rocks, trunks and roots, and the terrain too if you want its colour to take on the rock's. A node without `blend` draws as before: a scene with no `blend` part renders the same pixels as one without the addon, and loads none of it. `set-node` takes `blend` like any node field.

## How it works

For each pixel of a blend part, the pass looks at 24 taps on a spiral within `radius` (converted to pixels at that distance, 1 to 40 pixels). A tap counts when it shows another part (an object ID differs), its surface point lies within three radii of this pixel (a depth match: a silhouette against the sky or a far wall never counts), and the two surfaces are not parallel (a normal discontinuity, rebuilt from the depth). The share of taps that count, weighted toward the pixel, sets how much of the other part's colour mixes in. It does not blend across a part's own edges.

## Cost and limits

- One extra draw of the opaque geometry in the object ID mode (the render passes addon draws it), and one fullscreen pass that returns at once for every pixel outside a blend part. Measured on an RTX 3060 at 1080p with 4x MSAA, on a terrain with five sunk rocks and a trunk (median of 6 rounds of 150 frames, other sessions sharing the machine): 2.46 ms without blend, 3.42 ms with it, so about 0.97 ms. Most of that is the extra draw, so it grows with the geometry of the scene and the fullscreen pass stays small.
- Needs a renderer with `depth: true` and `installRenderPasses` first, like line art. The MCP preview does both.
- Opaque and cutout parts only. A blended or transmissive surface has no part ID.
- A blend part mixes toward the part on the other side of its seam; the other part changes only if it has `blend` too. Marking both gives the soft seam from both sides.
- A seam under about one pixel wide (a tiny radius far from the camera) is left alone. The path tracer does not run the pass.
- The part ID is the draw order of opaque instances. A part count above 16 million is not supported (the ID has 24 bits).
- In a recipe, a wrong `blend` value (`radius` outside 0.005 to 2, an unknown field) is reported when the preview draws the frame, with the message of the field.

## Code

```js
import { installRenderPasses } from '@codepawlhq/67js/addons/render-passes';
import { installMeshBlend } from '@codepawlhq/67js/addons/mesh-blend';

const renderer = installMeshBlend(installRenderPasses(new Renderer67(canvas, parts, { depth: true, hdr: true })));
// parts: [{ name, geometry, material, matrix, blend: { radius: 0.15 } }, ...]
```

Install it before `installLineArt` so the lines draw over the blended colour. `renderer.meshBlend.radii` is a `Map` from part name to radius for hosts whose parts do not carry the option (the recipe preview fills it from the nodes). `bench/reference/mesh-blend.mjs` renders the before and after still of a terrain with sunk rocks and a trunk, checks the pixels against main and measures the frame.
