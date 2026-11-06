// Live 3D AAA showcase hero for the homepage, powered by Glaze (Renderer67).
// Loads the staged Airport Ramp AAA world (Boeing 787-9 widebody, ground crew characters, pushback tug,
// catering & fuel trucks, terminal pier, control tower, hangars, 3-cascade shadows, and Industrial Sunset HDRI sky)
// and lets users or agents smoothly orbit and switch between 4 camera shots and surface-normal inspection.
import './replace-textured-parts.js';
import { Glaze } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { createCascadedShadows } from './cascaded-shadows.js';
import { readPartRanks } from './showcase-download.js';

const PROMPTS = {
  model: {
    prompt: '"Frame the widebody stand at golden hour with 3-cascade shadows across the Boeing 787-9, service trucks, and ground crew."',
    state: {
      eye: [138, 64, 36],
      target: [1, 3, -13],
      fov: 20,
      inspection: false,
      exposure: 1.0,
    },
  },
  explode: {
    prompt: '"Sweep down to ramp level beside the nose gear, turbofan cowling, pushback tug, and ground turnaround crew."',
    state: {
      eye: [58, 31, 84],
      target: [-8, 3, -18],
      fov: 24,
      inspection: false,
      exposure: 1.04,
    },
  },
  blend: {
    prompt: '"Orbit across the carbon wing, fuel tanker, terminal pier, and control tower against the Industrial Sunset HDRI sky."',
    state: {
      eye: [-86, 36, 82],
      target: [6, 8, -16],
      fov: 24,
      inspection: false,
      exposure: 1.02,
    },
  },
  review: {
    prompt: '"Switch Glaze to world-space surface normal inspection across the airliner fuselage, turbine blades, and ground vehicles."',
    state: {
      eye: [72, 26, 56],
      target: [-2, 4, -14],
      fov: 22,
      inspection: true,
      exposure: 1.0,
    },
  },
};

function orbitFromCamera(eye, target) {
  const dx = eye[0] - target[0];
  const dy = eye[1] - target[1];
  const dz = eye[2] - target[2];
  const distance = Math.hypot(dx, dy, dz) || 1;
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.asin(Math.max(-0.99, Math.min(0.99, dy / distance))),
    distance,
    target: [...target],
  };
}

function eyeFromOrbit(orbit) {
  const horiz = Math.cos(orbit.pitch) * orbit.distance;
  return [
    orbit.target[0] + Math.sin(orbit.yaw) * horiz,
    orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance,
    orbit.target[2] + Math.cos(orbit.yaw) * horiz,
  ];
}

