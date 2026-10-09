import { Renderer67 } from './renderer.js';
import { createWallEPreviewScene } from './wall-e-preview-scene.js';
import { approachValue } from './preview-transition.js';

const canvas = document.querySelector('#home-preview');
const status = document.querySelector('#home-preview-status');
const assemblySlider = document.querySelector('#preview-assembly');
const assemblyValue = document.querySelector('#preview-assembly-value');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = { yaw:0.6, pitch:0.28, distance:7.5, time:0, playing:!reducedMotion.matches, visible:false, assembly:0, assemblyTarget:0, speed:0, interacting:false, gaze:[0,0], gazeTarget:[0,0] };
const shadowEye = [-3,6,4];
const shadowTarget = [0,1,0];
const shadowBounds = { eye:[...shadowEye], target:[...shadowTarget], extent:6, near:0.1, far:20 };
let renderer;
let scene;
let scheduledFrame = 0;
let previousTime = 0;
let pointer;
let disposed = false;

function showError(error) {
  state.playing = false;
  status.hidden = false;
  status.textContent = `3D preview unavailable: ${error.message}. Reload the page to retry.`;
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
}

function draw() {
  if (!renderer || disposed || document.hidden || !state.visible) return;
  try {
    const frame = scene.sample(state.time, { gaze:state.gaze });
    for (let axis = 0; axis < 3; axis++) {
      shadowBounds.eye[axis] = shadowEye[axis] + frame.rootOffset[axis];
      shadowBounds.target[axis] = shadowTarget[axis] + frame.rootOffset[axis];
    }
    renderer.updateParts(scene.parts);
    const distance = state.distance * (canvas.clientWidth < 500 ? 1.05 : 1) + state.assembly * 10;
    const targetHeight = frame.target[1] + state.assembly * 0.35;
    renderer.render({
      eye:[frame.target[0] + Math.sin(state.yaw) * Math.cos(state.pitch) * distance, targetHeight + Math.sin(state.pitch) * distance, frame.target[2] + Math.cos(state.yaw) * Math.cos(state.pitch) * distance],
      target:[frame.target[0],targetHeight,frame.target[2]], fov:40, time:state.time, exposure:1, armorColor:[0.73,0.43,0.065], armorSurface:[0.62,0.43], assemblyAmount:state.assembly, effects:{ ...frame.effects, vignette:0, grain:0 },
    });
  } catch (error) {
    showError(error);
  }
}

function animate(timestamp) {
  scheduledFrame = 0;
  if ((!state.playing && state.assembly === state.assemblyTarget) || !state.visible || document.hidden || disposed) return;
  const elapsedSeconds = previousTime ? Math.min(0.1, (timestamp - previousTime) / 1000) : 0;
  const wasTransitioning = state.assembly !== state.assemblyTarget;
  state.assembly = approachValue(state.assembly, state.assemblyTarget, elapsedSeconds);
  if (wasTransitioning && state.assembly === 0 && state.assemblyTarget === 0 && !state.interacting && !reducedMotion.matches) {
    state.playing = true;
    state.speed = 0;
  }
  if (state.playing) {
    state.speed = Math.min(1, state.speed + elapsedSeconds / 1.2);
    state.time += elapsedSeconds * state.speed;
    for (let axis = 0; axis < 2; axis++) state.gaze[axis] = approachValue(state.gaze[axis], state.gazeTarget[axis], elapsedSeconds, 0.22);
  }
  previousTime = timestamp;
  draw();
  if (state.playing || state.assembly !== state.assemblyTarget) scheduledFrame = requestAnimationFrame(animate);
}

function synchronizePlayback() {
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  previousTime = 0;
  if ((state.playing || state.assembly !== state.assemblyTarget) && state.visible && !document.hidden && !disposed) {
    scheduledFrame = requestAnimationFrame(animate);
  }
}

function initialize() {
  if (renderer || disposed) return;
  try {
    scene = createWallEPreviewScene();
    renderer = new Renderer67(canvas, scene.parts, {
      ground:false, transparent:true, hdr:true, samples:4, pixelRatio:1.25, memoryBudgetMiB:192, shadowBounds,
    });
    window.__homePreview = { renderer, scene, state, draw };
    status.hidden = true;
    draw();
  } catch (error) {
    showError(error);
  }
}

function zoom(multiplier) {
  state.distance = Math.max(4.5, Math.min(14, state.distance * multiplier));
  draw();
}

function reset() {
  Object.assign(state, { yaw:0.6, pitch:0.28, distance:7.5 });
  draw();
}

