import { mat4, mat3 } from 'gl-matrix';
import { vertexShader, fragmentShader, depthVertexShader, depthFragmentShader, benchmarkVertexShader, benchmarkFragmentShader } from './shaders.js';
import { fullscreenVertex, postFragment, skyFragment } from './post.js';
import { planRenderSize } from './budget.js';

const MATERIAL_TAGS = { armor: 1, floor: 2, water: 3, foliage: 4, terrain: 5, grass: 7, fire: 8, smoke: 9 };

function compileProgram(context, vertexSource, fragmentSource) {
  const program = context.createProgram();
  const shaders = [];
  for (const [kind, source] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = context.createShader(kind);
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      const message = context.getShaderInfoLog(shader);
      context.deleteShader(shader);
      shaders.forEach((compiled) => context.deleteShader(compiled));
      context.deleteProgram(program);
      throw new Error(`Shader compilation failed: ${message}`);
    }
    shaders.push(shader);
    context.attachShader(program, shader);
  }
  context.linkProgram(program);
  shaders.forEach((shader) => context.deleteShader(shader));
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    const message = context.getProgramInfoLog(program);
    context.deleteProgram(program);
    throw new Error(`Shader linking failed: ${message}`);
  }
  return program;
}

function groundPart() {
  return {
    name: 'Studio floor',
    geometry: {
      positions: new Float32Array([-100, 0.019, -100, -100, 0.019, 100, 100, 0.019, 100, 100, 0.019, -100]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: mat4.create(),
    material: { color: [0.04, 0.05, 0.06], metallic: 0, roughness: 1, emission: 0, tag: 'floor' },
  };
}

export function groupParts(parts, batching = true) {
  const groups = new Map();
  for (const part of parts) {
    if (part.matrix.length !== 16 || !Array.from(part.matrix).every(Number.isFinite)) {
      throw new Error(`Invalid transform: ${part.name}`);
    }
    const key = batching ? part.geometry : part;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  return [...groups.values()];
}

export class Renderer67 {
  constructor(canvas, parts, { batching = true, pixelRatio = 1.5, benchmark = false, world = false, ground = true, samples = 4, memoryBudgetMiB = 256, environment = {}, shadowBounds = {} } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!this.context) throw new Error('WebGL2 is unavailable. Enable hardware acceleration or use a supported browser.');
    this.pixelRatio = pixelRatio;
    this.benchmark = benchmark;
    this.world = world;
    this.environment = environment;
    this.shadowBounds = shadowBounds;
    this.memoryBudgetMiB = memoryBudgetMiB;
    this.samples = benchmark ? 1 : Math.min(samples, this.context.getParameter(this.context.MAX_SAMPLES));
    this.geometryBytes = 0;
    this.buffers = [];
    this.batches = [];
    this.view = mat4.create();
    this.projection = mat4.create();
    this.viewProjection = mat4.create();
    this.lightProjection = mat4.create();
    this.inverseViewProjection = mat4.create();
    this.program = compileProgram(this.context, benchmark ? benchmarkVertexShader : vertexShader, benchmark ? benchmarkFragmentShader : fragmentShader);
    this.depthProgram = compileProgram(this.context, depthVertexShader, depthFragmentShader);
    this.uniforms = Object.fromEntries(['viewProjection', 'lightProjection', 'eye', 'armorColor', 'armorSurface', 'exposure', 'inspection', 'shadowMap', 'time', 'wind', 'worldMode', 'daylight', 'lightDirection', 'fogColor', 'fogDensity', 'waterRipple', 'rippleTime', 'explosionProgress', 'explosionCenter', 'assemblyAmount'].map((name) => [name, this.context.getUniformLocation(this.program, name)]));
    if (!benchmark) {
      this.postProgram = compileProgram(this.context, fullscreenVertex, postFragment);
      this.skyProgram = compileProgram(this.context, fullscreenVertex, skyFragment);
      this.postUniforms = Object.fromEntries(['frameTexture', 'resolution', 'monochrome', 'fade', 'cinematic', 'time', 'volumeExplosion', 'explosionProgress', 'inverseViewProjection', 'eye'].map((name) => [name, this.context.getUniformLocation(this.postProgram, name)]));
      this.skyUniforms = Object.fromEntries(['skyTop', 'skyBottom', 'sunDirection', 'inverseViewProjection', 'eye', 'time', 'daylight'].map((name) => [name, this.context.getUniformLocation(this.skyProgram, name)]));
    }
    this.depthUniform = this.context.getUniformLocation(this.depthProgram, 'lightProjection');
    this.depthAssemblyUniform = this.context.getUniformLocation(this.depthProgram, 'assemblyAmount');
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    groupParts(ground ? [...parts, groundPart()] : parts, batching).forEach((group) => this.batches.push(this.uploadBatch(group)));
    this.createShadowMap();
    this.resize();
    if (!this.benchmark && !this.multisampleFramebuffer) this.allocateFrameTargets(this.canvas.width, this.canvas.height);
  }

  uploadBuffer(target, data) {
    const buffer = this.context.createBuffer();
    this.buffers.push(buffer);
    this.context.bindBuffer(target, buffer);
    this.context.bufferData(target, data, this.context.STATIC_DRAW);
    this.geometryBytes += data.byteLength;
    return buffer;
  }

  uploadBatch(parts) {
    const context = this.context;
    const geometry = parts[0].geometry;
    const vertexArray = context.createVertexArray();
    context.bindVertexArray(vertexArray);
    for (const [location, data] of [[0, geometry.positions], [1, geometry.normals]]) {
      this.uploadBuffer(context.ARRAY_BUFFER, data);
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, 3, context.FLOAT, false, 0, 0);
    }
    this.uploadBuffer(context.ELEMENT_ARRAY_BUFFER, geometry.indices);
    const stride = 35;
    const instanceData = new Float32Array(parts.length * stride);
    const normalMatrix = mat3.create();
    parts.forEach((part, index) => {
      const offset = index * stride;
      if (!mat3.normalFromMat4(normalMatrix, part.matrix)) throw new Error(`Singular transform: ${part.name}`);
      instanceData.set(part.matrix, offset);
      instanceData.set(normalMatrix, offset + 16);
      instanceData.set(part.material.color, offset + 25);
      instanceData.set([part.material.metallic, part.material.roughness, part.material.emission ?? 0, MATERIAL_TAGS[part.material.tag] ?? 0], offset + 28);
      instanceData.set(part.assembly?.offset ?? [0, 0, 0], offset + 32);
    });
    this.uploadBuffer(context.ARRAY_BUFFER, instanceData);
    for (let column = 0; column < 4; column++) this.attribute(2 + column, 4, stride * 4, column * 16);
    for (let column = 0; column < 3; column++) this.attribute(6 + column, 3, stride * 4, 64 + column * 12);
    this.attribute(9, 3, stride * 4, 100);
    this.attribute(10, 4, stride * 4, 112);
    this.attribute(11, 3, stride * 4, 128);
    context.bindVertexArray(null);
    return { vertexArray, indexCount: geometry.indices.length, instanceCount: parts.length, floor: parts[0].material.tag === 'floor' };
  }

  attribute(location, size, stride, offset) {
    this.context.enableVertexAttribArray(location);
    this.context.vertexAttribPointer(location, size, this.context.FLOAT, false, stride, offset);
    this.context.vertexAttribDivisor(location, 1);
  }

  createShadowMap() {
    const context = this.context;
    const allocateShadow = !this.shadowTexture;
    if (allocateShadow) this.shadowTexture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    if (allocateShadow) context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, 2048, 2048, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    if (!this.shadowFramebuffer) this.shadowFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.shadowFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.shadowTexture, 0);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Shadow framebuffer is incomplete.');
    const defaults = this.world ? { eye: [-25, 60, 30], target: [0, 2, -10], extent: 65, near: 1, far: 220 } : { eye: [-3, 6, 4], target: [0, 1, 0], extent: 3.5, near: 0.1, far: 15 };
    const light = { ...defaults, ...this.shadowBounds };
    const lightView = mat4.lookAt(mat4.create(), light.eye, light.target, [0, 1, 0]);
    mat4.ortho(this.lightProjection, -light.extent, light.extent, -light.extent, light.extent, light.near, light.far);
    mat4.multiply(this.lightProjection, this.lightProjection, lightView);
    context.viewport(0, 0, 2048, 2048);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    context.clear(context.DEPTH_BUFFER_BIT);
    context.useProgram(this.depthProgram);
    context.uniformMatrix4fv(this.depthUniform, false, this.lightProjection);
    context.uniform1f(this.depthAssemblyUniform, this.assemblyAmount ?? 0);
    context.enable(context.POLYGON_OFFSET_FILL);
    context.polygonOffset(1, 1);
    for (const batch of this.batches) if (!batch.floor) this.drawBatch(batch);
    context.disable(context.POLYGON_OFFSET_FILL);
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  resize() {
    const plan = planRenderSize({ width: Math.max(1, this.canvas.clientWidth), height: Math.max(1, this.canvas.clientHeight), pixelRatio: this.pixelRatio, samples: this.samples, memoryBudgetMiB: this.memoryBudgetMiB, geometryBytes: this.geometryBytes, maximumSize: this.context.getParameter(this.context.MAX_RENDERBUFFER_SIZE) });
    const { width, height } = plan;
    this.memoryPlan = plan;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (!this.benchmark) this.allocateFrameTargets(width, height);
    }
    mat4.perspective(this.projection, this.world ? Math.PI / 4 : Math.PI / 5.5, width / height, 0.1, this.world ? 600 : 100);
    this.projection[8] = !this.benchmark && !this.world && this.canvas.clientWidth > 700 ? -0.25 : 0;
  }

  releaseFrameTargets() {
    const context = this.context;
    if (this.multisampleFramebuffer) context.deleteFramebuffer(this.multisampleFramebuffer);
    if (this.resolveFramebuffer) context.deleteFramebuffer(this.resolveFramebuffer);
    if (this.multisampleColor) context.deleteRenderbuffer(this.multisampleColor);
    if (this.multisampleDepth) context.deleteRenderbuffer(this.multisampleDepth);
    if (this.frameTexture) context.deleteTexture(this.frameTexture);
  }

  allocateFrameTargets(width, height) {
    const context = this.context;
    this.releaseFrameTargets();
    this.multisampleFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.multisampleFramebuffer);
    this.multisampleColor = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, this.multisampleColor);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, this.samples, context.RGBA8, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.RENDERBUFFER, this.multisampleColor);
    this.multisampleDepth = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, this.multisampleDepth);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, this.samples, context.DEPTH_COMPONENT24, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, this.multisampleDepth);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Multisample framebuffer allocation failed. Choose a lower quality preset.');
    this.frameTexture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, this.frameTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, width, height, 0, context.RGBA, context.UNSIGNED_BYTE, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    this.resolveFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.resolveFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, this.frameTexture, 0);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Resolve framebuffer allocation failed. Choose a lower quality preset.');
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  drawSky(frame) {
    const context = this.context;
    const environment = { skyTop: [0.20, 0.38, 0.52], skyBottom: [0.62, 0.70, 0.67], lightDirection: [-3, 6, 4], daylight: 1, ...this.environment, ...frame.environment };
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.skyProgram);
    context.uniform3fv(this.skyUniforms.skyTop, environment.skyTop);
    context.uniform3fv(this.skyUniforms.skyBottom, environment.skyBottom);
    context.uniform3fv(this.skyUniforms.sunDirection, environment.lightDirection);
    context.uniformMatrix4fv(this.skyUniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(this.skyUniforms.eye, frame.eye);
    context.uniform1f(this.skyUniforms.time, frame.time ?? 0);
    context.uniform1f(this.skyUniforms.daylight, environment.daylight);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  resolveFrame(frame) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
    context.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, this.canvas.width, this.canvas.height, context.COLOR_BUFFER_BIT, context.NEAREST);
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.postProgram);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.frameTexture);
    context.uniform1i(this.postUniforms.frameTexture, 0);
    context.uniform2f(this.postUniforms.resolution, this.canvas.width, this.canvas.height);
    context.uniform1f(this.postUniforms.monochrome, frame.monochrome ?? 0);
    context.uniform1f(this.postUniforms.fade, frame.fade ?? 0);
    context.uniform1f(this.postUniforms.cinematic, frame.cinematic ? 1 : 0);
    context.uniform1f(this.postUniforms.time, frame.time ?? 0);
    context.uniform1f(this.postUniforms.volumeExplosion, frame.volumeExplosion ? 1 : 0);
    context.uniform1f(this.postUniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniformMatrix4fv(this.postUniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(this.postUniforms.eye, frame.eye);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  drawBatch(batch) {
    this.context.bindVertexArray(batch.vertexArray);
    this.context.drawElementsInstanced(this.context.TRIANGLES, batch.indexCount, this.context.UNSIGNED_INT, 0, batch.instanceCount);
  }

  render(frame) {
    const { eye, target = [0, 1.2, 0], armorColor = [0.53, 0.39, 0.24], armorSurface = [0.88, 0.32], exposure = 1, inspection = false } = frame;
    const start = performance.now();
    const context = this.context;
    const assemblyAmount = Math.max(0, Math.min(1, frame.assemblyAmount ?? 0));
    if (this.assemblyAmount !== assemblyAmount) {
      this.assemblyAmount = assemblyAmount;
      this.createShadowMap();
    }
    if (frame.fov) mat4.perspective(this.projection, frame.fov * Math.PI / 180, this.canvas.width / this.canvas.height, 0.1, this.world ? 600 : 100);
    mat4.lookAt(this.view, eye, target, [0, 1, 0]);
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.invert(this.inverseViewProjection, this.viewProjection);
    context.bindFramebuffer(context.FRAMEBUFFER, this.benchmark ? null : this.multisampleFramebuffer);
    context.viewport(0, 0, this.canvas.width, this.canvas.height);
    context.clearColor(0.145, 0.162, 0.177, 1);
    context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
    if (this.world && !this.benchmark) this.drawSky(frame);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    context.useProgram(this.program);
    context.uniformMatrix4fv(this.uniforms.viewProjection, false, this.viewProjection);
    context.uniformMatrix4fv(this.uniforms.lightProjection, false, this.lightProjection);
    context.uniform3fv(this.uniforms.eye, eye);
    context.uniform3fv(this.uniforms.armorColor, armorColor);
    context.uniform2fv(this.uniforms.armorSurface, armorSurface);
    context.uniform1f(this.uniforms.exposure, exposure);
    context.uniform1f(this.uniforms.inspection, inspection ? 1 : 0);
    const environment = { lightDirection: [-3, 6, 4], fogColor: [0.35, 0.43, 0.43], fogDensity: 0.006, daylight: 1, explosionCenter: [0, 0, 0], ...this.environment, ...frame.environment };
    context.uniform1f(this.uniforms.time, frame.time ?? 0);
    context.uniform1f(this.uniforms.wind, frame.wind ?? 0.3);
    context.uniform1f(this.uniforms.worldMode, this.world ? 1 : 0);
    context.uniform1f(this.uniforms.daylight, environment.daylight);
    context.uniform3fv(this.uniforms.lightDirection, environment.lightDirection);
    context.uniform3fv(this.uniforms.fogColor, environment.fogColor);
    context.uniform1f(this.uniforms.fogDensity, environment.fogDensity);
    context.uniform3fv(this.uniforms.waterRipple, frame.waterRipple ?? [10000, 0, 10000]);
    context.uniform1f(this.uniforms.rippleTime, frame.rippleTime ?? -1000);
    context.uniform1f(this.uniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniform3fv(this.uniforms.explosionCenter, environment.explosionCenter);
    context.uniform1f(this.uniforms.assemblyAmount, assemblyAmount);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    context.uniform1i(this.uniforms.shadowMap, 0);
    for (const batch of this.batches) this.drawBatch(batch);
    context.bindVertexArray(null);
    if (!this.benchmark) this.resolveFrame(frame);
    this.cpuMilliseconds = performance.now() - start;
  }

  dispose() {
    this.releaseFrameTargets();
    this.batches.forEach((batch) => this.context.deleteVertexArray(batch.vertexArray));
    this.buffers.forEach((buffer) => this.context.deleteBuffer(buffer));
    this.context.deleteTexture(this.shadowTexture);
    this.context.deleteFramebuffer(this.shadowFramebuffer);
    this.context.deleteProgram(this.program);
    this.context.deleteProgram(this.depthProgram);
    if (this.postProgram) this.context.deleteProgram(this.postProgram);
    if (this.skyProgram) this.context.deleteProgram(this.skyProgram);
  }
}
