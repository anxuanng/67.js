// Mesh blend: a screen-space pass that softens the seam where one mesh cuts into another (a rock sunk into terrain, a trunk
// into the ground). A part opts in with `blend: { radius }`, the distance in metres over which its colour mixes with the
// colour of the surface it meets. Nothing here is in the core renderer: installMeshBlend adds a post stage and wraps
// render, and a frame with no `blend` part runs untouched, so a scene without it draws the same pixels.
//
// A pixel of a blend part looks at taps on a spiral within `radius` (in screen pixels at its distance) and counts the taps
// that show another part. A tap counts only when its surface point lies within a short reach of this pixel (a depth match:
// a silhouette against the sky or a far wall is skipped) and the surfaces do not run parallel (a normal discontinuity,
// rebuilt from the depth). The part IDs come from the object ID render pass, drawn just before the frame; the depth is the
// depth texture of the frame, so the renderer needs `depth: true`, as line art does. Cost: one extra draw of the opaque
// geometry in the ID mode, plus a fullscreen pass that exits early for every pixel outside a blend part.

export const MESH_BLEND_LIMITS = Object.freeze({ radius: Object.freeze([0.005, 2]) });
export const MESH_BLEND_TAPS = Object.freeze({ count: 24, angleStep: 2.39996323 });
const TAP_COUNT = MESH_BLEND_TAPS.count;
const MAXIMUM_PIXEL_RADIUS = 40;
const TABLE_WIDTH = 1024;

