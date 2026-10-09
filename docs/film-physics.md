# Physics in the trailer

The opening apparatus shot now includes a five-ball cradle driven by recorded rigid-body contacts and revolute joints.
This exists in the source checkout and next build. Published package `0.3.3` and the deployed film do not include it yet.

## Authoring and playback

`src/film-physics-definition.js` owns the bodies, colliders, anchors and bake options. It uses a 480 Hz timestep for eight simulated seconds.
`scripts/bake-film-physics.mjs` samples the result into existing translation and rotation tracks at 30 Hz.
`src/film-physics-clip.json` stores these tracks with the solver version, definition hash and timeline byte count.
The generated file is committed so playback does not load or run Rapier in the browser.

The film uses the existing animation player to sample absolute time. Ball matrices keep their identities while suspension cords follow their recorded centers.
Later samples clamp to the last recorded pose. This recording does not loop or restart across subsequent apparatus shots.

## Regenerate

The bake command overwrites `src/film-physics-clip.json`. Keep the definition and generated recording in the same change.

1. Run `node scripts/bake-film-physics.mjs` from the repository root.
2. Run `node --test tests/film-physics.test.js`.
3. Render the opening shot and inspect the contacts, strings and support clearance.

The tests compare every captured pose against a fresh Rapier bake.
They also remove ball contacts and verify that the initially stationary end ball no longer moves.
Recorded playback reproduces earlier matrices after a backward seek.

## Cost and physical limits

The bake records six bodies across 3,841 simulation frames, using exactly 645,288 timeline bytes.
The browser receives 2,410 animation keys for five visible balls rather than this full solver timeline.
The JSON source is about 249 KB before library minification and compression. Browser object storage costs more than packed Float32 pose storage.
The recorder releases its solver world after the bake. Rapier's shared WASM capacity remains resident in the authoring process.

This is a visual contact study with a small gap between balls, not an exact lossless Newton cradle.
The solver uses rigid spheres, hinges, restitution and damping. It does not simulate string elasticity or air drag.
The visible frame clears the recorded swing envelope and is not a collider.
Thirty-frame-per-second translation interpolation can slightly change contact separation between captured poses.

The shot demonstrates integrated physical action, but does not complete humanoid ragdolls, cloth, actor contact or cinematic character quality.
