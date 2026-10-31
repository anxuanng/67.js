# Agent lighting and look

This feature is included in npm release `0.5.0` and later.

Agent scene recipes can contain `environment`, `effects`, and `shadow` objects.
These fields belong to canonical recipes and checkpoint snapshots.
Look commands use the same atomic revision checks as node and material commands.
Failed look validation preserves the previous recipe and revision.

The optional helper `normalizeAgentLook({ environment, effects, shadow })` returns detached, fully normalized JSON.
It fills omitted fields without mutating the input.
`resolveAgentShadow(shadow, lightDirection)` returns detached renderer bounds with `eye`, `target`, `up`, `extent`, `near`, and `far`.
The helpers do not create geometry, render targets, or GPU resources.

```js
import { normalizeAgentLook, resolveAgentShadow } from '67js/addons/agent-scene';

const look = normalizeAgentLook({
  environment: {
    world: true,
    lightDirection: [-0.6, 1, 0.2],
    keyIntensity: 0.8,
    pointLights: [{ position: [0, 2, 1], color: [1, 0.6, 0.3], intensity: 12 }],
    volumeFog: { density: 0.02, minimum: [-4, 0, -4], maximum: [4, 4, 4] },
  },
  effects: { exposure: 1.2, bloom: { strength: 0.25 } },
  shadow: { target: [0, 1, 0], extent: 5, distance: 10, far: 24 },
});

const shadowBounds = resolveAgentShadow(look.shadow, look.environment.lightDirection);
```

The renderer uses `effects.exposure` as `frame.exposure`.
The remaining effect controls belong to `frame.effects`.
The environment's `world` flag selects the renderer's world presentation.
Look normalization always supplies the authored key color, including in world mode.

The MCP adapter applies the canonical look on every draw. A custom browser adapter must pass it explicitly:

```js
const renderer = new Renderer67(canvas, scene.parts, {
  ground: false, hdr: true, depth: true,
  world: scene.environment.world,
  environment: scene.environment,
  shadowBounds: resolveAgentShadow(scene.shadow, scene.environment.lightDirection),
});

function draw() {
  renderer.world = scene.environment.world;
  renderer.shadowBounds = resolveAgentShadow(scene.shadow, scene.environment.lightDirection);
  renderer.shadowsDirty = true;
  renderer.resize();
  renderer.updateParts(scene.parts);
  renderer.render({
    ...scene.camera, environment: scene.environment, effects: scene.effects,
    exposure: scene.effects.exposure, time: 0,
  });
}
```

For a frame loop, update shadow bounds and mark shadows dirty only when projector controls or geometry change.
Use `replaceParts` when `topologyRevision` changes, as described in the scene guide.

## Atomic look commands

| Operation | Payload |
| --- | --- |
| `set-environment` | `{ environment: partialEnvironment }` |
| `set-effects` | `{ effects: partialEffects }` |
| `set-shadow` | `{ shadow: partialShadow }` |

Each operation also contains its `type` discriminator.
Omitted fields retain their current canonical values.
Nested `volumeFog` and `bloom` objects merge their supplied fields.
Vector arrays replace their previous vector.
The complete `pointLights` list replaces the previous list, including `[]` to remove all point lights.
Final merged look fields pass normalization before any command publishes.

```js
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-environment', environment: { keyIntensity: 0.4, volumeFog: { density: 0.03 } } },
  { type: 'set-effects', effects: { exposure: 1.4, bloom: { threshold: 1.5 } } },
  { type: 'set-shadow', shadow: { extent: 7 } },
], { expectedRevision: scene.revision });

scene.apply([
  { type: 'set-environment', environment: { pointLights: [] } },
], { expectedRevision: scene.revision });

scene.restore(checkpoint, { expectedRevision: scene.revision });
scene.releaseCheckpoint(checkpoint);
```

The helper normalizes a complete candidate rather than merging patches itself.
Session and transport adapters own patch merging and renderer updates.
Checkpoint restore recovers canonical lighting, effects, and shadow controls with the rest of the scene.

## Environment

All numeric values must be finite and representable as Float32.
RGB arrays contain exactly three numbers.
Key light, point light, and fog colors use linear RGB.
Sky colors use display RGB, matching the renderer's existing environment contract.

| Field | Default | Range or meaning |
| --- | --- | --- |
| `world` | `false` | Boolean world presentation flag |
| `lightDirection` | `[-3, 6, 4]` | Components within ±1000000, length at least `0.000001` |
| `keyColor` | `[5.2, 4.7, 4.1]` | Components from `0` to `1000` |
| `keyIntensity` | `1` | `0` to `100` |
| `fillIntensity` | `1` | `0` to `100` |
| `ambientIntensity` | `1` | `0` to `100` |
| `daylight` | `1` | `0` to `100` |
| `pointLights` | `[]` | At most eight point light records |
| `skyTop` | `[0.2, 0.38, 0.52]` | Components from `0` to `1` |
| `skyBottom` | `[0.62, 0.7, 0.67]` | Components from `0` to `1` |
| `fogColor` | `[0.35, 0.43, 0.43]` | Components from `0` to `1` |
| `fogDensity` | `0.006` | `0` to `10` |
| `volumeFog` | Complete defaults below | One bounded world volume |

