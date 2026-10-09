# Render jobs

Release `0.6.0` includes five MCP tools for asynchronous image and video rendering.

## Agent workflow

1. Install `67js` with `npm install 67js@npm:@codepawlhq/67js@0.7.0`.
2. Launch `npx 67js-mcp --backend cpu --jobs C:/projects/my-scene/render-jobs`.
3. Create a scene and inspect its current revision.
4. Submit `scene_render_submit` with the session ID, current revision and render settings.
5. Poll `scene_render_status` until the job reaches a terminal state.
6. Read `scene_render_result` after completion to obtain output paths and SHA-256 hashes.
7. Release unwanted outputs with `scene_render_release`.

For MP4 jobs, FFmpeg must be on PATH or configured with `--ffmpeg` and an absolute executable path.
The job store must be private, absolute and dedicated to this runtime.
The store records UUIDs that `scene_capabilities` lists after a restart.

```json
{
  "sessionId": "<session UUID>",
  "expectedRevision": 0,
  "settings": {
    "kind": "video", "width": 640, "height": 360,
    "fps": 24, "duration": 3,
    "animation": { "clip": 0, "start": 1 },
    "rendererTime": { "start": 0, "rate": 1 }
  }
}
```

The runtime captures the source recipe and verified asset bytes before returning a job ID.
The job uses a separate browser page and temporarily leases the single renderer.
Preview rendering and edits pause during a job. Inspection and recipe export remain available.
The source revision, pose and checkpoints survive completion or cancellation.
Cancellation becomes terminal after the owned encoder and job page stop and the preview recovers.

Video uses CPU H.264 encoding, even dimensions and one streamed frame at a time.
The render backend can use GPU or CPU. Memory limits can reduce the actual output dimensions.
Results report actual dimensions and measured timings. They do not embed video bytes or include audio.

Release `0.7.0` samples recipe-owned [procedural motion](agent-motion.md) with `settings.motion: { start: 0 }`.
Job frames use `start + elapsed`. Omission holds the initial motion pose.
Nonlooping samples must fit the motion duration. Looping samples wrap and remain bounded by 3600 absolute seconds.

Creation and edits author tracks through scene recipes and `set-motion`, before job submission.
Static recipes remain static unless a shader uses renderer time.
Imported clips retain separate absolute sampling through `settings.animation`.

## Controller API

This module provides persistent job records around a trusted render callback.
It does not launch a browser, sample animation, encode video, or register MCP tools.
The runtime integration owns those operations.

The controller accepts one active job and rejects additional submissions until that job settles.
It copies the recipe, clip metadata, settings, and asset Buffer before asynchronous admission begins.
Asset recipes must bind their copied bytes through the recipe's SHA-256 `assetId`.
The controller never modifies the source scene or its revision.

## API

```js
import { createAgentRenderJobs } from '../scripts/agent-render-jobs.mjs';

const jobs = await createAgentRenderJobs({
  root: absoluteJobDirectory,
  run: async ({ jobId, directory, snapshot, settings, signal, progress }) => {
    // The runner writes render.mp4.partial inside directory.
    // It checks signal and stops its owned browser and encoder on abort.
    await progress({ frames: settings.frameCount, maximumPendingFrames: 1 });
    return {
      artifacts: [{
        temporary: 'render.mp4.partial',
        filename: 'render.mp4',
        mimeType: 'video/mp4',
      }],
      metrics: { maximumPendingFrames: 1 },
    };
  },
});

const submitted = await jobs.submit({
  sourceRevision: 7,
  snapshot: {
    recipe: canonicalRecipe,
    assetBytes: immutableAssetBuffer,
    clips: [{ duration: 5 }],
  },
  settings: {
    kind: 'video', width: 640, height: 360,
    fps: 24, duration: 3,
    animation: { clip: 0, start: 1 },
    rendererTime: { start: 0, rate: 1 },
  },
});

const status = jobs.status(submitted.jobId);
const acknowledgement = jobs.cancel(submitted.jobId);
await jobs.close();
```

| Method | Result |
| --- | --- |
| `submit(input)` | Promise of a queued job record after snapshot persistence |
| `status(jobId)` | Detached current record |
| `list()` | Detached retained records, including recovered jobs |
| `cancel(jobId)` | Immediate record with `cancelling`, or an existing terminal state |
| `result(jobId)` | Completed artifact metadata and metrics without arbitrary paths |
| `release(jobId)` | Promise of release confirmation for a settled terminal job |
| `close()` | Promise that aborts work, waits for settlement, and releases store ownership |

