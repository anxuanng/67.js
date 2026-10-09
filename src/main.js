import './style.css';
import { Renderer67 } from './renderer.js';
import { createModel } from './model.js';
import { downloadGlb } from './export.js';
import { assemblyOffset } from './assembly.js';

const canvas = document.querySelector('#viewport');
const parts = createModel();
const finishes = {
  yellow: { name: 'Factory yellow', color: [0.62, 0.34, 0.035], surface: [0.48, 0.43] },
  ceramic: { name: 'Ceramic', color: [0.7, 0.77, 0.74], surface: [0.05, 0.24] },
  graphite: { name: 'Graphite', color: [0.10, 0.14, 0.17], surface: [0.65, 0.4] },
};
const state = { azimuth: 0.48, elevation: 0.18, distance: 7.8, finish: 'yellow', exposure: 1, inspection: false, rotating: false, assembly: Math.max(0, Math.min(1, Number(new URLSearchParams(location.search).get('explosion')) || 0)), layer: 'all' };
let renderer;
let scheduledFrame = 0;
let lastTime = 0;
let frameCount = 0;
let cpuTotal = 0;
let noticeTimer;
let dragging = null;

function notify(message, failure = false) {
  const notice = document.querySelector('#notice');
  notice.textContent = `${failure ? '⚠' : '✓'} ${message}`;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  if (!failure) noticeTimer = setTimeout(() => { notice.hidden = true; }, 4000);
}

function camera() {
  const mobile = canvas.clientWidth <= 700;
  if (renderer) renderer.projection[8] = mobile || state.exporting ? 0 : -0.25 + state.assembly * 0.15;
  const distance = state.distance * (mobile ? 0.78 : 1) + state.assembly * (mobile ? 8 : 10);
  const target = [0, (mobile ? 1.5 : 1.35) + state.assembly * 0.35, 0];
  return {
    target,
    eye: [Math.sin(state.azimuth) * Math.cos(state.elevation) * distance, target[1] + Math.sin(state.elevation) * distance, Math.cos(state.azimuth) * Math.cos(state.elevation) * distance],
    armorColor: finishes[state.finish].color,
    armorSurface: finishes[state.finish].surface,
    exposure: state.exposure,
    inspection: state.inspection,
    assemblyAmount: state.assembly,
  };
}

function draw(time) {
  scheduledFrame = 0;
  if (!renderer || document.hidden) return;
  if (state.rotating && !dragging) state.azimuth += Math.min((time - lastTime) / 1000, 0.05) * 0.16;
  lastTime = time;
  renderer.render(camera());
  cpuTotal += renderer.cpuMilliseconds;
  frameCount++;
  document.querySelector('#cpu').textContent = `${(cpuTotal / frameCount).toFixed(2)} ms CPU`;
  if (frameCount > 60) { cpuTotal = renderer.cpuMilliseconds; frameCount = 1; }
  if (state.rotating) invalidate();
}

function invalidate() {
  if (!scheduledFrame && renderer && !document.hidden) scheduledFrame = requestAnimationFrame(draw);
}

function initialize() {
  const visibleParts = state.layer === 'all' ? parts : parts.filter((part) => part.assembly?.layer === state.layer);
  renderer = new Renderer67(canvas, visibleParts, { shadowBounds: { extent: 6, eye: [-3, 7, 4], target: [0, 1.5, 0] } });
  document.querySelector('#parts').textContent = `${visibleParts.length} parts · ${Math.round(renderer.triangles / 1000)}k triangles`;
  document.querySelector('#calls').textContent = `${renderer.batches.length} geometry draws`;
  invalidate();
  window.__studio = { parts, get renderer() { return renderer; }, state, camera, invalidate };
}

document.querySelector('#assembly').value = String(state.assembly * 100);
document.querySelector('#assembly-value').textContent = `${state.assembly * 100}%`;
document.querySelector('#assembly').setAttribute('aria-valuetext', state.assembly === 1 ? 'Fully exploded' : state.assembly === 0 ? 'Assembled' : `${state.assembly * 100}% exploded`);

try { initialize(); } catch (error) { notify(error.message, true); }

