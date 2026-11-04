// Opt-in addon (issue #287): stores the HDR frame and its multisample colour as R11F_G11F_B10F, 4 bytes a pixel instead of 8.
// At 1920 x 1080 with 4 samples that is 39.55 MB less. The format has no alpha, drops negative values and keeps 6 or 5 mantissa
// bits, so pictures differ from the default by a small amount (docs/guide.md). Without this addon the core keeps RGBA16F.
const COMPACT_FORMAT = 'R11F_G11F_B10F';

function respecifyColorTargets(renderer) {
  const context = renderer.context;
  if (!renderer.multisampleFramebuffer) return;
  const { width, height } = renderer.canvas;
  context.bindRenderbuffer(context.RENDERBUFFER, renderer.multisampleColor);
  context.renderbufferStorageMultisample(context.RENDERBUFFER, renderer.multisampleSamples, context[COMPACT_FORMAT], width, height);
  context.bindTexture(context.TEXTURE_2D, renderer.frameTexture);
  context.texImage2D(context.TEXTURE_2D, 0, context[COMPACT_FORMAT], width, height, 0, context.RGB, context.HALF_FLOAT, null);
  for (const framebuffer of [renderer.multisampleFramebuffer, renderer.resolveFramebuffer]) {
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Compact colour targets failed to allocate. Do not install compact colour on this device.');
  }
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  renderer.renderTargets.record('multisampleColor', { width, height, format: COMPACT_FORMAT, samples: renderer.multisampleSamples });
  renderer.renderTargets.record('frameColor', { width, height, format: COMPACT_FORMAT });
}

/** Switches the frame and multisample colour to R11F_G11F_B10F. Needs `hdr: true` and an opaque canvas. Returns the renderer. */
export function useCompactColor(renderer) {
  if (!renderer.hdr || renderer.transparent) throw new Error('Compact colour needs hdr: true with negotiated HDR support and an opaque canvas, because it has no alpha.');
  if (renderer.colorFormat === COMPACT_FORMAT) return renderer;
  const context = renderer.context;
  const supported = context.getInternalformatParameter(context.RENDERBUFFER, context[COMPACT_FORMAT], context.SAMPLES);
  if (renderer.multisampleSamples > 0 && !Array.from(supported).includes(renderer.multisampleSamples)) throw new Error(`Compact colour does not support ${renderer.multisampleSamples} samples on this device.`);
  const allocateFrameTargets = renderer.allocateFrameTargets;
  renderer.allocateFrameTargets = function allocateCompactColorTargets(width, height) {
    allocateFrameTargets.call(this, width, height);
    respecifyColorTargets(this);
  };
  renderer.colorFormat = COMPACT_FORMAT;
  respecifyColorTargets(renderer);
  return renderer;
}
