// The benchmark scenes as plain data, so both engine adapters draw the same triangles, materials and lights.
import { box, sphere } from '/src/geometry.js';

const FLOOR_SIZE = 200;
const CHARACTER_COUNT = 8;

function translation(x, y, z, scale = 1) {
  return new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
}

function gridObjects(count, spacing, geometry, scale, materialFor) {
  const side = Math.ceil(Math.sqrt(count));
  const objects = [];
  for (let index = 0; index < count; index++) {
    const x = (index % side - (side - 1) / 2) * spacing;
    const z = (Math.floor(index / side) - (side - 1) / 2) * spacing;
    objects.push({ geometry, matrix: translation(x, scale, z, scale), material: materialFor(index) });
  }
  return objects;
}

function hueColor(index, count) {
  const angle = (index / count) * Math.PI * 2;
  return [0.5 + 0.45 * Math.cos(angle), 0.5 + 0.45 * Math.cos(angle + 2.09), 0.5 + 0.45 * Math.cos(angle + 4.19)];
}

function floorObject() {
  return {
    geometry: 'box',
    matrix: new Float32Array([FLOOR_SIZE, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, FLOOR_SIZE, 0, 0, -0.05, 0, 1]),
    material: { color: [0.4, 0.4, 0.4], metallic: 0, roughness: 0.9 },
  };
}

const OUTDOOR_SIZE = 600;
const OUTDOOR_OBJECT_COUNT = 6000;

// A fixed pseudo-random sequence, so every engine and every run places the same objects.
function seededSequence(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function scatteredObjects(count, extent, geometry, material) {
  const next = seededSequence(67);
  const objects = [];
  for (let index = 0; index < count; index++) {
    const scale = 0.8 + next() * 1.2;
    objects.push({ geometry, matrix: translation((next() - 0.5) * extent, scale, (next() - 0.5) * extent, scale), material });
  }
  return objects;
}

const SUN = { direction: [-3, 6, 4], color: [3, 2.8, 2.5] };
const SHARED_MATERIAL = { color: [0.7, 0.45, 0.25], metallic: 0, roughness: 0.5 };

export const BENCHMARK_SCENES = {
  'instanced-objects': {
    description: '5,000 boxes that share a geometry and a material',
    build: () => ({
      geometries: { box: box(0, 1) },
      objects: gridObjects(5000, 1.5, 'box', 0.5, () => SHARED_MATERIAL),
      sun: SUN, pointLights: [], shadowExtent: 0,
      camera: { eye: [0, 40, 70], target: [0, 0, 0], fov: 45, near: 0.5, far: 400 },
    }),
  },
  'large-outdoor': {
    description: `${OUTDOOR_OBJECT_COUNT} spheres of about 1,000 triangles over ${OUTDOOR_SIZE} by ${OUTDOOR_SIZE} units, seen from the edge`,
    build: () => ({
      geometries: { box: box(0, 1), sphere: sphere(32, 16) },
      lods: { sphere: [0.25, 0.06] },
      objects: [
        { geometry: 'box', matrix: new Float32Array([OUTDOOR_SIZE, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, OUTDOOR_SIZE, 0, 0, -0.05, 0, 1]), material: { color: [0.3, 0.4, 0.25], metallic: 0, roughness: 0.9 } },
        ...scatteredObjects(OUTDOOR_OBJECT_COUNT, OUTDOOR_SIZE - 20, 'sphere', SHARED_MATERIAL),
      ],
      sun: SUN, pointLights: [], shadowExtent: 0,
      camera: { eye: [0, 4, -290], target: [0, 3, 0], fov: 60, near: 0.5, far: 900 },
    }),
  },
  'many-materials': {
    description: '1,000 spheres with 1,000 different materials',
    build: () => ({
      geometries: { box: box(0, 1), sphere: sphere(32, 16) },
      objects: [floorObject(), ...gridObjects(1000, 2.2, 'sphere', 0.9, index => ({
        color: hueColor(index, 1000), metallic: index % 2, roughness: 0.2 + (index % 7) * 0.1,
      }))],
      sun: SUN, pointLights: [], shadowExtent: 0,
      camera: { eye: [0, 30, 55], target: [0, 0, 0], fov: 45, near: 0.5, far: 400 },
    }),
  },
  'many-lights': {
    description: '400 spheres lit by 8 point lights',
    build: () => {
      const pointLights = [];
      for (let index = 0; index < 8; index++) {
        const angle = (index / 8) * Math.PI * 2;
        pointLights.push({ position: [Math.cos(angle) * 14, 4, Math.sin(angle) * 14], color: hueColor(index, 8), intensity: 60 });
      }
      return {
        geometries: { box: box(0, 1), sphere: sphere(32, 16) },
        objects: [floorObject(), ...gridObjects(400, 2.2, 'sphere', 0.9, () => SHARED_MATERIAL)],
        sun: { direction: SUN.direction, color: [0, 0, 0] }, pointLights, shadowExtent: 0,
        camera: { eye: [0, 18, 34], target: [0, 0, 0], fov: 45, near: 0.5, far: 400 },
      };
    },
  },
  transparency: {
    description: '300 overlapping translucent spheres that need sorting',
    build: () => ({
      geometries: { box: box(0, 1), sphere: sphere(32, 16) },
      objects: [floorObject(), ...gridObjects(300, 0.9, 'sphere', 0.8, index => ({
        color: hueColor(index, 300), metallic: 0, roughness: 0.3, opacity: 0.4,
      }))],
      sun: SUN, pointLights: [], shadowExtent: 0,
      camera: { eye: [0, 7, 16], target: [0, 0.5, 0], fov: 45, near: 0.5, far: 400 },
    }),
  },
  'moving-shadows': {
    description: '500 moving boxes that cast a directional shadow',
    build: () => {
      const objects = [floorObject(), ...gridObjects(500, 2, 'box', 1, () => SHARED_MATERIAL)];
      return {
        geometries: { box: box(0, 1) },
        objects, sun: SUN, pointLights: [], shadowExtent: 30,
        camera: { eye: [0, 25, 45], target: [0, 0, 0], fov: 45, near: 0.5, far: 400 },
        moving: objects.slice(1),
        update(time) {
          objects.slice(1).forEach((object, index) => {
            object.matrix[13] = 1.5 + Math.sin(time * 2 + index * 0.37);
          });
        },
      };
    },
  },
  'large-mesh': {
    description: 'One sphere with about 1 million triangles',
    build: () => ({
      geometries: { sphere: sphere(1024, 512) },
      objects: [{ geometry: 'sphere', matrix: translation(0, 0, 0, 3), material: SHARED_MATERIAL }],
      sun: SUN, pointLights: [], shadowExtent: 0,
      camera: { eye: [0, 3, 9], target: [0, 0, 0], fov: 45, near: 0.5, far: 100 },
    }),
  },
  'skinned-characters': {
    description: `${CHARACTER_COUNT} animated copies of a CC0 robot, at one spot with different clip times`,
    characters: { count: CHARACTER_COUNT, url: '/tests/fixtures/RobotExpressive.glb' },
    build: () => ({
      geometries: { box: box(0, 1) },
      objects: [floorObject()],
      sun: SUN, pointLights: [], shadowExtent: 12,
      camera: { eye: [2, 3.5, 9], target: [0, 2.4, 0], fov: 35, near: 0.1, far: 200 },
    }),
  },
};
