# Website and showcase verification

## 0.3.1

The site uses CodePawl's neutral light/dark surfaces, focus colors and rounded panels. The 67.js mark is a transparent outline block. Navigation icons are local SVGs.

The documentation interface reads `docs/guide.md`. Release preparation copies that source into the plain-text download. The site also serves `llms.txt` for models and agents. The package includes the guide and both scene/media skills.

Measured checks:

- 64 Node tests passed, including scene bounds, geometry winding, animation and render budget checks.
- The site check exercised nine routes at 1440, 390 and 320 pixels. No horizontal page overflow remained.
- Mobile object and nature controls stayed below their canvases. Titles stayed above the canvases.
- Documentation search, empty results and topic anchors worked.
- Object compositions, lighting, PNG export and assembly playback worked. Reduced motion used a static assembly toggle.
- Motion looks, portrait framing, deterministic seeking and PNG export worked.
- Nature lighting presets worked. Existing wind, viewpoints, detail, water ripples and keyboard controls passed regression checks.
- The object regression covered layer switching, exploded exports, resource reuse, context restoration and keyboard orbit.
- Landscape and portrait H.264 films each contain 288 frames over 12 seconds at 24fps. Export kept one pending frame.
- Seven gallery WebP previews total 297880 bytes. Their source PNGs remain available separately.

Interface review covered the changed homepage, documentation, object and nature studios, and the shared navigation in the motion studio. Generated bundles and binary media were excluded from source review. Rendered review found wrapping navigation, a swatch override and controls overlapping mobile content. These causes were corrected and checked again.

Layout and native keyboard/control semantics were checked. Screen-reader operation, RTL, 200% browser zoom and formal contrast measurement were not verified. Typography, writing and color were checked only within the edited sources and rendered states. This is not a full accessibility certification.

The motion film used hardware WebGL and NVENC on an RTX 3060. Reported graphics allocations are estimates. They do not measure total browser RSS or driver VRAM.
