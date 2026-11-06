// Live 3D hero scene for the homepage: HELIOS-67 Orbital Dyson Relay & Autonomous Strider Rig.
// Built with lathe, extrude, and tube modeling tools, brushed metal normal/roughness maps, HDRI sky reflections,
// screen-space MeshBlend basalt monoliths, and a live PBD cloth banner in Glaze (Renderer67).
import { mat4, quat } from 'gl-matrix';
import { Glaze } from './renderer.js';
import { lathe, extrude, tube } from './modeling.js';
import { cylinder, grid, sphere, torus } from './geometry.js';
import { assemblyOffset } from './assembly.js';
import { installMeshBlend } from './mesh-blend.js';
import { createFlagAnimation } from './nature-flag.js';
import { loadHdri } from './hdri.js';

const PROMPTS = {
  model: {
    prompt: '"Build an orbital Dyson relay with counter-rotating gimbals, helical collectors, and a solar plasma core."',
    state: {
      azimuth: 0.54,
      elevation: 0.22,
      distance: 7.4,
      targetHeight: 1.52,
      assembly: 0,
      inspection: false,
      lightDirection: [-3.8, 6.2, 4.4],
      temperature: 0.04,
      contrast: 1.06,
      wind: 0.35,
    },
  },
  explode: {
    prompt: '"Explode the gimbal rings, collector blades, and strider legs 72% outward to inspect the singularity core."',
    state: {
      azimuth: -0.48,
      elevation: 0.26,
      distance: 9.8,
      targetHeight: 1.62,
      assembly: 0.72,
      inspection: false,
      lightDirection: [4.2, 5.8, 3.6],
      temperature: -0.04,
      contrast: 1.07,
      wind: 0.25,
    },
  },
  blend: {
    prompt: '"Fuse volcanic basalt monoliths into the pad with MeshBlend and pin a live PBD wind banner to the mast."',
    state: {
      azimuth: 0.32,
      elevation: 0.14,
      distance: 8.1,
      targetHeight: 1.26,
      assembly: 0.1,
      inspection: false,
      lightDirection: [-5.2, 3.6, 2.8],
      temperature: 0.12,
      contrast: 1.08,
      wind: 0.9,
    },
  },
  review: {
    prompt: '"Inspect surface normals across the turned nozzles and helical tubes before cooking a path-traced still."',
    state: {
      azimuth: 0.82,
      elevation: 0.24,
      distance: 7.6,
      targetHeight: 1.54,
      assembly: 0.28,
      inspection: true,
      lightDirection: [-3.2, 6.0, 4.0],
      temperature: 0,
      contrast: 1.03,
      wind: 0.4,
    },
  },
};

