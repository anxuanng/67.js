# Blender parity ledger

This ledger compares 67.js with each feature in the [Blender 5.2 manual](https://docs.blender.org/manual/en/latest/).
It is the record for the goal in issue #23. Use `npm run parity` to print the coverage of each section.

## How to read it

| Status | Meaning |
| --- | --- |
| `done` | 67.js covers the purpose of the feature, and the Evidence column links to a test. |
| `partial` | Some of the feature works. The note says what exists and what does not. |
| `missing` | The feature is in scope, and 67.js does not have it. |
| `out of scope` | The goal does not include the feature. The note gives the reason. |

Agents are the user of 67.js, so a row judges the purpose of a Blender feature and not its interface. A row covers the pages below it unless a finer row exists.

`done` does not mean equal to Blender. A test shows that the feature works, and it does not show that the result matches. `npm run parity` counts a row as compared only when its evidence is in `tests/fixtures/blender/` or `bench/reference/`.

`bench/reference/` scores 67.js renders against Cycles and EEVEE on 8 scenes. Its README gives the scores and the largest gap in each scene.

`tests/blender-golden.test.js` compares mesh operations with results from Blender. A compared row can still differ, and `tests/fixtures/blender/differences.json` gives the reason for each difference.

Rows differ in size: `Modeling > Modifiers > Generate > Weld Modifier` and `Rendering > Render Engines > Cycles` each count as one. Do not quote the percentage as a measure of how close 67.js is to Blender.

To change a row, change its status and its evidence in the same pull request as the feature. `tests/parity-ledger.test.js` fails if a `done` row has no evidence, if a link is broken or if a manual page has no row.

To move to a new Blender release, run `node scripts/parity-manual-snapshot.mjs`. The test then lists each new page.

## Blender manual

| Manual path | Status | What exists, or why not | Evidence | Issues |
| --- | --- | --- | --- | --- |
| User Interface | out of scope | Interface for a person with a mouse. Agents use MCP tools. | | |
| Editors | out of scope | Interface for a person with a mouse. Agents use MCP tools, and people review images. | | |
| Scenes & Objects > Scenes | partial | One recipe holds one scene with its camera and environment. There are no scene units or linked scenes. | | |
| Scenes & Objects > Objects > Object Types | partial | Mesh nodes and empty nodes exist. Lights are environment settings, and curves and text do not exist as objects. | | #45 |
| Scenes & Objects > Objects > Object Origin | partial | Code has pivots in the scene graph. Recipes have no pivot field. | | |
| Scenes & Objects > Objects > Selecting | out of scope | Selection by mouse. Tools address nodes by ID. | | |
| Scenes & Objects > Objects > Editing | partial | Agents add, change and remove nodes in atomic batches. There is no duplicate, join or separate. | | |
| Scenes & Objects > Objects > Object Properties | partial | Transform, parent, label, geometry and material. | | |
| Scenes & Objects > Objects > Tools | out of scope | Viewport tools for a mouse. | | |
| Scenes & Objects > Collections | partial | Parent nodes group objects. There are no collections or collection instances. | | |
| Modeling > Meshes > Structure | done | Half-edge `EditMesh` and compact `MeshData`, with face tags and a topology validator. | [mesh-core](../tests/mesh-core.test.js) | |
| Modeling > Meshes > Primitives | partial | Box, cylinder, sphere and torus. There is no plane, grid, cone, ico sphere or monkey primitive. | | |
| Modeling > Meshes > Tools | partial | The operations behind extrude and loop cut exist as edits. Spin is covered only by `lathe`. | | #41 |
| Modeling > Meshes > Selecting | partial | Rules: all, tag, normal, inside, faces, and, or, not, grow, boundary. There is no loop, linked, similar or sharp edge selection. | | #41 |
| Modeling > Meshes > Editing | partial | 26 edits, including extrude, inset, bevel, loop cut, boolean, merge, bisect, bridge, fill, grid fill, dissolve, edge subdivision and a knife by projected polyline. All but the knife match Blender on fixtures; the knife is compared only with a straight plane cut. | [Blender results](../tests/fixtures/blender/golden.json) | #41 |
| Modeling > Meshes > Properties | partial | `smoothAngle` and face tags. There is no sharp edge attribute or crease. | | #39 |
| Modeling > Meshes > UVs | partial | `uv_unwrap` with LSCM, axis charts and shelf packing. Patterns can not use the result yet. | | #50 |
| Modeling > Meshes > Mesh Analysis | partial | `lintMesh` reports topology problems. With `{ geometry: true }` (always on in `mesh_inspect`) it also warns of crossing parts, a solid cutting itself, thin walls, floating parts and near-symmetry, using the BVH within face budgets. Checks are heuristics on parts, not Blender's exact Select Non-Manifold or Intersect checks. | [tests/mesh-lint-geometry.test.js](../tests/mesh-lint-geometry.test.js), [src/mesh-lint-geometry.js](../src/mesh-lint-geometry.js) | #66 |
| Modeling > Meshes > Remeshing | missing | No remesh. | | #40 |
| Modeling > Curves | partial | `tube` follows a curve and `extrude` follows a contour. There is no curve object. | | #45 |
| Modeling > Curves (New) | missing | No hair curves. | | #63 |
| Modeling > Surfaces | out of scope | Issue #45 records NURBS surfaces as out of scope unless demand appears. | | |
| Modeling > Metaball | out of scope | Issue #45 records metaballs as out of scope unless demand appears. | | |
| Modeling > Text | missing | No text objects. | | #45 |
| Modeling > Point Cloud | missing | No point clouds. | | #43 |
| Modeling > Volumes | missing | Depth-clipped volume fog exists. There are no volume objects. | | #63 |
| Modeling > Empties | done | A node with no geometry acts as an empty parent. | [agent-scene](../tests/agent-scene.test.js) | |
| Modeling > Modifiers > Common Modifier Options | done | A recipe mesh holds an ordered stack. `set-mesh-stack` replaces the stack or applies a node into the edit log. | [mesh-stack](../tests/mesh-stack.test.js) | |
| Modeling > Modifiers > Edit > Data Transfer Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Edit > Mesh Cache Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Edit > Mesh Sequence Cache Modifier | partial | `addons/spume` plays back a baked liquid as parts. There is no general cache. | | |
| Modeling > Modifiers > Edit > UV Project Modifier | partial | Patterns project by box in the shader. There is no projection to UVs. | | #50 |
| Modeling > Modifiers > Edit > UV Warp Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Edit > Vertex Weight Edit Modifier | missing | No vertex groups in recipes. | | #46 |
| Modeling > Modifiers > Edit > Vertex Weight Mix Modifier | missing | No vertex groups in recipes. | | #46 |
| Modeling > Modifiers > Edit > Vertex Weight Proximity Modifier | missing | No vertex groups in recipes. | | #46 |
| Modeling > Modifiers > Generate > Array Modifier | done | Stack node with count, offset, relative offset and merge. | [mesh-stack](../tests/mesh-stack.test.js), [Blender results](../tests/fixtures/blender/golden.json) | |
| Modeling > Modifiers > Generate > Array (Legacy) Modifier | out of scope | The Array Modifier row replaces it. | | |
| Modeling > Modifiers > Generate > Bevel Modifier | done | Stack node and edit, with segments, profile and overlap clamp, on edges only. | [mesh-bevel](../tests/mesh-bevel.test.js), [Blender results](../tests/fixtures/blender/golden.json) | |
| Modeling > Modifiers > Generate > Boolean Modifier | partial | Manifold boolean as an edit. It is not a stack node. | [mesh-boolean](../tests/mesh-boolean.test.js), [Blender results](../tests/fixtures/blender/golden.json) | |
| Modeling > Modifiers > Generate > Build Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Generate > Curve to Tube Modifier | partial | `tube` is a geometry type. It is not a stack node. | [modeling](../tests/modeling.test.js) | #45 |
| Modeling > Modifiers > Generate > Decimate Modifier | missing | No decimation. | | #40 |
| Modeling > Modifiers > Generate > Edge Split Modifier | missing | No equivalent. `smoothAngle` splits normals by angle. | | #42 |
| Modeling > Modifiers > Generate > Mask Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Generate > Mesh to Volume Modifier | missing | No volume objects. | | |
| Modeling > Modifiers > Generate > Mirror Modifier | done | Stack node with axis and merge. | [mesh-stack](../tests/mesh-stack.test.js), [Blender results](../tests/fixtures/blender/golden.json) | |
| Modeling > Modifiers > Generate > Multiresolution Modifier | missing | No multiresolution. | | |
| Modeling > Modifiers > Generate > Remesh Modifier | missing | No remesh. | | #40 |
| Modeling > Modifiers > Generate > Scatter on Surface Modifier | partial | `instances` with a `surface` source scatters a node at seeded, area-weighted points with yaw, scale and normal alignment, and `where` filters them. No minimum distance or density map, and `addons/clutter` and `addons/grass` still scatter in code. | [src/mesh-instances.js](../src/mesh-instances.js), [tests/mesh-fields.test.js](../tests/mesh-fields.test.js) | #42 |
| Modeling > Modifiers > Generate > Screw Modifier | partial | `lathe` covers a full turn. There is no stack node or screw offset. | | #42 |
| Modeling > Modifiers > Generate > Skin Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Generate > Solidify Modifier | done | Stack node with thickness, offset and even thickness. | [mesh-stack](../tests/mesh-stack.test.js), [Blender results](../tests/fixtures/blender/golden.json) | |
| Modeling > Modifiers > Generate > Subdivision Surface Modifier | done | `subdivide` edit and stack node: Catmull-Clark to 4 levels, semi-sharp creases, sharp boundaries, tags, UVs. Counts, area and positions match Blender; volume differs under 1% on four cases. | [src/mesh-subdivide.js](../src/mesh-subdivide.js), [tests/blender-golden.test.js](../tests/blender-golden.test.js), [tests/mesh-subdivide.test.js](../tests/mesh-subdivide.test.js), [pebble task](../bench/agent-modeling/tasks.mjs) | #39 |
| Modeling > Modifiers > Generate > Triangulate Modifier | missing | Render data is triangulated. There is no node that changes the mesh. | | #42 |
| Modeling > Modifiers > Generate > Volume to Mesh Modifier | missing | No volume objects. | | |
| Modeling > Modifiers > Generate > Weld Modifier | partial | `merge_by_distance` is an edit. It is not a stack node. | | #42 |
| Modeling > Modifiers > Generate > Wireframe Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Deform > Armature Modifier | partial | GPU skinning for imported rigs. Recipes can not bind a mesh. | [skinning](../tests/skinning.test.js) | #46 |
| Modeling > Modifiers > Deform > Cast Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Deform > Curve Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Deform > Displace Modifier | done | `displace` edit and stack node with a field as the texture, along the normal or an axis, with strength, midlevel and a face selection. Positions match Blender with a constant and with a Blend texture. | [src/mesh-field-edits.js](../src/mesh-field-edits.js), [tests/blender-golden.test.js](../tests/blender-golden.test.js), [src/mesh-fields.js](../src/mesh-fields.js), [tests/mesh-fields.test.js](../tests/mesh-fields.test.js) | #43 |
| Modeling > Modifiers > Deform > Hook Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Deform > Laplacian Deform Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Deform > Lattice Modifier | missing | No lattice. | | #42 |
| Modeling > Modifiers > Deform > Mesh Deform Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Deform > Shrinkwrap Modifier | partial | `addons/shrinkwrap` works in code. Recipes can not reach it. | [shrinkwrap](../tests/shrinkwrap.test.js) | #42, #47 |
| Modeling > Modifiers > Deform > Simple Deform Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Deform > Smooth Modifier | missing | No stack node. `addons/sculpt` smooths in code. | | #42 |
| Modeling > Modifiers > Deform > Smooth Corrective Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Deform > Smooth Laplacian Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Deform > Surface Deform Modifier | missing | `addons/surface-attachment` binds points, not whole meshes. | | |
| Modeling > Modifiers > Deform > Volume Displace Modifier | missing | No volume objects. | | |
| Modeling > Modifiers > Deform > Warp Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Deform > Wave Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Normals > Normal Edit Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Normals > Weighted Normal Modifier | missing | No equivalent. | | #42 |
| Modeling > Modifiers > Normals > Smooth By Angle Modifier | partial | `smoothAngle` is a geometry setting. It is not a stack node. | | #42 |
| Modeling > Modifiers > Physics > Cloth Modifier | missing | No cloth. | | #62 |
| Modeling > Modifiers > Physics > Collision Modifier | partial | Rapier colliders fitted to recipe geometry as box, ball, capsule, convex hull or trimesh, so a body rests on an authored mesh. | [agent-physics](../tests/agent-physics.test.js) | #61 |
| Modeling > Modifiers > Physics > Dynamic Paint Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Physics > Explode Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Physics > Fluid Modifier | partial | `addons/spume` plays back a liquid baked outside the browser. | [spume](../tests/spume.test.js) | #63 |
| Modeling > Modifiers > Physics > Ocean Modifier | missing | No equivalent. | | |
| Modeling > Modifiers > Physics > Particle Instance Modifier | missing | No particle system. | | #63 |
| Modeling > Modifiers > Physics > Particle System Modifier | missing | No particle system. | | #63 |
| Modeling > Modifiers > Physics > Soft Body Modifier | missing | No soft bodies. | | #62 |
| Modeling > Modifiers > Geometry Nodes Modifier | partial | Bounded JSON field expressions drive `set_position`, `displace`, a `field` selection rule and `instances`. There is no node graph, no loops, no custom node groups, and no realize, curve or volume nodes. | [src/mesh-fields.js](../src/mesh-fields.js), [tests/mesh-fields.test.js](../tests/mesh-fields.test.js), [tests/blender-golden.test.js](../tests/blender-golden.test.js), [pillar-court task](../bench/agent-modeling/tasks.mjs) | #43 |
| Modeling > Geometry Nodes | partial | Fields over attributes, noise and math (position, normal, index, tags), Set Position, Instance on Points (grid, scatter, surface) and Displace. Noise is not Blender's noise function, and there is no Blender comparison for instancing. Issue #43 chose bounded JSON expressions and not a visual editor. | [src/mesh-fields.js](../src/mesh-fields.js), [tests/mesh-fields.test.js](../tests/mesh-fields.test.js), [tests/blender-golden.test.js](../tests/blender-golden.test.js) | #43 |
| Modeling > Transform | partial | Node transforms, and `translate` on a selection with falloff. There is no rotate or scale on a selection. | | |
| Sculpting & Painting > Brushes | out of scope | Brush settings for a hand. Strokes have explicit parameters. | | |
| Sculpting & Painting > Selection & Visibility | out of scope | Interface for a person in a paint mode. | | |
| Sculpting & Painting > Navigating in Paint Modes | out of scope | Interface for a person in a paint mode. | | |
| Sculpting & Painting > Sculpting | partial | Inflate, displace and smooth strokes in code. Recipes can not reach them, and there is no remesh during a stroke. | [sculpt](../tests/sculpt.test.js) | #47 |
| Sculpting & Painting > Texture Paint | missing | No painting into textures. | | |
| Sculpting & Painting > Vertex Paint | partial | Imported vertex colors render. Recipes can not author them. | | |
| Sculpting & Painting > Weight Paint | missing | No vertex groups in recipes. Automatic weights replace painting by hand. | | #46 |
| Sculpting & Painting > Curves Sculpting | missing | No hair curves. | | #63 |
| Grease Pencil | out of scope | Decided in issue #23. | | |
| Animation & Rigging > Animation Editors | out of scope | Interface for a mouse. | | |
| Animation & Rigging > Keyframes | partial | Linear, step, smooth and Hermite curves with deterministic seeks. There are no other easing types or keying sets. | [animation](../tests/animation.test.js) | |
| Animation & Rigging > Armatures > Bones | missing | Recipes can not author bones. | | #46 |
| Animation & Rigging > Armatures > Properties | missing | Recipes can not author armatures. | | #46 |
| Animation & Rigging > Armatures > Structure | partial | Imported rigs keep their hierarchy. Recipes can not author one. | [gltf](../tests/gltf.test.js) | #46 |
| Animation & Rigging > Armatures > Skinning | partial | Four-influence GPU skinning. There is no automatic binding. | [skinning](../tests/skinning.test.js) | #46 |
| Animation & Rigging > Armatures > Posing | partial | Layers, masks, additive poses and IK in code. MCP has IK and one clip. | [skeleton-pose](../tests/skeleton-pose.test.js), [agent-asset-ik](../tests/agent-asset-ik.test.js) | #58, #59 |
| Animation & Rigging > Lattice | missing | No lattice. | | #42 |
| Animation & Rigging > Constraints > Interface | out of scope | Interface for a mouse. | | |
| Animation & Rigging > Constraints > Motion Tracking | out of scope | Motion tracking is out of scope in issue #23. | | |
| Animation & Rigging > Constraints > Transform > Copy Location Constraint | partial | `copy_location` in `motion.constraints`: axes, invert, offset, world or local space, influence. Matches Blender where tested. | [agent-motion-constraints](../tests/agent-motion-constraints.test.js) | #58 |
| Animation & Rigging > Constraints > Transform > Copy Rotation Constraint | partial | `copy_rotation`: Euler axes, invert, replace or add, world or local. World matrices match Blender 5.2 in 2 cases. | [blender-constraints](../tests/blender-constraints.test.js) | #58 |
| Animation & Rigging > Constraints > Transform > Copy Scale Constraint | partial | `copy_scale`: axes and offset, world or local. | [agent-motion-constraints](../tests/agent-motion-constraints.test.js) | #58 |
| Animation & Rigging > Constraints > Transform > Copy Transforms Constraint | missing | No constraint. | | #58 |
| Animation & Rigging > Constraints > Transform > Limit Distance Constraint | missing | No constraint. | | #58 |
| Animation & Rigging > Constraints > Transform > Limit Location Constraint | partial | `limit_location`: per-axis clamp, world or local. | [agent-motion-constraints](../tests/agent-motion-constraints.test.js) | #58 |
| Animation & Rigging > Constraints > Transform > Limit Rotation Constraint | partial | `limit_rotation` constraint and per-axis `limits` on two-bone IK joints, reported in `motionIk`. Matches Blender 5.2. | [blender-constraints](../tests/blender-constraints.test.js), [skeleton-pose-limits](../tests/skeleton-pose-limits.test.js) | #58 |
| Animation & Rigging > Constraints > Transform > Limit Scale Constraint | missing | No constraint. | | #58 |
| Animation & Rigging > Constraints > Transform > Maintain Volume Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Transform > Transformation Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Transform > Transform Cache Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Tracking > Clamp To Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Tracking > Damped Track Constraint | partial | Aim IK turns one joint toward a target. It is not a general constraint. | [agent-motion-ik](../tests/agent-motion-ik.test.js) | #58 |
| Animation & Rigging > Constraints > Tracking > Inverse Kinematics Constraint | partial | Two-bone and aim IK, in code and in `motion.ik`, with joint limits and sanity warnings on two-bone. There are no longer chains. | [agent-motion-ik](../tests/agent-motion-ik.test.js), [agent-asset-ik](../tests/agent-asset-ik.test.js) | #58 |
| Animation & Rigging > Constraints > Tracking > Locked Track Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Tracking > Spline IK Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Tracking > Stretch To Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Tracking > Track To Constraint | partial | `track_to` on nodes: track and up axes, `worldUp`. Matches Blender 5.2 in 2 cases. Cameras still use camera paths. | [blender-constraints](../tests/blender-constraints.test.js), [camera-path](../tests/camera-path.test.js) | #58 |
| Animation & Rigging > Constraints > Relationship > Action Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Relationship > Armature Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Relationship > Child Of Constraint | partial | `child_of` in `motion.constraints`: follows a moving target from its rest inverse (or none), with an influence that can be animated by an expression. Matches Blender 5.2 in 2 cases. No per-channel switches. | [blender-constraints](../tests/blender-constraints.test.js), [scene-graph](../tests/scene-graph.test.js) | #58 |
| Animation & Rigging > Constraints > Relationship > Floor Constraint | partial | `floor`: keeps a node on one side of a plane through the target, axis and offset. Matches Blender 5.2 for the Z floor with an offset; no `use_rotation`. | [blender-constraints](../tests/blender-constraints.test.js) | #58 |
| Animation & Rigging > Constraints > Relationship > Follow Path Constraint | partial | Camera paths only. | [camera-path](../tests/camera-path.test.js) | |
| Animation & Rigging > Constraints > Relationship > Geometry Attribute Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Relationship > Pivot Constraint | missing | No constraint. | | |
| Animation & Rigging > Constraints > Relationship > Shrinkwrap Constraint | partial | `addons/surface-attachment` binds points to a surface in code. | [surface-attachment](../tests/surface-attachment.test.js) | |
| Animation & Rigging > Actions | partial | Clips, weights and crossfades in code. An asset through MCP plays one clip at a time. | [animation-mixer](../tests/animation-mixer.test.js) | #59 |
| Animation & Rigging > Drivers | partial | `motion.drivers`: a node component or material property from a bounded expression over time and other nodes. No custom properties, shape keys or variables. | [agent-motion-constraints](../tests/agent-motion-constraints.test.js) | #58 |
| Animation & Rigging > Markers | missing | No markers or events. | | #60 |
| Animation & Rigging > Shape Keys | partial | Morph targets import, render and animate. Recipes can not author them. | [morph](../tests/morph.test.js) | #59 |
| Animation & Rigging > Motion Paths | out of scope | Viewport display for hand work. `scene_inspect` reports motion as numbers. | | |
| Animation & Rigging > In-Betweens | out of scope | Pose tools for a hand. Agents write keyframes and IK targets. | | |
| Physics > Rigid Body > Rigid Body Properties | partial | Dynamic, fixed and kinematic bodies with mass, density, friction, restitution and velocity, in code and in recipes. Trimesh and convex colliders, no bone-bound bodies yet. | [physics-colliders](../tests/physics-colliders.test.js) | #61 |
| Physics > Rigid Body > Rigid Body World | partial | Recorded simulation with deterministic seeks, in code and in a recipe `physics` section (MCP, a seek back repeats the PNG). | [agent-physics](../tests/agent-physics.test.js) | #61 |
| Physics > Rigid Body > Rigid Body Constraints | partial | Fixed, spherical, revolute and prismatic joints, with limits and motors, in code. | [physics](../tests/physics.test.js) | #61 |
| Physics > Cloth | missing | No cloth. | | #62 |
| Physics > Soft Body | missing | No soft bodies. | | #62 |
| Physics > Fluid | partial | `addons/spume` plays back a liquid baked outside the browser. There is no smoke or fire. | [spume](../tests/spume.test.js) | #63 |
| Physics > Particle System | missing | No shared particle system. Sparks exist only in the demo film. | | #63 |
| Physics > Dynamic Paint | missing | No equivalent. | | |
| Physics > Forces > Gravity | partial | Physics definitions and recipe `physics.gravity` set gravity. | [physics](../tests/physics.test.js) | #61 |
| Physics > Forces > Force Fields | missing | No force fields. | | #63 |
| Physics > Collision | partial | Rapier collisions with sensors (enter and leave events) and 16 collision layers with masks, in code and recipes. `scene_inspect` reports contacts and resting state. | [physics-colliders](../tests/physics-colliders.test.js) | #61 |
| Physics > Baking Physics Simulations | partial | Physics records to a timeline in code or when a recipe scene is created, on the main thread. | [film-physics](../tests/film-physics.test.js) | #61 |
| Physics > Simulation Nodes | missing | No node graph. | | #43 |
| Rendering > Render Engines > EEVEE | partial | A WebGL2 rasterizer with PBR, one directional shadow, 8 point lights, fog and bloom. There are no light probes. | [renderer](../tests/renderer.test.js), [scores against EEVEE](../bench/reference/baseline.json) | #52, #53, #55, #56 |
| Rendering > Render Engines > Cycles | missing | No path tracer and no render baking. | | #55, #57 |
| Rendering > Render Engines > Workbench | out of scope | A viewport engine for working by hand. | | |
| Rendering > Cameras | partial | Perspective, orthographic views, focal length and animated paths. There is no depth of field. | [camera-path](../tests/camera-path.test.js), [camera](../tests/camera.test.js) | #54 |
| Rendering > Lights > Light Objects | partial | One directional light with a shadow, 8 point lights, 8 spot lights and 4 rectangular area lights. Point and spot lights can cast shadows from one 24-tile atlas (a point light takes 6 tiles, a spot light 1). Area lights use a representative point and cast no shadow. The directional shadow is a single map, not cascaded. | [lighting](../tests/lighting.test.js), `npm run reference` scene `spot-area` | #52 |
| Rendering > Lights > Light Linking | missing | No light linking. | | #52 |
| Rendering > Lights > World Environment | partial | Recipes have sky colors, daylight and fog. Code can load an HDRI, and recipes can not reach it. | [environment](../tests/environment.test.js) | #53 |
| Rendering > Materials > Components | partial | Surfaces with PBR factors and five maps, a clear coat, transmission with thickness, attenuation and IOR, sheen, and specular weight and tint. There is no anisotropy, iridescence, subsurface scattering, volume material or displacement. | [texture-set](../tests/texture-set.test.js) | #50, #51 |
| Rendering > Materials > Assignment | done | A node names one material. | [agent-scene](../tests/agent-scene.test.js) | |
| Rendering > Materials > Preview | out of scope | Interface for a person. Agents use `scene_look`. | | |
| Rendering > Materials > Settings | partial | Opaque and blend in recipes, and mask on imported assets, with double-sided support. | [gltf-extensions](../tests/gltf-extensions.test.js) | #51 |
| Rendering > Materials > Line Art | missing | No line rendering. | | |
| Rendering > Materials > Legacy Textures | out of scope | Blender keeps these for old files. | | |
| Rendering > Shader Nodes > Input | missing | No node graph. | | #50 |
| Rendering > Shader Nodes > Output | missing | No node graph. | | #50 |
| Rendering > Shader Nodes > Shader | partial | A metallic-roughness surface with clear coat, transmission, sheen and specular layers, and unlit, liquid and foam tags. There is no anisotropy, iridescence or subsurface. | [material-layers](../tests/material-layers.test.js) | #51 |
| Rendering > Shader Nodes > Displacement | partial | Normal maps. There is no bump from height or displacement. | | #50 |
| Rendering > Shader Nodes > Texture | partial | Image maps and 11 pattern presets. There is no graph, so an agent can not combine them. | [material-patterns](../tests/material-patterns.test.js) | #50 |
| Rendering > Shader Nodes > Color | missing | No node graph. | | #50 |
| Rendering > Shader Nodes > Utilities | missing | No node graph. | | #50 |
| Rendering > Shader Nodes > Group | missing | No node graph. | | #50 |
| Rendering > Color Management | partial | ACES tone mapping and grading. There is no choice of color space or display. | [effects](../tests/effects.test.js) | |
| Rendering > Freestyle | missing | No line rendering. | | |
| Rendering > View Layers & Passes | missing | No layers or passes. | | #54 |
| Rendering > Render Output > Output Properties | partial | PNG and MP4, frame rate, duration and size. There is no stereo or metadata. | [agent-render-jobs](../tests/agent-render-jobs.test.js) | #60 |
| Rendering > Render Output > Audio Rendering | missing | Render jobs have no audio. | | #60 |
| Rendering > Render Output > Rendering Animations | done | Snapshot render jobs with progress, cancel and verified output. | [agent-render-jobs](../tests/agent-render-jobs.test.js) | |
| Rendering > Render Output > Animation Player | out of scope | Interface for a person. | | |
| Compositing | partial | A fixed chain of bloom, grading and FXAA. There is no graph. | [effects](../tests/effects.test.js) | #54 |
| Motion Tracking & Masking | out of scope | Decided in issue #23. | | |
| Video Editing | out of scope | Decided in issue #23. DaVinci Resolve or FFmpeg can cut rendered output. | | |
| Assets, Files, & Data System > Blender File | out of scope | Decided in issue #23. Recipes and GLB are the file formats. | | |
| Assets, Files, & Data System > Data-Blocks | out of scope | Blender file internals. Recipes name resources by ID. | | |
| Assets, Files, & Data System > Custom Properties | missing | Nodes have a label and no other fields. | | |
| Assets, Files, & Data System > File Paths | out of scope | The MCP server allows only a configured catalog. | | |
| Assets, Files, & Data System > Linked Libraries | out of scope | Blender file internals. | | |
| Assets, Files, & Data System > Asset Libraries | partial | A local GLB catalog. There is no library of reusable parts. | [agent-asset-catalog](../tests/agent-asset-catalog.test.js) | #68 |
| Assets, Files, & Data System > Media Formats | partial | Common web images in, and PNG and MP4 out. | | |
| Assets, Files, & Data System > Importing & Exporting Files | out of scope | Decided in issue #23: GLB is the exchange format. | | |
| Add-ons > Node Wrangler | out of scope | Interface for a mouse. | | |
| Add-ons > Rigify | missing | No rig presets. | | #46 |
| Add-ons > glTF 2.0 | partial | Import is broad. Export writes the five texture channels as PNG, skins with joints, morph targets and node clips, and bakes pattern materials with box projected UVs; Blender 5.2 and three.js open the RobotExpressive export with its 43 bones and 14 clips. Morph weight clips export, and the `scene_export_glb` MCP tool writes the current pose or an imported clip as a GLB file, checked in Blender 5.2 for a patterned recipe, the robot with IK and its Walking action. Not yet: recipe motion tracks as clips, a clip together with IK or node overrides. | [gltf](../tests/gltf.test.js), [export](../tests/export.test.js), [round trip](../tests/export-roundtrip.test.js), [MCP contract](../tests/mcp-tools.test.js) | #49 |
| Add-ons > Manage UI Translations | out of scope | Blender interface work. | | |
| Add-ons > VR Scene Inspection | out of scope | Interface for a person. | | |
| Advanced | out of scope | Decided in issue #23: 67.js does not run agent code. MCP and the JavaScript API take the place of `bpy`. | | |

## Work outside the manual

The goal also needs this work, and no page in the Blender manual covers it.

| Work | Status | Why | Issues |
| --- | --- | --- | --- |
| Parity evidence | partial | This ledger exists. The Blender comparisons do not. | #24, #25, #26 |
| Bundle size | partial | `npm run size` checks a budget for each entry, and the package has a 1 MiB limit. three.js is gone from the library; only the benchmark page imports it. | #27, #33, #34, #35, #36 |
| Runtime speed | partial | `bench/runtime` compares 7 scenes, and three.js wins most of them. There is no culling, LOD selection or adaptive quality, and bakes run on the main thread. | #28, #37, #38, #74 |
| Agent measurement | partial | A task suite runs on one model and reads recipes only. | #29, #30, #31, #69 |
| Pull request checks | partial | The `Test` workflow reports a status and does not block a merge. | #32 |
| Relations between parts | missing | The agent version of snapping. | #44 |
| Imported mesh editing | missing | Imported assets accept poses and transforms. Their topology is fixed. | #48 |
| Rendering backend | missing | WebGL2 only. WebGPU is not evaluated. | #56 |
| Terrain and navigation | partial | Terrain with 4 splat layers and no holes. There is no navmesh. | #64 |
| Tool cost and errors | partial | Lint and errors exist. No budget limits schema size, and not every error is checked. | #65, #66 |
| Branches and labelled images | missing | 8 checkpoints and unlabelled images. | #67 |