document.querySelector('#assembly').addEventListener('input', (event) => {
  state.assembly = Number(event.target.value) / 100;
  document.querySelector('#assembly-value').textContent = `${event.target.value}%`;
  event.target.setAttribute('aria-valuetext', state.assembly === 0 ? 'Assembled' : state.assembly === 1 ? 'Fully exploded' : `${event.target.value}% exploded`);
  invalidate();
});
document.querySelectorAll('[data-layer]').forEach((button) => button.addEventListener('click', () => {
  state.layer = button.dataset.layer;
  document.querySelectorAll('[data-layer]').forEach((control) => control.setAttribute('aria-pressed', String(control === button)));
  renderer?.dispose();
  try { initialize(); } catch (error) { notify(error.message, true); }
}));

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  state.azimuth -= (event.clientX - dragging.x) * 0.007;
  state.elevation = Math.max(-0.15, Math.min(1.1, state.elevation + (event.clientY - dragging.y) * 0.007));
  dragging.x = event.clientX;
  dragging.y = event.clientY;
  invalidate();
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(eventName, () => { dragging = null; });
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  state.distance = Math.max(3.5, Math.min(11, state.distance + event.deltaY * 0.008));
  invalidate();
}, { passive: false });
canvas.addEventListener('keydown', (event) => {
  const changes = { ArrowLeft: [-0.1, 0, 0], ArrowRight: [0.1, 0, 0], ArrowUp: [0, 0.08, 0], ArrowDown: [0, -0.08, 0], '+': [0, 0, -0.3], '=': [0, 0, -0.3], '-': [0, 0, 0.3] };
  if (changes[event.key]) {
    event.preventDefault();
    const [azimuth, elevation, distance] = changes[event.key];
    state.azimuth += azimuth;
    state.elevation = Math.max(-0.15, Math.min(1.1, state.elevation + elevation));
    state.distance = Math.max(3.5, Math.min(11, state.distance + distance));
    invalidate();
  }
  if (event.key.toLowerCase() === 'r') document.querySelector('#reset').click();
});
document.querySelector('#reset').addEventListener('click', () => {
  Object.assign(state, { azimuth: 0.48, elevation: 0.18, distance: 7.8 });
  invalidate();
});
document.querySelectorAll('[data-finish]').forEach((button) => button.addEventListener('click', () => {
  state.finish = button.dataset.finish;
  document.querySelectorAll('[data-finish]').forEach((swatch) => {
    const selected = swatch === button;
    swatch.classList.toggle('selected', selected);
    swatch.setAttribute('aria-pressed', String(selected));
  });
  document.querySelector('#finish-name').textContent = finishes[state.finish].name;
  invalidate();
}));
document.querySelector('#exposure').addEventListener('input', (event) => {
  state.exposure = Number(event.target.value);
  document.querySelector('#exposure-value').textContent = state.exposure.toFixed(1);
  invalidate();
});
document.querySelector('#rotate').addEventListener('click', (event) => {
  state.rotating = !state.rotating;
  event.currentTarget.setAttribute('aria-pressed', String(state.rotating));
  lastTime = performance.now();
  invalidate();
});
document.querySelector('#inspect').addEventListener('click', (event) => {
  state.inspection = !state.inspection;
  event.currentTarget.setAttribute('aria-pressed', String(state.inspection));
  invalidate();
});
document.querySelector('#quality').addEventListener('change', (event) => {
  if (!renderer) return;
  renderer.pixelRatio = Number(event.target.value);
  renderer.resize();
  invalidate();
});
document.querySelector('#export').addEventListener('click', () => {
  try {
    const finish = finishes[state.finish];
    const exported = parts.filter((part) => state.layer === 'all' || part.assembly?.layer === state.layer).map((part) => {
      const matrix = new Float32Array(part.matrix);
      const displacement = assemblyOffset(part, state.assembly);
      for (let axis = 0; axis < 3; axis++) matrix[12 + axis] += displacement[axis];
      const material = part.material.tag === 'armor' ? { ...part.material, color: finish.color, metallic: finish.surface[0], roughness: finish.surface[1] } : part.material;
      return { ...part, matrix, material };
    });
    downloadGlb(exported);
    notify('GLB exported. Open it in Blender or another glTF viewer.');
  } catch (error) { notify(`Export failed: ${error.message}`, true); }
});
document.querySelector('#benchmark').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  const wasRotating = state.rotating;
  state.rotating = false;
  document.querySelector('#rotate').setAttribute('aria-pressed', 'false');
  const summary = document.querySelector('#benchmark-summary');
  document.querySelector('#benchmark-result').hidden = false;
  summary.textContent = '◷ Loading benchmark…';
  try {
    const { runBenchmark } = await import('./benchmark.js');
    const report = await runBenchmark(parts, (progress) => { summary.textContent = `◷ ${progress}`; });
    window.__benchmarkReport = report;
    summary.textContent = `✓ Measured on this browser\n${report.results.map((result) => `${result.name}: ${result.milliseconds === 0 ? '<0.013' : result.milliseconds.toFixed(3)} ms · ${result.calls} calls`).join('\n')}`;
  } catch (error) { summary.textContent = `⚠ Benchmark failed: ${error.message}`; }
  finally {
    button.disabled = false;
    state.rotating = wasRotating;
    document.querySelector('#rotate').setAttribute('aria-pressed', String(wasRotating));
    invalidate();
  }
});
document.querySelector('#dismiss-benchmark').addEventListener('click', () => { document.querySelector('#benchmark-result').hidden = true; });
new ResizeObserver(() => { renderer?.resize(); invalidate(); }).observe(canvas);
document.addEventListener('visibilitychange', () => { lastTime = performance.now(); invalidate(); });
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  renderer?.dispose();
  renderer = null;
  notify('Graphics context lost. Waiting for the browser to restore it.', true);
});
canvas.addEventListener('webglcontextrestored', () => {
  try { initialize(); notify('Graphics restored.'); } catch (error) { notify(error.message, true); }
});
