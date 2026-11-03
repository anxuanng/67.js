// Reversed-Z depth (issue #310): with EXT_clip_control the depth range is zero to one, the projection maps the near plane to 1 and
// the far plane to 0, and the buffer is cleared to 0 and tested with GREATER. Floating point numbers are densest near 0, which is
// where the far surfaces land, so a 32-bit float buffer keeps its precision at distance instead of losing it as 1 / z does.
//
// This is an addon: the renderer core carries none of it. `installReversedDepth(renderer)` wraps a few renderer steps, and the
// mode decides when it switches on: `true` at once, `false` never, `'auto'` (the default) when a frame's far / near ratio passes
// FAR_TO_NEAR_LIMIT or `renderer.requestReversedDepth()` is called (the coplanar check does, for a flush pair far from the eye).
// Switching on reallocates the frame targets once, at the start of a frame.
import { mat4 } from 'gl-matrix';
import { compileProgram, fullscreenVertex } from './gl-program.js';

export const FAR_TO_NEAR_LIMIT = 1e4;
const DEFAULT_NEAR = 0.1;

/**
 * Turns a projection that maps depth to -1..1 into one that maps it to 1..0 (the clip control range is 0..1).
 * Only the third row changes: the new z is (w - z) / 2, so it works for perspective, orthographic and oblique matrices.
 */
export function reverseProjectionDepth(out, projection) {
  for (let column = 0; column < 4; column++) {
    const depthIndex = column * 4 + 2;
    const clipDepth = projection[depthIndex];
    const clipW = projection[depthIndex + 1];
    out[column * 4] = projection[column * 4];
    out[column * 4 + 1] = projection[column * 4 + 1];
    out[depthIndex] = (clipW - clipDepth) / 2;
    out[depthIndex + 1] = clipW;
  }
  return out;
}

/** Whether a frame's lens is stretched enough that a 24-bit depth buffer cannot tell close surfaces apart far away. */
export function exceedsFarToNearLimit(frame) {
  return frame.far / (frame.near ?? DEFAULT_NEAR) > FAR_TO_NEAR_LIMIT;
}

