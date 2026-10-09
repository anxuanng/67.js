import { mat4, mat3 } from 'gl-matrix';
import { vertexShader, fragmentShader, depthVertexShader, depthFragmentShader, benchmarkVertexShader, benchmarkFragmentShader } from './shaders.js';
import { fullscreenVertex, postFragment, skyFragment, bloomFragment } from './post.js';
import { planRenderSize, estimateTextureBytes } from './budget.js';
import { applyProjection } from './camera.js';
import { resolveEffects } from './effects.js';

const MATERIAL_TAGS = { armor: 1, floor: 2, water: 3, foliage: 4, terrain: 5, grass: 7, fire: 8, smoke: 9, unlit: 10 };
const INSTANCE_STRIDE = 41;

function validateTransform(part) {
  const finiteFloat = value => Number.isFinite(value) && Number.isFinite(Math.fround(value));
  if (part.matrix?.length !== 16 || !Array.from(part.matrix).every(finiteFloat)) throw new Error(`Invalid transform: ${part.name}`);
  const normalMatrix = mat3.normalFromMat4(mat3.create(), part.matrix);
  if (!normalMatrix || !Array.from(normalMatrix).every(Number.isFinite)) throw new Error(`Singular transform: ${part.name}`);
  for (const value of [part.material.color, part.material.emissiveColor ?? part.material.color, part.assembly?.offset ?? [0, 0, 0], part.assembly?.detailOffset ?? [0, 0, 0]]) {
    if (value.length !== 3 || !Array.from(value).every(finiteFloat)) throw new Error(`Invalid instance vector: ${part.name}`);
  }
  if (![part.material.metallic, part.material.roughness, part.material.emission ?? 0].every(finiteFloat)) throw new Error(`Invalid material: ${part.name}`);
  return normalMatrix;
}

function packInstance(data, index, part, normalMatrix) {
  const offset = index * INSTANCE_STRIDE;
  data.set(part.matrix, offset);
  data.set(normalMatrix, offset + 16);
  data.set(part.material.color, offset + 25);
  data.set([part.material.metallic, part.material.roughness, part.material.emission ?? 0, MATERIAL_TAGS[part.material.tag] ?? 0], offset + 28);
  data.set(part.assembly?.offset ?? [0, 0, 0], offset + 32);
  data.set(part.assembly?.detailOffset ?? [0, 0, 0], offset + 35);
  data.set(part.material.emissiveColor ?? part.material.color, offset + 38);
}

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
    validateTransform(part);
    const key = batching ? part.geometry : part;
    if (!groups.has(key)) groups.set(key, new Map());
    const maps = groups.get(key);
    const map = part.material.map ?? null;
    if (!maps.has(map)) maps.set(map, []);
    maps.get(map).push(part);
  }
  return [...groups.values()].flatMap(maps => [...maps.values()]);
}

export function textureDescriptorInfo(map, maximumSize = Infinity) {
  const width = map.image?.naturalWidth ?? map.image?.width;
  const height = map.image?.naturalHeight ?? map.image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > maximumSize || height > maximumSize) throw new Error('Texture image dimensions are invalid or exceed MAX_TEXTURE_SIZE.');
  if ((map.uvChannel ?? 0) !== 0) throw new Error('Only texture UV channel 0 is supported.');
  if (map.colorSpace && !['srgb', 'linear'].includes(map.colorSpace)) throw new Error('Texture color space must be srgb or linear.');
  const wrapS = map.wrapS ?? 10497;
  const wrapT = map.wrapT ?? 10497;
  const minFilter = map.minFilter ?? 9987;
  const magFilter = map.magFilter ?? 9729;
  if (![10497, 33071, 33648].includes(wrapS) || ![10497, 33071, 33648].includes(wrapT)) throw new Error('Unsupported texture wrap mode.');
  if (![9728, 9729, 9984, 9985, 9986, 9987].includes(minFilter) || ![9728, 9729].includes(magFilter)) throw new Error('Unsupported texture filtering mode.');
  const mipmaps = minFilter >= 9984;
  return { width, height, wrapS, wrapT, minFilter, magFilter, mipmaps, bytes: estimateTextureBytes(width, height, { mipmaps }) };
}

