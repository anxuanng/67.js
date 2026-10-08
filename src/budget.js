const MEBIBYTE = 1024 * 1024;

export const RENDER_PRESETS = Object.freeze({
  preview: { width: 960, height: 540, samples: 2, fps: 24, memoryBudgetMiB: 256 },
  balanced: { width: 1280, height: 720, samples: 4, fps: 24, memoryBudgetMiB: 384 },
  high: { width: 1920, height: 1080, samples: 4, fps: 24, memoryBudgetMiB: 512 },
  cpu: { width: 640, height: 360, samples: 1, fps: 12, memoryBudgetMiB: 192 },
});

export function estimateFrameBytes(width, height, samples, shadowResolution = 2048) {
  // Color/depth MSAA, resolve texture, browser buffers and one screenshot/encoder staging frame.
  return width * height * (8 * Math.max(1, samples) + 20) + shadowResolution ** 2 * 4;
}

export function planRenderSize({ width, height, pixelRatio = 1, samples = 4, memoryBudgetMiB = 256, geometryBytes = 0, shadowResolution = 2048, maximumSize = 8192 }) {
  for (const value of [width, height, pixelRatio, samples, memoryBudgetMiB, maximumSize]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Render dimensions, sample count and budget must be positive finite numbers.');
  }
  if (geometryBytes < 0 || !Number.isFinite(geometryBytes)) throw new Error('Geometry memory must be a nonnegative finite number.');
  const available = memoryBudgetMiB * MEBIBYTE - geometryBytes - shadowResolution ** 2 * 4;
  if (available < 64 * 64 * (8 * samples + 20)) throw new Error('Memory budget cannot hold the scene and a minimum render target. Lower scene detail or increase the budget.');
  const requestedWidth = Math.max(1, Math.round(width * pixelRatio));
  const requestedHeight = Math.max(1, Math.round(height * pixelRatio));
  const scale = Math.min(1, maximumSize / requestedWidth, maximumSize / requestedHeight, Math.sqrt(available / (requestedWidth * requestedHeight * (8 * samples + 20))));
  const renderWidth = Math.max(1, Math.floor(requestedWidth * scale));
  const renderHeight = Math.max(1, Math.floor(requestedHeight * scale));
  return { width: renderWidth, height: renderHeight, samples, estimatedBytes: estimateFrameBytes(renderWidth, renderHeight, samples, shadowResolution) + geometryBytes, reduced: scale < 1 };
}