// gl-program.js is not imported on purpose: this module loads on demand (see line-art.js).
const fullscreenVertex = `#version 300 es
precision highp float;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Checks a part's `blend` option and returns it normalized: { radius } in metres. */
export function normalizeBlend(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('blend must be an object such as { "radius": 0.15 }.');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'radius') throw new RangeError(`blend has no field ${key}. Fix: use { "radius": metres }.`);
  }
  const [minimum, maximum] = MESH_BLEND_LIMITS.radius;
  if (typeof input.radius !== 'number' || !(input.radius >= minimum && input.radius <= maximum)) {
    throw new RangeError(`blend.radius must be a number of metres between ${minimum} and ${maximum}.`);
  }
  return { radius: input.radius };
}

/**
 * The radius each object ID mixes over, indexed by ID (slot 0 is the background): the parts the ID pass numbers in order.
 * A part's own `blend` wins; `radii` maps a part name to a radius for hosts whose parts do not carry the option (a recipe's nodes).
 */
export function blendRadiusTable(parts, radii = new Map()) {
  const table = new Float32Array(parts.length + 1);
  parts.forEach((part, index) => {
    table[index + 1] = part.blend?.radius ?? radii.get(part.name) ?? 0;
  });
  return table;
}

// What scene_capabilities reports: one line, since every byte there is paid on each call. The limits are in the docs.
export const MESH_BLEND_CAPABILITIES = 'nodes[].blend {radius: metres 0.005-2} softens seams; needs depth; docs/mesh-blend.md';

export const blendFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform sampler2D sceneDepth;
uniform sampler2D partTexture;
uniform sampler2D radiusTexture;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float pixelsPerMetre;
uniform float orthographic;
out vec4 outputColor;
ivec2 lastPixel;
int partAt(ivec2 pixel) {
  ivec3 bytes = ivec3(texelFetch(partTexture, clamp(pixel, ivec2(0), lastPixel), 0).rgb * 255.0 + 0.5);
  return bytes.x + bytes.y * 256 + bytes.z * 65536;
}
vec3 positionAt(ivec2 pixel) {
  ivec2 clamped = clamp(pixel, ivec2(0), lastPixel);
  float depth = texelFetch(sceneDepth, clamped, 0).r;
  vec4 ndc = vec4((vec2(clamped) + 0.5) / vec2(lastPixel + 1) * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = inverseViewProjection * ndc;
  return world.xyz / world.w;
}
// The shorter step of the two sides, skipping a zero step (the frame edge clamps a neighbour onto the pixel itself).
vec3 shorterStep(vec3 first, vec3 second) {
  float firstLength = dot(first, first);
  float secondLength = dot(second, second);
  return (secondLength < 1e-14 || (firstLength >= 1e-14 && firstLength < secondLength)) ? first : second;
}
vec3 normalAt(ivec2 pixel, vec3 center) {
  vec3 right = positionAt(pixel + ivec2(1, 0)) - center;
  vec3 left = center - positionAt(pixel - ivec2(1, 0));
  vec3 up = positionAt(pixel + ivec2(0, 1)) - center;
  vec3 down = center - positionAt(pixel - ivec2(0, 1));
  vec3 raw = cross(shorterStep(right, left), shorterStep(up, down));
  vec3 toEye = normalize(eye - center);
  if (dot(raw, raw) < 1e-20) return toEye;
  vec3 normal = normalize(raw);
  return dot(normal, toEye) < 0.0 ? -normal : normal;
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  lastPixel = textureSize(sourceTexture, 0) - 1;
  vec4 source = texelFetch(sourceTexture, pixel, 0);
  outputColor = source;
  int part = partAt(pixel);
  if (part == 0) return;
  float radius = texelFetch(radiusTexture, ivec2(part & ${TABLE_WIDTH - 1}, part / ${TABLE_WIDTH}), 0).r;
  if (radius <= 0.0) return;
  vec3 center = positionAt(pixel);
  float pixelRadius = radius * pixelsPerMetre / (orthographic > 0.5 ? 1.0 : length(center - eye));
  pixelRadius = clamp(pixelRadius, 1.0, ${MAXIMUM_PIXEL_RADIUS}.0);
  float reach = radius * 3.0;
  vec3 colorSum = vec3(0.0);
  float otherWeight = 0.0;
  float totalWeight = 0.0;
  ivec2 nearestTap = pixel;
  bool found = false;
  for (int index = 0; index < ${TAP_COUNT}; index++) {
    float fraction = sqrt((float(index) + 0.5) / ${TAP_COUNT}.0);
    float angle = float(index) * ${MESH_BLEND_TAPS.angleStep};
    ivec2 tap = pixel + ivec2(round(vec2(cos(angle), sin(angle)) * pixelRadius * fraction));
    float weight = 1.0 - fraction;
    totalWeight += weight;
    int tapPart = partAt(tap);
    if (tapPart == 0 || tapPart == part) continue;
    if (distance(positionAt(tap), center) > reach) continue;
    if (!found) nearestTap = tap;
    found = true;
    colorSum += weight * texelFetch(sourceTexture, clamp(tap, ivec2(0), lastPixel), 0).rgb;
    otherWeight += weight;
  }
  if (!found) return;
  float creased = smoothstep(0.05, 0.4, 1.0 - dot(normalAt(pixel, center), normalAt(nearestTap, positionAt(nearestTap))));
  float amount = smoothstep(0.0, 0.5, otherWeight / totalWeight) * creased;
  outputColor.rgb = mix(source.rgb, colorSum / otherWeight, amount);
}`;

