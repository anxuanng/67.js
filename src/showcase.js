import './site.css';
import './brand.js';
import './showcase.css';
import { Renderer67 } from './renderer.js';
import { loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { createCascadedShadows } from './cascaded-shadows.js';

// Each scene lives in public/showcase/<id>/scene.json: its GLB, sky, camera, renderer and frame options, and credits.
const SCENE_LABELS = { airport: 'Airport ramp', datacenter: 'AI data center', port: 'Container port' };
const SCENE_IDS = Object.keys(SCENE_LABELS);

const canvas = document.querySelector('#showcase-viewport');
const status = document.querySelector('#showcase-status');
const tabs = document.querySelector('#showcase-tabs');
const title = document.querySelector('#showcase-title');
const blurb = document.querySelector('#showcase-blurb');
const creditList = document.querySelector('#showcase-credits');
const orbit = { yaw: 0, pitch: 0, distance: 1, target: [0, 0, 0] };
let renderer = null;
let scene = null;
let loadingRequest = 0;
let scheduledFrame = 0;
let pointer = null;

function showStatus(message, failed = false) {
  status.hidden = false;
  status.dataset.failed = failed ? 'true' : 'false';
  status.textContent = `${failed ? '⚠' : '◷'} ${message}`;
}

function orbitFromCamera(eye, target) {
  const offset = eye.map((value, axis) => value - target[axis]);
  const distance = Math.hypot(...offset);
  orbit.target = [...target];
  orbit.distance = distance;
  orbit.yaw = Math.atan2(offset[0], offset[2]);
  orbit.pitch = Math.asin(offset[1] / distance);
}

function eyeFromOrbit() {
  const horizontal = Math.cos(orbit.pitch) * orbit.distance;
  return [
    orbit.target[0] + Math.sin(orbit.yaw) * horizontal,
    orbit.target[1] + Math.sin(orbit.pitch) * orbit.distance,
    orbit.target[2] + Math.cos(orbit.yaw) * horizontal,
  ];
}

function draw() {
  scheduledFrame = 0;
  if (!renderer || !scene) return;
  renderer.render({ ...scene.frame, eye: eyeFromOrbit(), target: orbit.target });
}

function requestDraw() {
  if (!scheduledFrame) scheduledFrame = requestAnimationFrame(draw);
}

function renderTabs() {
  for (const id of SCENE_IDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.scene = id;
    button.textContent = SCENE_LABELS[id];
    button.addEventListener('click', () => selectScene(id));
    tabs.append(button);
  }
}

async function readDescription(id) {
  const response = await fetch(`/showcase/${id}/scene.json`);
  if (!response.ok) throw new Error(`scene ${id} is not available (${response.status})`);
  return response.json();
}

function showCredits(credits = []) {
  creditList.replaceChildren(...credits.map(credit => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = credit.source;
    link.textContent = credit.model;
    item.append(link, ` by ${credit.author}, ${credit.licence}`);
    return item;
  }));
}

async function selectScene(id) {
  const request = ++loadingRequest;
  history.replaceState(null, '', `?scene=${id}`);
  for (const button of tabs.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.scene === id));
  showStatus('Loading the scene…');
  try {
    const description = await readDescription(id);
    title.textContent = description.title;
    blurb.textContent = description.blurb;
    showCredits(description.credits);
    const [asset, map] = await Promise.all([
      loadGltf(description.glb),
      loadHdri(description.hdri, description.hdriOptions ?? {}),
    ]);
    if (request !== loadingRequest) return;
    renderer?.dispose();
    const rendererOptions = description.renderer ?? {};
    // scene.json stores cascades as plain options; the renderer takes the cascade object built from them.
    const shadowCascades = rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined;
    renderer = new Renderer67(canvas, asset.parts, {
      ground: false, hdr: true, samples: 4, memoryBudgetMiB: 384,
      ...rendererOptions,
      shadowCascades,
      environment: { ...(rendererOptions.environment ?? {}), map },
    });
    scene = { frame: { exposure: description.exposure ?? 1, ...(description.frame ?? {}) } };
    orbitFromCamera(description.eye, description.target);
    window.__showcase = { renderer, scene, orbit, draw };
    status.hidden = true;
    requestDraw();
  } catch (error) {
    if (request === loadingRequest) showStatus(`Could not open this scene: ${error.message}`, true);
  }
}

canvas.addEventListener('pointerdown', event => {
  pointer = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!pointer) return;
  orbit.yaw -= (event.clientX - pointer.x) * 0.005;
  orbit.pitch = Math.max(0.05, Math.min(1.45, orbit.pitch + (event.clientY - pointer.y) * 0.004));
  pointer = { x: event.clientX, y: event.clientY };
  requestDraw();
});
canvas.addEventListener('pointerup', () => { pointer = null; });
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  orbit.distance *= Math.exp(event.deltaY * 0.001);
  requestDraw();
}, { passive: false });
window.addEventListener('resize', () => {
  renderer?.resize();
  requestDraw();
});

renderTabs();
const requested = new URLSearchParams(location.search).get('scene');
selectScene(SCENE_IDS.includes(requested) ? requested : SCENE_IDS[0]);
