// Runs the OIDN network from the `denoiser` npm package (tensorflow.js) on one capture. denoise-browser.mjs drives this page.
import { Denoiser } from 'denoiser';

function base64ToFloats(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

function floatsToBase64(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

// The network reads normals as colours, so they are mapped from [-1, 1] to [0, 1] first.
function normalsAsColors(normal) {
  const mapped = new Float32Array(normal.length);
  for (let index = 0; index < normal.length; index++) mapped[index] = normal[index] * 0.5 + 0.5;
  return mapped;
}

window.denoiseInBrowser = async ({ width, height, color, albedo, normal, backend, quality, tiling }) => {
  const denoiser = new Denoiser(backend);
  denoiser.weightsUrl = '/tzas';
  denoiser.width = width;
  denoiser.height = height;
  denoiser.hdr = true;
  denoiser.quality = quality;
  denoiser.useTiling = tiling;
  const started = performance.now();
  await denoiser.build();
  const buildSeconds = (performance.now() - started) / 1000;
  denoiser.setInputData('color', base64ToFloats(color), { channels: 3 });
  denoiser.setInputData('albedo', base64ToFloats(albedo), { channels: 3 });
  denoiser.setInputData('normal', normalsAsColors(base64ToFloats(normal)), { channels: 3 });
  const executeStarted = performance.now();
  const output = await new Promise((resolve, reject) => {
    denoiser.onExecute(result => resolve(result), 'float32');
    denoiser.execute().catch(reject);
  });
  const executeSeconds = (performance.now() - executeStarted) / 1000;
  const floats = output instanceof Float32Array ? output : output.data ?? output;
  const result = { executeSeconds, buildSeconds, floatCount: floats.length, backend: denoiser.backend?.constructor?.name ?? null };
  denoiser.dispose();
  return { ...result, output: floatsToBase64(floats) };
};
window.denoiseReady = true;
