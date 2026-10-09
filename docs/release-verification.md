# Release verification

The 0.2.0 release uses the package name `67js`. The display name remains 67.js.

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
