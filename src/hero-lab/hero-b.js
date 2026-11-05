// Direction B: a world. Scroll position scrubs a camera path around the airport ramp.
// Only the first part of the showcase world loads (ground and hero aircraft) with the small preview sky, about 2.2 MB.
import './lab.css';
import { Renderer67 } from '../renderer.js';
import { loadGltf } from '../gltf.js';
import { loadHdri } from '../hdri.js';
import { createCascadedShadows } from '../cascaded-shadows.js';
import { clamp, damp, prefersReducedMotion, showStageError, smoothstep, startLoop } from './stage.js';

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#viewport');
const root = document.querySelector('.hero-b');
const chapterOne = document.querySelector('#chapter-one');
const chapterTwo = document.querySelector('#chapter-two');
const cue = document.querySelector('#cue');
const progressFill = document.querySelector('#progress-fill');

// Camera path: [eye, target, field of view]. Linear blend between keys, eased by the page's own scroll.
const KEYS = [
  { at: 0, eye: [138, 64, 36], target: [1, 3, -13], fov: 20 },
  { at: 0.55, eye: [74, 26, 62], target: [-4, 6, -14], fov: 26 },
  { at: 1, eye: [-30, 14, 70], target: [-12, 8, -14], fov: 34 },
];
const SCRUB_RATE = prefersReducedMotion ? 30 : 7;

function lerp(first, second, amount) {
  return first + (second - first) * amount;
}

function pathAt(progress) {
  let index = 0;
  while (index < KEYS.length - 2 && progress > KEYS[index + 1].at) index++;
  const from = KEYS[index];
  const to = KEYS[index + 1];
  const amount = smoothstep(0, 1, clamp((progress - from.at) / (to.at - from.at), 0, 1));
  return {
    eye: from.eye.map((value, axis) => lerp(value, to.eye[axis], amount)),
    target: from.target.map((value, axis) => lerp(value, to.target[axis], amount)),
    fov: lerp(from.fov, to.fov, amount),
  };
}

function scrollProgress() {
  const travel = root.offsetHeight - innerHeight;
  return clamp(-root.getBoundingClientRect().top / travel, 0, 1);
}

// Chapter copy is driven by the same progress value as the camera, using transform and opacity only.
function paintChapters(progress) {
  const leaving = smoothstep(0.12, 0.38, progress);
  chapterOne.style.opacity = String(1 - leaving);
  chapterOne.style.transform = `translateY(${-28 * leaving}px)`;
  chapterOne.style.pointerEvents = leaving > 0.5 ? 'none' : '';
  const arriving = smoothstep(0.62, 0.9, progress);
  chapterTwo.style.opacity = String(arriving);
  chapterTwo.style.transform = `translateY(${24 * (1 - arriving)}px)`;
  cue.style.opacity = String(1 - smoothstep(0.02, 0.12, progress));
  progressFill.style.transform = `scaleY(${progress})`;
}

async function start() {
  const description = await (await fetch('/showcase/airport/scene.json')).json();
  const [asset, sky] = await Promise.all([
    loadGltf(description.glb, description.gltfOptions),
    loadHdri(description.hdriPreview, description.hdriOptions),
  ]);
  const options = description.renderer;
  const renderer = new Renderer67(canvas, asset.parts, {
    ...options,
    pixelRatio: Math.min(devicePixelRatio, 1.25),
    memoryBudgetMiB: 384,
    shadowCascades: createCascadedShadows(options.shadowCascades),
    environment: { ...options.environment, map: sky },
  });

  const state = { progress: scrollProgress(), aim: scrollProgress() };
  const loop = startLoop(stage, seconds => {
    state.aim = scrollProgress();
    state.progress = damp(state.progress, state.aim, SCRUB_RATE, seconds);
    const settled = Math.abs(state.progress - state.aim) < 0.0004;
    if (settled) state.progress = state.aim;
    const camera = pathAt(state.progress);
    renderer.render({ ...description.frame, eye: camera.eye, target: camera.target, fov: camera.fov });
    paintChapters(state.progress);
    return !settled;
  });
  window.addEventListener('scroll', loop.wake, { passive: true });
  window.addEventListener('resize', loop.wake);
  window.__heroState = { state, renderer };
}

paintChapters(scrollProgress());
start().catch(error => showStageError(stage, `Live view unavailable: ${error.message}`));
