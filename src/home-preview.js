import { Renderer67 } from './renderer.js';
import { createMotionScene } from './motion.js';

const canvas = document.querySelector('#home-preview');
const status = document.querySelector('#home-preview-status');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = { yaw:0.6, pitch:0.28, distance:8, time:3, playing:!reducedMotion.matches, visible:false };
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
    const frame = scene.sample(state.time);
    renderer.updateParts(scene.parts);
    const distance = state.distance * (canvas.clientWidth < 500 ? 1.25 : 1);
    renderer.render({
      eye:[Math.sin(state.yaw) * Math.cos(state.pitch) * distance, Math.sin(state.pitch) * distance, Math.cos(state.yaw) * Math.cos(state.pitch) * distance],
      target:[0,0.1,0], fov:40, time:state.time, exposure:1, effects:{ ...frame.effects, vignette:0, grain:0 },
    });
  } catch (error) {
    showError(error);
  }
}

function animate(timestamp) {
  scheduledFrame = 0;
  if (!state.playing || !state.visible || document.hidden || disposed) return;
  const elapsedSeconds = previousTime ? Math.min(0.1, (timestamp - previousTime) / 1000) : 0;
  state.time = (state.time + elapsedSeconds) % scene.duration;
  previousTime = timestamp;
  draw();
  if (state.playing) scheduledFrame = requestAnimationFrame(animate);
}

function synchronizePlayback() {
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  previousTime = 0;
  if (state.playing && state.visible && !document.hidden && !disposed) {
    scheduledFrame = requestAnimationFrame(animate);
  }
}

function initialize() {
  if (renderer || disposed) return;
  try {
    scene = createMotionScene();
    renderer = new Renderer67(canvas, scene.parts, {
      ground:false, transparent:true, hdr:true, samples:4, pixelRatio:1.25, memoryBudgetMiB:192,
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
  Object.assign(state, { yaw:0.6, pitch:0.28, distance:8 });
  draw();
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointer) return;
  pointer = { id:event.pointerId, x:event.clientX, y:event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  state.yaw -= (event.clientX - pointer.x) * 0.008;
  if (event.pointerType !== 'touch') {
    state.pitch = Math.max(-1.1, Math.min(1.1, state.pitch + (event.clientY - pointer.y) * 0.008));
  }
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  draw();
});
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
    state.playing = !state.playing;
    synchronizePlayback();
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
  state.playing = !reducedMotion.matches;
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
