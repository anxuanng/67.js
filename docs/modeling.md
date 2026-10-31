# Profile, contour and path modeling

Available from version `0.4.0`.
The optional modeling entry builds its meshes itself and has no dependency on Three.js.
The core renderer does not import the modeling addon.

```js
import { lathe, extrude, tube } from '@codepawlhq/67js/addons/modeling';

const vessel = lathe([[0, 0], [0.6, 0], [0.8, 1], [0.6, 2], [0, 2]]);
const panel = extrude([[-2, -2], [2, -2], [2, 2], [-2, 2]], {
  holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]],
  depth: 0.2,
  bevel: 0.03,
});
const cable = tube([[0, 0, 0], [1, 1, 0], [2, 0, 1]], { radius: 0.04 });
```

Each result has Float32 positions, normalized normals and UV channel zero, plus Uint32 triangle indices.
Pass it as a part's `geometry` to `Renderer67`. Inputs are copied. Repeated instances can share the returned mesh.
These generators run when constructing a scene, rather than every frame.

## Lathe

`lathe(profile, { segments = 64, startAngle = 0, sweep = 2π, maxVertices = 250000 })`
revolves radius/height pairs around Y. Radii must be nonnegative, with at least one positive radius.
Angles use radians. Large start angles normalize modulo one turn before evaluation.
Segments range from 3 to 2048. UVs preserve the longitudinal seam.

Profiles with radius-zero ends meet the axis. Partial sweeps and open profile ends remain open.
Folded profiles can intersect themselves. This tool is not a solid Boolean solver.

## Extrude

`extrude(contour, { holes = [], depth = 1, steps = 1, bevel = 0, bevelThickness = bevel, bevelSegments = 3, maxVertices = 250000 })`
extrudes a simple XY polygon along positive Z. Holes must remain strictly inside the contour and cannot overlap, touch or nest.
Both polygon winding directions are accepted. A duplicated closing point is optional.
Bevels extend the caps from `-bevelThickness` to `depth + bevelThickness`.

Steps range from 1 to 256. Bevel segments range from 1 to 32.
Large bevels can intersect on narrow or concave shapes. Inspect the result and reduce bevel size to fit the local clearance.
The base contour validation does not establish that an arbitrary bevel produces a manifold solid.

## Tube

`tube(path, { radius = 0.1, segments = 64, radialSegments = 12, closed = false, maxVertices = 250000 })`
sweeps a circular cross-section along a centripetal Catmull-Rom curve through XYZ points.
Open paths need two points. Closed paths need three. Closed paths join the final sample back to the first.
Open tube ends have no caps. Paths can intersect themselves.

Segments range from 3 to 2048. Radial segments range from 3 to 128.

## Resource and precision limits

Each generator accepts at most 4096 input points. Extrusion applies that limit across its contour and holes.
Vertex estimates are checked before geometry allocation. `maxVertices` can range from 3 to 1000000.
This bounds geometry size, not total browser memory.

Account for maps, instance counts and render targets separately.
Polygon intersection validation uses quadratic edge comparisons, bounded by the input limit.
Nonfinite output, invalid normals and entirely collapsed Float32 meshes throw.
Center small geometry near the origin and place it with part transforms when working at large world coordinates.

## API choice

Plain point arrays keep profiles serializable and keep any other library's classes out of the API.
Accepting custom curve objects would let callers supply their own curve classes, but weakens input bounds.
Lathe, bevel construction and curve frames follow the formulas Three.js used before, so those outputs are unchanged. Extrusion caps use an ear-clipping triangulation of the addon's own, so a cap can be split along different diagonals than before, with the same area, volume and bounds.

The Aster lantern at `/modeling.html` combines these tools with texture channels and the shared scene graph.
It is a procedural modeling demonstration, not a mesh editor or a Blender feature parity claim.
