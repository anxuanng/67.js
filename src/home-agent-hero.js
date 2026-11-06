// Live AI Agent 3D Workbench for the homepage hero: prompts an agent, shows the MCP tool pipeline, and drives a real
// procedural 3D model (WALL-E study, 60+ parts) with MeshBlend terrain rocks and a live PBD cloth banner in Renderer67.
import { mat4, quat } from 'gl-matrix';
import { Renderer67 } from './renderer.js';
import { createModel } from './model.js';
import { box, cylinder, grid, sphere } from './geometry.js';
import { installMeshBlend } from './mesh-blend.js';
import { createFlagAnimation } from './nature-flag.js';

const PROMPTS = {
  model: {
    badge: 'scene_create · 64 parts · 0% exploded',
    prompt: '"Build a 64-part articulated rover with weathered armor, stereo optics, and hydraulic treads."',
    tools: [
      { tool: 'scene_create', detail: '64 parts · 18.4k tris · shared instanced meshes' },
      { tool: 'scene_apply', detail: 'set-material armor (metallic 0.62, roughness 0.43)' },
      { tool: 'scene_look', detail: '0.28 ms CPU · 0 overlap errors · bounds verified' },
    ],
    state: {
      azimuth: 0.52,
      elevation: 0.19,
      distance: 7.4,
      targetHeight: 1.32,
      assembly: 0,
      inspection: false,
      armorColor: [0.68, 0.38, 0.045],
      armorSurface: [0.52, 0.38],
      lightDirection: [-3.5, 6.2, 4.2],
      temperature: 0.04,
      contrast: 1.04,
      wind: 0.25,
    },
  },
  explode: {
    badge: 'scene_apply · explode-rig · 68% exploded',
    prompt: '"Explode the outer shell 68% along assembly vectors so the agent can inspect the internal drive and boards."',
    tools: [
      { tool: 'scene_apply', detail: 'set-assembly 0.68 · interior & exterior layers' },
      { tool: 'scene_inspect', detail: 'Battery cassette + Control electronics unobstructed' },
      { tool: 'scene_review', detail: '4-view orthographic & perspective sheet passed' },
    ],
    state: {
      azimuth: -0.58,
      elevation: 0.24,
      distance: 10.6,
      targetHeight: 1.52,
      assembly: 0.68,
      inspection: false,
      armorColor: [0.72, 0.78, 0.76],
      armorSurface: [0.12, 0.24],
      lightDirection: [4.2, 5.5, 3.4],
      temperature: -0.08,
      contrast: 1.06,
      wind: 0.2,
    },
  },
  blend: {
    badge: 'addons/mesh-blend + cloth · live PBD wind',
    prompt: '"Place basalt boulders with screen-space MeshBlend on the ground pad and pin a live wind banner behind the rover."',
    tools: [
      { tool: 'scene_apply', detail: 'enable createMeshBlend(radius: 0.22) on boulders' },
      { tool: 'scene_apply', detail: 'attach createCloth PBD banner (pinned mast edge)' },
      { tool: 'scene_render', detail: 'Renderer67 real-time + Trace67 path-traced still ready' },
    ],
    state: {
      azimuth: 0.34,
      elevation: 0.15,
      distance: 8.2,
      targetHeight: 1.25,
      assembly: 0.12,
      inspection: false,
      armorColor: [0.64, 0.36, 0.04],
      armorSurface: [0.48, 0.40],
      lightDirection: [-5.0, 3.4, 2.6],
      temperature: 0.14,
      contrast: 1.07,
      wind: 0.85,
    },
  },
  review: {
    badge: 'scene_review · surface normals & spatial check',
    prompt: '"Switch to surface-normal diagnostic pass to verify bevel continuity, silhouette separation, and zero self-intersections."',
    tools: [
      { tool: 'scene_review', detail: 'pass: normal · crease & silhouette check passed' },
      { tool: 'scene_diagnostics', detail: '0 warnings · all matrices finite & invertible' },
      { tool: 'Trace67', detail: 'optional offline path trace: 64 spp wavelet / OIDN' },
    ],
    state: {
      azimuth: 0.78,
      elevation: 0.22,
      distance: 7.6,
      targetHeight: 1.35,
      assembly: 0.28,
      inspection: true,
      armorColor: [0.62, 0.34, 0.035],
      armorSurface: [0.48, 0.43],
      lightDirection: [-3, 6, 4],
      temperature: 0,
      contrast: 1.02,
      wind: 0.4,
    },
  },
};

