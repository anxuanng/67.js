// A soft glow behind the hero drawn as ordered-dither pixels (ported from codepawl.com's DitherField). The field is a sum of
// blurred blobs; every cell of a coarse grid is inked or left blank by comparing the field with an 8x8 Bayer matrix.
// Decorative: it steps at ten frames a second, pauses off screen, draws one still frame for reduced motion, and is cut out
// from under the header and the hero words.
const CELL = 4;
const FRAME_MS = 100;
const CLEAR_SELECTORS = ['.navigation', '.hero-copy'];
const CLEAR_MARGIN = 24;
const CLEAR_FEATHER = 72;
const PRESET_OPACITY = 0.24;

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map(value => (value + 0.5) / 64);

function blobsAround(anchor) {
  return [
    { offsetX: 0, offsetY: 0, radius: Math.max(anchor.width, anchor.height) * 0.62, strength: 0.46, orbit: 22, speed: 0.35, phase: 0, pulse: 0.2, pulseSpeed: 0.9 },
    { offsetX: anchor.width * 0.4, offsetY: anchor.height * 0.4, radius: anchor.height * 0.5, strength: 0.28, orbit: 50, speed: 0.22, phase: 2.1, pulse: 0.3, pulseSpeed: 0.6 },
    { offsetX: -anchor.width * 0.4, offsetY: -anchor.height * 0.34, radius: anchor.height * 0.42, strength: 0.22, orbit: 45, speed: 0.28, phase: 4.2, pulse: 0.3, pulseSpeed: 0.75 },
  ];
}

// The ink colour as ImageData stores a pixel (little-endian ABGR).
function inkFromTheme() {
  const style = getComputedStyle(document.documentElement);
  const hex = style.getPropertyValue('--dither-ink').trim().slice(1);
  const strength = Number.parseFloat(style.getPropertyValue('--dither-strength')) || 1;
  const alpha = Math.round(Math.min(1, PRESET_OPACITY * strength) * 255);
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return ((alpha << 24) | (blue << 16) | (green << 8) | red) >>> 0;
}

export function startDitherField({ anchor, cover }) {
  const anchorElement = document.querySelector(anchor);
  const wrapper = document.createElement('div');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!anchorElement || !context) return;
  wrapper.className = 'dither';
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.append(canvas);
  document.body.prepend(wrapper);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ink = inkFromTheme();
  let columns = 0;
  let rows = 0;
  let image = null;
  let pixels = null;
  let field = null;
  let clearance = null;
  let anchorBox = new DOMRect();
  let startedAt = performance.now();
  let frame = 0;
  let lastStep = 0;
  let visible = true;

  function applyClearance(wrapperBox) {
    clearance = new Float32Array(columns * rows).fill(1);
    for (const selector of CLEAR_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const left = box.left - wrapperBox.left - CLEAR_MARGIN;
        const right = box.right - wrapperBox.left + CLEAR_MARGIN;
        const top = box.top - wrapperBox.top - CLEAR_MARGIN;
        const bottom = box.bottom - wrapperBox.top + CLEAR_MARGIN;
        const firstRow = Math.max(0, Math.floor((top - CLEAR_FEATHER) / CELL));
        const lastRow = Math.min(rows - 1, Math.ceil((bottom + CLEAR_FEATHER) / CELL));
        const firstColumn = Math.max(0, Math.floor((left - CLEAR_FEATHER) / CELL));
        const lastColumn = Math.min(columns - 1, Math.ceil((right + CLEAR_FEATHER) / CELL));
        for (let row = firstRow; row <= lastRow; row += 1) {
          const y = row * CELL + CELL / 2;
          const distanceY = Math.max(top - y, 0, y - bottom);
          for (let column = firstColumn; column <= lastColumn; column += 1) {
            const x = column * CELL + CELL / 2;
            const distanceX = Math.max(left - x, 0, x - right);
            const index = row * columns + column;
            clearance[index] = Math.min(clearance[index], Math.min(1, Math.hypot(distanceX, distanceY) / CLEAR_FEATHER));
          }
        }
      }
    }
  }

  function measure() {
    const wrapperBox = wrapper.getBoundingClientRect();
    const coverElement = document.querySelector(cover);
    const coverBottom = coverElement ? coverElement.getBoundingClientRect().bottom - wrapperBox.top : 640;
    const height = Math.max(480, Math.round(coverBottom + 140));
    wrapper.style.height = `${height}px`;
    columns = Math.ceil(wrapperBox.width / CELL);
    rows = Math.ceil(height / CELL);
    canvas.width = columns;
    canvas.height = rows;
    canvas.style.width = `${columns * CELL}px`;
    canvas.style.height = `${rows * CELL}px`;
    image = context.createImageData(columns, rows);
    pixels = new Uint32Array(image.data.buffer);
    field = new Float32Array(columns * rows);
    applyClearance(wrapperBox);
    const box = anchorElement.getBoundingClientRect();
    anchorBox = new DOMRect(box.left - wrapperBox.left, box.top - wrapperBox.top, box.width, box.height);
  }

  function addBlob(blob, seconds, centreX, centreY) {
    const x = (centreX + blob.offsetX + Math.cos(seconds * blob.speed + blob.phase) * blob.orbit) / CELL;
    const y = (centreY + blob.offsetY + Math.sin(seconds * blob.speed * 0.8 + blob.phase) * blob.orbit) / CELL;
    const radius = blob.radius * (1 + blob.pulse * Math.sin(seconds * blob.pulseSpeed + blob.phase));
    const sigma = radius / CELL / 2;
    const reach = Math.ceil(sigma * 3);
    const twoSigmaSquared = 2 * sigma * sigma;
    const top = Math.max(0, Math.floor(y - reach));
    const bottom = Math.min(rows - 1, Math.ceil(y + reach));
    const left = Math.max(0, Math.floor(x - reach));
    const right = Math.min(columns - 1, Math.ceil(x + reach));
    for (let row = top; row <= bottom; row += 1) {
      const distanceY = row - y;
      for (let column = left; column <= right; column += 1) {
        const distanceX = column - x;
        field[row * columns + column] += blob.strength * Math.exp(-(distanceX * distanceX + distanceY * distanceY) / twoSigmaSquared);
      }
    }
  }

  function draw(now) {
    if (!image) return;
    const seconds = (now - startedAt) / 1000;
    field.fill(0);
    for (const blob of blobsAround(anchorBox)) {
      addBlob(blob, seconds, anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 2);
    }
    pixels.fill(0);
    for (let row = 0; row < rows; row += 1) {
      const bayerRow = (row & 7) * 8;
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (field[index] * clearance[index] > BAYER[bayerRow + (column & 7)]) pixels[index] = ink;
      }
    }
    context.putImageData(image, 0, 0);
  }

  function loop(now) {
    frame = requestAnimationFrame(loop);
    if (!visible || document.hidden || now - lastStep < FRAME_MS) return;
    lastStep = now;
    draw(now);
  }

  function start() {
    cancelAnimationFrame(frame);
    if (reducedMotion.matches) {
      startedAt = performance.now() - 60000;
      draw(performance.now());
      return;
    }
    frame = requestAnimationFrame(loop);
  }

  function refresh() {
    measure();
    draw(performance.now());
  }

  measure();
  start();
  new ResizeObserver(refresh).observe(document.documentElement);
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(wrapper);
  reducedMotion.addEventListener('change', start);
}
