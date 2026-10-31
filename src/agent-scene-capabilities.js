import {
  MESH_EDIT_OPERATIONS, MAX_MESH_EDITS, STACK_OPERATIONS, MAX_STACK_NODES,
  FIELD_OPERATOR_NAMES, FIELD_ATTRIBUTES, MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, INSTANCE_SOURCES, MAX_INSTANCE_CANDIDATES,
} from './mesh-operations.js';

// What agent scenes support and their default limits, as plain data. The MCP server reads these without bundling
// the scene engine (geometry, three.js decoders, the mesh core), which runs in the preview page instead.

export const AGENT_SCENE_DEFAULT_LIMITS = Object.freeze({
  maxNodes: 4096, maxDepth: 256, maxGeometries: 256, maxMaterials: 256,
  maxVertices: 250_000, maxGeometryBytes: 32 * 1024 * 1024,
  maxOperations: 256, maxCheckpoints: 8, maxRecipeBytes: 1024 * 1024,
});

export const MATERIAL_PATTERN_TYPES = Object.freeze(['noise', 'wood', 'planks', 'bricks', 'tiles', 'marble', 'stone', 'concrete', 'metal', 'rust', 'fabric']);
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
  curve: 'Cubic Bezier sweep. points: [x,y,z] (smooth automatic handles) or {position, handleIn?, handleOut?} with handles as absolute positions (a lone handle is mirrored). radius (0.05), taper: radius factors 0+ spread along the length, e.g. [1,0.2], profile: [[x,y]...] cross-section in radius units (default round, radialSegments 8; sharp corners stay flat shaded), resolution: samples per span (12), closed. Open curves get flat caps.',
  text: 'Extruded text in the XY plane, first baseline on y=0, reading along +X, facing +Z, centred through depth. text (use \n for lines), size (1, em height), depth (0.2), align left|center|right, curveSegments 1-16 per outline curve (4), font (default DejaVu Sans, printable ASCII; other fonts come from registerAgentSceneFont in code, not MCP).',
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
// Metres that depth pass values 0 to 65535 span, measured from the camera.
export const RENDER_PASS_DEPTH_RANGE = 100;

export const AGENT_SCENE_CAPABILITIES = Object.freeze({
  format: '67js.scene', schemaVersion: 1,
  geometryTypes: Object.freeze(['box', 'cylinder', 'sphere', 'torus', 'lathe', 'extrude', 'tube', 'curve', 'text', 'mesh']),
  meshEdits: Object.freeze({ operations: Object.freeze(Object.keys(MESH_EDIT_OPERATIONS)), maxEdits: MAX_MESH_EDITS }),
  meshStack: Object.freeze({ operations: STACK_OPERATIONS, maxNodes: MAX_STACK_NODES }),
  fieldExpressions: Object.freeze({
    operators: FIELD_OPERATOR_NAMES, attributes: FIELD_ATTRIBUTES,
    maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxElements: MAX_FIELD_ELEMENTS,
  }),
  instancing: Object.freeze({ sources: INSTANCE_SOURCES, maxCandidatePoints: MAX_INSTANCE_CANDIDATES }),
  operations: Object.freeze([
    'set-node', 'set-material', 'set-camera', 'add-node', 'remove-node',
    'add-geometry', 'remove-geometry', 'add-material', 'remove-material',
    'set-environment', 'set-effects', 'set-shadow', 'set-motion', 'set-armatures', 'set-physics', 'edit-mesh', 'set-mesh-stack',
  ]),
  materialTags: Object.freeze(['surface', 'unlit', 'liquid', 'foam']),
  alphaModes: RECIPE_ALPHA_MODES,
  materialPatterns: MATERIAL_PATTERN_TYPES, maxMaterialPatterns: MAX_MATERIAL_PATTERNS,
  materialMappings: MATERIAL_MAPPINGS,
  renderPasses: Object.freeze({ names: RENDER_PASS_NAMES, files: 'render-<pass>.png or frame-N-<pass>.png, raw and unantialiased; opaque and cutout geometry only', depth: `16 bits in red and green over ${RENDER_PASS_DEPTH_RANGE} m`, objectId: '24 bits in RGB; the job result lists the part names' }),
  curveText: Object.freeze({ ...CURVE_TEXT_LIMITS, details: CURVE_TEXT_DETAILS }),
  materialGraph: Object.freeze({ outputs: MATERIAL_GRAPH_OUTPUTS, operators: MATERIAL_GRAPH_OPERATORS, ...MATERIAL_GRAPH_LIMITS, nodes: MATERIAL_GRAPH_NODES }),
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
    sensors: true, collisionLayers: 16, boneBodies: false,
    limits: Object.freeze({ maxBodies: 64, maxJoints: 64, maxDuration: 10, framesPerSecond: 60, maxTrimeshTriangles: 20000, maxHullPoints: 2048 }),
  }),
  motionLimits: Object.freeze({ maxTracks: 128, maxKeyframesPerTrack: 64, maxKeyframes: 2048, maxDuration: 30 }),
});

/** Degrees between faces above which a mesh geometry keeps a hard edge, as Blender's auto smooth does. */
export const MESH_SMOOTH_ANGLE_DEFAULT = 30;
