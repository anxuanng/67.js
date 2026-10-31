# Oppenheimer: a 67js trailer study

This 187-second procedural reconstruction follows the visual structure of [Universal Pictures’ Oppenheimer New Trailer](https://www.youtube.com/watch?v=uYPbbksJxIg).
The study uses 33 authored cuts across 13 sets, rendered through the actual 67js WebGL engine.
All geometry, camera moves and motion come from the scene code.
The output contains no source footage, dialogue or soundtrack.

## Visual direction

The visual language combines dark mechanical closeups, window silhouettes, desert scale and a final night test.
Figures use continuous head and coat meshes with adult proportions, presented as graphic silhouettes.
They do not reproduce the actors’ faces.
The terrain has a contoured surface, broken mountain ridges, scattered shale and dry sage stems.
The shared terrain shader adds restrained surface detail.

The Gadget uses curved individual leads, connector sockets, labels, bolts and a moving suspension assembly.
The laboratory uses narrow valve filaments and grid hoops instead of glowing solid tubes.
The jeep has separate tires, hubs, fasteners, fenders, seats and a steering assembly.
Night work lights keep the tower readable before the detonation.

## Shot timeline

| Seconds | Set | Composition and action |
| --- | --- | --- |
| 0 to 7 | `apparatus` | A slow move across the machined iris and its illuminated rim. |
| 7 to 13 | `control` | Meter needles and pilot lights establish the control circuit. |
| 13 to 20 | `apparatus` | The wider pressure chamber reveals collars, bolts and copper feedthroughs. |
| 20 to 29 | `office` | A fedora silhouette stands against the slatted office windows. |
| 29 to 34 | `sparks` | Heated particles travel outward through a dark volume. |
| 34 to 39 | `laboratory` | A low laboratory move reveals valve grids and thin glowing filaments. |
| 39 to 45 | `desert` | The test tower sits small against the mountain horizon. |
| 45 to 56 | `settlement` | A forward move follows the research town street. |
| 56 to 64 | `settlement` | A low camera tracks the moving jeep and its suspension vibration. |
| 64 to 73 | `settlement` | Two distant silhouettes place the machinery at human scale. |
| 73 to 85 | `office` | A monochrome office angle returns to the isolated figure. |
| 85 to 91 | `waves` | Metallic ripple crests spread across a dark reflecting pool. |
| 91 to 98 | `atom` | Rotating filaments cross a field of luminous dust. |
| 98 to 105 | `gadget` | The suspended Gadget reveals its terminals, taped labels and curved cables. |
| 105 to 110 | `office` | A monochrome silhouette interrupts the mechanical sequence. |
| 110 to 118 | `desert` | A rising tower angle approaches the suspended vessel. |
| 118 to 126 | `gadget` | A closer lateral move follows the Gadget wiring and its slow pendulum motion. |
| 126 to 133 | `laboratory` | The laboratory returns through a second camera angle. |
| 133 to 140 | `control` | Meter needles and signal lamps tighten the countdown. |
| 140 to 145 | `desert` | A low tower view emphasizes the steel structure above the desert. |
| 145 to 154 | `portrait` | A figure watches the distant tower from the foreground. |
| 154 to 161 | `night` | The night tower appears through its practical work lights and ground signals. |
| 161 to 165 | `portrait` | The fedora silhouette fills the foreground before the final cuts. |
| 165 to 168 | `control` | The camera approaches the firing control. |
| 168 to 170 | `gadget` | An extreme Gadget detail holds on the wiring. |
| 170 to 172 | `sparks` | Accelerating particles interrupt the countdown. |
| 172 to 174 | `night` | A short night insert approaches the tower platform. |
| 174 to 176 | `office` | The monochrome figure returns for one final interruption. |
| 176 to 178 | `control` | The controls complete the mechanical countdown. |
| 178 to 179.5 | `sparks` | A brief particle burst leads into darkness. |
| 179.5 to 181 | `night` | The wide night tower holds before ignition. |
| 181 to 184 | `ignition` | The volumetric fireball expands before the title begins at 183.3 seconds. |
| 184 to 187 | `ignition` | The title holds over the fireball before the terminal fade. |

## Deterministic playback

`FILM_DURATION` remains 187.
`FILM_SHOTS` owns the camera endpoints and cut boundaries.
`createFilmScenes()` constructs shared meshes and retained part identities.
`sampleFilm(seconds)` returns the camera, set, local time, grade, fade, flash, explosion progress and title state.

Each animated set resets its retained matrices from fixed bases before sampling its motion.
Backward seeking therefore produces the same geometry state as forward playback.
Motion includes the Gadget suspension, meter needles, pilot lights, jeep travel, ripple crests, rotating filaments and particles.
Only the active set owns GPU resources.

Ignition begins at 181 seconds and reaches full volume by 182.7 seconds.
The title begins at 183.3 seconds, after the fireball has an unobstructed moment.
The final frame is black at 187 seconds.

## Render evidence

The final keyframe captures use hardware WebGL on an RTX 3060, HDR and four MSAA samples at 1280 × 720.
The eight standard samples cover the office, town, jeep, Gadget, tower, silhouette, night test and ignition.
Eight supplemental samples cover the iris, controls, sparks, laboratory, ripples, atomic filaments, close silhouette and title.
The reports record no browser errors or WebGL errors.

The measured set maximum is 1,347 parts and 390,128 submitted triangles.
The highest shared geometry count is 11.
The renderer allocation estimate stays below 85 MiB at these capture settings, within the configured 384 MiB target budget.
This estimate does not measure total driver or browser memory.

The local evidence is in `artifacts/astra-trailer/final/contact.png`, `details-contact.png` and the adjacent JSON reports.
The six film tests cover cuts, finite camera samples, camera continuity, geometry budgets, deterministic motion and outward coat surfaces.

## Reproduction

1. Run `node --test tests/film.test.js`.
2. Run `node scripts/render-media.mjs --kind stills --scene film --backend gpu --preset balanced --output artifacts/film-review/frame.png`.

This is an unofficial stylized reconstruction study.
The figures, architecture and materials remain procedural, without photorealistic character assets or recorded performances.
