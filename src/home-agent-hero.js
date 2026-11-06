// Live 3D hero world for the homepage: HELIOS-67 Solar Chronometer & Architectural Observatory Courtyard.
// Built with lathe, extrude, and tube modeling tools, procedural stone paver & brushed metal normal/roughness maps,
// a sunlit classical-meets-solarpunk colonnade casting architectural louver shadows, wind-swaying courtyard trees,
// screen-space MeshBlend garden boulders, and a live PBD cloth banner in Glaze (Renderer67).
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
    prompt: '"Build a sunlit observatory courtyard with a colonnade pergola, stepped travertine plinth, and an articulated solar chronometer rig."',
    state: {
      azimuth: 0.56,
      elevation: 0.27,
      distance: 8.4,
      targetHeight: 1.48,
      assembly: 0,
      inspection: false,
      lightDirection: [-4.4, 5.2, 3.8],
      temperature: 0.05,
      contrast: 1.12,
      wind: 0.42,
    },
  },
  explode: {
    prompt: '"Explode the colonnade arches, toothed escapement gears, helical collectors, and strider legs 75% outward with live shadow casting."',
    state: {
      azimuth: -0.46,
      elevation: 0.30,
      distance: 10.2,
      targetHeight: 1.68,
      assembly: 0.75,
      inspection: false,
      lightDirection: [4.6, 5.4, 3.6],
      temperature: -0.02,
      contrast: 1.12,
      wind: 0.35,
    },
  },
  blend: {
    prompt: '"Sweep golden-hour sunlight across the colonnade louvers, MeshBlend mossy boulders into the basin rim, and drive the PBD cloth banner."',
    state: {
      azimuth: 0.28,
      elevation: 0.18,
      distance: 7.2,
      targetHeight: 1.18,
      assembly: 0.0,
      inspection: false,
      lightDirection: [-5.8, 3.6, 3.2],
      temperature: 0.14,
      contrast: 1.14,
      wind: 0.92,
    },
  },
  review: {
    prompt: '"Inspect world-space surface normals across the turned travertine columns, beveled gear teeth, and helical collector tubes."',
    state: {
      azimuth: 0.84,
      elevation: 0.28,
      distance: 8.2,
      targetHeight: 1.52,
      assembly: 0.24,
      inspection: true,
      lightDirection: [-3.8, 5.8, 4.0],
      temperature: 0,
      contrast: 1.04,
      wind: 0.38,
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
        let r = mix(0.88, 0.16, zenith) + horizonGlow * 0.45;
        let g = mix(0.76, 0.36, zenith) + horizonGlow * 0.24;
        let b = mix(0.65, 0.72, zenith) + horizonGlow * 0.08;

        const sunDot = Math.max(0, dirX * sunDir[0] + dirY * sunDir[1] + dirZ * sunDir[2]);
        const sunHalo = Math.pow(sunDot, 16) * 1.2 + Math.pow(sunDot, 160) * 5.5;
        r += sunHalo * 1.25;
        g += sunHalo * 0.92;
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
    intensity: 0.82,
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
      surfaces.data.set([255, Math.round(208 + brushed * 18), 255, 255], offset);
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

function buildFlagGeometry(columns = 18, rows = 10, width = 1.45, height = 0.74) {
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

function createArchRibContour() {
  const pts = [];
  const outerSegs = 28;
  for (let i = 0; i <= outerSegs; i++) {
    const a = (i / outerSegs) * Math.PI;
    pts.push([Math.cos(a) * 1.12, Math.sin(a) * 0.78]);
  }
  const innerSegs = 24;
  for (let i = innerSegs; i >= 0; i--) {
    const a = (i / innerSegs) * Math.PI;
    pts.push([Math.cos(a) * 0.84, Math.sin(a) * 0.52]);
  }
  return pts;
}

function createObservatoryScene() {
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
  const obsidian = {
    tag: 'metal',
    color: [0.09, 0.11, 0.15],
    metallic: 0.88,
    roughness: 0.24,
    ...metalMaps,
  };
  const titanium = {
    tag: 'metal',
    color: [0.52, 0.57, 0.65],
    metallic: 0.94,
    roughness: 0.20,
    ...metalMaps,
  };
  const gold = {
    tag: 'metal',
    color: [0.86, 0.60, 0.22],
    metallic: 0.95,
    roughness: 0.20,
    ...metalMaps,
  };
  const architecturalBronze = {
    tag: 'metal',
    color: [0.68, 0.46, 0.24],
    metallic: 0.90,
    roughness: 0.26,
    ...metalMaps,
  };
  const copper = {
    tag: 'metal',
    color: [0.72, 0.34, 0.18],
    metallic: 0.90,
    roughness: 0.26,
    ...metalMaps,
  };
  const porcelain = {
    tag: 'ceramic',
    color: [0.95, 0.93, 0.89],
    metallic: 0.06,
    roughness: 0.16,
  };
  const solarCore = {
    tag: 'light',
    color: [0.98, 0.52, 0.14],
    metallic: 0.05,
    roughness: 0.14,
    emissiveColor: [1.0, 0.52, 0.12],
    emission: 2.8,
  };
  const cyanGlow = {
    tag: 'light',
    color: [0.16, 0.76, 0.98],
    metallic: 0.1,
    roughness: 0.18,
    emissiveColor: [0.18, 0.80, 1.0],
    emission: 2.2,
  };
  const waterPool = {
    tag: 'water',
    color: [0.12, 0.42, 0.50],
    metallic: 0.08,
    roughness: 0.08,
  };
  const meadowTurf = {
    tag: 'terrain',
    color: [0.28, 0.46, 0.22],
    metallic: 0.02,
    roughness: 0.86,
  };

  // High-precision procedural modeling contours (extrude with teeth + spoke cutout holes)
  const gearContour = Array.from({ length: 128 }, (_, i) => {
    const a = (i / 128) * Math.PI * 2;
    const r = i % 4 < 2 ? 1.04 : 0.95;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const gearHole = Array.from({ length: 64 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;
    return [Math.cos(a) * 0.74, Math.sin(a) * 0.74];
  });

  const meridianContour = Array.from({ length: 96 }, (_, i) => {
    const a = (i / 96) * Math.PI * 2;
    const r = i % 6 < 3 ? 1.22 : 1.15;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const meridianHole = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2;
    return [Math.cos(a) * 1.04, Math.sin(a) * 1.04];
  });

  const meshes = {
    // Turned multi-stepped travertine courtyard altar plinth
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
    // Turned classical limestone colonnade pillar with base torus & Doric capital
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
    pedestal: withUvs(
      lathe(
        [
          [0, 0.44],
          [1.22, 0.44],
          [1.28, 0.51],
          [1.18, 0.60],
          [1.02, 0.68],
          [0.94, 0.78],
          [0.84, 0.86],
          [0.72, 0.94],
          [0, 0.94],
        ],
        { segments: 96 },
      ),
    ),
    lowerNozzle: withUvs(
      lathe(
        [
          [0, 0.94],
          [0.38, 0.94],
          [0.60, 1.02],
          [0.76, 1.16],
          [0.80, 1.30],
          [0.72, 1.34],
          [0.62, 1.20],
          [0.44, 1.08],
          [0.22, 1.02],
          [0, 1.02],
        ],
        { segments: 96 },
      ),
    ),
    upperCrown: withUvs(
      lathe(
        [
          [0, 2.76],
          [0.46, 2.76],
          [0.74, 2.84],
          [0.80, 2.92],
          [0.72, 3.00],
          [0.54, 3.08],
          [0.40, 3.22],
          [0.22, 3.36],
          [0.10, 3.48],
          [0.04, 3.62],
          [0, 3.62],
        ],
        { segments: 96 },
      ),
    ),
    collectorRib: withUvs(
      tube(
        [
          [0.74, 1.22, 0],
          [1.18, 1.56, 0.16],
          [1.26, 2.04, 0.28],
          [1.04, 2.52, 0.20],
          [0.68, 2.82, 0],
        ],
        { radius: 0.038, segments: 56, radialSegments: 10 },
      ),
    ),
    innerCoil: withUvs(
      tube(
        [
          [0.56, 1.18, 0],
          [0.84, 1.60, -0.14],
          [0.86, 2.12, -0.18],
          [0.60, 2.62, -0.08],
          [0.48, 2.78, 0],
        ],
        { radius: 0.020, segments: 48, radialSegments: 8 },
      ),
    ),
    striderLeg: withUvs(
      tube(
        [
          [0.88, 0.78, 0],
          [1.38, 0.94, 0.08],
          [1.76, 0.68, 0.04],
          [1.96, 0.45, 0],
        ],
        { radius: 0.058, segments: 36, radialSegments: 10 },
      ),
    ),
    gear: withUvs(
      extrude(gearContour, { holes: [gearHole], depth: 0.05, bevel: 0.007, bevelSegments: 2 }),
    ),
    meridian: withUvs(
      extrude(meridianContour, { holes: [meridianHole], depth: 0.065, bevel: 0.009, bevelSegments: 2 }),
    ),
    gyroRing: withUvs(torus(0.034, 84, 14)),
    innerRing: withUvs(torus(0.024, 72, 12)),
    curbRing: withUvs(torus(0.022, 96, 16)),
    orb: withUvs(sphere(44, 28)),
    bolt: withUvs(cylinder(24, 0.04, 2)),
    disk: withUvs(cylinder(72, 0.015, 2)),
  };

  const parts = [];
  const animated = [];

  function add(
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
    parts.push(part);
    return part;
  }

  // 1. Multi-Tier Sunlit Travertine Courtyard, Reflecting Water Basin & Stepped Altar
  // Note: Using `travertineStone` (`tag: 'ceramic'`) instead of `tag: 'floor'` so direct sunlight + cast shadows render with full PBR contrast!
  add('Outer meadow terrace', meshes.disk, meadowTurf, [0, -0.14, 0], [8.6, 0.08, 8.6]);
  add('Sunlit travertine courtyard plaza', meshes.disk, travertineStone, [0, -0.05, 0], [6.6, 0.06, 6.6]);
  add('Courtyard basalt perimeter curb', meshes.curbRing, basaltTrim, [0, 0.02, 0], [6.45, 6.45, 3.2], [90, 0, 0]);
  add('Reflecting basin water surface', meshes.disk, waterPool, [0, 0.02, 0], [4.35, 0.02, 4.35]);
  add('Reflecting basin limestone coping', meshes.curbRing, carvedLimestone, [0, 0.06, 0], [4.42, 4.42, 2.8], [90, 0, 0]);
  add('Stepped travertine central altar', meshes.steppedAltar, travertineStone, [0, 0, 0], [1, 1, 1]);
  add('Altar bronze azimuth bezel', meshes.curbRing, architecturalBronze, [0, 0.45, 0], [2.12, 2.12, 1.8], [90, 0, 0]);

  // 4 radial stone causeway bridges spanning the reflecting pool
  for (let i = 0; i < 4; i++) {
    const deg = i * 90 + 45;
    const rad = (deg * Math.PI) / 180;
    const rMid = 3.55;
    add(
      `Courtyard causeway bridge ${i}`,
      meshes.bolt,
      carvedLimestone,
      [Math.cos(rad) * rMid, 0.08, -Math.sin(rad) * rMid],
      [0.85, 0.06, 0.42],
      [0, deg, 0],
    );
  }

  // 2. Classical-Meets-Solarpunk Colonnade & Overhead Sun-Breaker Pergola
  // Positioned along the northern/western sun-facing arc so columns & louvers cast crisp architectural shadows across the courtyard!
  const colCount = 6;
  const colRadius = 4.95;
  const colAngles = [];
  for (let i = 0; i < colCount; i++) {
    const a = -2.35 + (i / (colCount - 1)) * 2.55;
    colAngles.push(a);
    const cx = Math.cos(a) * colRadius;
    const cz = Math.sin(a) * colRadius;
    const degY = (-a * 180) / Math.PI;
    add(
      `Colonnade limestone pillar ${i}`,
      meshes.columnPillar,
      carvedLimestone,
      [cx, 0.0, cz],
      [1, 1, 1],
      [0, degY, 0],
      [Math.cos(a) * 1.4, 0.65, Math.sin(a) * 1.4],
    );
    add(
      `Colonnade basalt abacus ${i}`,
      meshes.bolt,
      basaltTrim,
      [cx, 3.52, cz],
      [0.44, 0.08, 0.44],
      [0, degY, 0],
      [Math.cos(a) * 1.5, 1.05, Math.sin(a) * 1.5],
    );
  }

  // Arched stone spandrels and cantilevered bronze sun-breaker louvers spanning between columns
  for (let i = 0; i < colCount - 1; i++) {
    const a0 = colAngles[i];
    const a1 = colAngles[i + 1];
    const aMid = (a0 + a1) * 0.5;
    const p0 = [Math.cos(a0) * colRadius, 3.52, Math.sin(a0) * colRadius];
    const p1 = [Math.cos(a1) * colRadius, 3.52, Math.sin(a1) * colRadius];
    const midX = (p0[0] + p1[0]) * 0.5;
    const midZ = (p0[2] + p1[2]) * 0.5;
    const spanDeg = (-Math.atan2(p1[2] - p0[2], p1[0] - p0[0]) * 180) / Math.PI;

    add(
      `Colonnade arch spandrel ${i}`,
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
      add(
        `Pergola sun-breaker louver ${i}-${s}`,
        meshes.bolt,
        architecturalBronze,
        [lx, 3.68, lz],
        [1.15, 0.035, 0.085],
        [0, lDeg, 8],
        [Math.cos(sa) * 1.45, 1.65, Math.sin(sa) * 1.45],
      );
    }
  }

  // Swept tubular bronze architrave beams crowning the colonnade arc
  const outerBeamPoints = [];
  const innerBeamPoints = [];
  for (let i = 0; i <= 36; i++) {
    const a = mix(colAngles[0] - 0.1, colAngles[colCount - 1] + 0.1, i / 36);
    outerBeamPoints.push([Math.cos(a) * (colRadius + 0.12), 3.64, Math.sin(a) * (colRadius + 0.12)]);
    innerBeamPoints.push([Math.cos(a) * 3.35, 3.58, Math.sin(a) * 3.35]);
  }
  add(
    'Colonnade outer bronze architrave',
    withUvs(tube(outerBeamPoints, { radius: 0.075, segments: 44, radialSegments: 12 })),
    architecturalBronze,
    [0, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
    [0, 1.55, 0],
  );
  add(
    'Colonnade inner basalt ring beam',
    withUvs(tube(innerBeamPoints, { radius: 0.058, segments: 44, radialSegments: 12 })),
    basaltTrim,
    [0, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
    [0, 1.65, 0],
  );

  // 3. Centerpiece: HELIOS-67 Solar Chronometer & Quadruped Observatory Rig
  add('Obsidian reactor plinth', meshes.pedestal, obsidian, [0, 0, 0], [1, 1, 1], [0, 0, 0], [0, -0.55, 0]);
  add('Porcelain magnetic confinement bell', meshes.lowerNozzle, porcelain, [0, 0, 0], [1, 1, 1], [0, 0, 0], [0, -0.25, 0]);
  add('Upper Dyson collector crown', meshes.upperCrown, gold, [0, 0, 0], [1, 1, 1], [0, 0, 0], [0, 1.35, 0]);

  // Singularity core & Cerenkov injectors
  const core = add(
    'Solar plasma singularity core',
    meshes.orb,
    solarCore,
    [0, 2.02, 0],
    [0.42, 0.42, 0.42],
    [0, 0, 0],
    [0, 0, 0],
  );
  animated.push({ part: core, kind: 'pulse', basePosition: [0, 2.02, 0], baseScale: [0.42, 0.42, 0.42] });

  add('Lower Cerenkov injector', meshes.orb, cyanGlow, [0, 1.24, 0], [0.20, 0.11, 0.20], [0, 0, 0], [0, -0.2, 0]);
  add('Upper Cerenkov injector', meshes.orb, cyanGlow, [0, 2.74, 0], [0.20, 0.11, 0.20], [0, 0, 0], [0, 0.95, 0]);
  add('Apex telemetry jewel', meshes.orb, titanium, [0, 3.68, 0], [0.095, 0.095, 0.095], [0, 0, 0], [0, 1.7, 0]);

  // Counter-rotating base gear wheels with teeth & spoke cutouts
  for (let i = 0; i < 2; i++) {
    const g = add(
      `Azimuth drive gear ${i}`,
      meshes.gear,
      i === 0 ? gold : titanium,
      [0, 0.88 + i * 0.06, 0],
      [1, 1, 1],
      [-90, 0, 0],
      [0, -0.35 + i * 0.14, 0],
    );
    animated.push({ part: g, kind: 'spinZ', speed: i === 0 ? 0.22 : -0.28 });
  }

  // 3-Axis Counter-Rotating Armillary Gimbal Cage around the core
  const outerGimbal = add(
    'Outer meridian gimbal ring',
    meshes.meridian,
    obsidian,
    [0, 2.02, 0],
    [0.90, 0.90, 0.90],
    [18, 0, 0],
    [0, 0.35, 1.25],
  );
  animated.push({ part: outerGimbal, kind: 'gimbalOuter', center: [0, 2.02, 0], scale: [0.90, 0.90, 0.90] });

  const middleGimbal = add(
    'Middle gold gyroscope ring',
    meshes.gyroRing,
    gold,
    [0, 2.02, 0],
    [0.80, 0.80, 0.80],
    [62, 24, 0],
    [-1.15, 0.25, 0.45],
  );
  animated.push({ part: middleGimbal, kind: 'gimbalMid', center: [0, 2.02, 0], scale: [0.80, 0.80, 0.80] });

  const innerGimbal = add(
    'Inner Cerenkov containment ring',
    meshes.innerRing,
    cyanGlow,
    [0, 2.02, 0],
    [0.60, 0.60, 0.60],
    [35, -40, 0],
    [1.15, 0.2, -0.45],
  );
  animated.push({ part: innerGimbal, kind: 'gimbalInner', center: [0, 2.02, 0], scale: [0.60, 0.60, 0.60] });

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
      [dirX * 1.2, 0.25, dirZ * 1.2],
    );
    add(
      `Superconducting coil ${i}`,
      meshes.innerCoil,
      copper,
      [0, 0, 0],
      [1, 1, 1],
      [0, deg + 18, 0],
      [dirX * 0.78, 0.12, dirZ * 0.78],
    );
  }

  // Collar containment rings
  for (const [idx, height] of [1.32, 1.66, 2.34, 2.68].entries()) {
    const r = idx === 1 || idx === 2 ? 0.96 : 0.76;
    add(
      `Containment collar ${idx}`,
      meshes.gyroRing,
      idx % 2 === 0 ? gold : porcelain,
      [0, height, 0],
      [r, r, r],
      [90, 0, 0],
      [0, (idx - 1.5) * 0.55, 0],
    );
  }

  // 6 Heavy articulated strider anchor legs + footpads + cyan beacon nodes anchored to the stepped altar
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
      [dirX * 1.25, -0.25, dirZ * 1.25],
    );
    add(
      `Strider footpad ${i}`,
      meshes.bolt,
      gold,
      [dirX * 1.96, 0.47, -dirZ * 1.96],
      [0.24, 0.045, 0.24],
      [0, deg, 0],
      [dirX * 1.4, -0.40, -dirZ * 1.4],
    );
    add(
      `Strider knee node ${i}`,
      meshes.orb,
      i % 2 === 0 ? cyanGlow : solarCore,
      [dirX * 1.38, 0.96, -dirZ * 1.38],
      [0.06, 0.06, 0.06],
      [0, 0, 0],
      [dirX * 1.35, -0.1, -dirZ * 1.35],
    );
  }

  // 3 Autonomous orbital recon drones
  for (let i = 0; i < 3; i++) {
    const drone = add(
      `Orbital recon drone ${i}`,
      meshes.orb,
      i === 0 ? solarCore : cyanGlow,
      [1.9, 2.1, 0],
      [0.08, 0.048, 0.08],
      [0, 0, 0],
      [Math.cos(i * 2.1) * 0.95, 0.65, Math.sin(i * 2.1) * 0.95],
    );
    animated.push({ part: drone, kind: 'drone', index: i, radius: 1.68 + i * 0.20, height: 1.78 + i * 0.32 });
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
  let initialSkyMap;

  try {
    helios = createObservatoryScene();
    initialSkyMap = createProceduralSunSkyHdri(128, 64);

    // Moss-blended garden boulders + living wind-swaying courtyard trees & grass + live PBD Cloth banner
    const boulderSphere = withUvs(sphere(24, 16));
    const poleMesh = withUvs(cylinder(18, 0.03, 2));
    const flagGeometry = buildFlagGeometry(18, 10, 1.48, 0.76);

    const mossyBoulderMat = {
      tag: 'rock',
      color: [0.42, 0.46, 0.38],
      metallic: 0.06,
      roughness: 0.78,
      blend: { radius: 0.28 },
    };
    const mastMaterial = {
      tag: 'metal',
      color: [0.78, 0.58, 0.28],
      metallic: 0.92,
      roughness: 0.22,
    };
    const flagMaterial = {
      tag: 'cloth',
      color: [0.88, 0.28, 0.12],
      metallic: 0.06,
      roughness: 0.58,
      doubleSided: true,
    };

    const flagPart = {
      name: 'Expedition wind banner',
      geometry: flagGeometry,
      matrix: place([-2.65, 2.68, -1.15], [1, 1, 1], [0, 24, 0]),
      material: flagMaterial,
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
        name: 'Mossy boulder West',
        geometry: boulderSphere,
        matrix: place([-2.35, 0.18, 1.42], [0.76, 0.48, 0.64], [8, 22, -6]),
        material: mossyBoulderMat,
      },
      {
        name: 'Mossy boulder West companion',
        geometry: boulderSphere,
        matrix: place([-1.82, 0.10, 1.76], [0.44, 0.28, 0.40], [-5, 45, 11]),
        material: mossyBoulderMat,
      },
      {
        name: 'Mossy boulder East',
        geometry: boulderSphere,
        matrix: place([2.45, 0.20, -1.22], [0.84, 0.52, 0.68], [-6, -28, 8]),
        material: mossyBoulderMat,
      },
      {
        name: 'Mossy boulder East outcrop',
        geometry: boulderSphere,
        matrix: place([1.92, 0.12, -1.68], [0.48, 0.30, 0.44], [9, 14, -10]),
        material: mossyBoulderMat,
      },
      {
        name: 'Telemetry standard mast',
        geometry: poleMesh,
        matrix: place([-2.65, 1.62, -1.15], [0.042, 1.62, 0.042]),
        material: mastMaterial,
      },
      flagPart,
      ...treeAndFoliageParts,
    ];

    allParts = [...helios.parts, ...environmentParts];

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
        extent: 6.8,
        near: 1.0,
        far: 28.0,
      },
      environment: {
        map: initialSkyMap,
        lightDirection: [...PROMPTS.model.state.lightDirection],
        keyColor: [4.8, 3.9, 2.7],
        fillIntensity: 0.08,
        ambientIntensity: 0.34,
        fogColor: [0.76, 0.72, 0.66],
        fogDensity: 0.004,
        pointLights: [
          { position: [0, 2.02, 0], color: [1.0, 0.56, 0.18], intensity: 5.2, range: 8, radius: 0.14 },
          { position: [-2.2, 2.6, 2.0], color: [0.24, 0.76, 1.0], intensity: 3.2, range: 10, radius: 0.16 },
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

  function updateRigTransforms(assemblyAmount, time) {
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
        mat4.fromRotationTranslationScale(
          item.part.baseMatrix,
          q,
          [0, item.part.baseMatrix[13], 0],
          [1, 1, 1],
        );
      } else if (item.kind === 'gimbalOuter') {
        const q = quat.fromEuler(quat.create(), 18, (time * 0.38 * 180) / Math.PI, 12);
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, item.center, item.scale);
      } else if (item.kind === 'gimbalMid') {
        const q = quat.fromEuler(
          quat.create(),
          62 + Math.sin(time * 0.7) * 22,
          (-time * 0.62 * 180) / Math.PI,
          24,
        );
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, item.center, item.scale);
      } else if (item.kind === 'gimbalInner') {
        const q = quat.fromEuler(
          quat.create(),
          (time * 1.15 * 180) / Math.PI,
          -40,
          (time * 0.85 * 180) / Math.PI,
        );
        mat4.fromRotationTranslationScale(item.part.baseMatrix, q, item.center, item.scale);
      } else if (item.kind === 'drone') {
        const a = time * (0.65 + item.index * 0.18) + item.index * 2.09;
        const pos = [
          Math.cos(a) * item.radius,
          item.height + Math.sin(time * 1.8 + item.index) * 0.18,
          Math.sin(a) * item.radius,
        ];
        mat4.fromRotationTranslationScale(
          item.part.baseMatrix,
          quat.create(),
          pos,
          [0.08, 0.048, 0.08],
        );
      }
    }

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
      target.azimuth += dt * 0.08;
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
        map: envMap,
        lightDirection: [...current.lightDirection],
        keyColor: [4.8, 3.9, 2.7],
        fillIntensity: 0.08,
        ambientIntensity: 0.34,
        wind: current.wind,
        pointLights: [
          { position: [0, 2.02, 0], color: [1.0, 0.56, 0.18], intensity: 5.2, range: 8, radius: 0.14 },
          { position: [-2.2, 2.6, 2.0], color: [0.24, 0.76, 1.0], intensity: 3.2, range: 10, radius: 0.16 },
        ],
      },
      effects: {
        ambientOcclusion: 0.65,
        ambientOcclusionRadius: 0.55,
        bloom: { strength: 0.18, threshold: 1.05, radius: 1.1 },
        contrast: current.contrast,
        temperature: current.temperature,
        vignette: 0.12,
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
