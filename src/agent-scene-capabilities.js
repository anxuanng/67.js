import {
  MESH_EDIT_OPERATIONS, MAX_MESH_EDITS, STACK_OPERATIONS, MAX_STACK_NODES,
  FIELD_OPERATOR_NAMES, FIELD_ATTRIBUTES, MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, INSTANCE_SOURCES, MAX_INSTANCE_CANDIDATES,
  IMPORTED_MESH_EDIT_LIMITS,
} from './mesh-operations.js';
import { MATERIAL_LAYER_FIELDS, MATERIAL_LAYER_SCALAR_RANGES, MATERIAL_LAYER_COLOR_RANGES } from './material-layers.js';

// What agent scenes support and their default limits, as plain data. The MCP server reads these without bundling
// the scene engine (geometry, three.js decoders, the mesh core), which runs in the preview page instead.

export const AGENT_SCENE_DEFAULT_LIMITS = Object.freeze({
  maxNodes: 4096, maxDepth: 256, maxGeometries: 256, maxMaterials: 256,
  maxVertices: 250_000, maxGeometryBytes: 32 * 1024 * 1024,
  maxOperations: 256, maxCheckpoints: 8, maxRecipeBytes: 1024 * 1024,
});

// What each recipe material layer does, beside its range; the MCP schema keeps one short line per field.
const MATERIAL_LAYER_NOTES = Object.freeze({
  clearcoat: 'Lacquer lobe over the base, surface tag.',
  clearcoatRoughness: 'Coat roughness.',
  transmission: 'Refracts the opaque scene behind it, surface or liquid tag; blended parts do not show through; no anisotropy, iridescence, sheen or coat.',
  thickness: 'Metres crossed; 0 does not bend the view.',
  ior: 'Glass 1.5, water 1.33, diamond 2.42; sets the base reflectance.',
  attenuationColor: 'Linear RGB kept after attenuationDistance.',
  attenuationDistance: 'Metres to reach attenuationColor; omit for none.',
  sheenColor: 'Linear RGB glow at grazing angles; black is off.',
  sheenRoughness: 'Glow width.',
  specular: 'Non-metal reflection, 1 is normal.',
  specularColor: 'Linear RGB tint.',
  anisotropy: 'Stretches highlights along the grain; the grain follows the UV direction, or rings the up axis without UVs.',
  anisotropyRotation: 'Turns the grain around the normal, radians.',
  iridescence: 'Thin-film colour shift on reflections.',
  iridescenceIor: 'Film index of refraction.',
  iridescenceThickness: 'Film nanometres; colours cycle as it grows.',
});

