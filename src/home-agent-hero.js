// Live 3D hero world for the homepage: TARNISHED CRUCIBLE SENTINEL & SANCTUARY OF GOLDEN GRACE.
// An articulated Elden Ring-style armored knight with a 17-joint humanoid rig, Colossal Crucible Greatsword,
// Golden Order Greatshield, and a live PBD cloth sovereign cape standing before a glowing Site of Grace
// in a sunlit Gothic colonnade courtyard with wind-swaying trees and crisp high-contrast shadow casting in Glaze.
import './world-material-shader.js';
import { mat4, quat } from 'gl-matrix';
import { Glaze } from './renderer.js';
import { lathe, extrude, tube } from './modeling.js';
import { cylinder, sphere, torus } from './geometry.js';
import { assemblyOffset } from './assembly.js';
import { installMeshBlend } from './mesh-blend.js';
import { createFlagAnimation } from './nature-flag.js';
import { createEnvironmentMap } from './environment.js';
import { loadHdri } from './hdri.js';
import { createTree, vegetationParts, createGrassClump } from './vegetation.js';

const PROMPTS = {
  model: {
    prompt: '"Model an Elden Ring Crucible Sentinel with a winged greathelm, colossal greatsword, PBD cloth cape, and Site of Grace in a sunlit sanctuary."',
    state: {
      azimuth: 0.42,
      elevation: 0.22,
      distance: 7.4,
      targetHeight: 1.62,
      assembly: 0,
      animMode: 'idle',
      inspection: false,
      lightDirection: [-4.4, 5.2, 3.8],
      temperature: 0.06,
      contrast: 1.13,
      wind: 0.48,
    },
  },
  explode: {
    prompt: '"Explode the winged greathelm, Gothic plate cuirass, pauldrons, gauntlets, greaves, and colossal greatsword outward with live shadows."',
    state: {
      azimuth: -0.44,
      elevation: 0.26,
      distance: 9.2,
      targetHeight: 1.72,
      assembly: 0.78,
      animMode: 'idle',
      inspection: false,
      lightDirection: [4.6, 5.4, 3.6],
      temperature: -0.02,
      contrast: 1.12,
      wind: 0.38,
    },
  },
  blend: {
    prompt: '"Unleash the Ash-of-War greatsword slash, whip the PBD sovereign cape in golden-hour wind, and MeshBlend mossy runestones into the courtyard."',
    state: {
      azimuth: 0.24,
      elevation: 0.17,
      distance: 6.8,
      targetHeight: 1.48,
      assembly: 0,
      animMode: 'slash',
      inspection: false,
      lightDirection: [-5.6, 3.7, 3.4],
      temperature: 0.14,
      contrast: 1.15,
      wind: 0.96,
    },
  },
  review: {
    prompt: '"Inspect world-space surface normals across the fluted greathelm, Erdtree chest filigree, and beveled greatsword fuller."',
    state: {
      azimuth: 0.68,
      elevation: 0.24,
      distance: 6.2,
      targetHeight: 1.78,
      assembly: 0.18,
      animMode: 'idle',
      inspection: true,
      lightDirection: [-3.8, 5.8, 4.0],
      temperature: 0,
      contrast: 1.05,
      wind: 0.42,
    },
  },
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function place(position, scale = [1, 1, 1], degrees = [0, 0, 0]) {
  const orientation = quat.fromEuler(quat.create(), ...degrees);
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

function createProceduralSunSkyHdri(width = 128, height = 64) {
  const data = new Float32Array(width * height * 4);
  const sunLen = Math.hypot(-0.56, 0.64, 0.52);
  const sunDir = [-0.56 / sunLen, 0.64 / sunLen, 0.52 / sunLen];

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    const dirY = Math.cos(theta);
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * Math.PI * 2;
      const dirX = Math.cos(phi) * sinTheta;
      const dirZ = Math.sin(phi) * sinTheta;
      const idx = (y * width + x) * 4;

      if (dirY >= -0.05) {
        const t = clamp((dirY + 0.05) / 1.05, 0, 1);
        const zenith = Math.pow(t, 0.55);
        const horizonGlow = Math.pow(1 - t, 3.0);
        let r = mix(0.90, 0.18, zenith) + horizonGlow * 0.48;
        let g = mix(0.78, 0.36, zenith) + horizonGlow * 0.26;
        let b = mix(0.64, 0.70, zenith) + horizonGlow * 0.08;

        const sunDot = Math.max(0, dirX * sunDir[0] + dirY * sunDir[1] + dirZ * sunDir[2]);
        const sunHalo = Math.pow(sunDot, 16) * 1.25 + Math.pow(sunDot, 160) * 5.8;
        r += sunHalo * 1.28;
        g += sunHalo * 0.94;
        b += sunHalo * 0.56;

        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 1;
      } else {
        const gnd = clamp((-dirY - 0.05) / 0.95, 0, 1);
        data[idx + 0] = mix(0.44, 0.20, gnd);
        data[idx + 1] = mix(0.40, 0.18, gnd);
        data[idx + 2] = mix(0.34, 0.15, gnd);
        data[idx + 3] = 1;
      }
    }
  }

  return createEnvironmentMap({
    width,
    height,
    data,
    intensity: 0.84,
    rotation: 0.35,
    showBackground: true,
  });
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
      normals.data.set([128, Math.round(128 + brushed * 6), 255, 255], offset);
      surfaces.data.set([255, Math.round(206 + brushed * 18), 255, 255], offset);
    }
  }
  normalContext.putImageData(normals, 0, 0);
  packedContext.putImageData(surfaces, 0, 0);
  return {
    normalMap: { image: normal, colorSpace: 'linear' },
    metallicRoughnessMap: { image: packed, colorSpace: 'linear' },
    normalScale: [0.48, 0.48],
  };
}

function travertineStoneMaps() {
  const size = 128;
  const normal = document.createElement('canvas');
  const packed = document.createElement('canvas');
  normal.width = normal.height = packed.width = packed.height = size;
  const normalCtx = normal.getContext('2d');
  const packedCtx = packed.getContext('2d');
  const normals = normalCtx.createImageData(size, size);
  const surfaces = packedCtx.createImageData(size, size);

  const tiles = 8;
  const step = size / tiles;
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = Math.floor(x / step);
      const ty = Math.floor(y / step);
      const lx = (x % step) / step;
      const ly = (y % step) / step;
      const edge = Math.min(lx, 1 - lx, ly, 1 - ly);
      const groove = clamp(edge / 0.08, 0, 1);
      const vein =
        Math.sin((x + ty * 11) * 0.18 + Math.sin(y * 0.1) * 1.6) * 0.5 +
        Math.cos((y - tx * 7) * 0.14) * 0.5;
      heights[y * size + x] = groove * (0.85 + vein * 0.08);

      const offset = (y * size + x) * 4;
      const rough = Math.round(clamp((0.46 - vein * 0.05) * groove + 0.88 * (1 - groove), 0.25, 0.95) * 255);
      surfaces.data.set([255, rough, 12, 255], offset);
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = heights[y * size + ((x - 1 + size) % size)];
      const hR = heights[y * size + ((x + 1) % size)];
      const hD = heights[((y - 1 + size) % size) * size + x];
      const hU = heights[((y + 1) % size) * size + x];
      const dx = (hL - hR) * 2.4;
      const dy = (hD - hU) * 2.4;
      const len = Math.hypot(dx, dy, 1.0) || 1;
      const offset = (y * size + x) * 4;
      normals.data.set(
        [
          Math.round(((dx / len) * 0.5 + 0.5) * 255),
          Math.round(((dy / len) * 0.5 + 0.5) * 255),
          Math.round(((1 / len) * 0.5 + 0.5) * 255),
          255,
        ],
        offset,
      );
    }
  }

  normalCtx.putImageData(normals, 0, 0);
  packedCtx.putImageData(surfaces, 0, 0);
  return {
    normalMap: { image: normal, colorSpace: 'linear' },
    metallicRoughnessMap: { image: packed, colorSpace: 'linear' },
    normalScale: [0.75, 0.75],
  };
}