function compileShader(context, kind, source) {
  const shader = context.createShader(kind);
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
    throw new Error(`Mesh blend shader compilation failed: ${context.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function compileProgram(context, vertexSource, fragmentSource) {
  const program = context.createProgram();
  context.attachShader(program, compileShader(context, context.VERTEX_SHADER, vertexSource));
  context.attachShader(program, compileShader(context, context.FRAGMENT_SHADER, fragmentSource));
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    throw new Error(`Mesh blend shader linking failed: ${context.getProgramInfoLog(program)}`);
  }
  return program;
}

function createColorTarget(context, width, height, floatColor, filter) {
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, floatColor ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA,
    floatColor ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
    throw new Error('Mesh blend framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture, framebuffer };
}

function sameTable(first, second) {
  return first?.length === second.length && first.every((value, index) => value === second[index]);
}

/**
 * Adds the seam blend to a renderer. The renderer needs `depth: true` and installRenderPasses first. A part opts in with
 * `blend: { radius }`; a frame whose parts have none draws exactly as before.
 */
export function installMeshBlend(renderer) {
  if (renderer.meshBlend) return renderer;
  if (!renderer.passSupport) throw new Error('Mesh blend needs installRenderPasses(renderer) from 67js/addons/render-passes first.');
  const state = { active: false, table: null };
  let program = null;
  let uniforms = null;
  let partTarget = null;
  let outputTarget = null;
  let radiusTexture = null;

  function opaqueParts() {
    return renderer.batches.filter(batch => renderer.drawsInOpaqueLoop(batch)).flatMap(batch => batch.parts);
  }

  function uploadTable(table) {
    const { context } = renderer;
    if (sameTable(state.table, table)) return;
    state.table = table;
    const rows = Math.ceil(table.length / TABLE_WIDTH);
    const padded = new Float32Array(rows * TABLE_WIDTH);
    padded.set(table);
    radiusTexture ??= context.createTexture();
    context.bindTexture(context.TEXTURE_2D, radiusTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.R32F, TABLE_WIDTH, rows, 0, context.RED, context.FLOAT, padded);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
  }

  function captureParts() {
    const { context, canvas } = renderer;
    partTarget ??= createColorTarget(context, canvas.width, canvas.height, false, context.NEAREST);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.passSupport.framebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, partTarget.framebuffer);
    context.blitFramebuffer(0, 0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height, context.COLOR_BUFFER_BIT, context.NEAREST);
  }

  function apply(rendererInUse, frame, effects, sourceTexture) {
    if (!state.active) return null;
    if (!renderer.depthTexture) throw new Error('Mesh blend requires depth:true on the renderer.');
    const { context, canvas } = renderer;
    if (!program) {
      program = compileProgram(context, fullscreenVertex, blendFragment);
      uniforms = Object.fromEntries(['sourceTexture', 'sceneDepth', 'partTexture', 'radiusTexture', 'inverseViewProjection', 'eye', 'pixelsPerMetre', 'orthographic']
        .map(name => [name, context.getUniformLocation(program, name)]));
    }
    outputTarget ??= createColorTarget(context, canvas.width, canvas.height, renderer.hdr, context.LINEAR);
    context.bindFramebuffer(context.FRAMEBUFFER, outputTarget.framebuffer);
    context.viewport(0, 0, canvas.width, canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(program);
    [[sourceTexture, 'sourceTexture'], [renderer.depthTexture, 'sceneDepth'], [partTarget.texture, 'partTexture'], [radiusTexture, 'radiusTexture']].forEach(([texture, name], unit) => {
      context.activeTexture(context.TEXTURE0 + unit);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.uniform1i(uniforms[name], unit);
    });
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, renderer.inverseViewProjection);
    context.uniform3fv(uniforms.eye, frame.eye);
    context.uniform1f(uniforms.pixelsPerMetre, renderer.projection[5] * canvas.height / 2);
    context.uniform1f(uniforms.orthographic, renderer.projection[15] === 1 ? 1 : 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
    return outputTarget.texture;
  }

  function releaseTargets(context) {
    for (const target of [partTarget, outputTarget]) {
      if (!target) continue;
      context.deleteTexture(target.texture);
      context.deleteFramebuffer(target.framebuffer);
    }
    partTarget = null;
    outputTarget = null;
  }

  function dispose(context) {
    releaseTargets(context);
    if (program) context.deleteProgram(program);
    if (radiusTexture) context.deleteTexture(radiusTexture);
    program = null;
    radiusTexture = null;
    state.table = null;
  }

  renderer.postStages.push({ name: 'Mesh blend', apply, releaseTargets, dispose });
  const drawFrame = renderer.render.bind(renderer);
  renderer.render = frame => {
    state.active = false;
    if (frame.pass === undefined && !frame.reflectionTarget && !renderer.benchmark) {
      const table = blendRadiusTable(opaqueParts(), renderer.meshBlend.radii);
      if (table.some(radius => radius > 0)) {
        uploadTable(table);
        drawFrame({ ...frame, pass: 'objectId' });
        captureParts();
        state.active = true;
      }
    }
    try {
      drawFrame(frame);
    } finally {
      state.active = false;
    }
  };
  renderer.meshBlend = { limits: MESH_BLEND_LIMITS, radii: new Map() };
  return renderer;
}
