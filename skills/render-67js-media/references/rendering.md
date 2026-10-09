# Rendering commands

Run these commands from the repository root.

```powershell
node scripts/render-media.mjs --kind image --scene nature --backend gpu --preset high --output artifacts/nature.png
node scripts/render-media.mjs --kind image --scene object --backend cpu --preset cpu --output artifacts/object-cpu.png
node scripts/render-media.mjs --kind stills --scene film --backend gpu --preset balanced --output artifacts/stills/frame.png
node scripts/score.mjs
node scripts/render-media.mjs --kind video --scene film --backend gpu --preset balanced --encoder gpu --output artifacts/critical.mp4
```

The available scenes are `object`, `nature`, `film`, `motion`, `view2d` and `assets`.
GPU rendering selects hardware WebGL through Chrome. CPU rendering requests ANGLE SwiftShader.
The CPU exporter verifies that the selected backend reports SwiftShader.

| Preset | Dimensions | Samples | FPS | Target budget |
| --- | --- | ---: | ---: | ---: |
| `preview` | 960 × 540 | 2 | 24 | 256 MiB |
| `balanced` | 1280 × 720 | 4 | 24 | 384 MiB |
| `high` | 1920 × 1080 | 4 | 24 | 512 MiB |
| `cpu` | 640 × 360 | 1 | 12 | 192 MiB |

The memory planner includes color/depth targets, resolve storage, staging frames, shadows and uploaded geometry.
The browser context remains an additional allocation outside that estimate.
The offline exporter uses one capture frame at a time.
It disposes the previous scene before uploading the next scene.

`--memory` controls the target budget. `--width`, `--height`, `--fps` and `--duration` override preset values.
For object images, `--assembly 1` explodes the model. The default value `0` assembles it.

Each option requires a value. Dimensions range from 64 to 4096 pixels.
Memory ranges from 32 to 1024 MiB. Duration ranges from 0.1 to 120 seconds.

The video encoder can use `--encoder cpu` or `--encoder gpu` independently of the renderer backend.
The hardware encoder requires NVENC. A failed encoder stops the export and reports its error.
The renderer does not silently replace a failed hardware export with a lower-quality output.

`scripts/score.mjs` generates the original film score.
The `--audio <path>` option selects an existing score.
Only `film` selects the CRITICAL score automatically.
Do not use movie dialogue, footage or music without authorization.

```powershell
ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,r_frame_rate,nb_read_frames,color_space:format=duration,size -of json artifacts/critical.mp4
```

Inspect the sidecar `<output>.json` for backend, estimated allocation, process memory, frame queue and graphics errors.
The process guard stops Node above 512 MiB and sampled browser JavaScript heap above 256 MiB.
Heap samples do not establish peak browser RSS or total VRAM use.

## Animation, shorts and assets

```powershell
node scripts/render-media.mjs --kind video --scene motion --aspect portrait --backend gpu --encoder gpu --output artifacts/short.mp4
node scripts/render-media.mjs --kind image --scene view2d --aspect square --backend cpu --preset cpu --output artifacts/poster.png
node scripts/render-media.mjs --kind video --scene assets --asset model.glb --start 0 --duration 2 --output artifacts/model.mp4
```

`--aspect` accepts `landscape`, `portrait` or `square`. Explicit width and height override preset dimensions.
`--start` selects the first video sample. A scene duration limits the selected range.
`--asset` accepts a local GLB of at most 32 MiB and requires `--scene assets`.
The importer reports unsupported features before capture.

A reusable viewer exposes `window.__scene = { renderer, renderAt, duration, pause }`.
The exporter prioritizes this interface and samples absolute scene time.
The JSON report includes negotiated HDR and MSAA capabilities, alongside estimated allocation.