function place(position, scale = [1, 1, 1], degrees = [0, 0, 0]) {
  const orientation = quat.fromEuler(quat.create(), ...degrees);
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

function brushedMaps() {
  const normal = document.createElement('canvas');
  const packed = document.createElement('canvas');
  normal.width = normal.height = packed.width = packed.height = 128;
  const normalContext = normal.getContext('2d');
  const packedContext = packed.getContext('2d');
  const normals = normalContext.createImageData(128, 128);
  const surfaces = packedContext.createImageData(128, 128);
  for (let row = 0; row < 128; row++) {
    for (let col = 0; col < 128; col++) {
      const offset = (row * 128 + col) * 4;
      const brushed = Math.sin(row * 3.8 + Math.sin(col * 0.35) * 0.2);
      normals.data.set([128, Math.round(128 + brushed * 5), 255, 255], offset);
      surfaces.data.set([255, Math.round(212 + brushed * 16), 255, 255], offset);
    }
  }
  normalContext.putImageData(normals, 0, 0);
  packedContext.putImageData(surfaces, 0, 0);
  return {
    normalMap: { image: normal, colorSpace: 'linear' },
    metallicRoughnessMap: { image: packed, colorSpace: 'linear' },
    normalScale: [0.45, 0.45],
  };
}

function buildFlagGeometry(columns = 18, rows = 10, width = 1.45, height = 0.74) {
  const base = grid(columns);
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const normals = new Float32Array(positions.length);
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) {
      const idx = (row * (columns + 1) + col) * 3;
      const u = col / columns;
      const v = row / rows;
      positions[idx] = -(1 - u) * width;
      positions[idx + 1] = (0.5 - v) * height;
      positions[idx + 2] = 0;
      normals[idx + 2] = 1;
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col;
      const b = a + 1;
      const c = a + (columns + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {
    positions,
    normals,
    indices: new Uint32Array(indices),
    pinnedVertices: Array.from({ length: rows + 1 }, (_, row) => row * (columns + 1) + columns),
  };
}

function withUvs(geom) {
  if (geom.uvs) return geom;
  const count = geom.positions.length / 3;
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = geom.positions[i * 3];
    const y = geom.positions[i * 3 + 1];
    const z = geom.positions[i * 3 + 2];
    uvs[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uvs[i * 2 + 1] = y * 0.5 + 0.5;
  }
  return { ...geom, uvs };
}

function createHeliosScene() {
  const maps = brushedMaps();
  const obsidian = { tag: 'metal', color: [0.055, 0.06, 0.085], metallic: 0.88, roughness: 0.26, ...maps };
  const titanium = { tag: 'metal', color: [0.42, 0.46, 0.54], metallic: 0.94, roughness: 0.2, ...maps };
  const gold = { tag: 'metal', color: [0.76, 0.46, 0.14], metallic: 0.95, roughness: 0.22, ...maps };
  const copper = { tag: 'metal', color: [0.64, 0.28, 0.14], metallic: 0.9, roughness: 0.28, ...maps };
  const ceramic = { tag: 'ceramic', color: [0.78, 0.82, 0.88], metallic: 0.08, roughness: 0.22 };
  const solarCore = {
    tag: 'light',
    color: [0.95, 0.45, 0.12],
    metallic: 0.05,
    roughness: 0.15,
    emissiveColor: [1.0, 0.46, 0.1],
    emission: 2.8,
  };
  const cyanGlow = {
    tag: 'light',
    color: [0.16, 0.72, 0.98],
    metallic: 0.1,
    roughness: 0.18,
    emissiveColor: [0.18, 0.78, 1.0],
    emission: 2.1,
  };

  // High-precision procedural meshes
  const gearContour = Array.from({ length: 128 }, (_, i) => {
    const a = (i / 128) * Math.PI * 2;
    const r = i % 4 < 2 ? 0.98 : 0.92;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const gearHole = Array.from({ length: 64 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;
    return [Math.cos(a) * 0.76, Math.sin(a) * 0.76];
  });

  const meridianContour = Array.from({ length: 96 }, (_, i) => {
    const a = (i / 96) * Math.PI * 2;
    const r = i % 6 < 3 ? 1.18 : 1.13;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const meridianHole = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2;
    return [Math.cos(a) * 1.03, Math.sin(a) * 1.03];
  });

  const meshes = {
    pedestal: lathe(
      [
        [0, 0.02], [1.18, 0.02], [1.26, 0.07], [1.22, 0.16], [1.04, 0.22],
        [0.96, 0.3], [0.88, 0.38], [0.74, 0.44], [0.68, 0.54], [0, 0.54],
      ],
      { segments: 96 },
    ),
    lowerNozzle: lathe(
      [
        [0, 0.56], [0.36, 0.56], [0.58, 0.64], [0.74, 0.78], [0.78, 0.92],
        [0.72, 0.95], [0.64, 0.82], [0.46, 0.7], [0.22, 0.66], [0, 0.66],
      ],
      { segments: 96 },
    ),
    upperCrown: lathe(
      [
        [0, 2.52], [0.44, 2.52], [0.72, 2.6], [0.78, 2.68], [0.7, 2.76],
        [0.54, 2.82], [0.42, 2.96], [0.24, 3.08], [0.12, 3.18], [0.04, 3.32], [0, 3.32],
      ],
      { segments: 96 },
    ),
    collectorRib: tube(
      [
        [0.72, 0.84, 0],
        [1.16, 1.22, 0.16],
        [1.24, 1.74, 0.28],
        [1.02, 2.26, 0.2],
        [0.66, 2.58, 0],
      ],
      { radius: 0.036, segments: 56, radialSegments: 10 },
    ),
    innerCoil: tube(
      [
        [0.54, 0.8, 0],
        [0.82, 1.26, -0.14],
        [0.84, 1.82, -0.18],
        [0.58, 2.38, -0.08],
        [0.48, 2.54, 0],
      ],
      { radius: 0.018, segments: 48, radialSegments: 8 },
    ),
    striderLeg: tube(
      [
        [0.88, 0.36, 0],
        [1.36, 0.52, 0.08],
        [1.72, 0.28, 0.04],
        [1.92, 0.04, 0],
      ],
      { radius: 0.055, segments: 36, radialSegments: 10 },
    ),
    gear: extrude(gearContour, { holes: [gearHole], depth: 0.045, bevel: 0.006, bevelSegments: 2 }),
    meridian: extrude(meridianContour, { holes: [meridianHole], depth: 0.06, bevel: 0.008, bevelSegments: 2 }),
    gyroRing: withUvs(torus(0.032, 84, 14)),
    innerRing: withUvs(torus(0.022, 72, 12)),
    orb: withUvs(sphere(44, 28)),
    bolt: withUvs(cylinder(12, 0.04, 2)),
  };

  const parts = [];
  const animated = [];

  function add(name, geometry, material, position = [0, 0, 0], scale = [1, 1, 1], degrees = [0, 0, 0], assembly = [0, 0, 0]) {
    const baseMatrix = place(position, scale, degrees);
    const part = {
      name,
      geometry,
      material,
      matrix: mat4.clone(baseMatrix),
      baseMatrix,
      assembly,
    };
    parts.push(part);
    return part;
  }

  // Pedestal & nozzles
  add('Obsidian reactor plinth', meshes.pedestal, obsidian, [0, 0, 0], [1, 1, 1], [0, 0, 0], [0, -0.7, 0]);
  add('Lower magnetic confinement bell', meshes.lowerNozzle, gold, [0, 0, 0], [1, 1, 1], [0, 0, 0], [0, -0.35, 0]);
  add('Upper Dyson collector crown', meshes.upperCrown, gold, [0, 0, 0], [1, 1, 1], [0, 0, 0], [0, 1.35, 0]);

  // Singularity core & inner plasma shell
  const core = add('Solar plasma singularity core', meshes.orb, solarCore, [0, 1.68, 0], [0.42, 0.42, 0.42], [0, 0, 0], [0, 0, 0]);
  animated.push({ part: core, kind: 'pulse', basePosition: [0, 1.68, 0], baseScale: [0.42, 0.42, 0.42] });

  add('Lower Cerenkov injector', meshes.orb, cyanGlow, [0, 0.88, 0], [0.2, 0.11, 0.2], [0, 0, 0], [0, -0.25, 0]);
  add('Upper Cerenkov injector', meshes.orb, cyanGlow, [0, 2.48, 0], [0.2, 0.11, 0.2], [0, 0, 0], [0, 0.95, 0]);
  add('Apex telemetry jewel', meshes.orb, titanium, [0, 3.38, 0], [0.09, 0.09, 0.09], [0, 0, 0], [0, 1.7, 0]);

  // Counter-rotating base gear rings
  for (let i = 0; i < 2; i++) {
    const g = add(
      `Azimuth drive gear ${i}`,
      meshes.gear,
      i === 0 ? gold : titanium,
      [0, 0.46 + i * 0.055, 0],
      [1, 1, 1],
      [-90, 0, 0],
      [0, -0.45 + i * 0.12, 0],
    );
    animated.push({ part: g, kind: 'spinZ', speed: i === 0 ? 0.18 : -0.24 });
  }

  // 3-Axis Counter-Rotating Gimbal Cage around the core
  const outerGimbal = add(
    'Outer meridian gimbal ring',
    meshes.meridian,
    obsidian,
    [0, 1.68, 0],
    [0.86, 0.86, 0.86],
    [18, 0, 0],
    [0, 0.35, 1.15],
  );
  animated.push({ part: outerGimbal, kind: 'gimbalOuter', center: [0, 1.68, 0], scale: [0.86, 0.86, 0.86] });

  const middleGimbal = add(
    'Middle gold gyroscope ring',
    meshes.gyroRing,
    gold,
    [0, 1.68, 0],
    [0.78, 0.78, 0.78],
    [62, 24, 0],
    [-1.05, 0.25, 0.45],
  );
  animated.push({ part: middleGimbal, kind: 'gimbalMid', center: [0, 1.68, 0], scale: [0.78, 0.78, 0.78] });

  const innerGimbal = add(
    'Inner Cerenkov containment ring',
    meshes.innerRing,
    cyanGlow,
    [0, 1.68, 0],
    [0.58, 0.58, 0.58],
    [35, -40, 0],
    [1.05, 0.2, -0.45],
  );
  animated.push({ part: innerGimbal, kind: 'gimbalInner', center: [0, 1.68, 0], scale: [0.58, 0.58, 0.58] });

  // 10 Helical collector ribs + 10 copper superconducting coils
  for (let i = 0; i < 10; i++) {
    const deg = (i / 10) * 360;
    const rad = (deg * Math.PI) / 180;
    const dirX = Math.cos(rad);
    const dirZ = Math.sin(rad);
    add(
      `Helical collector rib ${i}`,
      meshes.collectorRib,
      i % 2 === 0 ? titanium : obsidian,
      [0, 0, 0],
      [1, 1, 1],
      [0, deg, 0],
      [dirX * 1.15, 0.22, dirZ * 1.15],
    );
    add(
      `Superconducting coil ${i}`,
      meshes.innerCoil,
      copper,
      [0, 0, 0],
      [1, 1, 1],
      [0, deg + 18, 0],
      [dirX * 0.72, 0.1, dirZ * 0.72],
    );
  }

  // Collar containment rings
  for (const [idx, height] of [0.96, 1.32, 2.04, 2.42].entries()) {
    const r = idx === 1 || idx === 2 ? 0.94 : 0.74;
    add(
      `Containment collar ${idx}`,
      meshes.gyroRing,
      idx % 2 === 0 ? gold : titanium,
      [0, height, 0],
      [r, r, r],
      [90, 0, 0],
      [0, (idx - 1.5) * 0.55, 0],
    );
  }

  // 6 Heavy articulated strider anchor legs + footpads + cyan beacon nodes
  for (let i = 0; i < 6; i++) {
    const deg = (i / 6) * 360 + 15;
    const rad = (deg * Math.PI) / 180;
    const dirX = Math.cos(rad);
    const dirZ = Math.sin(rad);
    add(
      `Strider anchor leg ${i}`,
      meshes.striderLeg,
      obsidian,
      [0, 0, 0],
      [1, 1, 1],
      [0, deg, 0],
      [dirX * 1.25, -0.3, dirZ * 1.25],
    );
    add(
      `Strider footpad ${i}`,
      meshes.bolt,
      gold,
      [dirX * 1.92, 0.04, -dirZ * 1.92],
      [0.22, 0.04, 0.22],
      [0, deg, 0],
      [dirX * 1.4, -0.45, -dirZ * 1.4],
    );
    add(
      `Strider knee node ${i}`,
      meshes.orb,
      i % 2 === 0 ? cyanGlow : solarCore,
      [dirX * 1.36, 0.54, -dirZ * 1.36],
      [0.055, 0.055, 0.055],
      [0, 0, 0],
      [dirX * 1.35, -0.1, -dirZ * 1.35],
    );
  }

  // 16 Radial pedestal bolts
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    add(
      `Plinth bolt ${i}`,
      meshes.bolt,
       ceramic,
      [Math.cos(a) * 1.12, 0.19, Math.sin(a) * 1.12],
      [0.032, 0.02, 0.032],
      [0, 0, 0],
      [Math.cos(a) * 0.45, -0.5, Math.sin(a) * 0.45],
    );
  }

  // 3 Autonomous orbital recon drones
  for (let i = 0; i < 3; i++) {
    const drone = add(
      `Orbital recon drone ${i}`,
      meshes.orb,
      i === 0 ? solarCore : cyanGlow,
      [1.8, 1.8, 0],
      [0.075, 0.045, 0.075],
      [0, 0, 0],
      [Math.cos(i * 2.1) * 0.9, 0.6, Math.sin(i * 2.1) * 0.9],
    );
    animated.push({ part: drone, kind: 'drone', index: i, radius: 1.58 + i * 0.18, height: 1.45 + i * 0.32 });
  }

  return { parts, animated };
}

export function mountHeroAgentWorkbench() {
  return mountHomeAgentHero();
}

export function mountHomeAgentHero() {
  const canvas = document.querySelector('#hero-viewport');
  const frame = document.querySelector('.hero-frame');
  if (!canvas || !frame) return;

  let helios;
  let allParts;
  let renderer;
  let flagAnimation;
  try {
    helios = createHeliosScene();

    // Volcanic obsidian landing pad + MeshBlend basalt monoliths + live PBD Cloth banner
    const groundDisk = cylinder(64, 0.01, 2);
    const basaltSpire = sphere(20, 14);
    const poleMesh = cylinder(16, 0.03, 2);
    const flagGeometry = buildFlagGeometry(18, 10, 1.45, 0.74);

    const groundMaterial = { tag: 'floor', color: [0.09, 0.085, 0.12], metallic: 0.12, roughness: 0.84 };
    const basaltMaterial = { tag: 'rock', color: [0.13, 0.12, 0.16], metallic: 0.18, roughness: 0.76, blend: { radius: 0.24 } };
    const mastMaterial = { tag: 'metal', color: [0.58, 0.62, 0.7], metallic: 0.88, roughness: 0.24 };
    const flagMaterial = {
      tag: 'cloth',
      color: [0.92, 0.36, 0.09],
      metallic: 0.08,
      roughness: 0.62,
      doubleSided: true,
    };

    const flagPart = {
      name: 'Expedition wind banner',
      geometry: flagGeometry,
      matrix: place([-2.55, 2.28, -1.25], [1, 1, 1], [0, 26, 0]),
      material: flagMaterial,
    };

    const environmentParts = [
      {
        name: 'Landing pad ground',
        geometry: groundDisk,
        matrix: place([0, -0.02, 0], [6.4, 0.04, 6.4]),
        material: groundMaterial,
      },
      {
        name: 'Basalt monolith West',
        geometry: basaltSpire,
        matrix: place([-2.25, 0.24, 1.18], [0.82, 0.56, 0.68], [8, 22, -6]),
        material: basaltMaterial,
      },
      {
        name: 'Basalt monolith West shard',
        geometry: basaltSpire,
        matrix: place([-1.68, 0.12, 1.54], [0.46, 0.3, 0.42], [-5, 45, 11]),
        material: basaltMaterial,
      },
      {
        name: 'Basalt monolith East',
        geometry: basaltSpire,
        matrix: place([2.35, 0.28, -0.92], [0.92, 0.62, 0.74], [-6, -28, 8]),
        material: basaltMaterial,
      },
      {
        name: 'Basalt monolith East outcrop',
        geometry: basaltSpire,
        matrix: place([1.84, 0.14, -1.48], [0.52, 0.32, 0.46], [9, 14, -10]),
        material: basaltMaterial,
      },
      {
        name: 'Telemetry mast',
        geometry: poleMesh,
        matrix: place([-2.55, 1.38, -1.25], [0.04, 1.38, 0.04]),
        material: mastMaterial,
      },
      flagPart,
    ];

    allParts = [...helios.parts, ...environmentParts];

    renderer = new Glaze(canvas, allParts, {
      hdr: true,
      ground: false,
      depth: true,
      samples: 4,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.75),
      memoryBudgetMiB: 192,
      environment: {
        pointLights: [
          { position: [0, 1.68, 0], color: [1.0, 0.54, 0.18], intensity: 6.5, range: 8, radius: 0.12 },
          { position: [-2.4, 2.6, 2.2], color: [0.24, 0.74, 1.0], intensity: 4.2, range: 10, radius: 0.15 },
        ],
      },
    });
    installMeshBlend(renderer);
    flagAnimation = createFlagAnimation(renderer, flagPart);
  } catch (err) {
    window.__heroWorkbench = { error: err.message };
    return;
  }

  frame.dataset.live = 'true';
  frame.dataset.live = 'true';
  frame.classList.add('is-live-3d');

  // Load preview HDRI asynchronously for real sky reflections on brushed gold & obsidian
  let envMap = null;
  loadHdri('./showcase/datacenter/sky.preview.hdr')
    .then(map => {
      envMap = map;
    })
    .catch(() => {});

  const current = { ...PROMPTS.model.state };
  let target = { ...PROMPTS.model.state };
  let activeKey = 'model';
  let dragging = false;
  let userInteracted = false;
  let pointerStart = [0, 0];
  let orbitStart = [0, 0];
  let simTime = 0;
  let lastNow = performance.now();

  const promptEl = document.querySelector('[data-agent-prompt]');
  const presetButtons = [...document.querySelectorAll('[data-prompt-preset]')];

  function applyPresetUI(key) {
    const preset = PROMPTS[key];
    if (!preset) return;
    activeKey = key;
    target = { ...preset.state };
    presetButtons.forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.promptPreset === key));
    });
    if (promptEl) promptEl.textContent = preset.prompt;
  }

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      userInteracted = true;
      applyPresetUI(btn.dataset.promptPreset);
    });
  });

  const presetKeys = Object.keys(PROMPTS);
  const autoCycle = setInterval(() => {
    if (userInteracted || document.hidden) return;
    const nextIdx = (presetKeys.indexOf(activeKey) + 1) % presetKeys.length;
    applyPresetUI(presetKeys[nextIdx]);
  }, 6500);

  canvas.addEventListener('pointerdown', event => {
    userInteracted = true;
    dragging = true;
    pointerStart = [event.clientX, event.clientY];
    orbitStart = [target.azimuth, target.elevation];
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - pointerStart[0];
    const dy = event.clientY - pointerStart[1];
    target.azimuth = orbitStart[0] - dx * 0.0065;
    target.elevation = Math.max(0.05, Math.min(1.15, orbitStart[1] + dy * 0.0055));
  });

  const endDrag = () => { dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function updateRigTransforms(assemblyAmount, time) {
    // Animate dynamic parts first
    for (const item of helios.animated) {
      if (item.kind === 'pulse') {
        const s = 1 + Math.sin(time * 3.2) * 0.055;
        mat4.fromRotationTranslationScale(
          item.part.baseMatrix,
          quat.create(),
          item.basePosition,
          item.baseScale.map(v => v * s),
        );
      } else if (item.kind === 'spinZ') {
        const q = quat.fromEuler(quat.create(), -90, (time * item.speed * 180) / Math.PI, 0);
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, [0, item.part.baseMatrix[13], 0], [1, 1, 1]);
      } else if (item.kind === 'gimbalOuter') {
        const q = quat.fromEuler(quat.create(), 18, (time * 0.38 * 180) / Math.PI, 12);
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, item.center, item.scale);
      } else if (item.kind === 'gimbalMid') {
        const q = quat.fromEuler(quat.create(), 62 + Math.sin(time * 0.7) * 22, (-time * 0.62 * 180) / Math.PI, 24);
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, item.center, item.scale);
      } else if (item.kind === 'gimbalInner') {
        const q = quat.fromEuler(quat.create(), (time * 1.15 * 180) / Math.PI, -40, (time * 0.85 * 180) / Math.PI);
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, item.center, item.scale);
      } else if (item.kind === 'drone') {
        const a = time * (0.65 + item.index * 0.18) + item.index * 2.09;
        const pos = [
          Math.cos(a) * item.radius,
          item.height + Math.sin(time * 1.8 + item.index) * 0.18,
          Math.sin(a) * item.radius,
        ];
        mat4.fromRotationTranslationScale(item.part.baseMatrix, quat.create(), pos, [0.075, 0.045, 0.075]);
      }
    }

    // Apply exploded assembly vectors
    for (const part of helios.parts) {
      const offset = assemblyOffset(part.assembly, assemblyAmount);
      part.matrix.set(part.baseMatrix);
      part.matrix[12] += offset[0];
      part.matrix[13] += offset[1];
      part.matrix[14] += offset[2];
    }
    renderer.updateParts(allParts);
  }

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
  });
  resizeObserver.observe(canvas);

  let rafId = 0;
  function tick(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
    lastNow = now;
    simTime += dt;

    const blend = 1 - Math.exp(-dt * 5.5);
    if (!dragging) {
      target.azimuth += dt * 0.11;
    }
    current.azimuth += (target.azimuth - current.azimuth) * blend;
    current.elevation += (target.elevation - current.elevation) * blend;
    current.distance += (target.distance - current.distance) * blend;
    current.targetHeight += (target.targetHeight - current.targetHeight) * blend;
    current.assembly += (target.assembly - current.assembly) * blend;
    current.temperature += (target.temperature - current.temperature) * blend;
    current.contrast += (target.contrast - current.contrast) * blend;
    current.wind += (target.wind - current.wind) * blend;
    current.inspection = target.inspection;
    for (let i = 0; i < 3; i++) {
      current.lightDirection[i] += (target.lightDirection[i] - current.lightDirection[i]) * blend;
    }

    updateRigTransforms(current.assembly, simTime);
    flagAnimation.update(simTime, current.wind);

    const cosEl = Math.cos(current.elevation);
    const eye = [
      Math.sin(current.azimuth) * cosEl * current.distance,
      current.targetHeight + Math.sin(current.elevation) * current.distance,
      Math.cos(current.azimuth) * cosEl * current.distance,
    ];

    renderer.render({
      eye,
      target: [0, current.targetHeight, 0],
      fov: 35,
      time: simTime,
      inspection: current.inspection,
      environment: {
        lightDirection: current.lightDirection,
        wind: current.wind,
        ...(envMap ? { map: envMap } : {}),
        pointLights: [
          { position: [0, 1.68, 0], color: [1.0, 0.54, 0.18], intensity: 6.5, range: 8, radius: 0.12 },
          { position: [-2.4, 2.6, 2.2], color: [0.24, 0.74, 1.0], intensity: 4.2, range: 10, radius: 0.15 },
        ],
      },
      effects: {
        bloom: { strength: 0.24, threshold: 0.9, radius: 1.2 },
        contrast: current.contrast,
        temperature: current.temperature,
        vignette: 0.14,
      },
    });

    rafId = requestAnimationFrame(tick);
  }

  updateRigTransforms(0, 0);
  renderer.resize();
  rafId = requestAnimationFrame(tick);

  window.__heroWorkbench = { renderer, applyPresetUI };
  window.addEventListener('pagehide', () => {
    clearInterval(autoCycle);
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    renderer.dispose();
  });
}
