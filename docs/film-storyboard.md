# CRITICAL

`CRITICAL` is an original 32-second short rendered from procedural 3D geometry in 67.js.
The film moves from intimate scientific detail through an ignition to an empty, scorched landscape.
Its visual motifs include machined metal, intersecting atomic orbits, interference waves, an isolated tower, fire, and smoke.
The film contains no copied footage, dialogue, music, logos, or claims of official affiliation.

## Timeline

| Seconds | Set | Image and camera | Grade |
| --- | --- | --- | --- |
| 0 to 5 | `apparatus` | A close view of the optical aperture withdraws to reveal the pressure chamber, fasteners, copper pipes, and ceramic feedthroughs. | Cool metal with one amber filament. |
| 5 to 10 | `atom` | The camera arcs around a clustered nucleus inside five luminous, intersecting orbital rings. | Blue light in a dark field. |
| 10 to 13.5 | `waves` | A lateral dolly crosses a physical interference chamber with a suspended wave trace and calibrated grid. | Full monochrome. |
| 13.5 to 17 | `desert` | A wide camera approaches a skeletal test tower below a dusk horizon. | Restrained warm earth. |
| 17 to 19 | `desert` | A hard cut moves close to the suspended vessel. The camera advances and tightens its field of view. | Darker, partly monochrome. |
| 19 to 26 | `ignition` | A flash reveals an expanding incandescent core, boiling fire cells, a smoke crown, dust rings, and ejected embers. | Orange fire against a cool sky. |
| 26 to 32 | `aftermath` | The camera withdraws from collapsed struts, low embers, and drifting smoke. The title appears at 28 seconds. | Muted earth and black ash. |

The opening fades from black during the first 0.8 seconds.
The ending fades to black from 31 to 32 seconds.
The only text is `CRITICAL` and `A 67.js short`.
The title reaches full opacity at 29.2 seconds.

## Renderer contract

`FILM_DURATION` equals `32`.
`createFilmScenes()` returns six sets keyed by the names in the timeline.
Each set contains `parts`, `environment`, and `ground: false`.
The desert sets contain their own terrain and supply `shadowBounds`.

Each part uses the existing renderer shape `{ name, geometry, matrix, material }`.
Repeated details share geometry objects for instancing.
Matrices use `gl-matrix` column-major transforms.
Materials contain `tag`, `color`, `metallic`, `roughness`, and `emission`.
The ignition includes the `fire`, `smoke`, and `particle` tags for procedural shader animation.

The environment contains linear `fogColor`, `fogDensity`, display-space `skyTop` and `skyBottom`, `lightDirection`, and `daylight`.
The shadow bounds contain `extent`, `target`, `eye`, `near`, and `far`.

`sampleFilm(time)` accepts a finite number in seconds and clamps it to `[0, 32]`.
Invalid values throw a `TypeError`.
The return value contains these fields:

| Field | Meaning |
| --- | --- |
| `scene` | The set key. |
| `camera` | World-space `eye`, world-space `target`, and `fov` in degrees. |
| `time` | Clamped absolute film time. |
| `sceneTime` | Seconds since the set first appeared. It continues across the desert camera cut. |
| `exposure` | Authored exposure, including the brief ignition lift. |
| `monochrome` | Grade blend from zero for color to one for monochrome. |
| `fade` | Black-overlay opacity. Zero is visible. One is black. |
| `flash` | White-overlay opacity. It peaks at 19 seconds and decays exponentially. |
| `explosionProgress` | An eased zero-to-one ignition expansion. The aftermath holds one. |
| `title`, `subtitle` | Empty strings before 28 seconds, then the final title. |
| `titleOpacity` | Title opacity including its fade and the terminal black. |

The ignition geometry describes its final size.
Its core sits at `[0, 7, 0]` with radius approximately seven units.
Fire cells surround the core, and the smoke crown reaches approximately 24 units high.

The renderer expands ignition positions around the world origin using `explosionProgress`.
Scaling only individual mesh radii leaves separated cells at the beginning of ignition.
Terrain keeps its authored position and scale.
The aftermath smoke uses full expansion and its own local `sceneTime`.

The renderer can use `time` for continuous noise and `sceneTime` for shot-specific effects.
All scene construction and sampling are deterministic.
The source uses no random generator, clock, browser state, or mutable playback state.

## Measured scene budgets

Triangle counts include every instance, including repeated meshes.

| Set | Parts | Triangles |
| --- | ---: | ---: |
| `apparatus` | 280 | 46,316 |
| `atom` | 159 | 116,640 |
| `waves` | 263 | 40,044 |
| `desert` | 264 | 41,620 |
| `ignition` | 612 | 332,316 |
| `aftermath` | 313 | 100,284 |

`node --test tests/film.test.js` passed four tests.
The tests check exact cuts, deterministic samples, finite cameras, camera continuity within shots, material contracts, and scene budgets.
The tests sample the full timeline at 60 frames per second.
The parent renderer integration owns rendered-frame inspection, the final color grade, and audiovisual export.