`settings.frameCount` contains 1 for images, 8 for stills, or `ceil(duration * fps)` for video.
The defaults are 24 fps and one second.
Images sample `animation.start` without requiring the default duration to fit the clip.
Stills and videos require the entire requested animation range to fit the selected clip.
Renderer time defaults to `{ start: 0, rate: 1 }` and remains separate from animation sampling.

`progress(update)` accepts monotonic `frames` and a `maximumPendingFrames` value of zero or one.
It returns a Promise for the corresponding status write.
Runner metrics must contain finite JSON within 64 KiB.

## Runner ownership

| Kind | Required output names | MIME type |
| --- | --- | --- |
| `image` | `render.png.partial` | `image/png` |
| `stills` | `frame-0.png.partial` through `frame-7.png.partial` | `image/png` |
| `video` | `render.mp4.partial` | `video/mp4` |

The runner returns every required artifact with its temporary filename, final filename, and MIME type.
Final filenames omit `.partial`.
The controller checks names, regular-file ownership, byte limits, and SHA-256 hashes before publication.
It hashes through a stream rather than loading the complete video into memory.
It renames outputs only after callback success and cancellation checks.
The completed result becomes visible after its status record persists.

The runner must enforce capture memory limits, frame byte limits, and encoder backpressure during execution.
The controller checks PNG artifact sizes and completed MP4 sizes.
It cannot measure transient video frame buffers or prevent an arbitrary callback from writing excess bytes before returning.
The runner must write only the documented partial files inside its assigned directory.

## States and cancellation

Normal execution follows `queued`, `running`, `finalizing`, and `completed`.
Cancellation follows `cancelling` and `cancelled` after the callback settles.
Deadline expiration aborts the callback and ends with `failed` after settlement.
Callback errors and output validation failures also produce `failed`.
Unfinished records from an earlier process become `interrupted` during recovery.
Recovery does not restart rendering.

`cancel()` aborts the signal immediately and does not wait behind rendering or disk persistence.
The runner must interrupt capture, encoder drain, and encoder finalization waits when aborted.
`close()` waits at most five seconds for a cancelled callback to settle.
If the callback remains active, `close()` rejects and keeps the store locked.
A later `close()` can release the lock after the callback settles.
An in-process controller cannot force an arbitrary callback to stop.

## Persistence and limits

The root must be an explicit absolute directory.
A store marker and exclusive process lock distinguish owned job storage from foreign files.
Each UUID directory contains an ownership marker, JSON snapshot, status record, and optional `asset.glb`.

Admission writes those files in a reserved `.pending-<storeId>-<jobId>` directory before renaming it to the published UUID.
No active job exists until that rename succeeds.
Interrupted or failed admissions remain quarantined, count toward the byte budget, and do not become jobs.
Reopening preserves their files, including malformed JSON and foreign regular files, so older completed results remain accessible.
Only verified empty pending directories are removed automatically.

The controller rejects links, file aliases, unknown filenames, foreign directories, and persisted path traversal.
It verifies completed artifact hashes when reopening a store.
It removes files individually during release, without recursive deletion.

The lock protects cooperating controller processes.
The filesystem must remain private to the owner while jobs run.
It does not isolate an arbitrary callback or hostile concurrent filesystem writer.

Malformed published job records require repair before the controller can reopen the store.
Quarantined admissions need explicit inspection and cleanup to reclaim their space.
Their directories must contain regular files without links or aliases. Other entry types require repair.

The controller never removes a dead process's lock automatically.
After a crash, confirm that no process owns the dedicated private store before manually removing `store.lock`.
This conservative repair step prevents two recovery processes from deleting a newly acquired lock.

| Budget | Default |
| --- | --- |
| Retained records | 32 |
| Total store bytes | 512 MiB |
| Combined output bytes per job | 128 MiB |
| PNG artifact bytes | 1 MiB each |
| Snapshot JSON | 1 MiB |
| Asset bytes | 16 MiB |
| Dimensions | 64 to 1024 pixels each |
| Video frame rate | 1 to 30 fps |
| Duration | 0.1 to 30 seconds |
| Maximum video frames | 900 |
| Still frames | 8 |
| Job elapsed deadline | Five minutes |
| Close settlement deadline | Five seconds |

The controller rejects odd MP4 dimensions.
Admission reserves the maximum output budget plus snapshot and metadata space.
The optional `limits` object can reduce controller budgets for bounded tests.
It cannot increase production limits.
Partial files count toward the store budget and remain until explicit release.

## CPU checks

1. Run `node --test tests/agent-render-jobs.test.js`.

The tests use actual temporary files and controlled callbacks.
They cover snapshots, persistence, hashes, cancellation, deadlines, restart recovery, quotas, path rejection, and file aliases.
The tests do not run browsers, ffmpeg, or GPU rendering.