export const MATERIAL_PATTERN_TYPES =Object.freeze(['noise', 'wood', 'planks', 'bricks', 'tiles', 'marble', 'stone', 'concrete', 'metal', 'rust', 'fabric']);
export const MAX_MATERIAL_PATTERNS = 16;
// A material graph bakes to textures on the CPU and never becomes shader text. Its node and depth limits are the field
// expression limits; maxWork is work units per pixel times pixels, so a costly graph needs a smaller texture.
export const MATERIAL_GRAPH_OUTPUTS = Object.freeze(['color', 'roughness', 'metallic', 'emission', 'height']);
export const MATERIAL_GRAPH_OPERATORS = Object.freeze([
  'uv', 'vec', 'ramp', 'noise', 'voronoi', 'wave', 'checker', 'gradient',
  'add', 'sub', 'mul', 'div', 'min', 'max', 'pow', 'abs', 'floor', 'fract', 'sqrt', 'invert', 'clamp', 'smoothstep', 'mix',
]);
export const MATERIAL_GRAPH_LIMITS = Object.freeze({ maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxStops: 8, maxWork: 30_000_000 });
// Curve and text geometry. A text geometry is bounded by vertices per curve segment: the bundled font stays under
// 640 per character and a registered font is held to 128 outline points per glyph (2400).
export const CURVE_TEXT_LIMITS = Object.freeze({
  maxCurvePoints: 1024, maxProfilePoints: 256, maxTextCharacters: 256, maxTextLines: 16,
  verticesPerCharacterSegment: 640, verticesPerCustomCharacterSegment: 2400, maxPointsPerGlyph: 128,
});
export const CURVE_TEXT_DETAILS = Object.freeze({
  curve: 'Cubic Bezier sweep. points: [x,y,z] or {position, handleIn?, handleOut?}. radius (0.05), taper, profile ([[x,y]...]), radialSegments, resolution, closed. See docs/modeling.md.',
  text: 'Extruded text, baseline y=0 along +X, facing +Z. text (\n for lines), size (1), depth (0.2), align left|center|right, curveSegments, font. See docs/modeling.md.',
});
export const MATERIAL_MAPPINGS = Object.freeze(['box', 'uv']);
export const MATERIAL_GRAPH_NODES = Object.freeze({
  outputs: 'color (linear RGB; a number is grey), roughness, metallic, emission (colour; defaults to 1), height (becomes a normal map).',
  node: 'A number, [x, y, z], or an object with exactly one operator.',
  textures: Object.freeze({
    noise: '{"noise":{"scale":8,"seed":1,"octaves":4}}',
    voronoi: '{"voronoi":{"scale":6,"output":"distance"|"edge"|"cell"}}',
    wave: '{"wave":{"frequency":4,"direction":"u"|"v"|"diagonal","shape":"sine"|"saw"|"triangle"}}',
    checker: '{"checker":{"count":8}} (even count)',
    gradient: '{"gradient":{"type":"u"|"v"|"radial"}}',
    note: 'Each takes "at", a vector such as {"uv":"both"}, to warp it. Scales are whole numbers 1 to 64 so it tiles.',
  }),
  uv: '{"uv":"u"|"v"|"both"} are the coordinates.',
  ramp: '{"ramp":{"value":node,"stops":[[0,[r,g,b]],[1,[r,g,b]]]}} maps a number to colours, 2 to 8 stops rising from 0 to 1.',
  maths: 'add sub mul div min max pow take [a,b]; abs floor fract sqrt invert take one node; clamp smoothstep mix take [a,b,c]; {"vec":[r,g,b]}. Numbers combine with vectors per component.',
  example: '{"color":{"ramp":{"value":{"noise":{"scale":8}},"stops":[[0,[0.1,0.05,0.02]],[1,[0.6,0.4,0.2]]]}},"height":{"noise":{"scale":8}}}',
  mapping: 'box (default) projects along the object axes and needs no UVs; uv follows geometry UVs, so the mesh needs a uv_unwrap node or geometry.uvs. size and axis only apply to box.',
});

// Recipe textures are opaque patterns, so cutout masking has nothing to cut.
export const RECIPE_ALPHA_MODES = Object.freeze(['opaque', 'blend']);

// Named lighting setups (see lighting-setups.js) and the occlusion strength that recipes get when they set none.
export const LIGHTING_SETUP_NAMES = Object.freeze(['daylight', 'overcast', 'sunset', 'studio']);
export const DEFAULT_LIGHTING_SETUP = 'daylight';
export const DEFAULT_AMBIENT_OCCLUSION = 0;

// Render passes a render job can write next to the lit image (see RENDER_PASS_MODES in renderer.js, which must list the same names).
export const RENDER_PASS_NAMES = Object.freeze(['albedo', 'normal', 'emission', 'depth', 'objectId']);
// Video encoders a render job can choose (nvenc is h264_nvenc and fails the job when the GPU or ffmpeg lacks it), the
// longest video, and the audio file names a job may mix in from the --audio folder: one path segment with a known
// extension, no drive or protocol syntax.
export const VIDEO_ENCODERS = Object.freeze(['cpu', 'nvenc']);
export const MAXIMUM_VIDEO_SECONDS = 60;
/** Recipe bake presets and ranges. A bake over 20 s fails the edit before the 30 s page deadline would close the runtime. */
export const BAKE_PRESETS = Object.freeze({
  draft: Object.freeze({ samples: 32, bounces: 1, texelsPerUnit: 3 }),
  standard: Object.freeze({ samples: 128, bounces: 2, texelsPerUnit: 6 }),
  fine: Object.freeze({ samples: 192, bounces: 2, texelsPerUnit: 7 }),
});
export const BAKE_RANGES = Object.freeze({ samples: [1, 256], bounces: [1, 3], texelsPerUnit: [1, 12] });
export const BAKE_MAXIMUM_SECONDS = 20;
/** Render job output: each side up to 1920 and never more pixels than 1920x1080 (portrait 1080x1920 fits). */
export const MAXIMUM_JOB_SIDE = 1920;
export const MAXIMUM_JOB_PIXELS = 1920 * 1080;
/**
 * Largest --memory value in MiB the MCP server accepts. Measured: a 1920x1080 frame needs about 175 MiB of targets
 * (planRenderSize estimate, 4 samples), Node RSS peaks under 180 MiB, so 384 leaves about 200 MiB for scene textures and geometry.
 */
