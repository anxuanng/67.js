import { mat4, quat } from 'gl-matrix';
import { lathe, extrude, tube } from './modeling.js';
import { cylinder, sphere, torus } from './geometry.js';
import { createSceneGraph } from './scene-graph.js';

/** Original mechanical lantern study built with reusable profile, contour and path tools. */
export function createLanternScene({ textures = {} } = {}) {
  const parts = [];
  const brass = { tag: 'metal', color: [0.46, 0.26, 0.085], metallic: 0.92, roughness: 0.3, ...textures.brass };
  const porcelain = { tag: 'ceramic', color: [0.58, 0.68, 0.65], metallic: 0.05, roughness: 0.26, ...textures.porcelain };
  const dark = { tag: 'metal', color: [0.025, 0.041, 0.044], metallic: 0.76, roughness: 0.36, ...textures.brass };
  const glow = { tag: 'light', color: [0.72, 0.33, 0.08], metallic: 0.05, roughness: 0.2, emissiveColor: [1, 0.42, 0.08], emission: 2.2 };
  const steel = { tag: 'metal', color: [0.33, 0.43, 0.45], metallic: 0.95, roughness: 0.22 };
  const meshes = {
    base: lathe([[0, 0.04], [0.7, 0.04], [0.82, 0.075], [0.86, 0.13], [0.86, 0.2], [0.82, 0.25], [0.7, 0.27], [0.65, 0.32], [0.63, 0.41], [0.6, 0.43], [0, 0.43]], { segments: 128 }),
    bowl: lathe([[0, 0.45], [0.34, 0.45], [0.48, 0.5], [0.6, 0.58], [0.66, 0.69], [0.67, 0.76], [0.65, 0.8], [0.61, 0.81], [0.6, 0.76], [0.56, 0.65], [0.46, 0.6], [0.3, 0.58], [0, 0.58]], { segments: 128 }),
    crown: lathe([[0, 2.16], [0.4, 2.16], [0.64, 2.21], [0.68, 2.25], [0.65, 2.3], [0.53, 2.33], [0.46, 2.39], [0.4, 2.5], [0.25, 2.59], [0.16, 2.61], [0.16, 2.65], [0.08, 2.68], [0, 2.68]], { segments: 128 }),
    arch: tube([[0.6, 0.76, 0], [0.88, 1.04, 0.08], [0.86, 1.53, 0.2], [0.63, 1.98, 0.23], [0.54, 2.22, 0]], { radius: 0.035, segments: 72, radialSegments: 12 }),
    innerArch: tube([[0.5, 0.69, 0], [0.62, 1.03, 0], [0.62, 1.63, 0], [0.48, 2.08, 0], [0.5, 2.2, 0]], { radius: 0.014, segments: 56, radialSegments: 8 }),
    bead: sphere(40, 24), bolt: cylinder(8, 0.04, 3), ring: torus(0.014, 96, 12),
  };
  const contour = Array.from({ length: 160 }, (_, index) => {
    const angle = index / 160 * Math.PI * 2;
    const radius = index % 4 < 2 ? 0.72 : 0.685;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  const hole = Array.from({ length: 96 }, (_, index) => {
    const angle = index / 96 * Math.PI * 2;
    return [Math.cos(angle) * 0.6, Math.sin(angle) * 0.6];
  });
  meshes.gear = extrude(contour, { holes: [hole], depth: 0.032, bevel: 0.004, bevelSegments: 2 });
  function add(name, geometry, material, position = [0, 0, 0], scale = [1, 1, 1], angles = [0, 0, 0]) {
    const matrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), ...angles), position, scale);
    parts.push({ name, geometry, material, matrix });
    return parts.at(-1);
  }
  add('Turned porcelain pedestal', meshes.base, porcelain);
  add('Machined lower reflector', meshes.bowl, brass);
  add('Turned brass crown', meshes.crown, brass);
  add('Suspended opal emitter', meshes.bead, glow, [0, 1.47, 0], [0.3, 0.53, 0.3]);
  add('Crown jewel', meshes.bead, steel, [0, 2.73, 0], [0.085, 0.09, 0.085]);
  add('Lower jewel', meshes.bead, glow, [0, 0.7, 0], [0.16, 0.1, 0.16]);
  const rotating = [];
  for (let index = 0; index < 8; index++) {
    const angle = index / 8 * 360;
    add(`Spiral cage rail ${index}`, meshes.arch, brass, [0, 0, 0], [1, 1, 1], [0, angle, 0]);
    add(`Inner cage rail ${index}`, meshes.innerArch, dark, [0, 0, 0], [1, 1, 1], [0, angle + 22.5, 0]);
  }
  for (const height of [0.84, 1.13, 1.81, 2.12]) {
    const radius = height < 1 || height > 2 ? 0.63 : 0.78;
    add(`Cage collar ${height}`, meshes.ring, brass, [0, height, 0], [radius, radius, radius], [90, 0, 0]);
  }
  for (let index = 0; index < 3; index++) {
    const gear = add(`Clockwork ring ${index}`, meshes.gear, index === 1 ? steel : brass, [0, 0.36 + index * 0.035, 0], [1, 1, 1], [-90, 0, 0]);
    rotating.push({ part: gear, base: mat4.clone(gear.matrix), speed: index % 2 ? -0.08 : 0.06 });
  }
  for (let index = 0; index < 24; index++) {
    const angle = index / 24 * Math.PI * 2;
    add(`Base fastener ${index}`, meshes.bolt, steel, [Math.cos(angle) * 0.78, 0.266, Math.sin(angle) * 0.78], [0.024, 0.015, 0.024]);
  }
  for (let index = 0; index < 8; index++) {
    const angle = index / 8 * Math.PI * 2;
    add(`Emitter suspension ${index}`, meshes.innerArch, steel, [0, 0.2, 0], [0.4, 0.8, 0.4], [0, index / 8 * 360, 0]);
    add(`Crown fastener ${index}`, meshes.bolt, steel, [Math.cos(angle) * 0.5, 2.355, Math.sin(angle) * 0.5], [0.021, 0.012, 0.021]);
  }
  const graph = createSceneGraph([
    { name: 'Lantern assembly' },
    ...parts.map(part => ({ ...part, parent: 'Lantern assembly' })),
  ]);
  for (const entry of rotating) entry.localMatrix = graph.getNode(entry.part.name).localMatrix;
  return {
    name: 'Aster lantern', parts: graph.parts, graph,
    sample(time = 0, aspect = 16 / 9) {
      if (!Number.isFinite(time) || !Number.isFinite(aspect) || aspect <= 0) throw new TypeError('Scene time and aspect must be finite, with positive aspect.');
      for (const entry of rotating) {
        entry.localMatrix.set(entry.base);
        mat4.rotateZ(entry.localMatrix, entry.localMatrix, time * entry.speed);
      }
      graph.update();
      const distance = aspect < 1 ? 1.15 : 1;
      return {
        eye: [4.2 * distance, 2.9, 5.2 * distance], target: [0, 1.35, 0], fov: 32, time,
        effects: { bloom: { strength: 0.16, threshold: 1, radius: 1.2 }, saturation: 0.93, contrast: 1.04, temperature: 0.03, vignette: 0.11, grain: 0.004 },
      };
    },
  };
}