function sampleCount(context, format, requested) {
  const colorCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, format, context.SAMPLES));
  const depthCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, context.DEPTH_COMPONENT24, context.SAMPLES));
  return Math.max(0, ...colorCounts.filter(count => count <= requested && depthCounts.includes(count)));
}

export class Renderer67 {
  constructor(canvas, parts, { batching = true, pixelRatio = 1.5, benchmark = false, world = false, ground = true, samples = 4, hdr = false, memoryBudgetMiB = 256, environment = {}, shadowBounds = {} } = {}) {
    this.canvas = canvas;
    if (!Number.isInteger(samples) || samples < 1) throw new Error('MSAA sample count must be a positive integer.');
    if (new Set(parts).size !== parts.length) throw new Error('Scene parts must have distinct object identities for animation.');
    this.context = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!this.context) throw new Error('WebGL2 is unavailable. Enable hardware acceleration or use a supported browser.');
    this.pixelRatio = pixelRatio;
    this.benchmark = benchmark;
    this.world = world;
    this.environment = environment;
    this.shadowBounds = shadowBounds;
    this.memoryBudgetMiB = memoryBudgetMiB;
    this.hdr = Boolean(hdr && !benchmark && this.context.getExtension('EXT_color_buffer_float'));
    this.multisampleSamples = benchmark ? 0 : sampleCount(this.context, this.hdr ? this.context.RGBA16F : this.context.RGBA8, Math.min(samples, this.context.getParameter(this.context.MAX_SAMPLES)));
    this.samples = Math.max(1, this.multisampleSamples);
    this.capabilities = { hdr: this.hdr, hdrRequested: Boolean(hdr), hdrFallbackReason: hdr && !this.hdr ? benchmark ? 'HDR is disabled in benchmark mode' : 'EXT_color_buffer_float is unavailable' : null, samples: this.multisampleSamples };
    this.geometryBytes = 0;
    this.buffers = [];
    this.batches = [];
    this.partLocations = new Map();
    this.textures = new Map();
    this.textureBytes = 4;
    this.shadowsDirty = true;
    const groups = groupParts(ground ? [...parts, groundPart()] : parts, batching);
    const textureLimit = this.context.getParameter(this.context.MAX_TEXTURE_SIZE);
    const maps = new Set(groups.map(group => group[0].material.map).filter(Boolean));
    for (const map of maps) this.textureBytes += textureDescriptorInfo(map, textureLimit).bytes;
    this.capabilities.maximumTextureSize = textureLimit;
    for (const group of groups) {
      const geometry = group[0].geometry;
      if (geometry.uvs && geometry.uvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry UV count must match the vertex count.');
      if (group[0].material.map && !geometry.uvs) throw new Error('Textured geometry requires UV channel 0.');
      if (geometry.colors && geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
    }
    const expectedGeometryBytes = groups.reduce((total, group) => total + ['positions', 'normals', 'indices', 'uvs', 'colors'].reduce((bytes, field) => bytes + (group[0].geometry[field]?.byteLength ?? 0), 0) + group.length * INSTANCE_STRIDE * 4, 0);
    planRenderSize({ width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight), pixelRatio, samples: this.samples, memoryBudgetMiB, geometryBytes: expectedGeometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !benchmark, maximumSize: textureLimit });
    this.view = mat4.create();
    this.projection = mat4.create();
    this.viewProjection = mat4.create();
    this.lightProjection = mat4.create();
    this.inverseViewProjection = mat4.create();
    this.program = compileProgram(this.context, benchmark ? benchmarkVertexShader : vertexShader, benchmark ? benchmarkFragmentShader : fragmentShader);
    this.depthProgram = compileProgram(this.context, depthVertexShader, depthFragmentShader);
    this.uniforms = Object.fromEntries(['viewProjection', 'lightProjection', 'eye', 'armorColor', 'armorSurface', 'exposure', 'inspection', 'shadowMap', 'baseMap', 'hasBaseMap', 'hdrEnabled', 'time', 'wind', 'worldMode', 'daylight', 'lightDirection', 'fogColor', 'fogDensity', 'waterRipple', 'rippleTime', 'explosionProgress', 'explosionCenter', 'assemblyAmount'].map((name) => [name, this.context.getUniformLocation(this.program, name)]));
    if (!benchmark) {
      this.postProgram = compileProgram(this.context, fullscreenVertex, postFragment);
      this.skyProgram = compileProgram(this.context, fullscreenVertex, skyFragment);
      this.postUniforms = Object.fromEntries(['frameTexture', 'bloomTexture', 'bloomStrength', 'hdrEnabled', 'grade', 'vignette', 'grainAmount', 'resolution', 'monochrome', 'fade', 'cinematic', 'time', 'volumeExplosion', 'explosionProgress', 'inverseViewProjection', 'eye'].map((name) => [name, this.context.getUniformLocation(this.postProgram, name)]));
      this.bloomProgram = compileProgram(this.context, fullscreenVertex, bloomFragment);
      this.bloomUniforms = Object.fromEntries(['sourceTexture', 'texelDirection', 'threshold', 'extract'].map(name => [name, this.context.getUniformLocation(this.bloomProgram, name)]));
      this.skyUniforms = Object.fromEntries(['skyTop', 'skyBottom', 'sunDirection', 'inverseViewProjection', 'eye', 'time', 'daylight', 'hdrEnabled'].map((name) => [name, this.context.getUniformLocation(this.skyProgram, name)]));
    }
    this.depthUniform = this.context.getUniformLocation(this.depthProgram, 'lightProjection');
    this.depthAssemblyUniform = this.context.getUniformLocation(this.depthProgram, 'assemblyAmount');
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.whiteTexture = this.createTexture(null);
    groups.forEach((group) => this.batches.push(this.uploadBatch(group)));
    this.createShadowMap();
    this.resize();
    if (!this.benchmark && !this.multisampleFramebuffer) this.allocateFrameTargets(this.canvas.width, this.canvas.height);
  }

