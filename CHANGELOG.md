# Changelog

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