function pauseForAssembly() {
  const wasPlaying = state.playing;
  state.playing = false;
  state.speed = 0;
  if (wasPlaying || !scheduledFrame) synchronizePlayback();
}

function finishAssemblyInteraction() {
  state.interacting = false;
  state.playing = state.assembly === 0 && state.assemblyTarget === 0 && !reducedMotion.matches;
  synchronizePlayback();
}

assemblySlider.addEventListener('pointerdown', () => {
  state.interacting = true;
  pauseForAssembly();
});
assemblySlider.addEventListener('input', () => {
  state.assemblyTarget = Number(assemblySlider.value) / 100;
  if (reducedMotion.matches) state.assembly = state.assemblyTarget;
  pauseForAssembly();
  const description = state.assemblyTarget === 0 ? 'Assembled' : Math.round(state.assemblyTarget * 100) + '% exploded';
  assemblyValue.textContent = description;
  assemblySlider.setAttribute('aria-valuetext', description);
  draw();
});
assemblySlider.addEventListener('change', () => {
  if (!state.interacting) finishAssemblyInteraction();
});
window.addEventListener('pointerup', () => {
  if (state.interacting) finishAssemblyInteraction();
});
window.addEventListener('pointercancel', () => {
  if (state.interacting) finishAssemblyInteraction();
});
assemblySlider.addEventListener('blur', () => {
  if (state.interacting) finishAssemblyInteraction();
});

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointer) return;
  pointer = { id:event.pointerId, x:event.clientX, y:event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!pointer) {
    const bounds = canvas.getBoundingClientRect();
    state.gazeTarget[0] = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
    state.gazeTarget[1] = Math.max(-1, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height * 2));
    return;
  }
  if (pointer.id !== event.pointerId) return;
  state.yaw -= (event.clientX - pointer.x) * 0.008;
  if (event.pointerType !== 'touch') {
    state.pitch = Math.max(-1.1, Math.min(1.1, state.pitch + (event.clientY - pointer.y) * 0.008));
  }
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  draw();
});
canvas.addEventListener('pointerleave', () => { state.gazeTarget.fill(0); });
canvas.addEventListener('lostpointercapture', () => { pointer = undefined; });
canvas.addEventListener('pointercancel', () => { pointer = undefined; });
canvas.addEventListener('pointerup', event => {
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  pointer = undefined;
});
canvas.addEventListener('wheel', event => {
  if (!renderer) return;
  event.preventDefault();
  zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.002));
}, { passive:false });
canvas.addEventListener('keydown', event => {
  if (event.code === 'Space') {
    event.preventDefault();
    if (state.assembly === 0 && state.assemblyTarget === 0 && !state.interacting) {
      state.playing = !state.playing;
      state.speed = 0;
      synchronizePlayback();
    }
    return;
  }
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'ArrowLeft') state.yaw -= 0.12;
  if (event.key === 'ArrowRight') state.yaw += 0.12;
  if (event.key === 'ArrowUp') state.pitch = Math.min(1.1, state.pitch + 0.12);
  if (event.key === 'ArrowDown') state.pitch = Math.max(-1.1, state.pitch - 0.12);
  if (['+','='].includes(event.key)) zoom(0.85);
  if (event.key === '-') zoom(1.15);
  if (event.key === 'Home') reset();
  draw();
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  showError(new Error('Graphics context was lost'));
});
canvas.addEventListener('webglcontextrestored', () => {
  renderer?.dispose();
  renderer = undefined;
  if (state.visible) initialize();
});

const resizeObserver = new ResizeObserver(() => {
  if (!renderer || disposed) return;
  try {
    renderer.resize();
    draw();
  } catch (error) {
    showError(error);
  }
});
resizeObserver.observe(canvas);
const visibilityObserver = new IntersectionObserver(entries => {
  state.visible = entries[0].isIntersecting;
  if (state.visible) {
    initialize();
    draw();
  }
  synchronizePlayback();
}, { threshold:0.05 });
visibilityObserver.observe(canvas);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) draw();
  synchronizePlayback();
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) state.assembly = state.assemblyTarget;
  state.playing = !reducedMotion.matches && state.assembly === 0 && state.assemblyTarget === 0 && !state.interacting;
  state.speed = 0;
  draw();
  synchronizePlayback();
});
window.addEventListener('pagehide', event => {
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  if (event.persisted) return;
  disposed = true;
  resizeObserver.disconnect();
  visibilityObserver.disconnect();
  renderer?.dispose();
});
window.addEventListener('pageshow', () => {
  draw();
  synchronizePlayback();
});
