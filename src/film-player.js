import './film-style.css';
import { Renderer67 } from './renderer.js';
import { createFilmScenes, FILM_DURATION, sampleFilm } from './film.js';

const query = new URLSearchParams(window.location.search);
const exporting = query.get('export') === '1';
function numberOption(name, fallback, minimum, maximum) {
  const raw = query.get(name);
  const value = raw === null || raw.trim() === '' ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.round(Math.max(minimum, Math.min(maximum, value))) : fallback;
}
const width = numberOption('width', 1280, 320, 7680);
const height = numberOption('height', 720, 240, 4320);
const samples = numberOption('samples', 4, 1, 8);
const memoryBudgetMiB = numberOption('memory', 384, 64, 1024);
const canvas = document.querySelector('#film-canvas');
const stage = document.querySelector('.film-stage');
const slider = document.querySelector('#film-time');
const playButton = document.querySelector('#film-play');
const playLabel = document.querySelector('#play-label');
const playSymbol = document.querySelector('#play-symbol');
const clock = document.querySelector('#film-clock');
const title = document.querySelector('#film-title');
const titleText = document.querySelector('#title-text');
const subtitleText = document.querySelector('#subtitle-text');
const flash = document.querySelector('#film-flash');
const scenes = createFilmScenes();
const score = exporting ? null : new Audio('./media/critical.mp4');
if (score) score.preload = 'none';
let renderer = null;
let activeScene = null;
let currentTime = 0;
let playing = false;
let animationFrame = 0;
let playbackOrigin = 0;

if (exporting) {
  document.body.classList.add('export-mode');
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
}

function displayTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function renderAt(time) {
  const sample = sampleFilm(time);
  const scene = scenes[sample.scene];
  if (activeScene !== sample.scene) {
    renderer?.dispose();
    renderer = null;
    activeScene = null;
    const parts = sample.scene === 'ignition' ? scene.parts.filter(part => !['fire', 'smoke'].includes(part.material.tag)) : scene.parts;
    renderer = new Renderer67(canvas, parts, {
      world: true,
      ground: scene.ground,
      environment: scene.environment,
      shadowBounds: scene.shadowBounds,
      pixelRatio: 1,
      samples,
      memoryBudgetMiB,
    });
    activeScene = sample.scene;
  }
  renderer.render({
    ...sample.camera,
    time: sample.sceneTime,
    exposure: sample.exposure,
    monochrome: sample.monochrome,
    fade: sample.fade,
    cinematic: true,
    explosionProgress: sample.explosionProgress,
    volumeExplosion: sample.scene === 'ignition',
    environment: scene.environment,
  });
  currentTime = sample.time;
  slider.value = String(currentTime);
  slider.setAttribute('aria-valuetext', `${currentTime.toFixed(1)} of ${FILM_DURATION} seconds`);
  clock.value = `${displayTime(currentTime)} / ${displayTime(FILM_DURATION)}`;
  titleText.textContent = sample.title;
  subtitleText.textContent = sample.subtitle;
  title.style.opacity = String(sample.titleOpacity);
  flash.style.opacity = String(sample.flash);
  return sample;
}

function setPlaying(value) {
  playing = value;
  playLabel.textContent = playing ? 'Pause' : currentTime >= FILM_DURATION ? 'Play again' : 'Play film';
  playSymbol.textContent = playing ? 'Ⅱ' : '▶';
  playButton.setAttribute('aria-label', playing ? 'Pause film' : 'Play film');
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (playing) {
    if (currentTime >= FILM_DURATION) renderAt(0);
    if (score) {
      score.currentTime = currentTime;
      score.play().catch(() => {
        document.querySelector('.film-caption').textContent = '⚠ Score unavailable. The 3D film continues.';
      });
    }
    playbackOrigin = performance.now() - currentTime * 1000;
    animationFrame = requestAnimationFrame(advance);
  } else score?.pause();
}

function showError(error) {
  setPlaying(false);
  const notice = document.querySelector('#film-error');
  notice.textContent = `⚠ ${error.message}`;
  notice.hidden = false;
  window.__filmError = error.message;
}

function advance(timestamp) {
  if (!playing) return;
  try {
    const seconds = score && !score.paused && score.readyState >= 2 ? score.currentTime : (timestamp - playbackOrigin) / 1000;
    renderAt(seconds);
    if (currentTime >= FILM_DURATION) setPlaying(false);
    else animationFrame = requestAnimationFrame(advance);
  } catch (error) {
    showError(error);
  }
}

playButton.addEventListener('click', () => setPlaying(!playing));
document.querySelector('#film-replay').addEventListener('click', () => {
  setPlaying(false);
  renderAt(0);
  setPlaying(true);
});
slider.addEventListener('input', () => {
  setPlaying(false);
  renderAt(Number(slider.value));
});
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.target.closest('input, button, a')) return;
  event.preventDefault();
  setPlaying(!playing);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setPlaying(false);
});
window.addEventListener('resize', () => {
  if (!renderer || exporting) return;
  renderer.resize();
  renderAt(currentTime);
});
window.addEventListener('pagehide', () => {
  setPlaying(false);
  renderer?.dispose();
  renderer = null;
  activeScene = null;
});

window.__filmReady = false;
window.renderAt = renderAt;
window.__film = {
  scenes,
  get renderer() { return renderer; },
  sampleFilm,
  renderAt,
  duration: FILM_DURATION,
  score,
  exporting,
  options: { width, height, samples, memoryBudgetMiB },
};
try {
  // Playback waits for a click for every motion preference, including reduced motion.
  renderAt(exporting ? 0 : 0.8);
  window.__filmReady = true;
} catch (error) {
  showError(error);
}
