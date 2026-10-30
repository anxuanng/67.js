// The reference scenes, built in the browser with the engine's own code so every engine feature can be reached.
// Each builder returns parts, a camera and lighting. render-blender.py builds the same scene from a dump of this data.
import { box, cylinder, sphere, torus } from '/src/geometry.js';
import { createEnvironmentMap, loadHdri } from '/src/hdri.js';
import { parseGltf } from '/src/gltf.js';
import { createTree, vegetationParts } from '/src/vegetation.js';

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

function environment(lighting, { lightDirection = [-3, 6, 4], keyColor = [0, 0, 0], pointLights = [], volumeFog } = {}) {
  return {
    world: true, fillIntensity: 0, ambientIntensity: 1, fogDensity: 0, lightDirection, keyColor, pointLights,
    map: lighting.map, ...(volumeFog ? { volumeFog } : {}),
  };
}

const SUN_COLOR = [3, 2.8, 2.5];

export const REFERENCE_SCENES = {
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
      { position: [0, 2.6, -0.5], color: [1, 0.9, 0.75], intensity: 8, radius: 0.05 },
      { position: [-2.5, 1.5, 1.5], color: [1, 0.6, 0.4], intensity: 2, radius: 0.05 },
      { position: [2.5, 1.5, 1.5], color: [0.5, 0.7, 1], intensity: 2, radius: 0.05 },
    ];
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { pointLights }),
      camera: { eye: [0, 1.5, 3.9], target: [0, 1, -1], up: [0, 1, 0], fov: 50, near: 0.05, far: 50 },
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
      tag: 'liquid', color: [1, 1, 1], roughness: 0.02, liquid: { ior: 1.5, thickness: 1.8, refraction: 1, scattering: 0 },
    }));
    return {
      parts, blenderWorld: lighting.blenderWorld,
      environment: environment(lighting, { keyColor: SUN_COLOR }),
      camera: { eye: [0, 1.8, 6], target: [0, 0.9, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 200 },
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