// Builds a vertical sovereign cape mesh hanging downward (-Y) from the knight's shoulder bar (row 0 pinned)
function buildSovereignCapeGeometry(columns = 14, rows = 18, width = 0.86, height = 1.48) {
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const normals = new Float32Array(positions.length);
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) {
      const idx = (row * (columns + 1) + col) * 3;
      const u = col / columns;
      const v = row / rows;
      // Flare wider toward the bottom hem like a royal Elden Ring mantle
      const flare = 1.0 + v * 0.42;
      positions[idx + 0] = (u - 0.5) * width * flare;
      positions[idx + 1] = -v * height;
      positions[idx + 2] = -v * 0.18 - Math.sin(u * Math.PI) * 0.04;
      normals[idx + 2] = -1;
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
    // Pin top row across the knight's shoulder pauldrons
    pinnedVertices: Array.from({ length: columns + 1 }, (_, col) => col),
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

function createArchRibContour() {
  const pts = [];
  const outerSegs = 28;
  for (let i = 0; i <= outerSegs; i++) {
    const a = (i / outerSegs) * Math.PI;
    pts.push([Math.cos(a) * 1.12, Math.sin(a) * 0.82]);
  }
  const innerSegs = 24;
  for (let i = innerSegs; i >= 0; i--) {
    const a = (i / innerSegs) * Math.PI;
    pts.push([Math.cos(a) * 0.84, Math.sin(a) * 0.56]);
  }
  return pts;
}

// Extruded Colossal Greatsword blade contour with a central fuller blood-groove cutout
function createGreatswordBladeGeometry() {
  const contour = [
    [-0.085, 0.0],
    [-0.115, 0.14],
    [-0.095, 0.28],
    [-0.125, 0.34],
    [-0.088, 0.44],
    [-0.068, 1.48],
    [-0.042, 1.84],
    [0.0, 2.08],
    [0.042, 1.84],
    [0.068, 1.48],
    [0.088, 0.44],
    [0.125, 0.34],
    [0.095, 0.28],
    [0.115, 0.14],
    [0.085, 0.0],
  ];
  const fullerHole = [
    [-0.022, 0.18],
    [0.022, 0.18],
    [0.016, 1.32],
    [-0.016, 1.32],
  ];
  return withUvs(
    extrude(contour, {
      holes: [fullerHole],
      depth: 0.032,
      bevel: 0.008,
      bevelSegments: 2,
    }),
  );
}

// Extruded Crucible Winged Crossguard
function createCrossguardGeometry() {
  const contour = [
    [-0.42, 0.08],
    [-0.32, 0.12],
    [-0.16, 0.045],
    [0.0, 0.065],
    [0.16, 0.045],
    [0.32, 0.12],
    [0.42, 0.08],
    [0.36, 0.01],
    [0.18, -0.04],
    [0.0, -0.06],
    [-0.18, -0.04],
    [-0.36, 0.01],
  ];
  return withUvs(
    extrude(contour, {
      depth: 0.068,
      bevel: 0.012,
      bevelSegments: 2,
    }),
  );
}

// Extruded Golden Order Heater/Kite Greatshield
function createGreatshieldGeometry() {
  const contour = [
    [-0.34, 0.48],
    [0.0, 0.56],
    [0.34, 0.48],
    [0.38, 0.16],
    [0.30, -0.24],
    [0.16, -0.52],
    [0.0, -0.68],
    [-0.16, -0.52],
    [-0.30, -0.24],
    [-0.38, 0.16],
  ];
  return withUvs(
    extrude(contour, {
      depth: 0.048,
      bevel: 0.014,
      bevelSegments: 2,
    }),
  );
}

// Extruded Tasset / Cuirass Crest Plate
function createTassetPlateGeometry() {
  const contour = [
    [-0.14, 0.18],
    [0.14, 0.18],
    [0.17, -0.08],
    [0.0, -0.24],
    [-0.17, -0.08],
  ];
  return withUvs(
    extrude(contour, {
      depth: 0.032,
      bevel: 0.008,
      bevelSegments: 2,
    }),
  );
}

// Extruded Erdtree Chest Emblem
function createErdtreeCrestGeometry() {
  const contour = [
    [-0.03, -0.22],
    [0.03, -0.22],
    [0.035, -0.04],
    [0.20, 0.02],
    [0.22, 0.07],
    [0.04, 0.03],
    [0.14, 0.16],
    [0.11, 0.21],
    [0.0, 0.10],
    [-0.11, 0.21],
    [-0.14, 0.16],
    [-0.04, 0.03],
    [-0.22, 0.07],
    [-0.20, 0.02],
    [-0.035, -0.04],
  ];
  return withUvs(
    extrude(contour, {
      depth: 0.028,
      bevel: 0.006,
      bevelSegments: 2,
    }),
  );
}

function createEldenSanctuaryScene() {
  const metalMaps = brushedMaps();
  const stoneMaps = travertineStoneMaps();

  const travertineStone = {
    tag: 'ceramic',
    color: [0.87, 0.82, 0.74],
    metallic: 0.04,
    roughness: 0.44,
    ...stoneMaps,
  };
  const carvedLimestone = {
    tag: 'ceramic',
    color: [0.92, 0.88, 0.81],
    metallic: 0.03,
    roughness: 0.36,
  };
  const basaltTrim = {
    tag: 'rock',
    color: [0.18, 0.21, 0.25],
    metallic: 0.16,
    roughness: 0.42,
  };
  // Blackened Damascus Steel for the Knight's Gothic plate armor
  const damascusSteel = {
    tag: 'metal',
    color: [0.18, 0.21, 0.26],
    metallic: 0.92,
    roughness: 0.22,
    ...metalMaps,
  };
  // Silvered Carian / Moonlight Steel for blade and fluted highlights
  const flutedSilver = {
    tag: 'metal',
    color: [0.66, 0.71, 0.78],
    metallic: 0.96,
    roughness: 0.16,
    ...metalMaps,
  };
  // Crucible / Golden Order Brushed Gold
  const crucibleGold = {
    tag: 'metal',
    color: [0.88, 0.64, 0.24],
    metallic: 0.95,
    roughness: 0.19,
    ...metalMaps,
  };
  // Ordovis Red-Gold Bronze for pauldrons, helm wings & shield rim
  const crucibleBronze = {
    tag: 'metal',
    color: [0.72, 0.42, 0.22],
    metallic: 0.91,
    roughness: 0.24,
    ...metalMaps,
  };
  // Crimson Plume & Surcoat Tabard
  const crimsonVelvet = {
    tag: 'cloth',
    color: [0.68, 0.12, 0.10],
    metallic: 0.05,
    roughness: 0.64,
  };
  // Glowing Golden Grace & Rune Blade Core
  const graceGold = {
    tag: 'light',
    color: [1.0, 0.74, 0.22],
    metallic: 0.05,
    roughness: 0.12,
    emissiveColor: [1.0, 0.68, 0.16],
    emission: 3.4,
  };
  // Moonlight / Carian Rune Glow
  const moonlightGlow = {
    tag: 'light',
    color: [0.28, 0.82, 1.0],
    metallic: 0.1,
    roughness: 0.16,
    emissiveColor: [0.24, 0.78, 1.0],
    emission: 2.4,
  };
  const waterPool = {
    tag: 'water',
    color: [0.12, 0.40, 0.48],
    metallic: 0.08,
    roughness: 0.08,
  };
  const meadowTurf = {
    tag: 'terrain',
    color: [0.28, 0.45, 0.22],
    metallic: 0.02,
    roughness: 0.86,
  };

  // Sculpted Blender-style meshes via lathe, extrude, and tube
  const meshes = {
    steppedAltar: withUvs(
      lathe(
        [
          [0, 0.0],
          [3.15, 0.0],
          [3.15, 0.12],
          [2.82, 0.15],
          [2.78, 0.27],
          [2.42, 0.30],
          [2.38, 0.42],
          [2.12, 0.45],
          [0, 0.45],
        ],
        { segments: 96 },
      ),
    ),
    columnPillar: withUvs(
      lathe(
        [
          [0, 0.0],
          [0.38, 0.0],
          [0.38, 0.14],
          [0.31, 0.22],
          [0.25, 0.32],
          [0.23, 1.75],
          [0.20, 3.10],
          [0.26, 3.22],
          [0.35, 3.34],
          [0.38, 3.46],
          [0, 3.46],
        ],
        { segments: 48 },
      ),
    ),
    archRib: withUvs(
      extrude(createArchRibContour(), { depth: 0.24, bevel: 0.025, bevelSegments: 2 }),
    ),
    // Sculpted Gothic Greathelm (turned dome, visor ridge, gorget neck flare)
    greathelm: withUvs(
      lathe(
        [
          [0.0, -0.14],
          [0.16, -0.14],
          [0.13, -0.06],
          [0.145, 0.04],
          [0.155, 0.14],
          [0.148, 0.24],
          [0.115, 0.31],
          [0.04, 0.36],
          [0.0, 0.38],
        ],
        { segments: 48 },
      ),
    ),
    // Swept Crucible Valkyrie Wing for the Greathelm
    helmWingRight: withUvs(
      tube(
        [
          [0.12, 0.12, 0.0],
          [0.22, 0.20, -0.04],
          [0.32, 0.34, -0.10],
          [0.36, 0.50, -0.16],
          [0.28, 0.64, -0.22],
        ],
        { radius: 0.028, segments: 28, radialSegments: 10 },
      ),
    ),
    helmWingLeft: withUvs(
      tube(
        [
          [-0.12, 0.12, 0.0],
          [-0.22, 0.20, -0.04],
          [-0.32, 0.34, -0.10],
          [-0.36, 0.50, -0.16],
          [-0.28, 0.64, -0.22],
        ],
        { radius: 0.028, segments: 28, radialSegments: 10 },
      ),
    ),
    // Flowing Horsehair Plume Crest
    helmPlume: withUvs(
      tube(
        [
          [0.0, 0.34, 0.02],
          [0.0, 0.46, -0.08],
          [0.0, 0.42, -0.26],
          [0.0, 0.26, -0.42],
          [0.0, 0.06, -0.50],
        ],
        { radius: 0.046, segments: 28, radialSegments: 12 },
      ),
    ),
    // Anatomically sculpted Gothic Cuirass Torso (lathe profile scaled wider in X)
    cuirass: withUvs(
      lathe(
        [
          [0.0, -0.26],
          [0.18, -0.26],
          [0.19, -0.14],
          [0.21, -0.02],
          [0.26, 0.14],
          [0.28, 0.28],
          [0.24, 0.40],
          [0.16, 0.46],
          [0.0, 0.46],
        ],
        { segments: 48 },
      ),
    ),
    // Armored Waist Faulds & Royal Tabard Skirt
    fauldsSkirt: withUvs(
      lathe(
        [
          [0.0, -0.44],
          [0.28, -0.44],
          [0.26, -0.28],
          [0.23, -0.12],
          [0.20, 0.0],
          [0.0, 0.0],
        ],
        { segments: 44 },
      ),
    ),
    // Sculpted Shoulder Pauldron Dome
    pauldronDome: withUvs(
      lathe(
        [
          [0.0, -0.12],
          [0.18, -0.12],
          [0.21, -0.04],
          [0.19, 0.06],
          [0.13, 0.14],
          [0.0, 0.16],
        ],
        { segments: 36 },
      ),
    ),
    // Turned Limb Armor Segment (Rerebrace, Vambrace, Cuisse, Fluted Greave)
    limbArmor: withUvs(
      lathe(
        [
          [0.0, -0.22],
          [0.075, -0.22],
          [0.088, -0.10],
          [0.102, 0.06],
          [0.092, 0.20],
          [0.0, 0.22],
        ],
        { segments: 32 },
      ),
    ),
    // Turned Sword Grip & Pommel
    swordHilt: withUvs(
      lathe(
        [
          [0.0, -0.48],
          [0.062, -0.44],
          [0.032, -0.36],
          [0.036, -0.18],
          [0.032, 0.0],
          [0.0, 0.0],
        ],
        { segments: 28 },
      ),
    ),
    // Site of Grace Twisted Golden Root Spire
    graceSpire: withUvs(
      tube(
        [
          [0.0, 0.45, 0.0],
          [0.04, 0.68, 0.03],
          [-0.03, 0.92, -0.02],
          [0.02, 1.18, 0.02],
          [0.0, 1.42, 0.0],
        ],
        { radius: 0.038, segments: 32, radialSegments: 10 },
      ),
    ),
    greatswordBlade: createGreatswordBladeGeometry(),
    crossguard: createCrossguardGeometry(),
    greatshield: createGreatshieldGeometry(),
    tassetPlate: createTassetPlateGeometry(),
    erdtreeCrest: createErdtreeCrestGeometry(),
    curbRing: withUvs(torus(0.022, 96, 16)),
    beltRing: withUvs(torus(0.045, 48, 12)),
    orb: withUvs(sphere(36, 24)),
    bolt: withUvs(cylinder(24, 0.04, 2)),
    disk: withUvs(cylinder(72, 0.015, 2)),
  };

  const staticParts = [];
  const characterRigParts = [];
  const floatingMotes = [];

  function addStatic(
    name,
    geometry,
    material,
    position = [0, 0, 0],
    scale = [1, 1, 1],
    degrees = [0, 0, 0],
    assembly = [0, 0, 0],
  ) {
    const baseMatrix = place(position, scale, degrees);
    const part = {
      name,
      geometry,
      material,
      matrix: mat4.clone(baseMatrix),
      baseMatrix,
      assembly,
    };
    staticParts.push(part);
    return part;
  }

  // Attach a part to one of the Knight's hierarchical bones!
  function addRigPart(
    name,
    boneName,
    geometry,
    material,
    localPos = [0, 0, 0],
    localScale = [1, 1, 1],
    localDeg = [0, 0, 0],
    assembly = [0, 0, 0],
  ) {
    const localMatrix = place(localPos, localScale, localDeg);
    const part = {
      name,
      boneName,
      geometry,
      material,
      localMatrix,
      matrix: mat4.create(),
      baseMatrix: mat4.create(),
      assembly,
    };
    characterRigParts.push(part);
    return part;
  }

  // ============================================================================
  // 1. SUNLIT ELDEN RING SANCTUARY COURTYARD & ARCHITECTURAL COLONNADE
  // ============================================================================
  addStatic('Outer meadow terrace', meshes.disk, meadowTurf, [0, -0.14, 0], [8.6, 0.08, 8.6]);
  addStatic('Sunlit travertine courtyard plaza', meshes.disk, travertineStone, [0, -0.05, 0], [6.6, 0.06, 6.6]);
  addStatic('Courtyard basalt perimeter curb', meshes.curbRing, basaltTrim, [0, 0.02, 0], [6.45, 6.45, 3.2], [90, 0, 0]);
  addStatic('Reflecting basin water surface', meshes.disk, waterPool, [0, 0.02, 0], [4.35, 0.02, 4.35]);
  addStatic('Reflecting basin limestone coping', meshes.curbRing, carvedLimestone, [0, 0.06, 0], [4.42, 4.42, 2.8], [90, 0, 0]);
  addStatic('Stepped travertine sanctuary dais', meshes.steppedAltar, travertineStone, [0, 0, 0], [1, 1, 1]);
  addStatic('Sanctuary golden order ring', meshes.curbRing, crucibleGold, [0, 0.45, 0], [2.12, 2.12, 1.8], [90, 0, 0]);

  for (let i = 0; i < 4; i++) {
    const deg = i * 90 + 45;
    const rad = (deg * Math.PI) / 180;
    const rMid = 3.55;
    addStatic(
      `Sanctuary causeway bridge ${i}`,
      meshes.bolt,
      carvedLimestone,
      [Math.cos(rad) * rMid, 0.08, -Math.sin(rad) * rMid],
      [0.85, 0.06, 0.42],
      [0, deg, 0],
    );
  }

  // Sun-facing Gothic Colonnade & Pergola Louvers casting dramatic architectural stripe shadows
  const colCount = 6;
  const colRadius = 4.95;
  const colAngles = [];
  for (let i = 0; i < colCount; i++) {
    const a = -2.35 + (i / (colCount - 1)) * 2.55;
    colAngles.push(a);
    const cx = Math.cos(a) * colRadius;
    const cz = Math.sin(a) * colRadius;
    const degY = (-a * 180) / Math.PI;
    addStatic(
      `Sanctuary colonnade pillar ${i}`,
      meshes.columnPillar,
      carvedLimestone,
      [cx, 0.0, cz],
      [1, 1, 1],
      [0, degY, 0],
      [Math.cos(a) * 1.4, 0.65, Math.sin(a) * 1.4],
    );
    addStatic(
      `Sanctuary pillar capital ${i}`,
      meshes.bolt,
      basaltTrim,
      [cx, 3.52, cz],
      [0.44, 0.08, 0.44],
      [0, degY, 0],
      [Math.cos(a) * 1.5, 1.05, Math.sin(a) * 1.5],
    );
  }

  for (let i = 0; i < colCount - 1; i++) {
    const a0 = colAngles[i];
    const a1 = colAngles[i + 1];
    const aMid = (a0 + a1) * 0.5;
    const p0 = [Math.cos(a0) * colRadius, 3.52, Math.sin(a0) * colRadius];
    const p1 = [Math.cos(a1) * colRadius, 3.52, Math.sin(a1) * colRadius];
    const midX = (p0[0] + p1[0]) * 0.5;
    const midZ = (p0[2] + p1[2]) * 0.5;
    const spanDeg = (-Math.atan2(p1[2] - p0[2], p1[0] - p0[0]) * 180) / Math.PI;

    addStatic(
      `Sanctuary arch spandrel ${i}`,
      meshes.archRib,
      carvedLimestone,
      [midX, 3.38, midZ],
      [1.08, 0.72, 1.0],
      [0, spanDeg, 0],
      [Math.cos(aMid) * 1.65, 1.35, Math.sin(aMid) * 1.65],
    );

    const louverCount = 4;
    for (let s = 0; s < louverCount; s++) {
      const sa = mix(a0, a1, (s + 0.5) / louverCount);
      const rLouver = 4.15;
      const lx = Math.cos(sa) * rLouver;
      const lz = Math.sin(sa) * rLouver;
      const lDeg = (-sa * 180) / Math.PI;
      addStatic(
        `Pergola sun-breaker louver ${i}-${s}`,
        meshes.bolt,
        crucibleBronze,
        [lx, 3.68, lz],
        [1.15, 0.035, 0.085],
        [0, lDeg, 8],
        [Math.cos(sa) * 1.45, 1.65, Math.sin(sa) * 1.45],
      );
    }
  }

  const outerBeamPoints = [];
  const innerBeamPoints = [];
  for (let i = 0; i <= 36; i++) {
    const a = mix(colAngles[0] - 0.1, colAngles[colCount - 1] + 0.1, i / 36);
    outerBeamPoints.push([Math.cos(a) * (colRadius + 0.12), 3.64, Math.sin(a) * (colRadius + 0.12)]);
    innerBeamPoints.push([Math.cos(a) * 3.35, 3.58, Math.sin(a) * 3.35]);
  }
  addStatic(
    'Colonnade outer bronze architrave',
    withUvs(tube(outerBeamPoints, { radius: 0.075, segments: 44, radialSegments: 12 })),
    crucibleBronze,
    [0, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
    [0, 1.55, 0],
  );
  addStatic(
    'Colonnade inner basalt ring beam',
    withUvs(tube(innerBeamPoints, { radius: 0.058, segments: 44, radialSegments: 12 })),
    basaltTrim,
    [0, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
    [0, 1.65, 0],
  );

  // ============================================================================
  // 2. SITE OF LOST GRACE (Golden Bonfire Shrine in front of the Knight)
  // ============================================================================
  const gracePos = [0.0, 0.0, 1.18];
  addStatic(
    'Site of Grace basalt rune basin',
    meshes.bolt,
    basaltTrim,
    [gracePos[0], 0.48, gracePos[2]],
    [0.42, 0.05, 0.42],
    [0, 0, 0],
    [0, -0.35, 0.5],
  );
  addStatic(
    'Site of Grace golden ring',
    meshes.beltRing,
    crucibleGold,
    [gracePos[0], 0.52, gracePos[2]],
    [0.36, 0.36, 0.36],
    [90, 0, 0],
    [0, -0.25, 0.6],
  );
  addStatic(
    'Site of Grace twisted golden root',
    meshes.graceSpire,
    graceGold,
    [gracePos[0], 0.02, gracePos[2]],
    [1, 1, 1],
    [0, 0, 0],
    [0, 0.65, 0.8],
  );
  const graceCore = addStatic(
    'Site of Grace humanity sprite',
    meshes.orb,
    graceGold,
    [gracePos[0], 0.92, gracePos[2]],
    [0.11, 0.24, 0.11],
    [0, 0, 0],
    [0, 0.85, 0.9],
  );
  floatingMotes.push({
    part: graceCore,
    kind: 'gracePulse',
    basePos: [gracePos[0], 0.92, gracePos[2]],
    baseScale: [0.11, 0.24, 0.11],
  });

  // Floating Golden Grace Runes / Motes rising around the Knight & Site of Grace
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const mote = addStatic(
      `Golden Grace rune mote ${i}`,
      meshes.orb,
      i % 2 === 0 ? graceGold : moonlightGlow,
      [Math.cos(a) * 1.1, 1.2 + i * 0.25, Math.sin(a) * 1.1],
      [0.038, 0.065, 0.038],
      [0, 0, 0],
      [Math.cos(a) * 0.8, 0.6, Math.sin(a) * 0.8],
    );
    floatingMotes.push({
      part: mote,
      kind: 'mote',
      index: i,
      radius: 0.95 + (i % 3) * 0.32,
      baseHeight: 0.95 + i * 0.32,
    });
  }

  // ============================================================================
  // 3. TARNISHED CRUCIBLE SENTINEL (17-Joint Articulated Elden Ring Knight)
  // ============================================================================
  // Head & Winged Greathelm (attached to `head` bone)
  addRigPart(
    'Crucible Winged Greathelm dome',
    'head',
    meshes.greathelm,
    damascusSteel,
    [0, 0.10, 0],
    [1.08, 1.12, 1.15],
    [0, 0, 0],
    [0, 1.45, 0.25],
  );
  addRigPart(
    'Greathelm golden faceguard visor',
    'head',
    meshes.tassetPlate,
    crucibleGold,
    [0, 0.12, 0.165],
    [0.68, 0.72, 0.85],
    [180, 0, 0],
    [0, 1.55, 0.85],
  );
  addRigPart(
    'Greathelm glowing visor slit',
    'head',
    meshes.orb,
    graceGold,
    [0, 0.16, 0.145],
    [0.095, 0.022, 0.05],
    [0, 0, 0],
    [0, 1.50, 0.65],
  );
  addRigPart(
    'Greathelm golden crown circlet',
    'head',
    meshes.beltRing,
    crucibleGold,
    [0, 0.25, 0],
    [0.165, 0.165, 0.18],
    [82, 0, 0],
    [0, 1.75, 0.3],
  );
  addRigPart(
    'Crucible Valkyrie helm wing R',
    'head',
    meshes.helmWingRight,
    crucibleGold,
    [0, 0.04, 0],
    [1, 1, 1],
    [0, 0, 0],
    [0.95, 1.85, -0.25],
  );
  addRigPart(
    'Crucible Valkyrie helm wing L',
    'head',
    meshes.helmWingLeft,
    crucibleGold,
    [0, 0.04, 0],
    [1, 1, 1],
    [0, 0, 0],
    [-0.95, 1.85, -0.25],
  );
  addRigPart(
    'Royal crimson horsehair plume',
    'head',
    meshes.helmPlume,
    crimsonVelvet,
    [0, 0.08, 0],
    [1.15, 1.15, 1.15],
    [0, 0, 0],
    [0, 2.05, -0.75],
  );

  // Chest Cuirass, Erdtree Filigree & Gorget (attached to `chest` bone)
  addRigPart(
    'Gothic fluted breastplate cuirass',
    'chest',
    meshes.cuirass,
    damascusSteel,
    [0, 0.18, 0],
    [1.32, 1.05, 0.94],
    [0, 0, 0],
    [0, 0.65, 0.55],
  );
  addRigPart(
    'Golden Order Erdtree chest filigree',
    'chest',
    meshes.erdtreeCrest,
    crucibleGold,
    [0, 0.28, 0.235],
    [1.05, 1.05, 1.0],
    [8, 0, 0],
    [0, 0.75, 1.15],
  );
  addRigPart(
    'Armored gorget collar',
    'chest',
    meshes.beltRing,
    crucibleBronze,
    [0, 0.56, 0.01],
    [0.24, 0.22, 0.24],
    [84, 0, 0],
    [0, 1.05, 0.45],
  );
  addRigPart(
    'Dorsal spine plate ridge',
    'chest',
    meshes.tassetPlate,
    flutedSilver,
    [0, 0.26, -0.23],
    [0.95, 1.25, 1.0],
    [0, 180, 0],
    [0, 0.75, -0.95],
  );

  // Pelvis Faulds, Crimson Tabard & Hip Tassets (attached to `pelvis` bone)
  addRigPart(
    'Segmented waist faulds & surcoat',
    'pelvis',
    meshes.fauldsSkirt,
    crimsonVelvet,
    [0, 0.08, 0],
    [1.22, 1.0, 0.95],
    [0, 0, 0],
    [0, -0.25, 0],
  );
  addRigPart(
    'Crucible golden girdle belt',
    'pelvis',
    meshes.beltRing,
    crucibleGold,
    [0, 0.06, 0],
    [0.27, 0.23, 0.27],
    [90, 0, 0],
    [0, -0.15, 0.65],
  );
  addRigPart(
    'Front heraldic tabard plate',
    'pelvis',
    meshes.tassetPlate,
    crucibleBronze,
    [0, -0.14, 0.23],
    [0.82, 1.18, 1.0],
    [-8, 0, 0],
    [0, -0.35, 0.95],
  );
  addRigPart(
    'Left hip tasset plate',
    'pelvis',
    meshes.tassetPlate,
    damascusSteel,
    [0.29, -0.12, 0.04],
    [0.95, 1.12, 1.0],
    [0, 78, -14],
    [0.95, -0.25, 0.35],
  );
  addRigPart(
    'Right hip tasset plate',
    'pelvis',
    meshes.tassetPlate,
    damascusSteel,
    [-0.29, -0.12, 0.04],
    [0.95, 1.12, 1.0],
    [0, -78, 14],
    [-0.95, -0.25, 0.35],
  );

  // Shoulders, Arms, Vambraces & Gauntlets (Left & Right)
  for (const [side, sign] of [
    ['Left', 1],
    ['Right', -1],
  ]) {
    const sKey = side.toLowerCase();
    // Multi-layered Crucible Pauldrons
    addRigPart(
      `${side} Crucible pauldron upper dome`,
      `${sKey}Shoulder`,
      meshes.pauldronDome,
      crucibleBronze,
      [sign * 0.06, 0.02, 0],
      [1.22, 1.15, 1.18],
      [0, 0, -sign * 28],
      [sign * 1.25, 0.85, 0.2],
    );
    addRigPart(
      `${side} pauldron lower lame`,
      `${sKey}Shoulder`,
      meshes.pauldronDome,
      damascusSteel,
      [sign * 0.11, -0.08, 0],
      [1.12, 0.92, 1.08],
      [0, 0, -sign * 42],
      [sign * 1.45, 0.65, 0.2],
    );
    addRigPart(
      `${side} golden rondel besague`,
      `${sKey}Shoulder`,
      meshes.orb,
      crucibleGold,
      [sign * -0.04, -0.02, 0.16],
      [0.085, 0.085, 0.032],
      [0, sign * 22, 0],
      [sign * 0.95, 0.75, 0.85],
    );

    // Upper Arm Rerebrace & Elbow Couter
    addRigPart(
      `${side} fluted rerebrace`,
      `${sKey}UpperArm`,
      meshes.limbArmor,
      damascusSteel,
      [0, -0.18, 0],
      [0.95, 0.88, 0.95],
      [0, 0, 0],
      [sign * 1.35, 0.35, 0],
    );
    addRigPart(
      `${side} winged elbow couter`,
      `${sKey}Forearm`,
      meshes.orb,
      crucibleGold,
      [sign * 0.02, 0.0, -0.02],
      [0.105, 0.095, 0.105],
      [0, 0, 0],
      [sign * 1.55, 0.15, -0.25],
    );

    // Forearm Vambrace & Gauntlet
    addRigPart(
      `${side} Gothic vambrace`,
      `${sKey}Forearm`,
      meshes.limbArmor,
      flutedSilver,
      [0, -0.17, 0],
      [0.86, 0.82, 0.86],
      [0, 0, 0],
      [sign * 1.55, -0.05, 0.35],
    );
    addRigPart(
      `${side} articulated gauntlet`,
      `${sKey}Hand`,
      meshes.orb,
      crucibleBronze,
      [0, -0.05, 0.02],
      [0.082, 0.105, 0.075],
      [0, 0, 0],
      [sign * 1.75, -0.25, 0.55],
    );
  }

  // Legs: Thigh Cuisses, Knee Poleyns, Fluted Greaves & Pointed Gothic Sabatons
  for (const [side, sign] of [
    ['Left', 1],
    ['Right', -1],
  ]) {
    const sKey = side.toLowerCase();
    addRigPart(
      `${side} fluted thigh cuisse`,
      `${sKey}Thigh`,
      meshes.limbArmor,
      damascusSteel,
      [0, -0.24, 0],
      [1.38, 1.15, 1.38],
      [0, 0, 0],
      [sign * 0.85, -0.45, 0.25],
    );
    addRigPart(
      `${side} cuisse golden ridge`,
      `${sKey}Thigh`,
      meshes.tassetPlate,
      crucibleGold,
      [0, -0.20, 0.12],
      [0.58, 0.92, 0.8],
      [0, 0, 0],
      [sign * 0.95, -0.45, 0.75],
    );
    addRigPart(
      `${side} winged knee poleyn`,
      `${sKey}Shin`,
      meshes.orb,
      crucibleGold,
      [0, 0.02, 0.06],
      [0.125, 0.135, 0.115],
      [0, 0, 0],
      [sign * 0.95, -0.65, 0.85],
    );
    addRigPart(
      `${side} tapered calf greave`,
      `${sKey}Shin`,
      meshes.limbArmor,
      flutedSilver,
      [0, -0.24, 0],
      [1.16, 1.18, 1.20],
      [0, 0, 0],
      [sign * 0.85, -0.85, 0.25],
    );
    addRigPart(
      `${side} pointed Gothic sabaton`,
      `${sKey}Foot`,
      meshes.tassetPlate,
      damascusSteel,
      [0, -0.03, 0.12],
      [0.72, 1.15, 1.65],
      [82, 0, 0],
      [sign * 0.85, -1.15, 0.75],
    );
  }

  // ============================================================================
  // 4. WEAPONS: COLOSSAL CRUCIBLE GREATSWORD (Right Hand) & GREATSHIELD (Left Arm)
  // ============================================================================
  addRigPart(
    'Colossal Crucible Greatsword blade',
    'rightHand',
    meshes.greatswordBlade,
    flutedSilver,
    [0, -0.04, 0.04],
    [1.08, 1.02, 1.2],
    [76, 0, 0],
    [-1.85, 0.55, 1.25],
  );
  addRigPart(
    'Greatsword Golden Order rune core',
    'rightHand',
    meshes.bolt,
    graceGold,
    [0, -0.02, 0.72],
    [0.016, 0.62, 0.012],
    [76, 0, 0],
    [-2.05, 0.65, 1.45],
  );
  addRigPart(
    'Greatsword winged crucible crossguard',
    'rightHand',
    meshes.crossguard,
    crucibleGold,
    [0, -0.04, 0.04],
    [1.05, 1.05, 1.05],
    [76, 0, 0],
    [-1.65, 0.35, 0.95],
  );
  addRigPart(
    'Greatsword wire-wrapped hilt & pommel',
    'rightHand',
    meshes.swordHilt,
    crucibleBronze,
    [0, -0.04, 0.04],
    [1.1, 1.05, 1.1],
    [76, 0, 0],
    [-1.55, 0.15, 0.75],
  );

  // Golden Order Greatshield mounted on Left Forearm
  addRigPart(
    'Golden Order Heater Greatshield',
    'leftForearm',
    meshes.greatshield,
    damascusSteel,
    [0.13, -0.16, 0.06],
    [1.05, 1.05, 1.05],
    [0, 74, 8],
    [1.85, 0.25, 0.95],
  );
  addRigPart(
    'Greatshield Erdtree golden emblem',
    'leftForearm',
    meshes.erdtreeCrest,
    crucibleGold,
    [0.175, -0.14, 0.07],
    [1.18, 1.25, 1.1],
    [0, 74, 8],
    [2.15, 0.35, 1.15],
  );

  return {
    staticParts,
    characterRigParts,
    floatingMotes,
  };
}

// Computes the 17-joint hierarchical world matrices for the Tarnished Crucible Knight
function evaluateKnightSkeleton(time, animMode = 'idle') {
  const world = {};
  const isSlash = animMode === 'slash';

  // Smooth breathing & combat cycle signals
  const breath = Math.sin(time * 2.1);
  const slowScan = Math.sin(time * 0.95);
  const combatPhase = time * 2.6;
  const slashWave = Math.sin(combatPhase);
  const slashImpact = Math.cos(combatPhase);

  function composeBone(parentName, pos, eulerDeg) {
    const local = mat4.fromRotationTranslationScale(
      mat4.create(),
      quat.fromEuler(quat.create(), eulerDeg[0], eulerDeg[1], eulerDeg[2]),
      pos,
      [1, 1, 1],
    );
    if (!parentName) return local;
    return mat4.multiply(mat4.create(), world[parentName], local);
  }

  // Pelvis root standing on top of the 0.45m stepped sanctuary dais
  const pelvisBob = isSlash
    ? Math.abs(slashWave) * 0.045 - 0.03
    : breath * 0.012;
  const pelvisYaw = isSlash ? slashWave * 24 : slowScan * 5 - 8;
  const pelvisPitch = isSlash ? slashImpact * 6 + 4 : 0;

  world.pelvis = composeBone(
    null,
    [0.0, 1.44 + pelvisBob, -0.18],
    [pelvisPitch, pelvisYaw, 0],
  );

  // Spine & Chest
  const chestPitch = isSlash ? slashImpact * 12 + 6 : breath * 2.2 + 2;
  const chestYaw = isSlash ? slashWave * 28 : slowScan * 7;
  const chestRoll = isSlash ? -slashWave * 8 : 0;
  world.chest = composeBone('pelvis', [0, 0.14, 0], [chestPitch, chestYaw, chestRoll]);

  // Head & Winged Greathelm
  const headPitch = isSlash ? -slashImpact * 8 + 4 : -breath * 1.8 + 3;
  const headYaw = isSlash ? -slashWave * 18 : slowScan * 16 + 6;
  world.head = composeBone('chest', [0, 0.62, 0.02], [headPitch, headYaw, 0]);

  // Right Arm (wielding the Colossal Crucible Greatsword)
  const rShoulderAngles = isSlash
    ? [-28 + slashWave * 48, -18 + slashImpact * 28, -24 - slashWave * 22]
    : [-18 + breath * 3.5, -14, -18 - breath * 2.0];
  const rElbowAngles = isSlash
    ? [-42 + slashImpact * 32, 0, 0]
    : [-38 + breath * 4.0, -8, 10];
  const rHandAngles = isSlash
    ? [18 + slashWave * 25, 12, -16]
    : [14 + slowScan * 6, 8, -12];

  world.rightShoulder = composeBone('chest', [-0.34, 0.46, 0.0], rShoulderAngles);
  world.rightUpperArm = composeBone('rightShoulder', [-0.04, -0.04, 0.0], [0, 0, 0]);
  world.rightForearm = composeBone('rightUpperArm', [0.0, -0.34, 0.0], rElbowAngles);
  world.rightHand = composeBone('rightForearm', [0.0, -0.32, 0.0], rHandAngles);

  // Left Arm (holding the Golden Order Greatshield)
  const lShoulderAngles = isSlash
    ? [-24 - slashWave * 22, 22, 22 + slashImpact * 12]
    : [-16 - breath * 2.5, 24 + slowScan * 5, 18];
  const lElbowAngles = isSlash
    ? [-54 - slashWave * 16, 18, 0]
    : [-52 + breath * 3.0, 22, 0];

  world.leftShoulder = composeBone('chest', [0.34, 0.46, 0.0], lShoulderAngles);
  world.leftUpperArm = composeBone('leftShoulder', [0.04, -0.04, 0.0], [0, 0, 0]);
  world.leftForearm = composeBone('leftUpperArm', [0.0, -0.34, 0.0], lElbowAngles);
  world.leftHand = composeBone('leftForearm', [0.0, -0.32, 0.0], [0, 0, 0]);

  // Left Leg (planted forward toward the Site of Grace)
  const lThighPitch = isSlash ? -18 + slashWave * 10 : -12;
  const lShinPitch = isSlash ? 24 - slashWave * 8 : 14;
  const lFootPitch = -(pelvisPitch + lThighPitch + lShinPitch);

  world.leftThigh = composeBone('pelvis', [0.19, -0.06, 0.04], [lThighPitch, -8, 5]);
  world.leftShin = composeBone('leftThigh', [0.0, -0.46, 0.0], [lShinPitch, 0, -5]);
  world.leftFoot = composeBone('leftShin', [0.0, -0.45, 0.0], [lFootPitch, 8, 0]);

  // Right Leg (braced back in heroic stance)
  const rThighPitch = isSlash ? 16 - slashWave * 10 : 10;
  const rShinPitch = isSlash ? 14 + slashWave * 8 : 8;
  const rFootPitch = -(pelvisPitch + rThighPitch + rShinPitch);

  world.rightThigh = composeBone('pelvis', [-0.19, -0.06, -0.04], [rThighPitch, 12, -5]);
  world.rightShin = composeBone('rightThigh', [0.0, -0.46, 0.0], [rShinPitch, 0, 5]);
  world.rightFoot = composeBone('rightShin', [0.0, -0.45, 0.0], [rFootPitch, -12, 0]);

  return world;
}

export function mountHeroAgentWorkbench() {
  return mountHomeAgentHero();
}

export function mountHomeAgentHero() {
  const canvas = document.querySelector('#hero-viewport');
  const frame = document.querySelector('.hero-frame');
  if (!canvas || !frame) return;

  let scene;
  let allParts;
  let renderer;
  let capeAnimation;
  let initialSkyMap;

  try {
    scene = createEldenSanctuaryScene();
    initialSkyMap = createProceduralSunSkyHdri(128, 64);

    // Moss-blended garden boulders + living wind-swaying courtyard trees & grass + live PBD Cloth Sovereign Cape
    const boulderSphere = withUvs(sphere(24, 16));
    const capeGeometry = buildSovereignCapeGeometry(14, 18, 0.86, 1.48);

    const mossyBoulderMat = {
      tag: 'rock',
      color: [0.42, 0.46, 0.38],
      metallic: 0.06,
      roughness: 0.78,
      blend: { radius: 0.28 },
    };
    const sovereignCapeMaterial = {
      tag: 'cloth',
      color: [0.72, 0.13, 0.11],
      metallic: 0.06,
      roughness: 0.56,
      doubleSided: true,
    };

    // Sovereign Cape draped directly from the Knight's shoulder pauldrons (`y = 1.98, z = -0.36`)
    const capePart = {
      name: 'Sovereign crimson mantle cape',
      geometry: capeGeometry,
      matrix: place([0.0, 1.98, -0.36], [1, 1, 1], [12, 0, 0]),
      material: sovereignCapeMaterial,
    };

    // Living courtyard trees & shrubs (`createTree` + `vegetationParts`) that sway in the wind and cast dappled leaf shadows
    const oakTree = createTree({ species: 'broadleaf', height: 4.6, leaves: 'cards' }, 19);
    const birchTree = createTree({ species: 'birch', height: 4.8, leaves: 'cards' }, 31);
    const bushVariant = createTree({ species: 'bush', height: 1.15, leaves: 'cards' }, 71);
    const grassClump = createGrassClump({ blades: 18, height: 0.42, radius: 0.22, style: 'blades', seed: 11 });

    const treeAndFoliageParts = [
      ...vegetationParts(oakTree, place([-4.45, -0.05, 2.35], [1, 1, 1], [0, 32, 0]), 0, 'Courtyard Oak West'),
      ...vegetationParts(birchTree, place([4.55, -0.05, -2.15], [1, 1, 1], [0, 140, 0]), 0, 'Courtyard Birch East'),
      ...vegetationParts(bushVariant, place([-3.15, 0.02, 2.15], [1, 1, 1], [0, 18, 0]), 0, 'Courtyard Shrub West'),
      ...vegetationParts(bushVariant, place([3.25, 0.02, 1.85], [0.92, 0.92, 0.92], [0, 95, 0]), 0, 'Courtyard Shrub East'),
      ...vegetationParts(grassClump, place([-2.55, 0.04, 1.65], [1.2, 1.2, 1.2], [0, 15, 0]), 0, 'Basin Grass West'),
      ...vegetationParts(grassClump, place([2.45, 0.04, -1.55], [1.2, 1.2, 1.2], [0, 85, 0]), 0, 'Basin Grass East'),
    ];

    const environmentParts = [
      {
        name: 'Mossy runestone West',
        geometry: boulderSphere,
        matrix: place([-2.35, 0.18, 1.42], [0.76, 0.48, 0.64], [8, 22, -6]),
        material: mossyBoulderMat,
      },
      {
        name: 'Mossy runestone West companion',
        geometry: boulderSphere,
        matrix: place([-1.82, 0.10, 1.76], [0.44, 0.28, 0.40], [-5, 45, 11]),
        material: mossyBoulderMat,
      },
      {
        name: 'Mossy runestone East',
        geometry: boulderSphere,
        matrix: place([2.45, 0.20, -1.22], [0.84, 0.52, 0.68], [-6, -28, 8]),
        material: mossyBoulderMat,
      },
      {
        name: 'Mossy runestone East outcrop',
        geometry: boulderSphere,
        matrix: place([1.92, 0.12, -1.68], [0.48, 0.30, 0.44], [9, 14, -10]),
        material: mossyBoulderMat,
      },
      capePart,
      ...treeAndFoliageParts,
    ];

    // Evaluate initial pose before constructing Glaze so bounds & shadow maps fit the posed Knight
    const initialBones = evaluateKnightSkeleton(0, 'idle');
    for (const part of scene.characterRigParts) {
      const boneMat = initialBones[part.boneName];
      mat4.multiply(part.baseMatrix, boneMat, part.localMatrix);
      part.matrix.set(part.baseMatrix);
    }

    allParts = [...scene.staticParts, ...scene.characterRigParts, ...environmentParts];

    renderer = new Glaze(canvas, allParts, {
      world: true,
      hdr: true,
      ground: false,
      depth: true,
      samples: 4,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.75),
      memoryBudgetMiB: 192,
      shadowBounds: {
        target: [0, 1.35, 0],
        extent: 6.5,
        near: 1.0,
        far: 28.0,
      },
      environment: {
        map: initialSkyMap,
        lightDirection: [...PROMPTS.model.state.lightDirection],
        keyColor: [4.9, 4.0, 2.8],
        fillIntensity: 0.08,
        ambientIntensity: 0.34,
        fogColor: [0.76, 0.72, 0.66],
        fogDensity: 0.004,
        pointLights: [
          { position: [0, 1.05, 1.18], color: [1.0, 0.68, 0.20], intensity: 6.2, range: 7.5, radius: 0.14 },
          { position: [-1.8, 2.4, 1.8], color: [0.28, 0.78, 1.0], intensity: 2.8, range: 9.0, radius: 0.16 },
        ],
      },
    });
    installMeshBlend(renderer);
    capeAnimation = createFlagAnimation(renderer, capePart);
  } catch (err) {
    window.__heroWorkbench = { error: err.message };
    return;
  }

  frame.dataset.live = 'true';
  frame.classList.add('is-live-3d');

  // Optionally upgrade to real outdoor sky HDRI once loaded (shader already has environmentMap compiled!)
  let envMap = initialSkyMap;
  loadHdri('./showcase/airport/sky.preview.hdr', {
    intensity: 0.85,
    rotation: 0.4,
    showBackground: true,
  })
    .then(map => {
      if (map) envMap = map;
    })
    .catch(() => {});

  const current = {
    ...PROMPTS.model.state,
    lightDirection: [...PROMPTS.model.state.lightDirection],
  };
  let target = {
    ...PROMPTS.model.state,
    lightDirection: [...PROMPTS.model.state.lightDirection],
  };
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
    target = {
      ...preset.state,
      lightDirection: [...preset.state.lightDirection],
    };
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
    dragging = true;
    userInteracted = true;
    pointerStart = [event.clientX, event.clientY];
    orbitStart = [target.azimuth, target.elevation];
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - pointerStart[0];
    const dy = event.clientY - pointerStart[1];
    target.azimuth = orbitStart[0] - dx * 0.0065;
    target.elevation = Math.max(0.06, Math.min(1.15, orbitStart[1] + dy * 0.0055));
  });

  const endDrag = () => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function updateRigTransforms(assemblyAmount, time, animMode) {
    const boneWorlds = evaluateKnightSkeleton(time, animMode);

    for (const part of scene.characterRigParts) {
      const boneMat = boneWorlds[part.boneName];
      mat4.multiply(part.baseMatrix, boneMat, part.localMatrix);
      const offset = assemblyOffset(part.assembly, assemblyAmount);
      part.matrix.set(part.baseMatrix);
      part.matrix[12] += offset[0];
      part.matrix[13] += offset[1];
      part.matrix[14] += offset[2];
    }

    for (const item of scene.floatingMotes) {
      if (item.kind === 'gracePulse') {
        const s = 1 + Math.sin(time * 3.8) * 0.09;
        mat4.fromRotationTranslationScale(
          item.part.baseMatrix,
          quat.create(),
          [item.basePos[0], item.basePos[1] + Math.sin(time * 2.4) * 0.03, item.basePos[2]],
          [item.baseScale[0] * s, item.baseScale[1] * (1 + Math.cos(time * 4.2) * 0.12), item.baseScale[2] * s],
        );
      } else if (item.kind === 'mote') {
        const a = time * (0.55 + item.index * 0.12) + item.index * 1.05;
        const pos = [
          Math.cos(a) * item.radius,
          item.baseHeight + Math.sin(time * 1.6 + item.index) * 0.22,
          Math.sin(a) * item.radius,
        ];
        mat4.fromRotationTranslationScale(
          item.part.baseMatrix,
          quat.create(),
          pos,
          [0.038, 0.065, 0.038],
        );
      }
    }

    for (const part of scene.staticParts) {
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
      target.azimuth += dt * 0.07;
    }
    current.azimuth += (target.azimuth - current.azimuth) * blend;
    current.elevation += (target.elevation - current.elevation) * blend;
    current.distance += (target.distance - current.distance) * blend;
    current.targetHeight += (target.targetHeight - current.targetHeight) * blend;
    current.assembly += (target.assembly - current.assembly) * blend;
    current.temperature += (target.temperature - current.temperature) * blend;
    current.contrast += (target.contrast - current.contrast) * blend;
    current.wind += (target.wind - current.wind) * blend;
    current.animMode = target.animMode;
    current.inspection = target.inspection;
    for (let i = 0; i < 3; i++) {
      current.lightDirection[i] += (target.lightDirection[i] - current.lightDirection[i]) * blend;
    }

    updateRigTransforms(current.assembly, simTime, current.animMode);
    capeAnimation.update(simTime, current.wind);

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
        map: envMap,
        lightDirection: [...current.lightDirection],
        keyColor: [4.9, 4.0, 2.8],
        fillIntensity: 0.08,
        ambientIntensity: 0.34,
        wind: current.wind,
        pointLights: [
          { position: [0, 1.05, 1.18], color: [1.0, 0.68, 0.20], intensity: 6.2, range: 7.5, radius: 0.14 },
          { position: [-1.8, 2.4, 1.8], color: [0.28, 0.78, 1.0], intensity: 2.8, range: 9.0, radius: 0.16 },
        ],
      },
      effects: {
        ambientOcclusion: 0.66,
        ambientOcclusionRadius: 0.55,
        bloom: { strength: 0.18, threshold: 1.05, radius: 1.1 },
        contrast: current.contrast,
        temperature: current.temperature,
        vignette: 0.12,
      },
    });

    rafId = requestAnimationFrame(tick);
  }

  updateRigTransforms(0, 0, 'idle');
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
