# Release verification

## 0.4.0

The source validation used Windows Chrome, ANGLE D3D11 and an RTX 3060.
Publication and deployment require separate registry and live release checks.

| Check | Measured result |
| --- | --- |
| Node tests | 295 tests passed for the complete source before release preparation. |
| Consumer | The packed package imported every addon, including physics, mesh queries and shrinkwrap. |
| Shrinkwrap | All 1,617 source vertices matched the target in nearest and projection modes at landscape and portrait sizes. |
| GPU morph reuse | The computed projection and GPU morph endpoint produced identical pixels. Reverse seeks reproduced the original pixels without graphics errors. |
| Contact query | Both wrapped fixture meshes remained separate from the target in triangle surface queries. This does not certify arbitrary meshes. |
| Query work | Projection used 12,337 triangle callbacks after pruning, compared with 25,416 before pruning on the same fixture. |
| Nearest query | 96 queries on a 4,992-triangle fixture matched exhaustive scan distances and points exactly. |
| Build | The library, website and clean packed consumer passed. |

Nearest query timings were 45.07 ms for index construction and 9.40 ms for 96 queries.
An exhaustive scan took 33.43 ms for the same queries.
These fixture measurements do not prove a general performance advantage over Three.js.
Build the index once and reuse it.

Shrinkwrap accepts static geometry and preserves topology. Clearance applies at vertices and does not guarantee separation over entire triangles.
Physics recordings do not provide humanoid ragdoll binding. Transparent materials, compressed meshes and ray tracing remain unsupported.
The procedural scientist still needs a recognizable face and improved cinematic presentation.

## 0.3.3

These checks used Windows Chrome, ANGLE D3D11 and an RTX 3060.

| Check | Measured result |
| --- | --- |
| Node tests | 78 tests passed, including articulated joints, forward track contact, deterministic film motion and assembly interpolation. |
| Assembly | Native slider taps and interrupted transitions passed at 1440, 390 and 320 pixels. Driving remained paused until complete reassembly. |
| Motion preferences | Reduced motion snapped assembly to the selected position and kept driving paused. |
| Moving character | Head, arms and claws rendered correctly at four poses. Camera and shadow bounds followed the root at 120 seconds. |
| Film transport | Held pointer input, coalesced seeks, delayed audio, keyboard input and paused seeking passed. Real playback resumed without moving behind the selected time. |
| Terrain | Film sand and nature terrain compiled and rendered without WebGL errors. |
| Trailer | Sixteen inspected frames cover the rebuilt machinery, silhouettes, jeep, desert, night lighting and ignition. |
| Full export | 4,488 frames at 1280 × 720 and 24 FPS rendered in 110.13 seconds. The film lasts 187 seconds. |
| Memory | The export kept one pending frame. Peak renderer allocation was 84.34 MiB, observed Node RSS was 217.34 MiB and sampled browser heap was 19.42 MiB. |
| Delivery | FFprobe verified H.264, BT.709, 48 kHz stereo AAC and 187 seconds. The delivery file contains 22,729,620 bytes. |

The export used JPEG capture at quality 95 and NVENC encoding.
The browser player renders the same procedural scene directly through WebGL.
The downloadable file uses a lower bitrate to fit the hosting asset limit.
Its encoded Gadget closeup was inspected after compression.

Renderer estimates exclude driver memory and browser RSS.
The figures remain stylized silhouettes, without photorealistic character assets or recorded performances.

## 0.3.0

The package is `@codepawlhq/67js`, installed locally through the `67js` alias. The display name remains 67.js.

| Check | Measured result |
| --- | --- |
| Node tests | 64 tests passed, including ordered and reverse-index hierarchy limits, relative resource paths and negotiated sample reporting. |
| Consumer | A clean project installed the archive and imported the core plus all six addons. |
| HDR and effects | Hardware WebGL negotiated RGBA16F targets. Bloom and color grading changed pixel checksums without graphics errors. |
| Determinism | Out-of-order motion seeks reproduced exact pixel checksums. |
| Resource reuse | Eighty motion updates created zero additional buffers, textures, framebuffers or renderbuffers. |
| Standard assets | An imported GLB displayed two distinct base-color textures and reproduced absolute node animation seeks. |
| Views | Flat XY geometry and front, top, right and perspective model views rendered without graphics errors. |
| CPU | SwiftShader rendered the HDR motion scene and encoded a square 2D clip through libx264. |
| Video | Landscape and portrait motion exports each contain 144 H.264 frames over 12 seconds. Imported GLB animation contains 24 frames over two seconds. |
| Capture queue | Every tested video kept one pending frame and remained within its configured allocation estimate. |
| Regression | WALL·E assembly, layers, exports, benchmark pixel agreement, keyboard controls and context restoration passed. |
| Layout | New studios rendered at 1440, 390 and 320 pixels without horizontal overflow. |

The tested hardware was an RTX 3060 through ANGLE D3D11. Software rendering used Chrome ANGLE SwiftShader.
The allocation figures estimate renderer targets, geometry, textures and capture staging. They do not measure total driver VRAM or browser RSS.

The Codex review found three actionable issues: mismatched capture samples, unnormalized glTF resource URLs and hierarchy limits that depended on node ordering.
Constructor options now select capture samples, and sample reporting follows the negotiated allocation count.
Resource lookup normalizes URLs, and hierarchy validation visits roots before descendant nodes. Regression tests cover all three paths.
Claude reached its weekly limit on both review attempts. This release therefore has one-family source review, with weaker coverage than a completed cross review.

## Historical 0.2.0 checks

The early archive used the unscoped `67js` name before npm rejected that name. The scoped organization package supersedes it.

| Check | Measured result |
| --- | --- |
| Node tests | 24 tests passed, including all 574 detail offsets and unchanged assembled geometry. |
| Consumer installation | A clean temporary project installed the archive and imported the core and all three addons. |
| Package size | The archive contains code and documentation. It is below 100 KB and excludes preview media. |
| Browser download | A standalone module imported from a Blob URL and rendered a cube without graphics errors. |
| Slider | Assembly round trip, allocation reuse, layers and exploded GLB translations passed. |
| Homepage and guide | Rendered at 1440, 390 and 320 pixels without page overflow. |
| Deep link | The exploded preview opens the studio with the slider at 100%. |
| GPU preview | The 1440 × 900 export used four MSAA samples and reported no WebGL errors. |
| Cloudflare configuration | Wrangler's deployment dry run passed. |

The review covered the homepage, guide and object viewer against commit `32aa19c`.
It excluded generated bundles, lockfiles and binary images from source review.
Layout and accessibility checks covered native controls, focus styles, labels, release states and narrow views.
Screen-reader operation, RTL and browser zoom were not verified.
There were no remaining actionable interface findings within the inspected coverage.

The Codex API reviewer found that the browser download omitted shared chunks.
A separate, single-entry browser bundle fixed that issue. The downloaded-module check passed after the fix.
The Claude reviewer hit its weekly limit on both attempts.
This review therefore used one model family and provides weaker coverage than a completed cross review.

Release metadata is generated from the package version and Git commit.
Deployment requires a clean checkout and the same commit on `origin/main`.
The deployment script checks the live version, commit and package integrity after upload.
