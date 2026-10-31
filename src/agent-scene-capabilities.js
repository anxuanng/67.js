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

// Recipe textures are opaque patterns, so cutout masking has nothing to cut.
export const RECIPE_ALPHA_MODES = Object.freeze(['opaque', 'blend']);

export const AGENT_SCENE_CAPABILITIES = Object.freeze({
  format: '67js.scene', schemaVersion: 1,
  geometryTypes: Object.freeze(['box', 'cylinder', 'sphere', 'torus', 'lathe', 'extrude', 'tube', 'mesh']),
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
    'set-environment', 'set-effects', 'set-shadow', 'set-motion', 'set-physics', 'edit-mesh', 'set-mesh-stack',
  ]),
  materialTags: Object.freeze(['surface', 'unlit', 'liquid', 'foam']),
  alphaModes: RECIPE_ALPHA_MODES,
  materialPatterns: MATERIAL_PATTERN_TYPES, maxMaterialPatterns: MAX_MATERIAL_PATTERNS,
  fixedResources: false, dynamicTopology: true, checkpoints: true, positiveScaleOnly: true,
  authoredLook: true, maxPointLights: 8,
  // Local lights: spot and rectangular area lights. Shadows share one 2048 x 3072 depth atlas of 24 tiles; a shadowed
  // point light uses 6 tiles and a shadowed spot light 1. Area lights cast no shadow. Light linking is not supported.
  maxSpotLights: 8, maxAreaLights: 4,
  localShadows: Object.freeze({ lights: Object.freeze(['pointLights', 'spotLights']), atlasTiles: 24, pointLightTiles: 6, spotLightTiles: 1, tileSize: 512 }),
  lightLinking: false,
  proceduralMotion: true,
  motionIk: Object.freeze(['two-bone', 'aim']),
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