export const MAXIMUM_MEMORY_MIB = 384;
export const AUDIO_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(wav|mp3|ogg|flac)$/;
// Metres that depth pass values 0 to 65535 span, measured from the camera.
export const RENDER_PASS_DEPTH_RANGE = 100;

// Fields and defaults of the whole-mesh modifiers, which the tool schemas leave out to stay small.
export const MESH_MODIFIER_NOTES = Object.freeze({
  weld: 'distance 0.001: merge closer vertices.',
  triangulate: 'minVertices 4: split faces with that many corners or more.',
  edge_split: 'angle 30: split edges bending more than this many degrees.',
  smooth: 'factor 0.5 (-2 to 2) steps toward the neighbour mean; iterations 1 to 64.',
  simple_deform: 'mode twist or bend use angle (45 degrees), taper or stretch use factor (0.5); axis x, y or z (z).',
  cast: 'sphere about the origin: factor 0 to 1 (0.5), size radius (0 = mean vertex distance).',
});

// Organic shaping edits. Details stay here so the tool schemas stay small.
export const MESH_SCULPT_NOTES = Object.freeze({
  sculpt: 'strokes run in order on the vertices of the selected faces; other vertices stay, so a tag confines them. A stroke has type inflate (along the vertex normal), displace (along direction, needed) or smooth (strength 0 to 1), center and radius, strength in mesh units (negative pushes in). Falloff is smooth to zero at the radius. For bulges, dents and softened forms.',
  shrinkwrap: 'target is a primitive record placed by translation, rotation and scale. mode nearest (default) moves each selected vertex to the closest point; project moves it along direction (needed) to the first hit. offset (default 0) stands it off along the normal, on the side it came from. maxDistance limits the search; onMiss error (default) or keep. To lay a flat grid sheet onto a curved target as a decal, use enough cells to follow the curve, then solidify.',
});

