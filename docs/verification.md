# Verification

The local run used Chrome 154 through Playwright and an NVIDIA RTX 3060 through ANGLE D3D11.
The raw benchmark results are in `benchmark.json`.

| Check | Result |
| --- | --- |
| Geometry winding, unit normals, indices and model bounds | Four Node tests passed, including export validation. |
| GLB export | The independent Three.js GLTFLoader loaded all 252 model nodes. |
| WebGL | No GL errors or browser console errors during the smoke. |
| Desktop | The rendered 1440 × 900 studio was inspected. |
| Mobile | The rendered 390 × 844 and 320 × 700 studio was inspected. |
| Controls | Finish, reset, keyboard orbit, normals, auto orbit and GLB download passed. |
| Recovery | Context loss and restoration passed. |
| Benchmark output | All four renderers matched the reference image above 99.99% of channels. |
| Production build | Vite built successfully. |

The interface review covered the new studio and its controls.
The first mobile render overlapped the model and controls. A separate mobile canvas region fixed the overlap.
The selected finish swatch initially lost its fill. A specific selected-swatch rule fixed that state.
Both repaired states were checked in the subsequent rendered smoke.

Keyboard controls use native elements, visible focus styles and explicit labels.
Screen-reader behavior, 200% browser zoom and a formal contrast audit were not verified.
The benchmark measures CPU submission only. GPU timing and visual parity with Blender remain unverified.