// The depth texture the other passes read holds standard depth (1 at the far plane), so a stage right after the resolve turns the
// reversed depth back, through a copy, with gl_FragDepth. Ambient occlusion, depth of field, fog and line art then need no change.
const STANDARD_DEPTH_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D reversedDepth;
void main() {
  gl_FragDepth = 1.0 - texelFetch(reversedDepth, ivec2(gl_FragCoord.xy), 0).r;
}`;

function createDepthConversionStage() {
  let program = null;
  let uniform = null;
  let copy = null;

  function releaseTargets(context) {
    if (!copy) return;
    context.deleteTexture(copy.texture);
    context.deleteFramebuffer(copy.framebuffer);
    copy = null;
  }

  function createCopy(context, width, height) {
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT32F, width, height, 0, context.DEPTH_COMPONENT, context.FLOAT, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height };
  }

  function apply(renderer) {
    if (!renderer.depthTexture) return null;
    const context = renderer.context;
    const { width, height } = renderer.canvas;
    if (!program) {
      program = compileProgram(context, fullscreenVertex, STANDARD_DEPTH_FRAGMENT);
      uniform = context.getUniformLocation(program, 'reversedDepth');
    }
    if (copy && (copy.width !== width || copy.height !== height)) releaseTargets(context);
    copy ??= createCopy(context, width, height);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.resolveFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, copy.framebuffer);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.DEPTH_BUFFER_BIT, context.NEAREST);
    context.bindFramebuffer(context.FRAMEBUFFER, renderer.resolveFramebuffer);
    context.viewport(0, 0, width, height);
    context.useProgram(program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, copy.texture);
    context.uniform1i(uniform, 0);
    context.enable(context.DEPTH_TEST);
    context.depthFunc(context.ALWAYS);
    context.colorMask(false, false, false, false);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.drawArrays(context.TRIANGLES, 0, 3);
    context.colorMask(true, true, true, true);
    context.depthFunc(context.LESS);
    context.disable(context.DEPTH_TEST);
    return null;
  }

  function dispose(context) {
    releaseTargets(context);
    if (program) context.deleteProgram(program);
    program = null;
  }

  return { name: 'Reversed depth', apply, releaseTargets, dispose };
}

// The frame targets are allocated with 24-bit depth by the core; this respecifies the two depth stores as 32-bit float.
function useFloatDepthTargets(renderer) {
  const context = renderer.context;
  if (!renderer.multisampleFramebuffer) return;
  const { width, height } = renderer.canvas;
  context.bindRenderbuffer(context.RENDERBUFFER, renderer.multisampleDepth);
  context.renderbufferStorageMultisample(context.RENDERBUFFER, renderer.multisampleSamples, context.DEPTH_COMPONENT32F, width, height);
  if (renderer.depthTexture) {
    context.bindTexture(context.TEXTURE_2D, renderer.depthTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT32F, width, height, 0, context.DEPTH_COMPONENT, context.FLOAT, null);
  }
  for (const framebuffer of [renderer.multisampleFramebuffer, renderer.resolveFramebuffer]) {
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Reversed depth targets failed to allocate. Pass reversedDepth: false to the install.');
  }
  context.bindFramebuffer(context.FRAMEBUFFER, null);
}

/**
 * Wraps the renderer so its colour pass draws with reversed-Z once the mode asks for it. Returns the renderer.
 * `renderer.reversedDepth` is true once it is on. A browser without EXT_clip_control, or a benchmark renderer, stays standard.
 */
export function installReversedDepth(renderer, mode = 'auto') {
  if (mode === false || renderer.reversedDepth !== undefined) return renderer;
  const context = renderer.context;
  const original = {
    render: renderer.render,
    applyEnvironmentUniforms: renderer.applyEnvironmentUniforms,
    applyDepthLayer: renderer.applyDepthLayer,
    resolveFrame: renderer.resolveFrame,
    allocateFrameTargets: renderer.allocateFrameTargets,
  };
  const rasterProjection = mat4.create();
  const rasterViewProjection = mat4.create();
  let clipControl = null;
  let requested = mode === true;
  let inFrame = false;
  let reversed = false;

  // Back to the standard range before the backgrounds, the post passes and the shadow maps draw.
  function endReversed() {
    if (!reversed || clipControl.active === false) return;
    clipControl.extension.clipControlEXT(clipControl.extension.LOWER_LEFT_EXT, clipControl.extension.NEGATIVE_ONE_TO_ONE_EXT);
    context.depthFunc(context.LESS);
    clipControl.active = false;
  }

  // Called with the main program in use, after its standard matrix is set: swap in the reversed one and clear to the far value.
  function beginReversed() {
    reverseProjectionDepth(rasterProjection, renderer.projection);
    mat4.multiply(rasterViewProjection, rasterProjection, renderer.view);
    context.uniformMatrix4fv(renderer.uniforms.viewProjection, false, rasterViewProjection);
    context.clearDepth(0);
    context.clear(context.DEPTH_BUFFER_BIT);
    context.clearDepth(1);
    clipControl.extension.clipControlEXT(clipControl.extension.LOWER_LEFT_EXT, clipControl.extension.ZERO_TO_ONE_EXT);
    context.depthFunc(context.GREATER);
    clipControl.active = true;
  }

  function enable() {
    const extension = renderer.benchmark ? null : context.getExtension?.('EXT_clip_control');
    requested = false;
    if (!extension) {
      renderer.reversedDepth = false;
      return false;
    }
    clipControl = { extension, active: false };
    reversed = true;
    renderer.reversedDepth = true;
    renderer.rasterProjection = rasterProjection;
    renderer.rasterViewProjection = rasterViewProjection;
    if (renderer.capabilities) renderer.capabilities.reversedDepth = true;
    renderer.applyEnvironmentUniforms = function applyEnvironmentUniformsReversed(map, uniforms) {
      original.applyEnvironmentUniforms.call(this, map, uniforms);
      if (inFrame && !clipControl.active && uniforms === undefined) beginReversed();
    };
    // The core pulls a decal toward the eye with a negative offset; reversed depth grows toward the eye, so the sign flips.
    renderer.applyDepthLayer = function applyDepthLayerReversed(layer) {
      original.applyDepthLayer.call(this, layer);
      if (layer && clipControl.active) context.polygonOffset(layer, layer * 4);
    };
    renderer.resolveFrame = function resolveFrameStandard(...parameters) {
      endReversed();
      return original.resolveFrame.apply(this, parameters);
    };
    renderer.allocateFrameTargets = function allocateFloatDepthTargets(width, height) {
      original.allocateFrameTargets.call(this, width, height);
      useFloatDepthTargets(this);
    };
    renderer.postStages.unshift(createDepthConversionStage());
    useFloatDepthTargets(renderer);
    return true;
  }

  renderer.requestReversedDepth = () => {
    requested = true;
  };
  renderer.render = function renderReversed(frame) {
    if (!reversed && renderer.reversedDepth === undefined && (requested || exceedsFarToNearLimit(frame))) enable();
    if (!reversed) return original.render.call(this, frame);
    inFrame = true;
    try {
      return original.render.call(this, frame);
    } finally {
      inFrame = false;
      endReversed();
    }
  };
  if (requested) enable();
  return renderer;
}