  uploadBuffer(target, data, usage = this.context.STATIC_DRAW) {
    const buffer = this.context.createBuffer();
    this.buffers.push(buffer);
    this.context.bindBuffer(target, buffer);
    this.context.bufferData(target, data, usage);
    this.geometryBytes += data.byteLength;
    return buffer;
  }

  createTexture(map) {
    if (this.textures.has(map)) return this.textures.get(map);
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    const previousFlip = context.getParameter(context.UNPACK_FLIP_Y_WEBGL);
    const previousColorSpace = context.getParameter(context.UNPACK_COLORSPACE_CONVERSION_WEBGL);
    try {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, map?.flipY ?? false);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      if (map) {
        const info = textureDescriptorInfo(map, context.getParameter(context.MAX_TEXTURE_SIZE));
        context.texImage2D(context.TEXTURE_2D, 0, map.colorSpace === 'linear' ? context.RGBA8 : context.SRGB8_ALPHA8, context.RGBA, context.UNSIGNED_BYTE, map.image);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, info.wrapS);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, info.wrapT);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, info.minFilter);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, info.magFilter);
        if (info.mipmaps) context.generateMipmap(context.TEXTURE_2D);
      } else {
        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      }
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    } finally {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, previousFlip);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
    }
    this.textures.set(map, texture);
    return texture;
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
    if (geometry.uvs) {
      if (geometry.uvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry UV count must match the vertex count.');
      this.uploadBuffer(context.ARRAY_BUFFER, geometry.uvs);
      context.enableVertexAttribArray(13);
      context.vertexAttribPointer(13, 2, context.FLOAT, false, 0, 0);
    } else {
      if (parts[0].material.map) throw new Error('Textured geometry requires UV channel 0.');
      context.disableVertexAttribArray(13);
      context.vertexAttrib2f(13, 0, 0);
    }
    if (geometry.colors) {
      if (geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
      this.uploadBuffer(context.ARRAY_BUFFER, geometry.colors);
      context.enableVertexAttribArray(14);
      context.vertexAttribPointer(14, 3, context.FLOAT, false, 0, 0);
    } else {
      context.disableVertexAttribArray(14);
      context.vertexAttrib3f(14, 1, 1, 1);
    }
    this.uploadBuffer(context.ELEMENT_ARRAY_BUFFER, geometry.indices);
    const stride = INSTANCE_STRIDE;
    const instanceData = new Float32Array(parts.length * stride);
    const normalMatrix = mat3.create();
    parts.forEach((part, index) => {
      mat3.normalFromMat4(normalMatrix, part.matrix);
      packInstance(instanceData, index, part, normalMatrix);
    });
    const instanceBuffer = this.uploadBuffer(context.ARRAY_BUFFER, instanceData, context.DYNAMIC_DRAW);
    for (let column = 0; column < 4; column++) this.attribute(2 + column, 4, stride * 4, column * 16);
    for (let column = 0; column < 3; column++) this.attribute(6 + column, 3, stride * 4, 64 + column * 12);
    this.attribute(9, 3, stride * 4, 100);
    this.attribute(10, 4, stride * 4, 112);
    this.attribute(11, 3, stride * 4, 128);
    this.attribute(12, 3, stride * 4, 140);
    this.attribute(15, 3, stride * 4, 152);
    context.bindVertexArray(null);
    const map = parts[0].material.map ?? null;
    const batch = { vertexArray, instanceBuffer, instanceData, texture: this.createTexture(map), map, indexCount: geometry.indices.length, instanceCount: parts.length, floor: parts[0].material.tag === 'floor' };
    parts.forEach((part, index) => this.partLocations.set(part, { batch, index, geometry: part.geometry, map }));
    return batch;
  }

  updateParts(parts, { shadows = true } = {}) {
    const prepared = parts.map(part => {
      const location = this.partLocations.get(part);
      if (!location) throw new Error(`Unknown part identity: ${part.name}`);
      if (part.geometry !== location.geometry) throw new Error(`Geometry changes require a new renderer: ${part.name}`);
      if ((part.material.map ?? null) !== location.map) throw new Error(`Texture map changes require a new renderer: ${part.name}`);
      return { part, location, normalMatrix: validateTransform(part) };
    });
    const batches = new Set();
    for (const { part, location, normalMatrix } of prepared) {
      packInstance(location.batch.instanceData, location.index, part, normalMatrix);
      batches.add(location.batch);
    }
    for (const batch of batches) {
      this.context.bindBuffer(this.context.ARRAY_BUFFER, batch.instanceBuffer);
      this.context.bufferSubData(this.context.ARRAY_BUFFER, 0, batch.instanceData);
    }
    if (shadows && prepared.length > 0) this.shadowsDirty = true;
    return prepared.length;
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
    this.shadowsDirty = false;
  }

  resize() {
    const plan = planRenderSize({ width: Math.max(1, this.canvas.clientWidth), height: Math.max(1, this.canvas.clientHeight), pixelRatio: this.pixelRatio, samples: this.samples, memoryBudgetMiB: this.memoryBudgetMiB, geometryBytes: this.geometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !this.benchmark, maximumSize: Math.min(this.context.getParameter(this.context.MAX_RENDERBUFFER_SIZE), this.context.getParameter(this.context.MAX_TEXTURE_SIZE)) });
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
    for (const target of this.bloomTargets ?? []) {
      context.deleteTexture(target.texture);
      context.deleteFramebuffer(target.framebuffer);
    }
    this.bloomTargets = [];
    this.multisampleFramebuffer = null;
    this.resolveFramebuffer = null;
    this.multisampleColor = null;
    this.multisampleDepth = null;
    this.frameTexture = null;
  }

  allocateFrameTargets(width, height) {
    const context = this.context;
    this.releaseFrameTargets();
    this.multisampleFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.multisampleFramebuffer);
    this.multisampleColor = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, this.multisampleColor);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, this.multisampleSamples, this.hdr ? context.RGBA16F : context.RGBA8, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.RENDERBUFFER, this.multisampleColor);
    this.multisampleDepth = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, this.multisampleDepth);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, this.multisampleSamples, context.DEPTH_COMPONENT24, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, this.multisampleDepth);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Multisample framebuffer allocation failed. Choose a lower quality preset.');
    this.frameTexture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, this.frameTexture);
    context.texImage2D(context.TEXTURE_2D, 0, this.hdr ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA, this.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    this.resolveFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.resolveFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, this.frameTexture, 0);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Resolve framebuffer allocation failed. Choose a lower quality preset.');
    this.bloomWidth = Math.max(1, Math.ceil(width / 2));
    this.bloomHeight = Math.max(1, Math.ceil(height / 2));
    for (let index = 0; index < 2; index++) {
      const texture = context.createTexture();
      const framebuffer = context.createFramebuffer();
      this.bloomTargets.push({ texture, framebuffer });
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(context.TEXTURE_2D, 0, this.hdr ? context.RGBA16F : context.RGBA8, this.bloomWidth, this.bloomHeight, 0, context.RGBA, this.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
      if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error('Bloom framebuffer allocation failed. Choose a lower quality preset.');
    }
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
    context.uniform1f(this.skyUniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  resolveFrame(frame, effects) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
    context.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, this.canvas.width, this.canvas.height, context.COLOR_BUFFER_BIT, context.NEAREST);
    if (effects.bloom.strength > 0) this.drawBloom(effects.bloom);
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.viewport(0, 0, this.canvas.width, this.canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.postProgram);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.frameTexture);
    context.uniform1i(this.postUniforms.frameTexture, 0);
    context.activeTexture(context.TEXTURE2);
    context.bindTexture(context.TEXTURE_2D, effects.bloom.strength > 0 ? this.bloomTargets[1].texture : this.whiteTexture);
    context.uniform1i(this.postUniforms.bloomTexture, 2);
    context.uniform1f(this.postUniforms.bloomStrength, effects.bloom.strength);
    context.uniform1f(this.postUniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform3f(this.postUniforms.grade, effects.saturation, effects.contrast, effects.temperature);
    context.uniform1f(this.postUniforms.vignette, effects.vignette);
    context.uniform1f(this.postUniforms.grainAmount, effects.grain);
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

  drawBloom(bloom) {
    const context = this.context;
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.bloomProgram);
    context.viewport(0, 0, this.bloomWidth, this.bloomHeight);
    context.uniform1i(this.bloomUniforms.sourceTexture, 0);
    context.uniform1f(this.bloomUniforms.threshold, bloom.threshold);
    for (let pass = 0; pass < 2; pass++) {
      context.bindFramebuffer(context.FRAMEBUFFER, this.bloomTargets[pass].framebuffer);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, pass === 0 ? this.frameTexture : this.bloomTargets[0].texture);
      context.uniform1f(this.bloomUniforms.extract, pass === 0 ? 1 : 0);
      context.uniform2f(this.bloomUniforms.texelDirection, pass === 0 ? bloom.radius / this.bloomWidth : 0, pass === 1 ? bloom.radius / this.bloomHeight : 0);
      context.drawArrays(context.TRIANGLES, 0, 3);
    }
  }

  drawBatch(batch, textured = false) {
    if (textured && !this.benchmark) {
      this.context.activeTexture(this.context.TEXTURE1);
      this.context.bindTexture(this.context.TEXTURE_2D, batch.texture);
      this.context.uniform1i(this.uniforms.baseMap, 1);
      this.context.uniform1f(this.uniforms.hasBaseMap, batch.map ? 1 : 0);
    }
    this.context.bindVertexArray(batch.vertexArray);
    this.context.drawElementsInstanced(this.context.TRIANGLES, batch.indexCount, this.context.UNSIGNED_INT, 0, batch.instanceCount);
  }

  render(frame) {
    const { eye, target = [0, 1.2, 0], armorColor = [0.53, 0.39, 0.24], armorSurface = [0.88, 0.32], exposure = 1, inspection = false } = frame;
    const effects = resolveEffects(frame.effects);
    const start = performance.now();
    const context = this.context;
    const assemblyAmount = Math.max(0, Math.min(1, frame.assemblyAmount ?? 0));
    if (this.assemblyAmount !== assemblyAmount || this.shadowsDirty) {
      this.assemblyAmount = assemblyAmount;
      this.createShadowMap();
    }
    applyProjection(this.projection, frame, this.canvas.width / this.canvas.height, { world: this.world });
    mat4.lookAt(this.view, eye, target, frame.up ?? [0, 1, 0]);
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
    context.uniform1f(this.uniforms.hdrEnabled, this.hdr ? 1 : 0);
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
    for (const batch of this.batches) this.drawBatch(batch, true);
    context.bindVertexArray(null);
    if (!this.benchmark) this.resolveFrame(frame, effects);
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
    if (this.bloomProgram) this.context.deleteProgram(this.bloomProgram);
    for (const texture of this.textures.values()) this.context.deleteTexture(texture);
    this.textures.clear();
    this.partLocations.clear();
  }
}
