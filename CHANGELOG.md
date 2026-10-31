# Changelog

## Unreleased

- Add a recipe timeline, job audio and an encoder choice (part of issue #60, first slice). A recipe `timeline` lists named shots played in order over the motion clock, each with a `duration`, an optional `motionStart`, a partial `camera` on top of the sampled one and a `dip` through black; `set-timeline` edits it. `settings.timeline: { start }` renders it as an image, stills or video: one clock drives the shot, the motion and the renderer, so a seek to any time gives the same frame as inside a video. `settings.audio: { file, offset }` mixes one `.wav`, `.mp3`, `.ogg` or `.flac` from the new `--audio <folder>` option into a video, checks that it covers the video, decodes both streams afterwards and reports `metrics.sync` (a gap over 50 ms fails the job); `settings.encoder` is `cpu` or `nvenc`. File names are plain names without paths, drives or protocols, files must be regular and at most 32 MiB, and ffmpeg gets `-protocol_whitelist file`; nothing else comes from the agent. Video jobs can last 60 s (was 30), still capped at 900 frames, so a 60 s video runs at 15 fps. Measured through MCP on SwiftShader (`npm run smoke:film-timeline`): 9 PNG seeks across three shots and a dip match 8 stills byte for byte, and a 60 s, 900 frame video with sound rendered in 58 s (84 s on a loaded machine) at 128 x 128 with the click in the decoded audio on the decoded cut frame (offset 0.1 ms, streams 20 ms apart). Tool schemas stay inside their budgets (the timeline is a record reference; fields are in `scene_capabilities` `filmTimeline`). Left out: resumable long renders, several audio tracks, gain, markers inside a shot, animation events, crossfades and timelines for imported assets. The video sequence editor stays a non-goal.

- Add recipe cloth (part of issue #62, no new tool). A `cloth` section records sheets with a position-based solver (`src/cloth.js`, loaded on demand with the new `cloth` module, no peer dependency): pinned edges, gravity, steady wind, ball and box colliders, thickness and friction, 60 frames a second, bounded by particle, frame and solver-operation limits. A seek blends two recorded frames, so the same time gives the same positions and a seek backwards repeats them (`npm run smoke:agent-cloth` repeats the PNG bytes through the MCP preview). New `grid` geometry (a flat sheet, 1 to 64 segments), `set-cloth` operation and a `cloth` report in `scene_inspect`. The tool schemas stay within the total budget: `set-physics` now takes the same record reference as `set-motion`, and the physics descriptions are shorter. A hanging sheet matches a Blender cloth bake (`scripts/blender-cloth.py`) to 0.08 percent of its height; a sheet dropped on a ball does not match, and no parity is claimed. No self collision and no soft bodies yet.
- Edit the topology of imported GLB parts (part of issue #48, no new tool). `mesh_edit` and `mesh_inspect` take a part ID such as `mesh-10` of an imported asset: the part becomes a welded polygon mesh with axis tags and a `material-<n>` tag, the edit log is kept in the asset recipe as `meshEdits` (checkpoints, export and replay work), and every result passes `validateTopology`. New vertices take skin weights, morph deltas and vertex colours from the nearest original surface point and faces left without UVs read the nearest UV island; on a skinned or morphed part an edit more than a quarter of the part's bounds diagonal from the original surface is rejected with the next action. `mesh_inspect` reports `localToWorldScale` and `localAxesInWorld`. Measured on RobotExpressive through MCP (`npm run smoke:imported-topology`): a through hole in the closed left leg (98 to 210 triangles, still one closed part), a cut in the skinned right hand (124 to 109) and the morphed head (154 to 134), a 3 m extrude on the head rejected, GLB export and checkpoint restore intact. Suite task `robot-leg-hole`.
- Make room in the npm package (part of issue #36). The MCP preview page, `build/mcp/preview.js`, is now an entry of the library build and imports the engine chunks that the package entries already ship, instead of bundling its own copy of the engine. The archive drops from 904,975 to 666,214 bytes. `build/mcp/manifest.json` lists those chunks under `previewChunks` with their hashes, the MCP runtime serves them next to `preview.js`, and `bench/size/budgets.json` gains `archiveBytes`, which `npm run smoke:package` checks.
- Add six whole-mesh modifiers as edits and stack nodes (part of issue #42): `weld`, `triangulate`, `edge_split`, `smooth`, `simple_deform` (twist, bend, taper, stretch) and `cast` (sphere). Each has Blender cases in `tests/fixtures/blender/` that match with no listed difference, `triangulate` and `edge_split` check their output size before building it, and their fields are described in `scene_capabilities` `meshModifiers` so the tool schemas grow by one compact entry. Left for later slices: screw, skin, wireframe, lattice, curve, hook, wave, shrinkwrap, weighted normal, smooth by angle and the other cast shapes. `npm run parity` now prints the modifier coverage.

- Add `curve` and `text` geometry (part of issue #45). `curve` sweeps a round or custom profile along a cubic Bezier chain with explicit or automatic handles, a taper along the length and flat caps; `text` extrudes the outlines of the bundled DejaVu Sans (printable ASCII, 20 KB, loaded on demand with its own `text` module and never in an entry) or of a font table added with `registerAgentSceneFont`, with size, depth, alignment, lines and curve resolution. Volume, area and bounds match Blender 5.2 to 2e-5 for two Bezier curves and for a letter and a word set in the same font. Recipes stay plain JSON with bounded, validated fields and vertex estimates checked before generation. The MCP schemas gain two strict entries in the geometry list (1.4 KB of the 190 KB across all tools; not offered as mesh bases or cutters); field types and limits live in `scene_capabilities` under `curveText`, and the MCP takes no font file or URL. The DejaVu licence is in `THIRD-PARTY-NOTICES.md`. Metaballs and NURBS surfaces are recorded as out of scope in `docs/parity.md`. Not done: a suite task in `bench/agent-modeling`, kerning, bevelled text, non-ASCII glyphs in the bundled font.

- Add frustum culling, levels of detail and live adaptive resolution (part of issue #37). `Renderer67` tests each instance of a batch against the view frustum with the geometry's bounding sphere and draws only the visible ones (on by default, `culling: false` turns it off; skinned, morphed, swaying, fire, smoke, water, assembly and blended batches and the shadow passes are not culled). A part's `lods`, the array from `generateGeometryLods`, makes each instance pick a level by pixel error (`lodPixelError`, default 1). Selection is a pure function of the camera and the matrices, so a seek draws the same frame. `createGpuTimer` and `AdaptiveResolution` in `src/adaptive-quality.js` give live viewers GPU timing and a resolution scale with a minimum; an export can not build one, and `src/main.js` uses it only outside `export=1`. New `large-outdoor` scene in `bench/runtime` with ablations: 1.55 ms against 8.41 ms without culling and 6.0 ms for three.js on an RTX 3060, 517 ms against 4,428 ms and 944 ms on SwiftShader. Core grows 1,845 bytes gzip (budget 81,500). Recipes cannot declare `lods` yet. See `docs/culling-lod.md`.

- Add relations between parts (part of issue #44, no new tool): a mesh node takes `relations` (`attach`, `gap`, `flush`, `align`, `centered`, up to 8) against other mesh nodes, or against the faces of one carrying a mesh tag (`region`). They work on world bounds, are solved after geometry exists and again on every `scene_apply`, so one edit to a body keeps the parts that sit against it. Unknown IDs and tags, two relations on one axis and cycles (a part waiting on its own child included) are rejected with the next action; solving is deterministic and independent of node order. The code loads on demand (`relations`). The schema carries only a generic `relations` list (597 bytes over `scene_create` and `scene_apply` together); the kinds and fields are in `scene_capabilities` `relations`, and the engine validates them. Measured on Sonnet (3 runs each), relations did not cut tool calls or errors: the kettle resize took 3.3 calls against 3.0, and a 12-part desk with three inspected resizes took 8 against 8, with 13% fewer output tokens (3,833 against 4,403) and the same cost and pass rate. The suite gains `kettle-resize`, `desk-resize` and their plain twins, and `touches` and `centreAt` checks.
- Add render passes, depth of field and camera motion blur (issue #54, first slice). Render jobs of kind `image` or `stills` take `settings.passes` (`albedo`, `normal`, `emission`, `depth`, `objectId`) and write each as a raw, unantialiased PNG beside the lit image (`render-depth.png`, `frame-3-objectId.png`); depth is 16 bits over 100 m in red and green, object IDs are 24 bits with the part names in the job metrics. In code, `renderer.render({ pass })` draws a pass into its own non-multisampled target. `effects.depthOfField` (`blur`, `focusDistance`) and `effects.motionBlur` (`shutter`) are new recipe effects: fixed sample patterns and a per-pixel rotation from the pixel position, so a seek to a frame repeats the same pixels. They live in the new `67js/addons/camera-effects` entry; the preview installs it, and the core renderer only gains a stage hook and the pass branch (a compiled-out shader feature). Motion blur follows camera tracks only, sampled from time at `motion.start + elapsed - shutter`. Measured on SwiftShader through MCP (`npm run smoke:render-passes`): 8 stills with 5 passes each, then four seeks, all byte-identical to the same frame in the sequence. Temporal anti-aliasing, accumulation and the compositing graph of #54 are not part of this slice.

- Expose clip layers, bone masks and name retargeting through MCP, and morph clips in `createAssetPose` (issue #59, in part). An asset recipe's `motion.layers` (up to 8) plays the file's own clips at motion time with a bone `mask`, `weight`, `speed`, `offset`, `loop`, `additive` with `reference`, `bones` (clip track to another asset node) and `morph`, before tracks and IK, so a character walks and waves at once; everything is checked against the asset and bounded, and a seek equals playing. `morphClipFromGltfAnimation` and a layer's `morphs` put morph weights through `createAssetPose` (masks pick parts by their owning bone), `createAssetLayerEvaluator` serves hosts that stage the pose themselves, and `asset.stagePose` takes `morphWeights`. Add the `robot-walk-wave` task to the agent modeling suite and extend `npm run smoke:character`. Not done: foot tilt on slopes, full-body IK, and rest-pose retargeting from another asset through MCP. Raise `entry:skeleton-pose` to 19,000 and `entry:agent-asset` to 85,200 bytes gzip, and the tool schema budgets by 800 bytes (`scene_apply` to 47,800, `scene_create_asset` to 20,150, total to 190,700).
- Use one expression language for fields and drivers (issue #98). `src/expression.js` holds the limits, number literals, operator table, syntax and hostile-input checks; `src/mesh-fields.js` (per mesh element: attributes, noise, random, vectors) and `src/motion-expression.js` (per time: `time`, node reads) only add their own inputs, and each rejects the other's with a message that names the context. **This changes driver expressions** (neither language was released): an operator with one operand may be written bare, `{"neg": x}`, in drivers as in fields; `if` takes its second operand when the condition is not 0 (a driver used above 0); `sqrt` of a negative, `pow` overflow and `mod` by 0 give 0 instead of an error; `smoothstep` with equal edges is a step; `div` by 0 is still a non-finite error in a driver, because a hostile-input test pins it, and 0 in a field. Drivers gain `ceil`, `round`, `sign`, `lte`, `gte`, `eq`, `and`, `or`, `not` and booleans; fields gain `atan2` and `saturate`. The unknown-operator hint of fields lists operators in a new order. Error messages for a malformed driver changed in wording and are all TypeErrors. The MCP schema for drivers now points at the field language instead of listing operators (schemas 183,741 to 183,762 bytes), and the `scene_capabilities` budget rises from 3,050 to 3,100 bytes for two operator names.

- Add branches and labelled images to the agent tools (part of issue #67, no new tool). `scene_apply` with a `branch` name runs the operations on a scratch copy and stores the result in a snapshot store that holds one copy per distinct recipe (8 branches), leaving the scene, its revision and its checkpoints untouched. `scene_review` shots take a `branch` and render it in a private scene; `scene_restore` with `branch` keeps one. `labels: true` on `scene_look` and `scene_review` draws part names, material tags and mesh lint problems on the image and returns them as JSON with pixel positions. Branch names are bounded (`^[a-z][a-z0-9_-]{0,23}$`). The tool-schema budget rose by 800 bytes in total (150 for `scene_apply`). `npm run smoke:agent-branches` drives it through MCP on SwiftShader.

- Add a bounded material node graph (issue #50): material `pattern` of `type: "graph"` bakes noise, voronoi, wave, checker, gradient, ramp, maths and `uv` nodes on the CPU into base colour, roughness, metallic, emission and height (a normal map, so bump). The graph is data, never shader text; nodes, depth, ramp stops, texture size and work are checked before any pixel is computed. Add `mapping: "uv"` to every pattern so it follows `uv_unwrap` UVs instead of box projection; the emissive map now box-maps like the other maps. The 11 presets bake the same bytes as before. Covered in the MCP schema, `scene_capabilities` (`materialGraph`, `materialMappings`), GLB export, `docs/agent-scene.md`, `docs/material-maps.md` and the `brick-graph` reference scene.
- Add `decimate`, `remesh` and generated levels of detail (issue #40). `decimate` (a `ratio` of triangles) is a quadric edge collapse of our own that keeps open boundaries, the borders between tags and the tags themselves; it measured 0.25 to 0.85 of the Hausdorff error of meshoptimizer 1.3.0 on the same meshes and adds no dependency, but takes about 2.5 s on 100k triangles where meshoptimizer takes 0.09 s. `remesh` (`voxelSize` or `resolution`, at most 192 per side and 4,194,304 cells, checked before allocation) builds a closed quad surface from a BVH signed distance with surface nets. Both are edits and stack nodes, in the MCP schemas, and load on demand with the mesh code. `generateMeshLods`, `generateGeometryLods` and `generateAssetLods` (also in `67js/addons/mesh`) return levels with a measured error for runtime selection (issue #37). Four decimate and two remesh cases join the Blender comparison, compared by volume, area and Hausdorff distance because face counts differ.

- Make the default look good without tuning. Recipes get an image-based environment: `environment.setup` (`daylight` by default, `overcast`, `sunset`, `studio`) selects a small procedural sky map generated in code, plus its key light, with `environmentIntensity` and `environmentRotation`; no URLs or files from tool input. `effects.ambientOcclusion` (0 to 1) and `ambientOcclusionRadius` add screen-space ambient occlusion from the depth texture. It is off by default: measured with `npm run reference -- --ambient-occlusion`, it improved no score by more than 0.002 (strength 0.8: -0.0019 in foliage, +0.0047 in lit-interior; strength 0.4, radius 0.3: within +0.0013 everywhere). When used it compiles and allocates on first use and costs about 16 ms on a 190 ms SwiftShader frame (8 percent). `scene_capabilities` lists `lightingSetups`, `defaultLightingSetup` and `ambientOcclusion`. **This changes the look of every existing recipe that sets no lighting**: it now has an environment map, a key color of `[3, 2.8, 2.5]` instead of `[5.2, 4.7, 4.1]`, and a fill intensity of `0` instead of `1`. The engine default is unchanged (occlusion off, no map) so code scenes keep their pixels. Screen-space reflections are not part of this. The `scene:lit-box` size budget rises by 100 bytes gzip for the environment and occlusion code. The reference suite gets `--ambient-occlusion`, and its Blender renderer drops triangles that repeat a vertex, which crashed Blender on the skinned character
- Measure and cut the cost of the MCP tools (issue #65). `node scripts/measure-tool-cost.mjs` reports each tool schema and each typical result in bytes and estimated tokens (3.5 characters a token). The 22 schemas came to 373,388 bytes (about 107,000 tokens) and are now 173,216 (about 49,500): recipe geometries and asset recipes point to `mesh_edit`, `mesh_stack` and `scene_create` for the mesh edit, stack and motion detail instead of repeating about 45 KB and 35 KB in each tool, and vectors, colours, quaternions and IDs are shared `$ref` definitions. The backend still validates every field. `tests/tool-cost.test.js` fails when the schema total, one tool's schema or a typical result passes `bench/tool-cost-budgets.json`. A small mesh change is 187 bytes as `mesh_edit` against 1,254 as dispose plus a whole-recipe `scene_create` on a 7-node recipe.
- Return diagnostics that name the next action (issue #66). `mesh_inspect` lint adds `intersecting-parts`, `self-intersection`, `thin-wall`, `floating-part` and `asymmetric` warnings from the BVH, with face budgets and a `skippedChecks` list; they never turn `ok` off and the agent modeling suite does not grade them. `scene_inspect` adds `diagnostics` for material fields the renderer ignores, blended transmission and unused materials or geometries, and asset inspection adds decoder warnings (accepted but not drawn features), skinned meshes with no joints, joints with no skin and assets with no clips. Error messages now list allowed fields, known IDs and the next call: a missing session (the largest group, 21 of 68 recorded errors) names the active session or says to call `scene_create`, and page errors no longer carry the bundle stack. `tests/tool-errors.test.js` walks 27 error paths and rejects a message with no next action.

- Add authored rigs (#46): a recipe `armatures` list (bones with a name, parent, head and tail, or a `humanoid` or `quadruped` preset fitted to a mesh node's bounds, with `landmarks` to move bones), and a `skin` on a mesh node that binds it with automatic weights, plus a `set-armatures` operation. Each bone becomes a recipe node, so keyframed bone rotation and `motion.ik` run through the same paths as imported rigs, and humanoid bones carry the `HUMANOID_BONES` names so `retargetClip` maps them. Weights are the distance to each bone segment with an inverse-fourth-power falloff, the nearest four kept; they depend only on position, so hard-edge seams never open. `scene_inspect` gains `rig`: unweighted vertices, bones with no vertices, and joint axis problems (zero-length bones, straight limb chains, knees that bend backward). `scene_export_glb` writes the bones and a walk clip baked at 30 frames a second from tracks and IK. Add the `rigged-walker` task to the agent modeling suite, with a reference and three failing variants. Blender 5.2 opens the exported walker as 1 armature, 21 bones, 14 meshes with 21 vertex groups each and 1 action of 24 frames; three.js loads 14 skinned meshes and the clip.
- Load agent scene code on demand: mesh editing, `lathe`/`extrude`/`tube`, material `pattern` and `motion` now sit behind `loadAgentSceneModules(recipe)` (or `loadAllAgentSceneModules()`), and `createAgentScene` throws an error naming that call when a needed module is missing. A recipe of primitives drops from 141,241 to 73,581 bytes gzip in `scene:agent-scene` (every lazy chunk still totals 145,049). `npm run size` now bundles with code splitting and reports the initial load, plus a `+lazy` row for the total. `npm test` preloads every module. The archive no longer carries 29 docs that the site serves (physics, lighting, terrain and the other addon docs); agent docs stay
- Add joint limits, node constraints and drivers to motion (issue #58). Two-bone IK takes `limits` per joint and axis in degrees and `bendToward`; `scene_inspect` `motionIk` now carries `limited` (each pose a limit changed) and `warnings` (`hyperextended`, and `wrong-bend` for a knee or elbow bent the unnatural way, which a wrong pole used to hide behind `reached`). `motion.constraints` adds `copy_location`, `copy_rotation`, `copy_scale`, `limit_location`, `limit_rotation`, `track_to`, `child_of` (with an inverse and an influence blend) and `floor`, and `motion.drivers` sets a node component or material property from a bounded JSON expression over time and other nodes (never run as code). The order is tracks, IK, drivers, constraints, with no state between samples, so a seek equals playing. `copy_rotation`, `limit_rotation`, `track_to`, `child_of` and `floor` match Blender 5.2 world matrices in 8 recorded cases (`tests/fixtures/blender/constraints.json`). Joint limits are also in `67js/addons/skeleton-pose`. The `leg-plant` task joins the agent modeling suite. The expression language is a new small one in `src/motion-expression.js`: the field expressions of the mesh addon were not on `main` yet

- Reach Rapier from recipes: a `physics` section (and a `set-physics` operation) puts rigid bodies on node IDs with box, ball, capsule, convex or trimesh colliders fitted to their geometry, joints, gravity and a duration of up to 10 seconds. It is recorded once at 60 steps a second and seeks like `motion`, so a seek back repeats the same frame (checked as identical PNG bytes on SwiftShader through MCP). `scene_inspect` reports per-body final positions and resting times, contacts and sensor enter and leave events. Rapier stays an optional peer, served to the preview from `node_modules` like Manifold, so the MCP server bundle does not grow.
- Add trimesh and convex-hull colliders (bounded triangle and point counts, checked before allocation), sensors with enter and leave events, and 16-bit collision groups and masks to `addons/physics`, plus `contactEvents`, `restFrames`, `bakePhysicsScene`, `loadPhysicsEngine` and `setPhysicsModuleLoader`. A collider with `sensor` now bakes instead of throwing.
- Add the `tray-drop` task to the agent modeling suite: balls dropped into a pocket cut in an authored mesh, graded on a fixed trimesh body, balls resting on the pocket floor and a repeatable seek. Raise four size budgets for the physics code (`entry:physics` to 17,900, `entry:agent-scene` to 121,100, `entry:agent-asset` to 128,500, `scene:agent-scene` to 147,300 bytes gzip).

- Add bounded field expressions: a JSON language of math, comparison, logic, vectors, seeded noise and attributes (position, normal, index, tags) that compiles once to closures over typed arrays and never executes a string. It limits nodes (64), depth (12), elements (250,000) and node-evaluations (8 million) before it evaluates, and only reads operator names from a fixed table. It drives a `{ "field": expression }` face selection rule, `set_position` and `displace` as edits and stack nodes, and a `where` filter for instances. `displace` and `set_position` match Blender's Displace modifier and a Geometry Nodes Set Position node in five new golden cases
- Add `instances` on a recipe node: repeat its geometry at the points of a grid, a seeded scatter in a box or the surface of a geometry, with `where`, `yaw`, `alignToNormal` and `scale`, at most 2048 candidate points. It expands to ordinary nodes that share geometry and material, so the renderer draws one instanced batch. Add the `pillar-court` task to the agent modeling suite
- Add the `scene_export_glb` MCP tool (22 tools now) and morph weight clips in `exportGlb`. The tool writes the active recipe or imported asset scene as a GLB under `<jobs>/exports/` with a server-chosen name and returns the path, byte count and SHA-256; it takes no path, keeps the newest eight files and refuses more than 32 MiB. It exports the current pose (pattern textures, imported textures, skins, morph weights, IK as posed), `motionTime` seeks authored motion first, and `clip` adds an imported asset's source clip. Clip tracks with `property: 'weights'` write a SCALAR sampler of one weight per target. Checked in Blender 5.2: a patterned recipe opens with 2 meshes and 3 images, the robot with IK opens as 1 armature, 43 bones and 20 meshes, and its Walking clip as one action of 23 frames. Nothing in `src/index.js` changes, so no size budget moves
- Add material layers: `clearcoat` and `clearcoatRoughness`, `transmission` with `thickness`, `ior`, `attenuationColor` and `attenuationDistance`, `sheenColor` and `sheenRoughness`, and `specular` and `specularColor`. Recipes, the MCP schema, glTF import and export (`KHR_materials_clearcoat`, `transmission`, `volume`, `ior`, `specular`, `sheen`) all take them, each checked at the boundary. Transmission refracts the opaque scene like the `liquid` material. Anisotropy and iridescence are not rendered yet. Import of those two still warns
- Change the glTF import of the six layer extensions above from accepted-and-ignored to rendered, so `asset.warnings` no longer lists them
- Add spot lights (`environment.spotLights`, 8), rectangular area lights (`environment.areaLights`, 4) and shadows for point and spot lights (`castShadow: true`). Intensity of a spot light is candela, as for a point light, with Blender's cone mask. Area lights use a representative point, within 1.2 percent of Cycles on the axis. Shadows share one 2048 x 3072 depth atlas of 24 tiles (24 MiB, allocated on first use): a point light takes 6 and a spot light 1, and a request for more is an error. The shader code and the atlas exist only in a scene that uses them. Recipes get all of it through `set-environment`, the MCP schema and `scene_capabilities` (`maxSpotLights`, `maxAreaLights`, `localShadows`). Cascaded directional shadows and light linking are not part of this

- Add ten cutting and repair edits: `fill_holes`, `dissolve_faces`, `dissolve_edges`, `dissolve_verts`, `dissolve_limited`, `bisect_plane` (with `fill`, `clearInner`, `clearOuter`), `bridge_edge_loops` (with `segments`), `subdivide_edges`, `grid_fill` and `knife_project`. Each tags what it makes, and the edge rule `{ "open": true }` picks boundary edges. The lint message for an open boundary now suggests `fill_holes`. 18 new cases match Blender in counts, face sizes, area, volume and positions; the knife is compared only with a straight plane cut and differs where a face runs along the projection direction
- Export textures, skeletons and clips to GLB: `exportGlb(parts, { nodes, clips, maxTextureSize })` now writes `map`, `normalMap`, `metallicRoughnessMap`, `occlusionMap` and `emissiveMap` as embedded PNG (limit 2048 px by default, with an error that names the option), skins with joint nodes and inverse bind matrices, and animation clips (translation, rotation and scale tracks; SMOOTH becomes cubic with zero tangents). Pattern materials export their baked textures with box projected UVs, so the picture matches without `uv_unwrap`. It previously threw on skins and on every texture channel. The `entry:core` size budget goes from 67,100 to 70,500 bytes gzip (+3,400)
- Make the first frame and the SwiftShader frame cost less, with the same pixels. The main fragment shader now compiles only the features that a scene uses (maps, splat layers, moss, alpha and the special material tags), and a part that needs another feature later recompiles it. All programs, with the environment prefilter, now start together and use `KHR_parallel_shader_compile`. On an RTX 3060 the first frame went from 3.7 to 4.4 seconds down to 0.5 to 1.0 seconds, and a SwiftShader frame costs 0.4 to 0.5 times what it did. `bench/runtime/PROFILE.md` has the profile
- Add `subdivide` as a mesh edit and stack node: Catmull-Clark subdivision to 4 levels with semi-sharp creases picked by an edge rule, sharp boundaries, kept corners, n-gon support, and tags, UVs and edge attributes carried through each level. The size is checked before it allocates. Counts, area and positions match Blender at levels 1 to 3; the `pebble` task joins the agent modeling suite
- Remove `67js/addons/film` from the npm package. It held the 187-second trailer demo with its baked physics recording, 75 KB gzip of the archive. Nothing else in the package used it. To keep using it, copy `src/film.js`, `src/film-rig.js`, `src/film-character.js`, `src/film-physics-definition.js` and `src/film-physics-clip.json` from the repository, or read the trailer on the site at `/film.html`. The archive goes from 901,314 to 829,085 bytes
- Remove three.js from modeling and the agent scene: `lathe`, `extrude` and `tube` no longer import it, and `scene:agent-scene` drops from 185,681 to 117,290 bytes gzip. `lathe` and `tube` output is identical to before, vertex for vertex. `extrude` walls, bevels, UVs, normals and bounds are identical, and volume matches within 1e-4. Extrusion caps use a new ear-clipping triangulation, so a cap can split along other diagonals, and a cap with collinear points can add or drop a seam vertex. A clockwise hole under a clockwise contour is now flipped to face outward, where it used to keep inward walls
- Load glTF without Three.js: the addon has its own GLB and glTF parser, node sampler and animation clips, so a box with the addon drops from 159,422 to 67,467 bytes gzip. Draco, meshopt and KTX2 still come from the decoders you pass in `options.decoders`. Only the default scene is decoded, and a node outside it is decoded only when a skin or an animation names it
- Remove three.js from modeling and the agent scene: `lathe`, `extrude` and `tube` no longer import it, and `scene:agent-scene` drops from 185,681 to 117,290 bytes gzip. `lathe` and `tube` output is identical to before, vertex for vertex. `extrude` walls, bevels, UVs, normals and bounds are identical, and volume matches within 1e-4. Extrusion caps use a new ear-clipping triangulation, so a cap can split along other diagonals, and a cap with collinear points can add or drop a seam vertex. A clockwise hole under a clockwise contour is now flipped to face outward, where it used to keep inward walls
- Remove three.js and three-mesh-bvh from mesh queries, shrinkwrap and surface patches: a typed-array BVH and its own triangle tests replace them, so no source file in `src/` except the benchmark page imports three.js and the npm archive drops from 856,115 to 798,532 bytes. `entry:mesh-query` drops from 85,555 to 15,535 bytes gzip, `entry:shrinkwrap` from 86,779 to 17,860 and `entry:surface` from 72,974 to 9,838. Nearest, project, raycast and pair results match three-mesh-bvh on fixtures and random queries. Nearest queries on 100k triangles are about 20 percent slower and a pair query with one mesh shifted against itself is slower (21 ms against 2 ms), while a closed-solid pair is 2.4 times faster. The surface patch clipper follows DecalGeometry and keeps its triangle order
- Update the bundled `zod` to 4.6.7, which fixes a memory exhaustion advisory in the validation of oversized collections
- Make the MCP preview server reject requests with another Host header, which closes DNS rebinding
- Check the size of a mesh `array` before it allocates. Before this, the check ran after the copies existed
- Change the bevel `profile` to the meaning it has in Blender: 0.5 is a circular arc, 0.25 is flat, 1 is square, and below 0.25 is concave. Before this, 0 was flat and 0.5 was a parabola, so a recipe with a `profile` other than 0.5 changes shape
- Stop adding a fan of triangles where one beveled edge ends at a vertex with three faces. The third face now takes the profile's points, as in Blender

## 0.14.0

- Add `motion.ik` to imported assets: IK runs over the selected clip and overrides, moves every skin and rigid part, and takes `worldForward`, so agents can pose imported characters through MCP without writing quaternions
- Add `npm run smoke:character`, which takes a real CC0 character through the MCP server along the path an agent uses

## 0.13.1

- Add `createAssetPose`, which poses a loaded glTF asset's whole hierarchy so every skin and rigid part moves, and `clipFromGltfAnimation`, which converts its clips for layers and `retargetClip`
- Add `worldForward` to aim IK, because bone axes differ between real rigs
- Accept skin weights one unit of Float32 rounding above 1, which exporters write and which made such files fail to load

## 0.13.0

- Add `motion.ik` to procedural recipes: two-bone and aim solvers on node hierarchies, with fixed, keyframed or node-following targets, so agents can animate jointed models without writing quaternions; `scene_inspect` reports whether each solver reaches its target across the clip
- Add `67js/addons/skeleton-pose`: clip layers for skinned rigs with joint masks and additive blending, two-bone IK with poles and aim IK with angle limits and shared chains, all seekable, with joints named by rig name or humanoid bone

## 0.12.0

- Add the recipe material field `pattern`: eleven seeded, tileable procedural surfaces (wood, planks, bricks, tiles, marble, stone, concrete, metal, rust, fabric, noise) that need no UVs, keep their real size under node scale, and can change while a scene is open
- Add periodic gradient, ridged and cellular noise for those patterns
- Close `extrude` solids whose holes have aligned edges: their caps left T-junctions, so the mesh was open and booleans refused it
- Let `mesh_inspect` take `geometry` as well as `geometries`, matching `mesh_edit` and `mesh_stack`
- Say in the MCP schema that `box` and `cylinder` are bevelled by default, and how to get exact sizes

## 0.11.0

- Add `67js/addons/grass`: terrain-following grass fields of clumped, curved blades with rounded normals, root-to-tip colour, dry patches, masks for paths, four presets and tile level of detail
- Bend `grass` tag vertices by blade height and roll wind gusts across the field as a travelling wave
- Break up grass fields with `patchiness` (short, thin and dense patches), seed `stalks` and folded blades, and let sunlight glow through backlit blades
- Add `67js/addons/clutter`: pebbles, chipped rocks with moss, twigs and fallen leaves scattered over terrain in streamed tiles, with four presets
- Share one tile and level-of-detail system between grass and clutter
- Add a `moss` layer to standard materials: its own rough, sheened, light-wrapping material with a sharp shading mask and a blurred cushion mask; clutter rocks use it
- Add splat `parallax` (default 0.03 m) for near-ground relief from the layer height maps
- Add splat `variation` (brightness and hue drift at three scales that grows with distance) and `edgeNoise` (ragged layer borders), both on by default
- Add `uv_unwrap` as a mesh edit and stack node: seams from an edge rule, automatic cuts until each island is a disk, least-squares conformal maps, axis charts for closed or stretched islands, area-even scaling and shelf packing into 0..1, with a report of islands, flipped triangles, area distortion and utilization
- Teach the `build-67js-scene` skill mesh modeling: a workflow, face and edge rules, tested recipes (crate, pillar, drum, bracket, bench row, planter, soap) and an error table; a test builds every recipe in the reference and requires a clean lint
- Shrink the MCP server bundle from 1,072 KB to 590 KB by keeping the scene engine out of it: capabilities and default limits now come from plain-data modules (`agent-scene-capabilities.js`, `mesh-operations.js`), and the MCP build fails if engine code returns; the npm archive drops from 1,003 KB to 887 KB
- Add `67js/addons/mesh`, a polygon mesh core for agent modeling: compact `MeshData` with attributes on point, edge, face and corner domains, a half-edge `EditMesh` with typed-array disk and radial cycles, `validateTopology`, conversion from renderer geometry with welding, quads and axis face tags, hard-edge corner normals, n-gon triangulation, render extraction and `lintMesh`
- Add semantic face selection and mesh edits (extrude region and individual, inset region and individual, delete, flip normals, translate with proportional falloff, merge by distance, tag) that tag the faces they create
- Add the recipe geometry type `mesh` (a base shape plus a replayable edit log) and the `mesh_edit` MCP tool, which appends or replaces edits atomically and reports each edit's result
- Add `loop_cut`: edge rings across quads picked by an edge rule (including `along` a direction), evenly spaced cuts or one cut at a factor, band tags, T-junction-free neighbours and interpolated UVs; and `alongNormals` for `extrude_face_region`, which extrudes rings and curved bands as one joined region
- Add edge `bevel` as a mesh edit and stack node: rim, angle, region-border or all-edge selection, width, segments, profile and overlap clamping, with sliding corners and smooth triangular patches where three rounded edges meet
- Add mesh booleans (union, difference, intersect) through Manifold WebAssembly as the `boolean` edit with an inline primitive cutter, tag transfer and polygon rebuilding; `manifold-3d` is an optional peer dependency, which the MCP runtime serves to its preview page when installed
- Add mirror, array and solidify as mesh edits and as a non-destructive modifier stack evaluated after the edits, with every prefix cached, and the `mesh_stack` MCP tool to set the stack or apply its first nodes into the edit log
- Report hollow cavities as valid in `lintMesh` instead of as inverted parts
- Add the `mesh_inspect` MCP tool: polygon counts, face sizes, parts, face tags, bounds and lint problems with suggested fixes for every recipe geometry

## 0.10.0

- Add `67js/addons/terrain` for seeded, chunked heightfields with distance level of detail and `heightAt` for placement
- Add `67js/addons/texture-set` with `loadTextureSet` and `loadLeafTextures`, and a four-layer splat material with slope, height and mask rules, height-blended edges, triplanar cliffs and anti-tiling
- Add `67js/addons/vegetation` for seeded trees, bushes, grass and flowers with real branches, Poisson-disk scattering, wind and three levels of detail
- Accept scanned bark (`barkTextures`) and scanned leaf cards with normal maps (`leafTextures`) on trees and scattered vegetation
- Add `67js/addons/spume` to play back liquid baked by the Spume solver, with refracting `liquid` and soft `foam` materials
- Add `67js/addons/vehicle` for path-driven wheel spin, steering, body roll, pitch and ground following
- Add `67js/addons/retarget` to move humanoid clips between Mixamo, VRM, Unreal and Rigify rigs and offset crowds
- Add `67js/addons/hdri` and environment maps for image-based lighting with roughness-blurred reflections
- Add alpha mask, alpha blend, opacity and double-sided materials, with alpha-to-coverage under MSAA
- Import Draco, meshopt and KTX2 compressed glTF assets, texture transforms and GPU instancing
- Let agent recipes author liquid, foam, glass and double-sided materials and liquid optics
- Let streamed parts such as liquid frames share a renderer with retained textured parts
- Reduce sky reflection on leaf and grass cards so grazing cards no longer turn grey-blue
- Serve the CC0 textures and HDRI from the site with open CORS, and credit Poly Haven and ambientCG
- Rewrite the README and add CONTRIBUTING.md

## 0.9.1

- Synchronize the roadmap and standalone command with the visual review release

## 0.9.0

- Add `scene_review` to compare up to four labeled camera, motion or imported clip samples in one PNG
- Preserve source recipes, revisions, preview poses, viewport dimensions and checkpoints through isolated reviews
- Bound review dimensions, image bytes, pending frames, sampled memory and private-render deadlines
- Restore the source preview after failed shots and release private renderers during connection closure
- Document the agent review workflow and verify independent shots through actual CPU-rendered pixel comparisons

## 0.8.1

- Refine the film scientist with integrated facial surfaces, inset eyes, swept hair and a shorter neck
- Add independent blink, brow, mouth and gaze channels with deterministic cues for each set
- Replace repeating actor motion with held poses and preserve shared geometry through backward seeks
- Verify eyelid coverage across the complete eye aperture and render isolated blink comparisons on CPU

## 0.8.0

- Add stable imported source-node IDs, hierarchy inspection and local joint overrides.
- Add authored joint, material and camera motion on imported GLBs with independent clip timing.
- Preserve decoded rigs, morphs and textures through staged pose transactions and failed-pose rollback.
- Verify a textured nine-joint astronaut through native MCP images, stills and video.

## 0.7.0

- Author bounded procedural motion in agent recipes with local node, material and camera tracks.
- Reuse linear, step, smooth and cubic interpolation with looping and absolute-time preview seeks.
- Validate the complete sampled pose before publishing transforms, material handles or camera changes.
- Preserve authored recipes, revisions, geometry identities and checkpoints during transient seeks.
- Sample procedural motion in PNG, still sequence and MP4 snapshot jobs while retaining the source preview pose.

## 0.6.0

- Add five MCP tools for asynchronous snapshot rendering, progress, cancellation, results and output release.
- Render one PNG, eight stills or a silent H.264 MP4 while preserving the source pose, revision and checkpoints.
- Retain bounded job records and verify completed artifact hashes when reopening the private store.
- Share the streamed FFmpeg encoder with the offline renderer and keep one pending frame.
- Prevent repeated MCP builds from embedding the browser preview in the Node server bundle.

## 0.5.0

- Add atomic agent commands for creating, removing and rebinding nodes and shared resources, with bounded checkpoint geometry ownership.
- Reconcile rigid untextured renderer topology while retaining unchanged batches and sharing immutable geometry buffers across draws.
- Ship the `67js-mcp` npm command with a prebuilt SDK server, browser preview and complete bundled dependency licenses.
- Add twelve MCP tools with strict scene schemas, persistent CPU/GPU previews and bounded PNG responses.
- Import local catalog GLBs with supported material maps, rigs, morphs and deterministic clip sampling.
- Retain authored lighting, volumetric fog, grading and directional shadow coverage across edits and checkpoints.
- Keep renderer sessions alive across edits and close owned browser resources when the MCP connection ends.
- Add optional agent scene sessions with stable IDs, shared geometry, revision checks, atomic edits and bounded checkpoints.
- Prioritize agent authoring, visual feedback and MCP integration in the implementation roadmap.

## 0.4.1

- Put installation on the homepage with npm, pnpm, Yarn and Bun controls.
- Replace the Downloads navigation tab with a legacy redirect to homepage installation.
- Expand the documentation with modeling, deformation, physics and surface workflows.

- Add retained rigid surface attachments that follow relative morphs, four-influence skinning and world transforms.
- Separate source package checks from published npm consumer checks with verified archive integrity.

## 0.4.0

- Add four-influence GPU skinning, relative position/normal morphs and glTF morph weight animation.
- Add camera paths, local lights and depth-clipped volumetric fog.
- Add optional recorded Rapier physics with contacts, joint limits and bounded motors.
- Add static sculpt brushes and projector-clipped surface patches with geometric clearance.
- Preserve opaque vertex colors, UVs and independent HDR emission in static GLB exports.

- Add bounded nearest-surface and directional shrinkwrap with counted queries, atomic output and shared normal reconstruction.
- Add owned, bounded BVH mesh queries for static surface contact, ray hits and validated closed-solid containment.
- Close primitive seams exactly in Float32 and validate detail counts before geometry allocation.
- Add retained scene hierarchy, pivots and atomic reparenting with world pose preservation.
- Add bounded lathe, extrusion with holes and bevels, and curve tube modeling through an optional addon.
- Add a lantern modeling study with textured materials, orbit controls and PNG capture.
- Add torus surface and cap UVs for textured materials.
- Add Hermite animation curves with explicit tangents and retained playback buffers.
- Add absolute-time clip mixing, weighted actions and crossfades with deterministic seeking.
- Import and render normal, metallic/roughness, occlusion and emissive texture maps.
- Count and release every material texture channel within the existing render budget.
- Add sphere UVs and preserve normal mapping across small atlas regions.
- Reuse instance normal matrices and reject GLB exports that would discard material maps.
- Keep orbital velocity continuous with fewer showcase keyframes.

## 0.3.3

- Smooth WALL·E assembly changes when visitors tap or drag the slider
- Pause driving during assembly changes and gradually resume after complete reassembly
- Add head tracking, articulated arms and claws, suspension and continuous forward caterpillar movement
- Keep the camera and shadows aligned with the moving robot
- Prevent trailer playback and delayed audio seeks from overriding timeline input
- Rebuild the trailer with detailed machinery, silhouettes, moving vehicles and practical lighting
- Add filtered terrain grain and surface relief without additional textures

## 0.3.2

- Add transparent render targets with MSAA coverage and continuous homepage animation.
- Showcase WALL·E with moving caterpillars and a slider that pauses driving until reassembly.
- Replace the short film with a 187-second Oppenheimer trailer study, 33 shots and 13 procedural sets.
- Enable HDR in the film player and extend bounded video exports to four minutes.
- Speed up video capture using high-quality JPEG frames while keeping PNG stills lossless.
- Add direct CDP capture, fast lossless PNG mode, automatic encoder preflight, stage timings and progress estimates.
- Simplify Downloads and unify the homepage, Docs and Downloads footer.


## 0.3.1

- Rebuild the homepage around the scene-to-film workflow and a real video showcase.
- Add searchable documentation, a plain-text guide and an AI agent entry point.
- Align site surfaces with CodePawl and add a transparent outline block logo and local SVG icons.
- Add WALL·E camera compositions, lighting presets, assembly playback and PNG capture.
- Add nature light presets and HDR grading, clockwork detail, appearance controls and frame capture.
- Build a timber footbridge with planks, fasteners, rails and a dedicated viewpoint in Silverwater valley.
- Replace the asset viewer placeholder with an imported clockwork GLB study.
- Reflow object controls below the canvas on mobile and allow studio navigation to wrap.

## 0.3.0

- Introduce deterministic keyframe animation and persistent instance updates.
- Add opt-in HDR, bloom and color grading with render budget accounting.
- Add orthographic cameras and a flat 2D scene viewer.
- Import bounded glTF/GLB assets with textures, vertex colors and rigid node animation through an optional addon.
- Export landscape, portrait and square media, including imported asset animation.
- Add motion and asset studios, implementation roadmap and graphics engine documentation.
- Keep the website package archive identical to the published npm archive.

## 0.2.4

- Publish changed versions through GitHub Actions and npm trusted publishing.
- Skip versions that already exist on the registry.

## 0.2.3

- Publish the package under the CodePawl organization as `@codepawlhq/67js`.

## 0.2.2

- Publish under `@codepawl_vn/67js` because npm rejects the unscoped name.
- Install with the local alias `67js` to preserve the short import path.

## 0.2.1

- Include the bundled gl-matrix copyright notice in package and browser downloads.

## 0.2.0

- Distribute the renderer as an installable ESM package with separate scene addons.
- Add a homepage with release metadata, installation instructions, downloads and previews.
- Separate small WALL·E components during explosion while preserving the assembled model.
- Synchronize the package, browser module and website version during each build.
- Host the site at `67js.codepawl.com` through Workers Static Assets.

## 0.1.0

- Add the object studio, interactive nature world and original 32-second film.
- Add anti-aliasing, instanced geometry and GLB export.
- Add bounded image and video exports for hardware WebGL and software rendering.
