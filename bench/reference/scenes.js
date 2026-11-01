// The reference scenes, built in the browser with the engine's own code so every engine feature can be reached.
// Each builder returns parts, a camera and lighting. render-blender.py builds the same scene from a dump of this data.
import { box, cylinder, sphere, torus } from '/src/geometry.js';
import { createEnvironmentMap, loadHdri } from '/src/hdri.js';
import { parseGltf } from '/src/gltf.js';
import { createTree, vegetationParts } from '/src/vegetation.js';
import { createAgentScene, loadAgentSceneModules } from '/src/agent-scene.js';
import { materialPatternTextures, normalizeMaterialPattern } from '/src/material-patterns.js';

const HDRI_FILE = 'public/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr';
const HDRI_URL = '/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr';
const ROBOT_FILE = 'tests/fixtures/RobotExpressive.glb';
const IDENTITY_ROTATION_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function placedMatrix(translation, scale) {
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = IDENTITY_ROTATION_MATRIX;
  return new Float32Array([
    xx * scale[0], xy * scale[0], xz * scale[0], 0,
    yx * scale[1], yy * scale[1], yz * scale[1], 0,
    zx * scale[2], zy * scale[2], zz * scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

function part(name, geometry, translation, scale, material) {
  return { name, geometry, matrix: placedMatrix(translation, scale), material: { tag: 'surface', metallic: 0, roughness: 0.5, emission: 0, ...material } };
}

function floor(color = [0.5, 0.5, 0.5]) {
  return part('floor', box(0, 1), [0, -0.05, 0], [40, 0.1, 40], { color, roughness: 0.8 });
}

async function skyLighting(intensity = 1) {
  const map = await loadHdri(HDRI_URL, { intensity, showBackground: true });
  return { map, blenderWorld: { type: 'hdri', file: HDRI_FILE, intensity } };
}

function constantLighting(value) {
  const data = new Float32Array(8 * 4 * 3).fill(value);
  const map = createEnvironmentMap({ width: 8, height: 4, data, showBackground: true });
  return { map, blenderWorld: { type: 'constant', value } };
}

function environment(lighting, { lightDirection = [-3, 6, 4], keyColor = [0, 0, 0], pointLights = [], spotLights = [], areaLights = [], volumeFog } = {}) {
  return {
    world: true, fillIntensity: 0, ambientIntensity: 1, fogDensity: 0, lightDirection, keyColor, pointLights, spotLights, areaLights,
    map: lighting.map, ...(volumeFog ? { volumeFog } : {}),
  };
}

const SUN_COLOR = [3, 2.8, 2.5];

// A wall of bricks written as a material graph: a triangle wave across each course for the mortar joints, half a brick of
// shift on every second course, noise through a colour ramp for the brick tone. Blender gets the same graph as nodes.
const BRICK_COLUMNS = 6;
const BRICK_ROWS = 12;

function brickGraph() {
  const coordinate = axis => ({ uv: axis });
  const oddCourse = { smoothstep: [0.49, 0.51, { wave: { frequency: BRICK_ROWS / 2, direction: 'v', shape: 'saw' } }] };
  const shifted = { vec: [{ add: [coordinate('u'), { mul: [oddCourse, 0.5 / BRICK_COLUMNS] }] }, coordinate('v'), 0] };
  const jointAcross = { smoothstep: [0.12, 0.3, { wave: { frequency: BRICK_COLUMNS, direction: 'u', shape: 'triangle', at: shifted } }] };
  const jointAlong = { smoothstep: [0.08, 0.2, { wave: { frequency: BRICK_ROWS, direction: 'v', shape: 'triangle' } }] };
  const body = { min: [jointAcross, jointAlong] };
  const tone = { ramp: { value: { noise: { scale: 10, seed: 2, octaves: 3 } }, stops: [[0, [0.3, 0.09, 0.05]], [1, [0.58, 0.24, 0.14]]] } };
  return { color: { mix: [[0.45, 0.42, 0.38], tone, body] }, height: body };
}

function wallQuad(width, height) {
  const halfWidth = width / 2;
  return {
    positions: new Float32Array([-halfWidth, 0, 0, halfWidth, 0, 0, halfWidth, height, 0, -halfWidth, height, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

export const REFERENCE_SCENES = {
  async 'brick-graph'() {
    const lighting = await skyLighting();
    const pattern = normalizeMaterialPattern({ type: 'graph', graph: brickGraph(), mapping: 'uv', bump: 1, resolution: 512 });
    const { map, normalMap, boxMapScale, boxMapAxis } = materialPatternTextures(pattern);
    const wall = part('wall', wallQuad(6, 4), [0, 0, 0], [1, 1, 1], { color: [1, 1, 1], roughness: 0.85, map, normalMap, boxMapScale, boxMapAxis });
    wall.material.graph = pattern.graph;
    wall.material.graphBump = pattern.bump;
    return {
      parts: [floor([0.4, 0.38, 0.32]), wall], blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2, 8.5], target: [0, 2, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 100 },
      shadow: { eye: [-6, 10, 8], target: [0, 1, 0], up: [0, 1, 0], extent: 8, near: 0.1, far: 40 },
    };
  },

  async 'material-spheres'() {
    const lighting = await skyLighting();
    const shared = sphere(64, 40);
    const parts = [floor()];
    for (const [column, roughness] of [0.1, 0.3, 0.5, 0.7, 0.9].entries()) {
      const x = (column - 2) * 1.5;
      parts.push(part(`plastic-${column}`, shared, [x, 0.6, 0.8], [0.6, 0.6, 0.6], { color: [0.8, 0.2, 0.15], roughness }));
      parts.push(part(`metal-${column}`, shared, [x, 0.6, -0.8], [0.6, 0.6, 0.6], { color: [0.9, 0.75, 0.4], roughness, metallic: 1 }));
    }
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 3.5, 7.5], target: [0, 0.4, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: { eye: [-6, 12, 8], target: [0, 0, 0], up: [0, 1, 0], extent: 8, near: 0.1, far: 40 },
    };
  },

  async 'lit-interior'() {
    const lighting = constantLighting(0.02);
    const wall = { color: [0.7, 0.68, 0.62], roughness: 0.9 };
    const cube = box(0, 1);
    const parts = [
      part('room-floor', cube, [0, -0.05, 0], [8, 0.1, 8], { color: [0.45, 0.32, 0.22], roughness: 0.6 }),
      part('room-ceiling', cube, [0, 3.05, 0], [8, 0.1, 8], wall),
      part('room-back', cube, [0, 1.5, -4.05], [8, 3.2, 0.1], wall),
      part('room-left', cube, [-4.05, 1.5, 0], [0.1, 3.2, 8], { ...wall, color: [0.55, 0.25, 0.2] }),
      part('room-right', cube, [4.05, 1.5, 0], [0.1, 3.2, 8], { ...wall, color: [0.2, 0.35, 0.5] }),
      part('table', cube, [0, 0.7, -1], [2.4, 0.1, 1.2], { color: [0.3, 0.18, 0.1], roughness: 0.4 }),
      part('table-leg', cube, [0, 0.33, -1], [0.3, 0.66, 0.3], { color: [0.2, 0.2, 0.2], roughness: 0.5 }),
      part('vase', sphere(48, 32), [-0.5, 1.05, -1], [0.3, 0.3, 0.3], { color: [0.2, 0.5, 0.45], roughness: 0.2 }),
      part('block', cube, [0.6, 1, -1], [0.4, 0.5, 0.4], { color: [0.75, 0.7, 0.2], roughness: 0.5 }),
    ];
    const pointLights = [
      { position: [0, 2.6, -0.5], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05, castShadow: true },
      { position: [-2.5, 1.5, 1.5], color: [1, 0.6, 0.4], intensity: 2, radius: 0.05, castShadow: true },
      { position: [2.5, 1.5, 1.5], color: [0.5, 0.7, 1], intensity: 2, radius: 0.05, castShadow: true },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.5, 3.9], target: [0, 1, -1], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  // A closed room built from a recipe, with brick walls: the bake has to give a patterned wall bounced light and keep its bricks.
  async 'brick-room'() {
    const lighting = constantLighting(0.02);
    const pointLights = [
      { position: [0, 2.6, -0.5], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05, castShadow: true },
      { position: [-2.5, 1.5, 1.5], color: [1, 0.6, 0.4], intensity: 2, radius: 0.05, castShadow: true },
    ];
    const placedBox = (id, translation, scale, material) => ({ id, geometry: 'box', material, translation, scale });
    const recipe = {
      format: '67js.scene', schemaVersion: 1,
      geometries: [{ id: 'box', type: 'box' }, { id: 'ball', type: 'sphere', segments: 48, rings: 32 }],
      materials: [
        { id: 'bricks', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'bricks', size: 0.5 } },
        { id: 'plaster', color: [0.7, 0.68, 0.62], roughness: 0.9 },
        { id: 'boards', color: [0.45, 0.32, 0.22], roughness: 0.6 },
        { id: 'teal', color: [0.2, 0.5, 0.45], roughness: 0.2 },
      ],
      nodes: [
        placedBox('room-floor', [0, -0.05, 0], [8, 0.1, 8], 'boards'),
        placedBox('room-ceiling', [0, 3.05, 0], [8, 0.1, 8], 'plaster'),
        placedBox('room-back', [0, 1.5, -4.05], [8, 3.2, 0.1], 'bricks'),
        placedBox('room-left', [-4.05, 1.5, 0], [0.1, 3.2, 8], 'bricks'),
        placedBox('room-right', [4.05, 1.5, 0], [0.1, 3.2, 8], 'bricks'),
        placedBox('room-front', [0, 1.5, 4.05], [8, 3.2, 0.1], 'plaster'),
        placedBox('table', [0, 0.7, -1], [2.4, 0.1, 1.2], 'plaster'),
        { id: 'vase', geometry: 'ball', material: 'teal', translation: [-0.5, 1.05, -1], scale: [0.3, 0.3, 0.3] },
      ],
      camera: { eye: [0, 1.5, 3.6], target: [0, 1.1, -1], fov: 60, near: 0.05, far: 50 },
    };
    await loadAgentSceneModules(recipe);
    const scene = createAgentScene(recipe);
    return {
      parts: scene.parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.5, 3.6], target: [0, 1.1, -1], up: [0, 1, 0], fov: 60, near: 0.05, far: 50 },
    };
  },

  // A shadowing spot light with a soft cone edge and a rectangular panel, over objects that block the spot.
  async 'spot-area'() {
    const lighting = constantLighting(0.01);
    const cube = box(0, 1);
    const wall = { color: [0.7, 0.68, 0.62], roughness: 0.9 };
    const parts = [
      part('stage-floor', cube, [0, -0.05, 0], [10, 0.1, 10], { color: [0.55, 0.5, 0.45], roughness: 0.7 }),
      part('stage-back', cube, [0, 1.5, -4.05], [10, 3.2, 0.1], wall),
      part('column', cube, [-0.9, 0.75, -1.5], [0.4, 1.5, 0.4], { color: [0.6, 0.6, 0.65], roughness: 0.5 }),
      part('ball', sphere(48, 32), [0.6, 0.5, -1], [0.5, 0.5, 0.5], { color: [0.8, 0.25, 0.2], roughness: 0.3 }),
      part('block', cube, [1.8, 0.3, -2], [0.6, 0.6, 0.6], { color: [0.2, 0.45, 0.75], roughness: 0.6 }),
    ];
    const spotLights = [
      { position: [-2.4, 3.2, 0.5], direction: [2.4, -3.2, -1.7], angle: 0.5, penumbra: 0.3, color: [1, 0.92, 0.8], intensity: 40, radius: 0.05, castShadow: true },
    ];
    const areaLights = [
      { position: [2.2, 2.6, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 1.5, height: 0.8, color: [0.7, 0.8, 1], intensity: 4 },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { spotLights, areaLights }),
      camera: { eye: [0, 1.8, 4.5], target: [0, 0.7, -1.5], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  // A street 140 m long under the sun. A single shadow map has to cover the whole street, so its texels are about 8 cm wide;
  // cascades give the cars and lamp posts near the camera 1 to 2 cm texels. harness.js draws it with one map by default and
  // with cascades when run.mjs gets --cascades <count>.
  async 'long-street'() {
    const lighting = constantLighting(0.25);
    const cube = box(0, 1);
    const parts = [part('street-ground', cube, [0, -0.05, -10], [60, 0.1, 160], { color: [0.32, 0.32, 0.33], roughness: 0.9 })];
    const facade = { color: [0.62, 0.55, 0.48], roughness: 0.85 };
    for (let block = 0; block < 12; block++) {
      const z = 55 - block * 12;
      const height = 5 + ((block * 7) % 5) * 2;
      parts.push(part(`building-west-${block}`, cube, [-10.5, height / 2, z], [6, height, 10], facade));
      parts.push(part(`building-east-${block}`, cube, [10.5, (height + 3) / 2, z], [6, height + 3, 10], { color: [0.55, 0.58, 0.62], roughness: 0.85 }));
    }
    for (let post = 0; post < 14; post++) {
      const z = 52 - post * 10;
      parts.push(part(`lamp-post-${post}`, cube, [-4.6, 2.2, z], [0.16, 4.4, 0.16], { color: [0.15, 0.15, 0.16], roughness: 0.4, metallic: 0.8 }));
      parts.push(part(`lamp-arm-${post}`, cube, [-4.1, 4.3, z], [1.1, 0.12, 0.12], { color: [0.15, 0.15, 0.16], roughness: 0.4, metallic: 0.8 }));
    }
    const carColors = [[0.7, 0.1, 0.1], [0.1, 0.25, 0.6], [0.85, 0.8, 0.7], [0.1, 0.4, 0.2]];
    carColors.forEach((color, index) => {
      parts.push(part(`car-body-${index}`, cube, [2.4, 0.55, 44 - index * 9], [1.8, 0.7, 4.2], { color, roughness: 0.35 }));
      parts.push(part(`car-roof-${index}`, cube, [2.4, 1.15, 44.3 - index * 9], [1.5, 0.5, 2.2], { color: [0.12, 0.14, 0.17], roughness: 0.2 }));
    });
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR, lightDirection: [-0.7, 0.8, 0.35] }),
      camera: { eye: [-1.5, 1.7, 56], target: [0, 2.2, -40], up: [0, 1, 0], fov: 50, near: 0.1, far: 200 },
      shadow: { eye: [-58, 66, 30], target: [0, 0, -10], up: [0, 1, 0], extent: 85, near: 1, far: 260 },
    };
  },

  // Three point lights that each light only some parts (light linking). Without linking the red light would tint the right
  // sphere too. Blender gets the same lists as light-linking receiver collections.
  async 'light-linking'() {
    const lighting = constantLighting(0.01);
    const cube = box(0, 1);
    const parts = [
      part('stage-floor', cube, [0, -0.05, 0], [10, 0.1, 10], { color: [0.6, 0.6, 0.6], roughness: 0.8 }),
      part('stage-back', cube, [0, 1.5, -3.05], [10, 3.2, 0.1], { color: [0.7, 0.7, 0.7], roughness: 0.9 }),
      part('sphere-left', sphere(48, 32), [-1.2, 0.6, -0.5], [0.6, 0.6, 0.6], { color: [0.8, 0.8, 0.8], roughness: 0.4 }),
      part('sphere-right', sphere(48, 32), [1.2, 0.6, -0.5], [0.6, 0.6, 0.6], { color: [0.8, 0.8, 0.8], roughness: 0.4 }),
      part('block-center', cube, [0, 0.4, -1.5], [0.8, 0.8, 0.8], { color: [0.8, 0.8, 0.8], roughness: 0.6 }),
    ];
    const pointLights = [
      { position: [-1.8, 2.4, 1.2], color: [1, 0.35, 0.2], intensity: 14, radius: 0.1, affects: ['sphere-left', 'block-center'] },
      { position: [1.8, 2.4, 1.2], color: [0.25, 0.45, 1], intensity: 14, radius: 0.1, affects: ['sphere-right'] },
      { position: [0, 3, 2.5], color: [1, 1, 1], intensity: 6, radius: 0.1, affects: ['stage-floor', 'stage-back'] },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.6, 4.6], target: [0, 0.6, -0.8], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
    };
  },

  async character() {
    const lighting = await skyLighting();
    const response = await fetch(`/${ROBOT_FILE}`);
    const asset = await parseGltf(await response.arrayBuffer());
    return {
      parts: [floor([0.4, 0.42, 0.45]), ...asset.parts], blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [2, 3.5, 9], target: [0, 2.4, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: { eye: [-6, 12, 8], target: [0, 2, 0], up: [0, 1, 0], extent: 7, near: 0.1, far: 40 },
    };
  },

  async foliage() {
    const lighting = await skyLighting();
    const tree = createTree({ species: 'broadleaf', height: 6, leaves: 'cards' }, 3);
    return {
      parts: [floor([0.25, 0.3, 0.18]), ...vegetationParts(tree, placedMatrix([0, 0, 0], [1, 1, 1]))],
      blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 3.5, 12], target: [0, 3.2, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 200 },
      shadow: { eye: [-6, 14, 8], target: [0, 3, 0], up: [0, 1, 0], extent: 9, near: 0.1, far: 40 },
    };
  },

  async glass() {
    const lighting = await skyLighting();
    const cube = box(0, 1);
    const parts = [floor()];
    const colors = [[0.8, 0.15, 0.1], [0.9, 0.8, 0.2], [0.15, 0.6, 0.25], [0.15, 0.3, 0.8]];
    colors.forEach((color, index) => {
      parts.push(part(`stripe-${index}`, cube, [(index - 1.5) * 1, 1, -1.5], [0.5, 2, 0.2], { color, roughness: 0.6 }));
    });
    parts.push(part('glass-sphere', sphere(96, 64), [0, 0.9, 0.5], [0.9, 0.9, 0.9], {
      color: [1, 1, 1], roughness: 0.02, transmission: 1, ior: 1.5, thickness: 1.8,
    }));
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 1.8, 6], target: [0, 0.9, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: { eye: [-6, 12, 8], target: [0, 0, 0], up: [0, 1, 0], extent: 6, near: 0.1, far: 40 },
    };
  },

  async 'car-paint'() {
    const lighting = await skyLighting();
    const parts = [
      floor([0.2, 0.2, 0.22]),
      part('lacquer-red', sphere(96, 64), [-1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.55, 0.02, 0.02], roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.03 }),
      part('flake-blue', sphere(96, 64), [0, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.03, 0.12, 0.6], metallic: 0.8, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.03 }),
      part('uncoated-red', sphere(96, 64), [1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.55, 0.02, 0.02], roughness: 0.5 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2.2, 7], target: [0, 0.7, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: { eye: [-6, 12, 8], target: [0, 0, 0], up: [0, 1, 0], extent: 6, near: 0.1, far: 40 },
    };
  },

  // Anisotropy and iridescence against Cycles: a brushed gold sphere, a dark dielectric with a thin film and a silver one.
  async 'brushed-film'() {
    const lighting = await skyLighting();
    const parts = [
      floor([0.2, 0.2, 0.22]),
      part('brushed-gold', sphere(96, 64), [-1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [1, 0.77, 0.34], metallic: 1, roughness: 0.35, anisotropy: 0.8 }),
      part('oil-film', sphere(96, 64), [0, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.02, 0.02, 0.025], roughness: 0.15, iridescence: 1, iridescenceIor: 1.3, iridescenceThickness: 400 }),
      part('film-on-silver', sphere(96, 64), [1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.9, 0.9, 0.92], metallic: 1, roughness: 0.2, iridescence: 1, iridescenceIor: 1.3, iridescenceThickness: 400 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2.2, 7], target: [0, 0.7, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: { eye: [-6, 12, 8], target: [0, 0, 0], up: [0, 1, 0], extent: 6, near: 0.1, far: 40 },
    };
  },

  async metal() {
    const lighting = await skyLighting();
    const parts = [
      floor([0.2, 0.2, 0.22]),
      part('chrome', sphere(96, 64), [-1.6, 0.8, 0], [0.8, 0.8, 0.8], { color: [0.95, 0.95, 0.95], metallic: 1, roughness: 0.05 }),
      part('gold', torus(0.3, 96, 32), [0.3, 1.1, 0], [0.7, 0.7, 0.7], { color: [1, 0.77, 0.34], metallic: 1, roughness: 0.3 }),
      part('copper', box(0, 1), [2, 0.6, 0], [1.2, 1.2, 1.2], { color: [0.95, 0.64, 0.54], metallic: 1, roughness: 0.5 }),
      part('steel', cylinder(64, 0, 1), [0, 0.2, 1.6], [0.5, 0.4, 0.5], { color: [0.56, 0.57, 0.58], metallic: 1, roughness: 0.2 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2.2, 7], target: [0, 0.7, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
      shadow: { eye: [-6, 12, 8], target: [0, 0, 0], up: [0, 1, 0], extent: 6, near: 0.1, far: 40 },
    };
  },

  async fog() {
    const lighting = constantLighting(0.05);
    const cube = box(0, 1);
    const parts = [floor([0.35, 0.35, 0.35])];
    for (let index = 0; index < 5; index++) {
      parts.push(part(`pillar-left-${index}`, cube, [-2, 2, -index * 2.2 + 3], [0.5, 4, 0.5], { color: [0.5, 0.48, 0.45], roughness: 0.8 }));
      parts.push(part(`pillar-right-${index}`, cube, [2, 2, -index * 2.2 + 3], [0.5, 4, 0.5], { color: [0.5, 0.48, 0.45], roughness: 0.8 }));
    }
    const volumeFog = {
      density: 0.25, minimum: [-8, 0, -10], maximum: [8, 6, 8], color: [1, 1, 1], ambient: [0.05, 0.05, 0.05],
      anisotropy: 0.3, noiseAmount: 0, steps: 48, maxDistance: 60,
    };
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { lightDirection: [-5, 6, 2], keyColor: [6, 5.6, 5], volumeFog }),
      camera: { eye: [0, 1.6, 7], target: [0, 1.6, -4], up: [0, 1, 0], fov: 50, near: 0.1, far: 80 },
      shadow: { eye: [-10, 12, 4], target: [0, 0, -1], up: [0, 1, 0], extent: 12, near: 0.1, far: 50 },
    };
  },

  async 'outdoor-hdri'() {
    const lighting = await skyLighting();
    const cube = box(0, 1);
    const parts = [
      floor([0.4, 0.38, 0.32]),
      part('block-large', cube, [-2.5, 1.5, -2], [2, 3, 2], { color: [0.6, 0.55, 0.5], roughness: 0.8 }),
      part('block-small', cube, [1, 0.5, 0], [1, 1, 1], { color: [0.7, 0.3, 0.2], roughness: 0.6 }),
      part('ball', sphere(64, 40), [3, 0.8, -1], [0.8, 0.8, 0.8], { color: [0.2, 0.4, 0.7], roughness: 0.3 }),
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 2, 10], target: [0, 1.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 300 },
      shadow: { eye: [-8, 14, 10], target: [0, 0, 0], up: [0, 1, 0], extent: 10, near: 0.1, far: 50 },
    };
  },
};