function place(position, scale, rotation = [0, 0, 0]) {
  const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

function buildFlagGeometry(columns = 18, rows = 10, width = 1.35, height = 0.72) {
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
      positions[idx + 1] = (v - 0.5) * height;
      positions[idx + 2] = 0;
      normals[idx + 2] = 1;
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return { positions, normals, indices: new Uint32Array(indices), _base: base };
}

function createEnvironmentParts() {
  const padMesh = cylinder(64, 0.04, 4);
  const rockMesh = sphere(28, 18);
  const mastMesh = cylinder(20, 0.01, 2);
  const flagGeometry = buildFlagGeometry();

  const groundMaterial = { tag: 'floor', color: [0.16, 0.15, 0.19], metallic: 0.08, roughness: 0.82, emission: 0 };
  const rockMaterial = { tag: 'rock', color: [0.24, 0.22, 0.27], metallic: 0.12, roughness: 0.74, emission: 0 };
  const rimMaterial = { tag: 'steel', color: [1.0, 0.42, 0.17], metallic: 0.2, roughness: 0.3, emission: 0.65 };
  const mastMaterial = { tag: 'steel', color: [0.52, 0.55, 0.58], metallic: 0.88, roughness: 0.26, emission: 0 };
  const flagMaterial = { tag: 'cloth', color: [0.96, 0.38, 0.14], metallic: 0.06, roughness: 0.64, emission: 0.08, doubleSided: true };

  const flagPart = {
    name: 'Agent signal banner',
    geometry: flagGeometry,
    matrix: place([-1.55, 2.75, -1.35], [1, 1, 1]),
    material: flagMaterial,
  };

  const parts = [
    {
      name: 'Calibration pad',
      geometry: padMesh,
      matrix: place([0, -0.09, 0], [3.6, 0.09, 3.6]),
      material: groundMaterial,
    },
    {
      name: 'Calibration ring',
      geometry: box(0.02, 2),
      matrix: place([0, 0.005, 2.15], [1.4, 0.012, 0.05]),
      material: rimMaterial,
    },
    {
      name: 'Basalt outcrop West',
      geometry: rockMesh,
      matrix: place([-1.75, 0.22, 0.85], [0.62, 0.38, 0.52], [0.2, 0.5, -0.15]),
      material: rockMaterial,
      blend: { radius: 0.22 },
    },
    {
      name: 'Basalt outcrop East',
      geometry: rockMesh,
      matrix: place([1.85, 0.18, -0.75], [0.55, 0.32, 0.48], [-0.15, 0.8, 0.2]),
      material: rockMaterial,
      blend: { radius: 0.22 },
    },
    {
      name: 'Basalt boulder North',
      geometry: rockMesh,
      matrix: place([1.45, 0.14, 1.25], [0.38, 0.24, 0.34], [0.1, -0.4, 0.1]),
      material: rockMaterial,
      blend: { radius: 0.18 },
    },
    {
      name: 'Telemetry mast',
      geometry: mastMesh,
      matrix: place([-1.52, 1.62, -1.35], [0.045, 1.65, 0.045]),
      material: mastMaterial,
    },
    flagPart,
  ];
  return { parts, flagPart };
}

function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function mountHeroAgentWorkbench() {
  const canvas = document.querySelector('#hero-viewport');
  const stage = document.querySelector('.hero-frame');
  if (!canvas || !stage) return;

  const promptText = document.querySelector('[data-agent-prompt]');
  const toolList = document.querySelector('[data-agent-tools]');
  const badgeText = document.querySelector('[data-agent-badge]');
  const metricsText = document.querySelector('[data-agent-metrics]');
  const buttons = [...document.querySelectorAll('[data-prompt-preset]')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer = null;
  let flagAnimation = null;
  let initError = null;
  let activeKey = 'model';
  const current = {
    azimuth: PROMPTS.model.state.azimuth,
    elevation: PROMPTS.model.state.elevation,
    distance: PROMPTS.model.state.distance,
    targetHeight: PROMPTS.model.state.targetHeight,
    assembly: PROMPTS.model.state.assembly,
    armorColor: [...PROMPTS.model.state.armorColor],
    armorSurface: [...PROMPTS.model.state.armorSurface],
    lightDirection: [...PROMPTS.model.state.lightDirection],
    temperature: PROMPTS.model.state.temperature,
    contrast: PROMPTS.model.state.contrast,
    wind: PROMPTS.model.state.wind,
    inspection: false,
  };
  let target = { ...PROMPTS.model.state };

  function renderHud(key) {
    const preset = PROMPTS[key];
    if (!preset) return;
    if (promptText) promptText.textContent = preset.prompt;
    if (badgeText) badgeText.textContent = preset.badge;
    if (toolList) {
      toolList.innerHTML = preset.tools
        .map(item => `<li><code>${item.tool}</code><span>${item.detail}</span></li>`)
        .join('');
    }
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.promptPreset === key));
    }
  }

  try {
    const modelParts = createModel();
    const env = createEnvironmentParts();
    const allParts = [...modelParts, ...env.parts];
    renderer = new Renderer67(canvas, allParts, {
      hdr: true,
      depth: true,
      ground: false,
      samples: 4,
      memoryBudgetMiB: 256,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      shadowBounds: { extent: 6.5, eye: [-3.5, 7, 4], target: [0, 1.3, 0] },
    });
    installMeshBlend(renderer);
    flagAnimation = createFlagAnimation(renderer, env.flagPart);
    stage.dataset.live = 'true';
  } catch (error) {
    initError = error?.message || String(error);
  }

  let frameId = 0;
  let lastTimestamp = 0;
  let visible = true;
  let dragging = null;

  function step(timestamp) {
    frameId = 0;
    if (document.hidden || !visible || !renderer) {
      lastTimestamp = 0;
      return;
    }
    const dt = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.05) : 1 / 60;
    lastTimestamp = timestamp;
    const rate = reducedMotion ? 18 : 6.5;

    if (!dragging && !reducedMotion) {
      target.azimuth += dt * 0.08;
    }

    current.azimuth = damp(current.azimuth, target.azimuth, rate, dt);
    current.elevation = damp(current.elevation, target.elevation, rate, dt);
    current.distance = damp(current.distance, target.distance, rate, dt);
    current.targetHeight = damp(current.targetHeight, target.targetHeight, rate, dt);
    current.assembly = damp(current.assembly, target.assembly, rate, dt);
    current.temperature = damp(current.temperature, target.temperature, rate, dt);
    current.contrast = damp(current.contrast, target.contrast, rate, dt);
    current.wind = damp(current.wind, target.wind, rate, dt);
    for (let i = 0; i < 3; i++) {
      current.armorColor[i] = damp(current.armorColor[i], target.armorColor[i], rate, dt);
      current.lightDirection[i] = damp(current.lightDirection[i], target.lightDirection[i], rate, dt);
    }
    for (let i = 0; i < 2; i++) {
      current.armorSurface[i] = damp(current.armorSurface[i], target.armorSurface[i], rate, dt);
    }
    current.inspection = target.inspection;

    flagAnimation.update(timestamp / 1000, current.wind);

    const mobile = canvas.clientWidth <= 820;
    renderer.projection[8] = mobile ? 0 : 0.16;
    const dist = current.distance * (mobile ? 1.12 : 1);
    const lookTarget = [0, current.targetHeight, 0];
    const eye = [
      Math.sin(current.azimuth) * Math.cos(current.elevation) * dist,
      lookTarget[1] + Math.sin(current.elevation) * dist,
      Math.cos(current.azimuth) * Math.cos(current.elevation) * dist,
    ];

    renderer.render({
      target: lookTarget,
      eye,
      armorColor: current.armorColor,
      armorSurface: current.armorSurface,
      exposure: 1.04,
      inspection: current.inspection,
      assemblyAmount: current.assembly,
      environment: { lightDirection: current.lightDirection },
      effects: {
        contrast: current.contrast,
        temperature: current.temperature,
        saturation: 1.04,
        vignette: 0.12,
        bloom: { strength: 0.14, threshold: 1.1, radius: 1 },
      },
    });

    if (metricsText) {
      metricsText.textContent = `${renderer.batches.length} draws · ${(renderer.cpuMilliseconds || 0.25).toFixed(2)} ms CPU · 50.9 KB gzip core`;
    }

    if (!reducedMotion) wake();
  }

  function wake() {
    if (!frameId && visible && !document.hidden && renderer) {
      frameId = requestAnimationFrame(step);
    }
  }

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const key = button.dataset.promptPreset;
      if (!PROMPTS[key]) return;
      activeKey = key;
      target = {
        ...PROMPTS[key].state,
        armorColor: [...PROMPTS[key].state.armorColor],
        armorSurface: [...PROMPTS[key].state.armorSurface],
        lightDirection: [...PROMPTS[key].state.lightDirection],
      };
      renderHud(key);
      if (reducedMotion) {
        Object.assign(current, target);
      }
      wake();
    });
  }

  if (renderer) {
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = { x: event.clientX, y: event.clientY, azimuth: target.azimuth, elevation: target.elevation };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!dragging) return;
      const dx = (event.clientX - dragging.x) / Math.max(canvas.clientWidth, 1);
      const dy = (event.clientY - dragging.y) / Math.max(canvas.clientHeight, 1);
      target.azimuth = dragging.azimuth - dx * 2.6;
      target.elevation = Math.max(-0.05, Math.min(0.85, dragging.elevation + dy * 1.4));
      wake();
    });
    const endDrag = () => { dragging = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true;
      wake();
    }).observe(stage);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('resize', () => {
      renderer.resize();
      wake();
    });
  }

  renderHud(activeKey);
  wake();
  window.__heroWorkbench = {
    get renderer() { return renderer; },
    get error() { return initError; },
    selectPreset: key => buttons.find(b => b.dataset.promptPreset === key)?.click(),
  };
}