export const AGENT_SCENE_CAPABILITIES = Object.freeze({
  format: '67js.scene', schemaVersion: 1,
  geometryTypes: Object.freeze(['box', 'cylinder', 'sphere', 'torus', 'lathe', 'extrude', 'tube', 'curve', 'text', 'grid', 'terrain', 'mesh']),
  terrain: 'One mesh, x and z from -size/2 to size/2, hills about y = 0. size 40 m (1-2000), resolution 64 cells (2-256), seed 1, amplitude 1 m (0-200), holes up to 16 of {center:[x,z],radius} with no surface inside; radius a few cells or more.',
  meshEdits: Object.freeze({ operations: Object.freeze(Object.keys(MESH_EDIT_OPERATIONS)), maxEdits: MAX_MESH_EDITS }),
  meshStack: Object.freeze({ operations: STACK_OPERATIONS, maxNodes: MAX_STACK_NODES }),
  meshModifiers: MESH_MODIFIER_NOTES,
  meshSculpt: MESH_SCULPT_NOTES,
  fieldExpressions: Object.freeze({
    operators: FIELD_OPERATOR_NAMES, attributes: FIELD_ATTRIBUTES,
    maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxElements: MAX_FIELD_ELEMENTS,
  }),
  instancing: Object.freeze({ sources: INSTANCE_SOURCES, maxCandidatePoints: MAX_INSTANCE_CANDIDATES }),
  operations: Object.freeze([
    'set-node', 'set-material', 'set-camera', 'add-node', 'remove-node',
    'add-geometry', 'remove-geometry', 'add-material', 'remove-material',
    'set-environment', 'set-effects', 'set-shadow', 'set-motion', 'set-armatures', 'set-physics', 'set-cloth', 'set-timeline', 'set-particles', 'set-bake', 'edit-mesh', 'set-mesh-stack',
  ]),
  materialTags: Object.freeze(['surface', 'unlit', 'liquid', 'foam']),
  materialLayers: Object.freeze(Object.fromEntries(MATERIAL_LAYER_FIELDS.map(field => [field, Object.freeze({
    range: MATERIAL_LAYER_SCALAR_RANGES[field] ?? MATERIAL_LAYER_COLOR_RANGES[field] ?? 'above 0',
    note: MATERIAL_LAYER_NOTES[field],
  })]))),
  alphaModes: RECIPE_ALPHA_MODES,
  materialPatterns: MATERIAL_PATTERN_TYPES, maxMaterialPatterns: MAX_MATERIAL_PATTERNS,
  materialMappings: MATERIAL_MAPPINGS,
  renderPasses: Object.freeze({ names: RENDER_PASS_NAMES, files: 'render-<pass>.png or frame-N-<pass>.png, raw and unantialiased; opaque and cutout geometry only', depth: `16 bits in red and green over ${RENDER_PASS_DEPTH_RANGE} m`, objectId: '24 bits in RGB; the job result lists the part names' }),
  // Recipe timeline (src/film-timeline.js), rendered with settings.timeline; the rest is in docs/agent-render-jobs.md.
  filmTimeline: Object.freeze({
    maxShots: 64, maxTotalSeconds: 60, maxShotSeconds: 30,
    shot: 'name (unique), duration, motionStart (default: the shot start, so non-looping motion must cover it), camera (partial: eye target up fov near far), focusDistance (m) and blur (0 to 1) for the depth of field of the shot, dip (s; fades through black at the cut into this shot).',
    notSupported: 'layers, overlaps, crossfades, markers, events, imported assets',
  }),
  curveText: Object.freeze({
    maxCurvePoints: CURVE_TEXT_LIMITS.maxCurvePoints, maxProfilePoints: CURVE_TEXT_LIMITS.maxProfilePoints,
    maxTextCharacters: CURVE_TEXT_LIMITS.maxTextCharacters, maxTextLines: CURVE_TEXT_LIMITS.maxTextLines,
    verticesPerCharacterSegment: CURVE_TEXT_LIMITS.verticesPerCharacterSegment,
    details: CURVE_TEXT_DETAILS,
  }),
  materialGraph: Object.freeze({ outputs: MATERIAL_GRAPH_OUTPUTS, operators: MATERIAL_GRAPH_OPERATORS, ...MATERIAL_GRAPH_LIMITS, nodes: MATERIAL_GRAPH_NODES }),
  // mesh_edit on an imported GLB part (geometry mesh-<n>, listed by scene_inspect). Edits run in the part's local space
  // (mesh_inspect gives localToWorldScale and localAxesInWorld) on a welded mesh with axis tags and a material tag.
  importedMeshEdits: Object.freeze({
    ...IMPORTED_MESH_EDIT_LIMITS,
    transfer: 'New vertices take skin weights, morph deltas and colours from the nearest original surface point; faces left without UVs read the nearest original UV island. Not supported: mesh_stack, relations, instancing.',
    rejects: 'On a skinned or morphed part an edit farther than maxTransferFraction of the part bounds diagonal from the original surface; booleans on open parts (fill_holes first).',
  }),
  fixedResources: false, dynamicTopology: true, checkpoints: true, positiveScaleOnly: true,
  authoredLook: true, maxPointLights: 8,
  lightingSetups: LIGHTING_SETUP_NAMES, defaultLightingSetup: DEFAULT_LIGHTING_SETUP,
  ambientOcclusion: Object.freeze({ default: DEFAULT_AMBIENT_OCCLUSION, defaultRadius: 0.5, off: 0 }),
  // Local lights: spot and rectangular area lights. Shadows share one 2048 x 3072 depth atlas of 24 tiles; a shadowed
  // point light uses 6 tiles and a shadowed spot light 1. Area lights cast no shadow. Light linking is not supported.
  maxSpotLights: 8, maxAreaLights: 4,
  localShadows: Object.freeze({ lights: Object.freeze(['pointLights', 'spotLights']), atlasTiles: 24, pointLightTiles: 6, spotLightTiles: 1, tileSize: 512 }),
  lightLinking: false,
  proceduralMotion: true,
  motionIk: Object.freeze(['two-bone', 'aim']),
  // Authored rigs: armatures expand into bone nodes, and a node `skin` binds a mesh with automatic weights (four influences).
  // Node relations place a mesh node against other mesh nodes (world bounds), solved again after every edit.
  relations: Object.freeze({
    maxPerNode: 8, maxNodes: 256, sides: Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']),
    kinds: Object.freeze({
      attach: 'to, side, offset: touch the face of the target on side and centre on the other axes; offset is the distance, negative sinks in',
      gap: 'to, side, offset: as attach on that axis only',
      flush: 'to, side, offset: own face on side level with the same face of the target',
      align: 'to, axis, at (min, center, max), offset: anchor on one axis',
      centered: 'to, axes (default x, y, z): centre on those axes',
    }),
    notes: 'Optional region (a mesh tag) uses only those faces of the target. One relation per axis, no loops, mesh nodes only. A relation replaces translation on its axes. set-node with relations [] removes them.',
  }),
  rigging: Object.freeze({ presets: Object.freeze(['humanoid', 'quadruped']), maxArmatures: 16, maxBones: 128, maxInfluences: 4, weights: 'bone-distance' }),
  motionConstraints: Object.freeze(['copy_location', 'copy_rotation', 'copy_scale', 'limit_location', 'limit_rotation', 'track_to', 'child_of', 'floor']),
  motionDrivers: Object.freeze({ maxDrivers: 32, maxConstraints: 32, maxExpressionParts: 64, maxExpressionDepth: 8 }),
  // Recipe physics: Rapier (an optional peer) bakes bodies on nodes offline; playback is a seek into the bake.
  physics: Object.freeze({
    bodyTypes: Object.freeze(['dynamic', 'fixed', 'kinematic']),
    shapes: Object.freeze(['box', 'ball', 'capsule', 'convex', 'trimesh']),
    jointTypes: Object.freeze(['spherical', 'revolute', 'prismatic', 'fixed']),
    sensors: true, collisionLayers: 16,
    ragdoll: 'physics.ragdoll {armature}: limp capsule per bone; needs a floor',
    limits: Object.freeze({ maxBodies: 64, maxJoints: 64, maxDuration: 10, framesPerSecond: 60, maxTrimeshTriangles: 20000, maxHullPoints: 2048 }),
  }),
  // Recipe cloth: a position-based solver (no peer dependency) records any root mesh node as a deformable sheet.
  cloth: Object.freeze({
    sheetGeometry: 'grid { segments 1-64 }: unit sheet in XY facing +Z, sized by node scale; any triangle mesh works',
    defaults: Object.freeze({ stiffness: 0.9, bend: 0.1, density: 0.2, damping: 0.3, friction: 0.3, thickness: 0.01, colliderShape: 'box' }),
    notes: 'density kg/m2, damping 1/s, thickness m, wind m/s steady. Pin edges are of the local bounds. Colliders are fixed ball or box fits to geometry bounds. No self collision, no soft bodies. Sheets and colliders are root nodes with no motion track or physics body.',
    limits: Object.freeze({ maxSheets: 8, maxColliders: 16, maxDuration: 10, maxParticles: 5000, framesPerSecond: 60, substeps: 4, iterations: 8 }),
  }),
  // Recipe particles: closed-form from seeded launch values, so any time is computed directly and a seek never replays.
  particles: Object.freeze({
    emitter: 'System node keeps its geometry as the particle shape (keep it low-poly); node transform does not move particles. Fields (defaults): node, seed (1), count (100), rate (per second; omit for a burst at 0), lifetime, speed, size (each number or [min, max]; 1, 1, 0.05), direction ([0,1,0]), spread (cone degrees, 30), emitter { shape point|box|sphere|disc, position, halfExtents, radius }, scale constant|shrink|grow, drag (1/s, 0), floor (world y where particles land and rest).',
    hair: 'type hair grows strands from a read-only root surface node into node (its own geometry is ignored). Fields (defaults): surface, seed, count, length (m, number or [min, max], 0.1), segments (1-8, 4), width (m, 0.004), droop (0.5), lean (0.2), sway (tip travel m, off), swayRate (Hz, 0.5). Triangular tapering tubes, no UVs.',
    sectionFields: 'systems, gravity ([0,-9.81,0]), wind (m/s; moves emitter particles only with drag > 0, and sets the hair sway direction)',
    notes: 'A particle is a pure function of seed, index and time; raising count keeps earlier ones. No collision but the floor, no bounce, rotation, colour or alpha; no hair collision, combing or clumping. Report: maxAlive and endsAt per system.',
    limits: Object.freeze({ maxSystems: 4, maxParticlesPerSystem: 2000, maxParticles: 4000, maxVertices: 100000, maxLifetime: 60 }),
  }),
  // Recipe bake: bounced light written into lightmaps at build time (src/light-bake.js, loaded on demand).
  bake: Object.freeze({
    fields: 'preset, or samples (1-256), bounces (1-3), texelsPerUnit (1-12) over it. Same recipe, same bytes.',
    presets: BAKE_PRESETS,
    notes: 'Bounced light from point lights and the key light, for closed rooms. Reruns only when parts, lights, materials or bake change. Patterns and textures keep their look. Skips alpha, skin, morph, hair hosts (bake.skipped, bake.seconds). Spot and area lights, environment map and specular are not baked. Over 20 s fails the edit.',
    limits: Object.freeze({ maxSeconds: BAKE_MAXIMUM_SECONDS, maxPointLights: 8 }),
  }),
  motionLimits: Object.freeze({ maxTracks: 128, maxKeyframesPerTrack: 64, maxKeyframes: 2048, maxDuration: 30 }),
});

/** Degrees between faces above which a mesh geometry keeps a hard edge, as Blender's auto smooth does. */
export const MESH_SMOOTH_ANGLE_DEFAULT = 30;