Directional key radiance equals `keyColor * keyIntensity`.
Zero intensity disables that lighting contribution.
Direction magnitude remains in the canonical recipe.
The shadow projector uses its normalized direction, so changing only magnitude does not change shadow placement.
High radiance can clip at the renderer's half-float HDR target limit of `65504` before bloom and tone mapping.

## Point lights

Each point light requires a world-space `position`.
The renderer uses inverse-square attenuation outside its radius.
Radius limits attenuation rather than creating an area emitter or softening shadows.
Point lights currently cast no local shadows and do not scatter through volume fog.

| Field | Default | Range |
| --- | --- | --- |
| `position` | Required | Three components within ±1000000 |
| `color` | `[1, 1, 1]` | Linear RGB components from `0` to `1` |
| `intensity` | `1` | `0` to `100000` |
| `radius` | `0.05` | `0.001` to `1000000` |
| `range` | `0` | `0` for unlimited falloff, otherwise `0.001` to `1000000` |

Range values between zero and `0.001` reject.
The existing directional shadow map remains the source of shadows.
Point lights can illuminate through opaque walls.

## Volume fog

Active volume fog requires an opaque renderer with `{ hdr: true, depth: true }` and negotiated HDR support.
The volume uses resolved opaque depth and directional scattering with the directional shadow map.
Density zero disables the volume.
These controls reuse `resolveVolumeFog` and its existing domain rules.

| Field | Default | Range |
| --- | --- | --- |
| `density` | `0` | `0` to `10` |
| `minimum` | `[-100, 0, -100]` | Three components within ±100000 |
| `maximum` | `[100, 20, 100]` | Three components within ±100000, strictly above minimum after Float32 rounding |
| `color` | `[0.8, 0.85, 0.9]` | Linear RGB components from `0` to `1` |
| `ambient` | `[0.03, 0.035, 0.04]` | Linear RGB components from `0` to `10` |
| `drift` | `[0.03, 0, 0]` | Three components within ±100 |
| `steps` | `16` | Integer from `8` to `48` |
| `anisotropy` | `0.3` | `-0.9` to `0.9` |
| `noiseAmount` | `0.5` | `0` to `1` |
| `noiseScale` | `0.3` | `0.001` to `100` |
| `maxDistance` | `100` | `0.01` to `10000` |

Fog bounds reject dimensions that collapse after Float32 rounding.
The current volume supports one directional scattering source.
Local point scattering, transparent depth, multiple scattering, and multiple volumes remain outside this contract.
See [volume fog](https://67js.codepawl.com/volumetric.md) for renderer requirements and frame-time limits.

## Effects

The controls reuse `resolveEffects` with a preview bloom strength of `0.12`.
Exposure remains independent and maps to `frame.exposure`.
Bloom strength zero disables bloom.

| Field | Default | Range |
| --- | --- | --- |
| `exposure` | `1` | `0.01` to `16` |
| `saturation` | `1` | `0` to `2` |
| `contrast` | `1` | `0.1` to `2` |
| `temperature` | `0` | `-1` to `1` |
| `vignette` | `0` | `0` to `1` |
| `grain` | `0` | `0` to `0.1` |
| `bloom.strength` | `0.12` | `0` to `2` |
| `bloom.threshold` | `1` | `0` to `10` |
| `bloom.radius` | `1` | `0.1` to `4` |

## Directional shadows

Shadow controls define an orthographic projector aligned with the current light direction.
The derived eye equals `target + normalize(lightDirection) * distance`.
The projector uses up vector `[0, 0, 1]` when the absolute normalized Y component exceeds `0.99`.
Other directions use `[0, 1, 0]`.
This avoids a collinear camera up vector for vertical lights.

| Field | Default | Range |
| --- | --- | --- |
| `target` | `[0, 1, 0]` | Three components within ±1000000 |
| `extent` | `3.5` | `0.01` to `100000`, half-width and half-height |
| `distance` | `8` | `0.01` to `1000000` |
| `near` | `0.1` | `0.001` to `1000000` |
| `far` | `15` | `0.001` to `1000000`, above near after Float32 rounding |

The derived eye and target must remain distinguishable at Float32 precision.
View, projection, and combined matrices must remain finite and nonsingular at Float32 precision.
Large targets and short distances can fail these combined checks even when each field fits its individual range.
Derived projectors do not automatically fit scene or fog bounds.

## Validation boundary

Every object rejects unknown keys.
Inputs must contain ordinary plain JSON objects and dense arrays without extra fields or hidden properties.
Accessors, executable values, cyclic references, typed arrays, and nonfinite numbers reject.
The helpers return independent arrays, including volume defaults.
JSON nesting has a maximum depth of 32, and look arrays have at most eight entries.

| Design | Benefit | Cost |
| --- | --- | --- |
| Forward raw renderer environment and postprocess options | Direct access to every renderer field | Defaults and validation vary across adapters |
| Normalize a bounded JSON look before publication | Canonical defaults, replay, atomic validation, and one derived shadow direction | Explicit field vocabulary |

The helper normalizes bounded JSON while reusing the engine's lighting, effects, and volume validators.
Session and transport code remain responsible for revisions, patches, checkpoint ownership, and rendering.