function inWholeWorldOrder(files) {
  if (files.some(file => !file.ranks || file.ranks.length !== file.parts.length)) {
    return files.flatMap(file => file.parts);
  }
  const ranked = files.flatMap(file =>
    file.parts.map((part, index) => ({ part, rank: file.ranks[index] })),
  );
  return ranked.sort((a, b) => a.rank - b.rank).map(entry => entry.part);
}

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url} (${response.status})`);
  return response.blob();
}

export function mountHeroAgentWorkbench() {
  return mountHomeAgentHero();
}

export async function mountHomeAgentHero() {
  const canvas = document.querySelector('#hero-viewport');
  const frame = document.querySelector('.hero-frame');
  if (!canvas || !frame) return;

  let renderer = null;
  let activeMap = null;
  let sceneDescription = null;

  try {
    const descResp = await fetch('/showcase/airport/scene.json');
    if (!descResp.ok) throw new Error(`Airport scene description unavailable (${descResp.status})`);
    sceneDescription = await descResp.json();

    const glbUrl = new URL(sceneDescription.glb, location.href);
    const previewSkyUrl = new URL(
      sceneDescription.hdriPreview ?? sceneDescription.hdri,
      location.href,
    ).href;
    const fullSkyUrl = new URL(sceneDescription.hdri, location.href).href;
    const restUrls = (sceneDescription.glbRest ?? []).map(p => new URL(p, location.href).href);

    // Kick off stage-2 downloads in parallel while stage-1 decodes
    const remainingPromise = Promise.all([
      Promise.all(restUrls.map(url => fetchBlob(url))),
      loadHdri(fullSkyUrl, sceneDescription.hdriOptions ?? {}).catch(() => null),
    ]);

    const [firstBlob, previewMap] = await Promise.all([
      fetchBlob(glbUrl.href),
      loadHdri(previewSkyUrl, sceneDescription.hdriOptions ?? {}),
    ]);

    const sharedTextures = createSharedTextures();
    const firstAsset = await loadGltf(firstBlob, {
      baseUrl: new URL('.', glbUrl).href,
      sharedTextures,
      ...(sceneDescription.gltfOptions ?? {}),
    });
    const firstRanks = await readPartRanks(firstBlob);

    activeMap = previewMap;
    const rendererOptions = sceneDescription.renderer ?? {};
    const shadowCascades = rendererOptions.shadowCascades
      ? createCascadedShadows(rendererOptions.shadowCascades)
      : undefined;

    renderer = new Glaze(canvas, firstAsset.parts, {
      ground: false,
      hdr: true,
      depth: true,
      samples: 4,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      memoryBudgetMiB: 512,
      ...rendererOptions,
      shadowCascades,
      environment: {
        ...(rendererOptions.environment ?? {}),
        map: activeMap,
      },
    });

    frame.dataset.live = 'true';
    frame.classList.add('is-live-3d');

    // Finish loading full world parts + full HDRI sky
    const [restBlobs, fullMap] = await remainingPromise;
    if (restBlobs.length > 0) {
      const files = [{ parts: firstAsset.parts, ranks: firstRanks }];
      for (let i = 0; i < restBlobs.length; i++) {
        const baseUrl = new URL('.', new URL(sceneDescription.glbRest[i], location.href)).href;
        const restAsset = await loadGltf(restBlobs[i], {
          baseUrl,
          sharedTextures,
          ...(sceneDescription.gltfOptions ?? {}),
        });
        files.push({ parts: restAsset.parts, ranks: await readPartRanks(restBlobs[i]) });
      }
      const allParts = inWholeWorldOrder(files);
      renderer.replaceParts(allParts);
    }
    if (fullMap) {
      activeMap = fullMap;
    }
  } catch (err) {
    window.__heroWorkbench = { error: err.message };
    return;
  }

  const initialOrbit = orbitFromCamera(PROMPTS.model.state.eye, PROMPTS.model.state.target);
  const current = {
    yaw: initialOrbit.yaw,
    pitch: initialOrbit.pitch,
    distance: initialOrbit.distance,
    target: [...initialOrbit.target],
    fov: PROMPTS.model.state.fov,
    exposure: PROMPTS.model.state.exposure,
    inspection: PROMPTS.model.state.inspection,
  };
  let target = {
    yaw: initialOrbit.yaw,
    pitch: initialOrbit.pitch,
    distance: initialOrbit.distance,
    target: [...initialOrbit.target],
    fov: PROMPTS.model.state.fov,
    exposure: PROMPTS.model.state.exposure,
    inspection: PROMPTS.model.state.inspection,
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
    const nextOrbit = orbitFromCamera(preset.state.eye, preset.state.target);
    target = {
      yaw: nextOrbit.yaw,
      pitch: nextOrbit.pitch,
      distance: nextOrbit.distance,
      target: [...nextOrbit.target],
      fov: preset.state.fov,
      exposure: preset.state.exposure,
      inspection: preset.state.inspection,
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
  }, 7500);

  canvas.addEventListener('pointerdown', event => {
    dragging = true;
    userInteracted = true;
    pointerStart = [event.clientX, event.clientY];
    orbitStart = [target.yaw, target.pitch];
    canvas.setPointerCapture?.(event.pointerId);
  });

  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - pointerStart[0];
    const dy = event.clientY - pointerStart[1];
    target.yaw = orbitStart[0] - dx * 0.0055;
    target.pitch = Math.max(0.05, Math.min(1.35, orbitStart[1] + dy * 0.0045));
  });

  const endDrag = () => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const resizeObserver = new ResizeObserver(() => {
    renderer.resize();
  });
  resizeObserver.observe(canvas);

  const frameDefaults = sceneDescription.frame ?? {};
  const baseEffects = frameDefaults.effects ?? {};

  let rafId = 0;
  function tick(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
    lastNow = now;
    simTime += dt;

    const blend = 1 - Math.exp(-dt * 5.2);
    if (!dragging) {
      target.yaw += dt * 0.018;
    }

    current.yaw += (target.yaw - current.yaw) * blend;
    current.pitch += (target.pitch - current.pitch) * blend;
    current.distance += (target.distance - current.distance) * blend;
    for (let i = 0; i < 3; i++) {
      current.target[i] += (target.target[i] - current.target[i]) * blend;
    }
    current.fov += (target.fov - current.fov) * blend;
    current.exposure += (target.exposure - current.exposure) * blend;
    current.inspection = target.inspection;

    const eye = eyeFromOrbit(current);

    renderer.render({
      ...frameDefaults,
      eye,
      target: current.target,
      fov: current.fov,
      exposure: current.exposure,
      time: simTime,
      inspection: current.inspection,
      environment: {
        ...(sceneDescription.renderer?.environment ?? {}),
        map: activeMap,
      },
      effects: {
        ...baseEffects,
        ambientOcclusion: 0.55,
        ambientOcclusionRadius: 4.5,
      },
    });

    rafId = requestAnimationFrame(tick);
  }

  renderer.resize();
  // Render one synchronous frame before exposing __heroWorkbench so screenshots are guaranteed ready
  renderer.render({
    ...frameDefaults,
    eye: eyeFromOrbit(current),
    target: current.target,
    fov: current.fov,
    exposure: current.exposure,
    time: 0,
    inspection: current.inspection,
    environment: {
      ...(sceneDescription.renderer?.environment ?? {}),
      map: activeMap,
    },
    effects: {
      ...baseEffects,
      ambientOcclusion: 0.55,
      ambientOcclusionRadius: 4.5,
    },
  });
  rafId = requestAnimationFrame(tick);

  window.__heroWorkbench = { renderer, applyPresetUI, complete: true };
  window.addEventListener('pagehide', () => {
    clearInterval(autoCycle);
    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    renderer.dispose();
  });
}
