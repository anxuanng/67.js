import { mat4, mat3 } from 'gl-matrix';
import { vertexShader, fragmentShader, liquidFragmentShader, depthVertexShader, depthFragmentShader, benchmarkVertexShader, benchmarkFragmentShader } from './shaders.js';
import { fullscreenVertex, postFragment, skyFragment, bloomFragment } from './post.js';
import { planRenderSize, estimateTextureBytes, estimateFrameBytes } from './budget.js';
import { applyProjection } from './camera.js';
import { resolveEffects } from './effects.js';
import { createLightingState, updateLightingState } from './lighting.js';
import { resolveVolumeFog } from './volumetric.js';
import { assertEnvironmentMap, createEnvironmentResources, environmentBackgroundFragment, estimateEnvironmentBytes } from './environment.js';
import { validateSkinGeometry, validateSkinPose, skinTextureLayout, packSkinInfluences } from './skinning.js';
import { validateMorphGeometry, validateMorphPose, validateMorphTransform, packMorphTargets } from './morph.js';

const MATERIAL_TAGS = { armor: 1, floor: 2, water: 3, foliage: 4, terrain: 5, grass: 7, fire: 8, smoke: 9, unlit: 10, liquid: 11, foam: 12 };
// Liquid and foam see the resolved opaque scene, so they draw in their own pass after it.
const TRANSLUCENT_TAGS = new Set(['liquid', 'foam']);
const DEFAULT_LIQUID = Object.freeze({ thickness: 0.5, ior: 1.33, refraction: 1, scattering: 1, foamOpacity: 0.55, foamSoftness: 1 });
const INSTANCE_STRIDE = 41;
const ZERO_VECTOR = Object.freeze([0, 0, 0]);
const MATERIAL_MAPS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const MAP_UNIFORMS = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const MAP_FLAGS = ['hasBaseMap', 'hasNormalMap', 'hasMetallicRoughnessMap', 'hasOcclusionMap', 'hasEmissiveMap'];
const DEFAULT_NORMAL_SCALE = [1, 1];
const PROCEDURAL_MATERIAL_TAGS = new Set(['water', 'foliage', 'grass', 'terrain', 'floor', 'fire', 'smoke', 'liquid', 'foam']);

function renderPass(material) {
  return TRANSLUCENT_TAGS.has(material.tag) ? material.tag : 'opaque';
}

function batchPass(batch) {
  return batch.pass ?? 'opaque';
}

export function resolveLiquidOptics(options = {}) {
  const optics = { ...DEFAULT_LIQUID, ...options };
  for (const [name, minimum, maximum] of [['thickness', 0, 100], ['ior', 1, 3], ['refraction', 0, 4], ['scattering', 0, 10], ['foamOpacity', 0, 1], ['foamSoftness', 0, 1]]) {
    const value = optics[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`liquid.${name} must be between ${minimum} and ${maximum}.`);
  }
  return optics;
}
const SKIN_UNIFORMS = ['skinEnabled', 'skinInfluences', 'jointPalette'];
const MORPH_UNIFORMS = ['morphEnabled', 'morphVertexCount', 'morphTargetCount', 'morphWeights[0]', 'morphTargets'];
const ENVIRONMENT_LOOKUP_UNIFORMS = ['environmentSpecular', 'environmentEnabled', 'environmentIntensity', 'environmentRotation', 'environmentLevelMax'];
const ENVIRONMENT_UNIFORMS = [...ENVIRONMENT_LOOKUP_UNIFORMS, 'environmentBrdf', 'environmentIrradiance[0]'];
const ENVIRONMENT_SPECULAR_UNIT = 9;
const ENVIRONMENT_BRDF_UNIT = 10;

function validateMaterialMaps(material) {
  if (PROCEDURAL_MATERIAL_TAGS.has(material.tag)) {
    for (let index = 1; index < MATERIAL_MAPS.length; index++) {
      if (material[MATERIAL_MAPS[index]]) throw new Error('Material maps require a standard PBR material tag. Procedural tags are unsupported.');
    }
  }
  if (material.tag === 'unlit' && (material.normalMap || material.metallicRoughnessMap || material.occlusionMap)) {
    throw new Error('Unlit materials support only base and emissive maps.');
  }
  const normalScale = material.normalScale ?? DEFAULT_NORMAL_SCALE;
  if (normalScale.length !== 2 || !Number.isFinite(normalScale[0]) || !Number.isFinite(normalScale[1]) || !Number.isFinite(Math.fround(normalScale[0])) || !Number.isFinite(Math.fround(normalScale[1]))) throw new Error('normalScale must contain two finite floats.');
  const occlusionStrength = material.occlusionStrength ?? 1;
  if (!Number.isFinite(occlusionStrength) || occlusionStrength < 0 || occlusionStrength > 1) throw new Error('occlusionStrength must be within zero and one.');
}

function materialMapState(material) {
  validateMaterialMaps(material);
  const normalScale = material.normalScale ?? DEFAULT_NORMAL_SCALE;
  const occlusionStrength = material.occlusionStrength ?? 1;
  return [...MATERIAL_MAPS.map(field => material[field] ?? null), normalScale[0], normalScale[1], occlusionStrength];
}

function hasMaterialMap(material) {
  return MATERIAL_MAPS.some(field => material[field]);
}

function finiteFloat(value) {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function finiteVector(value, size) {
  if (value?.length !== size) return false;
  for (let index = 0; index < size; index++) if (!finiteFloat(value[index])) return false;
  return true;
}

function validateTransform(part, normalMatrix = mat3.create()) {
  if (!finiteVector(part.matrix, 16)) throw new Error(`Invalid transform: ${part.name}`);
  if (!mat3.normalFromMat4(normalMatrix, part.matrix) || !finiteVector(normalMatrix, 9)) throw new Error(`Singular transform: ${part.name}`);
  if (!finiteVector(part.material.color, 3) || !finiteVector(part.material.emissiveColor ?? part.material.color, 3) ||
      !finiteVector(part.assembly?.offset ?? ZERO_VECTOR, 3) || !finiteVector(part.assembly?.detailOffset ?? ZERO_VECTOR, 3)) {
    throw new Error(`Invalid instance vector: ${part.name}`);
  }
  if (!finiteFloat(part.material.metallic) || !finiteFloat(part.material.roughness) || !finiteFloat(part.material.emission ?? 0)) throw new Error(`Invalid material: ${part.name}`);
  return normalMatrix;
}

function packInstance(data, index, part, normalMatrix) {
  const offset = index * INSTANCE_STRIDE;
  data.set(part.matrix, offset);
  data.set(normalMatrix, offset + 16);
  data.set(part.material.color, offset + 25);
  data[offset + 28] = part.material.metallic;
  data[offset + 29] = part.material.roughness;
  data[offset + 30] = part.material.emission ?? 0;
  data[offset + 31] = MATERIAL_TAGS[part.material.tag] ?? 0;
  data.set(part.assembly?.offset ?? ZERO_VECTOR, offset + 32);
  data.set(part.assembly?.detailOffset ?? ZERO_VECTOR, offset + 35);
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
  const batches = [];
  const morphInfos = new Map();
  for (const part of parts) {
    validateTransform(part);
    if (part.castShadow !== undefined && typeof part.castShadow !== 'boolean') throw new TypeError('castShadow must be a boolean');
    validateSkinGeometry(part.geometry, part.skin);
    if (part.skin) validateSkinPose(part.skin, part.geometry, part.matrix);
    if (part.skin && PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Skinned parts require a standard material tag.');
    if (!morphInfos.has(part.geometry)) morphInfos.set(part.geometry, validateMorphGeometry(part.geometry, part.morph));
    else if (part.morph || part.geometry.morphTargets) validateMorphPose(part.morph, morphInfos.get(part.geometry));
    if (part.morph && PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Morphed parts require a standard material tag.');
    if (part.morph) validateMorphTransform(part.morph, morphInfos.get(part.geometry), part.matrix, part.skin);
    const key = batching ? part.geometry : part;
    if (!groups.has(key)) groups.set(key, new Map());
    let maps = groups.get(key);
    for (const value of [...materialMapState(part.material), part.skin ?? null, part.morph ?? null, part.castShadow !== false, renderPass(part.material)]) {
      if (!maps.has(value)) maps.set(value, new Map());
      maps = maps.get(value);
    }
    if (!maps.has('parts')) {
      const batch = [];
      maps.set('parts', batch);
      batches.push(batch);
    }
    maps.get('parts').push(part);
  }
  return batches;
}

export function textureDescriptorInfo(map, maximumSize = Infinity) {
  const width = map.image?.naturalWidth ?? map.image?.width;
  const height = map.image?.naturalHeight ?? map.image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > maximumSize || height > maximumSize) throw new Error('Texture image dimensions are invalid or exceed MAX_TEXTURE_SIZE.');
  if ((map.uvChannel ?? 0) !== 0) throw new Error('Only texture UV channel 0 is supported.');
  if (map.transform || map.offset || map.repeat || map.rotation !== undefined || map.extensions && Object.keys(map.extensions).length) throw new Error('Texture transforms and extensions are unsupported. Bake them into UV channel 0.');
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

function geometryBufferBytes(geometry) {
  return ['positions', 'normals', 'uvs', 'colors', 'indices'].reduce((total, field) => total + (geometry[field]?.byteLength ?? 0), 0);
}

function validateReplacementGeometry(geometry) {
  const vertexCount = geometry.positions?.length / 3;
  if (!(geometry.positions instanceof Float32Array) || !Number.isInteger(vertexCount) || vertexCount < 1 ||
      !(geometry.normals instanceof Float32Array) || geometry.normals.length !== vertexCount * 3 ||
      !(geometry.indices instanceof Uint32Array) || geometry.indices.length < 3 || geometry.indices.length % 3 !== 0) {
    throw new TypeError('Replacement geometry needs matching Float32 positions/normals and Uint32 triangles.');
  }
  // Plain loops: replaceParts runs this every frame for streamed meshes, where callback-based
  // `every` cost about ten times more than the upload itself.
  for (const [field, count] of [['positions', 3], ['normals', 3], ['uvs', 2], ['colors', 3]]) {
    const values = geometry[field];
    if (!values && ['uvs', 'colors'].includes(field)) continue;
    if (!(values instanceof Float32Array) || values.length !== vertexCount * count || !allFinite(values)) {
      throw new TypeError(`Replacement ${field} must contain finite matching Float32 data.`);
    }
  }
  const indices = geometry.indices;
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] >= vertexCount) throw new RangeError('Replacement triangle indices must address existing vertices.');
  }
}

function allFinite(values) {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    // NaN fails both comparisons; infinities fail one.
    if (!(value > -Infinity && value < Infinity)) return false;
  }
  return true;
}

export class Renderer67 {
  constructor(canvas, parts, { batching = true, pixelRatio = 1.5, benchmark = false, world = false, ground = true, transparent = false, samples = 4, hdr = false, depth = false, memoryBudgetMiB = 256, environment = {}, shadowBounds = {} } = {}) {
    this.canvas = canvas;
    if (!Number.isInteger(samples) || samples < 1) throw new Error('MSAA sample count must be a positive integer.');
    if (new Set(parts).size !== parts.length) throw new Error('Scene parts must have distinct object identities for animation.');
    this.lighting = createLightingState();
    updateLightingState(this.lighting, environment, { world });
    const volume = resolveVolumeFog(environment.volumeFog);
    if (volume.density > 0 && (!depth || benchmark || transparent || !hdr)) throw new Error('Volume fog requires depth:true, hdr:true, an opaque canvas and normal rendering');
    this.context = canvas.getContext('webgl2', { antialias: true, alpha: Boolean(transparent), premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!this.context) throw new Error('WebGL2 is unavailable. Enable hardware acceleration or use a supported browser.');
    this.transparent = Boolean(transparent);
    this.pixelRatio = pixelRatio;
    this.benchmark = benchmark;
    this.depth = Boolean(depth && !benchmark);
    this.world = world;
    this.environment = environment;
    this.shadowBounds = shadowBounds;
    this.memoryBudgetMiB = memoryBudgetMiB;
    this.hdr = Boolean(hdr && !benchmark && this.context.getExtension('EXT_color_buffer_float'));
    if (volume.density > 0 && !this.hdr) throw new Error('Volume fog requires EXT_color_buffer_float for HDR rendering');
    this.multisampleSamples = benchmark ? 0 : sampleCount(this.context, this.hdr ? this.context.RGBA16F : this.context.RGBA8, Math.min(samples, this.context.getParameter(this.context.MAX_SAMPLES)));
    this.capabilities = { hdr: this.hdr, hdrRequested: Boolean(hdr), hdrFallbackReason: hdr && !this.hdr ? benchmark ? 'HDR is disabled in benchmark mode' : 'EXT_color_buffer_float is unavailable' : null, samples: this.multisampleSamples };
    this.geometryBytes = 0;
    this.geometryBuffers = new Map();
    this.batching = batching;
    this.groundPart = ground ? groundPart() : null;
    this.buffers = [];
    this.batches = [];
    this.partLocations = new Map();
    this.updateBatches = new Set();
    this.updateSkins = new Set();
    this.updateMorphs = new Set();
    this.skinTextures = new Map();
    this.influenceTextures = new Map();
    this.morphTextures = new Map();
    this.textures = new Map();
    this.textureBytes = 4;
    this.shadowsDirty = true;
    const groups = groupParts(this.groundPart ? [...parts, this.groundPart] : parts, batching);
    const textureLimit = this.context.getParameter(this.context.MAX_TEXTURE_SIZE);
    this.hasSkins = groups.some(group => group[0].skin);
    this.hasMorphs = groups.some(group => group[0].morph);
    if (this.hasSkins && (this.context.getParameter(this.context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 2 || this.context.getParameter(this.context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < 8)) throw new Error('GPU skinning requires two vertex texture units and eight combined texture units.');
    if (this.hasMorphs && (this.context.getParameter(this.context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < (this.hasSkins ? 3 : 1) || this.context.getParameter(this.context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < 9)) throw new Error('GPU morphing requires one additional vertex texture unit and nine combined texture units.');
    const morphGeometries = new Set();
    for (const group of groups) {
      const part = group[0];
      if (!part.morph || morphGeometries.has(part.geometry)) continue;
      const texelCount = part.geometry.positions.length / 3 * part.geometry.morphTargets.length * 2;
      this.textureBytes += skinTextureLayout(texelCount, textureLimit, 2).bytes;
      morphGeometries.add(part.geometry);
    }
    const poses = new Set();
    const skinGeometries = new Set();
    for (const group of groups) {
      const part = group[0];
      if (!part.skin) continue;
      if (!poses.has(part.skin)) this.textureBytes += skinTextureLayout(part.skin.jointMatrices.length / 4, textureLimit, 4).bytes;
      if (!skinGeometries.has(part.geometry)) this.textureBytes += skinTextureLayout(part.geometry.positions.length / 3 * 2, textureLimit, 2).bytes;
      poses.add(part.skin);
      skinGeometries.add(part.geometry);
    }
    const maps = new Set();
    for (const group of groups) {
      for (const field of MATERIAL_MAPS) {
        const map = group[0].material[field];
        if (!map) continue;
        const info = textureDescriptorInfo(map, textureLimit);
        if (['normalMap', 'metallicRoughnessMap', 'occlusionMap'].includes(field) && map.colorSpace !== 'linear') throw new Error(`${field} requires a linear texture descriptor.`);
        if (field === 'emissiveMap' && (map.colorSpace ?? 'srgb') !== 'srgb') throw new Error('emissiveMap requires an srgb texture descriptor.');
        if (!maps.has(map)) this.textureBytes += info.bytes;
        maps.add(map);
      }
    }
    this.capabilities.maximumTextureSize = textureLimit;
    this.environmentResources = null;
    this.environmentBackgroundProgram = null;
    this.environmentBytes = !benchmark && environment.map ? estimateEnvironmentBytes(environment.map, textureLimit) : 0;
    this.textureBytes += this.environmentBytes;
    for (const group of groups) {
      const geometry = group[0].geometry;
      if (geometry.uvs && geometry.uvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry UV count must match the vertex count.');
      if (hasMaterialMap(group[0].material) && !geometry.uvs) throw new Error('Textured geometry requires UV channel 0.');
      for (const coordinate of geometry.uvs ?? []) {
        if (!Number.isFinite(coordinate)) throw new Error('Geometry UVs must be finite.');
      }
      if (geometry.colors && geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
    }
    const expectedGeometryBytes = groups.reduce((total, group) => total + ['positions', 'normals', 'indices', 'uvs', 'colors'].reduce((bytes, field) => bytes + (group[0].geometry[field]?.byteLength ?? 0), 0) + group.length * INSTANCE_STRIDE * 4, 0);
    planRenderSize({ width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight), pixelRatio, samples: this.samples, memoryBudgetMiB, geometryBytes: expectedGeometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !benchmark, depth: this.depth, maximumSize: textureLimit });
    this.view = mat4.create();
    this.projection = mat4.create();
    this.viewProjection = mat4.create();
    this.lightProjection = mat4.create();
    this.inverseViewProjection = mat4.create();
    this.program = compileProgram(this.context, benchmark ? benchmarkVertexShader : vertexShader, benchmark ? benchmarkFragmentShader : fragmentShader);
    this.depthProgram = compileProgram(this.context, depthVertexShader, depthFragmentShader);
    this.uniforms = Object.fromEntries(['viewProjection', 'lightProjection', 'eye', 'armorColor', 'armorSurface', 'exposure', 'inspection', 'shadowMap', ...MAP_UNIFORMS, ...MAP_FLAGS, ...SKIN_UNIFORMS, ...MORPH_UNIFORMS, 'normalScale', 'occlusionStrength', 'hdrEnabled', 'time', 'wind', 'worldMode', 'daylight', 'fogColor', 'lightDirection', 'fogDensity', 'waterRipple', 'rippleTime', 'explosionProgress', 'explosionCenter', 'assemblyAmount'].map((name) => [name, this.context.getUniformLocation(this.program, name)]));
    for (const name of ['pointLightCount', 'pointLightPositions[0]', 'pointLightColors[0]', 'pointLightRadii[0]', 'keyColor', 'fillIntensity', 'ambientIntensity']) {
      this.uniforms[name] = this.context.getUniformLocation(this.program, name);
    }
    for (const name of ENVIRONMENT_UNIFORMS) this.uniforms[name] = this.context.getUniformLocation(this.program, name);
    this.depthSkinUniforms = Object.fromEntries(SKIN_UNIFORMS.map(name => [name, this.context.getUniformLocation(this.depthProgram, name)]));
    this.depthMorphUniforms = Object.fromEntries(MORPH_UNIFORMS.map(name => [name, this.context.getUniformLocation(this.depthProgram, name)]));
    if (!benchmark) {
      this.postProgram = compileProgram(this.context, fullscreenVertex, postFragment);
      this.skyProgram = compileProgram(this.context, fullscreenVertex, skyFragment);
      this.postUniforms = Object.fromEntries(['transparent', 'frameTexture', 'bloomTexture', 'bloomStrength', 'hdrEnabled', 'grade', 'vignette', 'grainAmount', 'resolution', 'monochrome', 'fade', 'cinematic', 'time', 'volumeExplosion', 'explosionProgress', 'inverseViewProjection', 'eye', 'sceneDepth', 'volumeShadowMap', 'volumeLightProjection', 'volumeLightDirection', 'volumeLightColor', 'volumeDensity', 'volumeMinimum', 'volumeMaximum', 'volumeColor', 'volumeAmbient', 'volumeDrift', 'volumeSteps', 'volumeAnisotropy', 'volumeNoiseAmount', 'volumeNoiseScale', 'volumeMaxDistance', 'orthographic'].map((name) => [name, this.context.getUniformLocation(this.postProgram, name)]));
      this.bloomProgram = compileProgram(this.context, fullscreenVertex, bloomFragment);
      this.bloomUniforms = Object.fromEntries(['sourceTexture', 'texelDirection', 'threshold', 'extract'].map(name => [name, this.context.getUniformLocation(this.bloomProgram, name)]));
      this.skyUniforms = Object.fromEntries(['skyTop', 'skyBottom', 'sunDirection', 'inverseViewProjection', 'eye', 'time', 'daylight', 'hdrEnabled'].map((name) => [name, this.context.getUniformLocation(this.skyProgram, name)]));
      this.liquidProgram = compileProgram(this.context, vertexShader, liquidFragmentShader);
      this.liquidUniforms = Object.fromEntries(['viewProjection', 'lightProjection', 'eye', 'sceneColor', 'resolution', 'exposure', 'hdrEnabled', 'worldMode', 'daylight', 'lightDirection', 'keyColor', 'ambientIntensity', 'fogColor', 'fogDensity', 'liquidOptics', 'foamShape', ...ENVIRONMENT_LOOKUP_UNIFORMS, 'time', 'wind', 'explosionProgress', 'explosionCenter', 'assemblyAmount', ...SKIN_UNIFORMS, ...MORPH_UNIFORMS].map((name) => [name, this.context.getUniformLocation(this.liquidProgram, name)]));
    }
    this.depthUniform = this.context.getUniformLocation(this.depthProgram, 'lightProjection');
    this.depthAssemblyUniform = this.context.getUniformLocation(this.depthProgram, 'assemblyAmount');
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.whiteTexture = this.createTexture(null);
    // Disabled skin samplers still need distinct units from the depth sampler.
    const liquidPrograms = this.liquidProgram ? [[this.liquidProgram, this.liquidUniforms]] : [];
    for (const [program, uniforms] of [[this.program, this.uniforms], [this.depthProgram, this.depthSkinUniforms], ...liquidPrograms]) {
      this.context.useProgram(program);
      this.context.uniform1i(uniforms.skinInfluences, 6);
      this.context.uniform1i(uniforms.jointPalette, 7);
    }
    for (const [program, uniforms] of [[this.program, this.uniforms], [this.depthProgram, this.depthMorphUniforms], ...liquidPrograms]) {
      this.context.useProgram(program);
      this.context.uniform1i(uniforms.morphTargets, 8);
    }
    for (const unit of [6, 7, 8]) {
      this.context.activeTexture(this.context.TEXTURE0 + unit);
      this.context.bindTexture(this.context.TEXTURE_2D, this.whiteTexture);
    }
    this.initializeEnvironment(environment.map);
    groups.forEach((group) => this.batches.push(this.uploadBatch(group)));
    this.createShadowMap();
    this.resize();
    if (!this.benchmark && !this.multisampleFramebuffer) this.allocateFrameTargets(this.canvas.width, this.canvas.height);
  }

  get samples() {
    return Math.max(1, this.multisampleSamples);
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
    const vertexArray = context.createVertexArray();
    try {
      return this.uploadBatchData(parts, vertexArray);
    } catch (error) {
      context.bindVertexArray(null);
      context.deleteVertexArray(vertexArray);
      throw error;
    }
  }

  uploadBatchData(parts, vertexArray) {
    const context = this.context;
    const geometry = parts[0].geometry;
    context.bindVertexArray(vertexArray);
    let geometryBuffers = this.geometryBuffers.get(geometry);
    if (!geometryBuffers) {
      geometryBuffers = new Map();
      for (const field of ['positions', 'normals', 'uvs', 'colors', 'indices']) {
        if (geometry[field]) {
          const target = field === 'indices' ? context.ELEMENT_ARRAY_BUFFER : context.ARRAY_BUFFER;
          geometryBuffers.set(field, this.uploadBuffer(target, geometry[field]));
        }
      }
      this.geometryBuffers.set(geometry, geometryBuffers);
    }
    for (const [location, field] of [[0, 'positions'], [1, 'normals']]) {
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get(field));
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, 3, context.FLOAT, false, 0, 0);
    }
    if (geometry.uvs) {
      if (geometry.uvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry UV count must match the vertex count.');
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get('uvs'));
      context.enableVertexAttribArray(13);
      context.vertexAttribPointer(13, 2, context.FLOAT, false, 0, 0);
    } else {
      if (hasMaterialMap(parts[0].material)) throw new Error('Textured geometry requires UV channel 0.');
      context.disableVertexAttribArray(13);
      context.vertexAttrib2f(13, 0, 0);
    }
    if (geometry.colors) {
      if (geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get('colors'));
      context.enableVertexAttribArray(14);
      context.vertexAttribPointer(14, 3, context.FLOAT, false, 0, 0);
    } else {
      context.disableVertexAttribArray(14);
      context.vertexAttrib3f(14, 1, 1, 1);
    }
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, geometryBuffers.get('indices'));
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
    const mapState = materialMapState(parts[0].material);
    const textures = mapState.slice(0, 5).map(descriptor => this.createTexture(descriptor));
    const skin = parts[0].skin ?? null;
    const skinTexture = skin ? this.createSkinTexture(this.skinTextures, skin, skin.jointMatrices, 4) : null;
    const influenceTexture = skin ? this.createSkinTexture(this.influenceTextures, geometry, null, 2) : null;
    const morph = parts[0].morph ?? null;
    const morphTexture = morph ? this.createMorphTexture(geometry, morph) : null;
    const morphWeights = morph ? new Float32Array(morph.weights) : null;
    const batch = { parts: [...parts], vertexArray, instanceBuffer, instanceData, textures, mapState, texture: textures[0], map, skin, skinTexture, influenceTexture, morph, morphTexture, morphWeights, indexCount: geometry.indices.length, instanceCount: parts.length, floor: parts[0].material.tag === 'floor', castShadow: parts[0].castShadow !== false, pass: renderPass(parts[0].material) };
    parts.forEach((part, index) => this.partLocations.set(part, { batch, index, geometry: part.geometry, map, mapState, skin, jointMatrices: skin?.jointMatrices, skinIndices: geometry.skinIndices, skinWeights: geometry.skinWeights, morph, morphWeights: morph?.weights, morphTargets: geometry.morphTargets, normalMatrix: mat3.create(), committedMatrix: batch.instanceData.subarray(index * INSTANCE_STRIDE, index * INSTANCE_STRIDE + 16) }));
    return batch;
  }

  /** Reconcile immutable rigid, untextured geometry without rebuilding programs or render targets. */
  replaceParts(parts) {
    if (!Array.isArray(parts) || new Set(parts).size !== parts.length) {
      throw new TypeError('Scene parts must be an array with distinct object identities.');
    }
    for (const location of this.partLocations.values()) {
      if (location.skin || location.morph || location.morphTargets || location.skinIndices || location.mapState.slice(0, 5).some(Boolean)) {
        throw new Error('replaceParts currently requires an existing rigid, untextured scene.');
      }
    }
    for (const part of parts) {
      if (part.skin || part.morph || part.geometry.morphTargets || part.geometry.skinIndices || hasMaterialMap(part.material)) {
        throw new Error('replaceParts currently requires rigid, untextured parts.');
      }
    }
    const renderParts = this.groundPart ? [...parts, this.groundPart] : parts;
    const groups = groupParts(renderParts, this.batching);
    const geometries = new Set(renderParts.map(part => part.geometry));
    for (const geometry of geometries) {
      validateReplacementGeometry(geometry);
    }
    const retained = new Set();
    const replacements = groups.map(group => {
      const first = group[0];
      const location = this.partLocations.get(first);
      const batch = location?.batch;
      const mapState = materialMapState(first.material);
      const sameParts = batch?.parts.length === group.length && batch.parts.every((part, index) => part === group[index]);
      const sameState = location?.geometry === first.geometry && batch?.castShadow === (first.castShadow !== false) &&
        batch.floor === (first.material.tag === 'floor') && batchPass(batch) === renderPass(first.material) &&
        batch.mapState.every((value, index) => value === mapState[index]);
      if (sameParts && sameState) {
        retained.add(batch);
        return { group, batch };
      }
      return { group, batch: null };
    });
    const newGeometryBytes = [...geometries].filter(geometry => !this.geometryBuffers.has(geometry)).reduce((total, geometry) => total + geometryBufferBytes(geometry), 0);
    const newInstanceBytes = replacements.filter(item => !item.batch).reduce((total, item) => total + item.group.length * INSTANCE_STRIDE * 4, 0);
    const frameBytes = estimateFrameBytes(this.canvas.width, this.canvas.height, this.samples, 2048, { hdr: this.hdr, bloom: !this.benchmark, depth: this.depth });
    const peakBytes = frameBytes + this.textureBytes + this.geometryBytes + newGeometryBytes + newInstanceBytes;
    if (peakBytes > this.memoryBudgetMiB * 1024 * 1024) {
      throw new RangeError('Memory budget cannot hold the current scene and staged replacement buffers.');
    }
    const previousLocations = this.partLocations;
    const previousBuffers = [...this.buffers];
    const previousGeometryBytes = this.geometryBytes;
    const previousGeometryBuffers = new Map(this.geometryBuffers);
    const stagedLocations = new Map();
    const stagedBatches = [];
    this.partLocations = stagedLocations;
    try {
      for (const item of replacements) {
        if (item.batch) {
          stagedBatches.push(item.batch);
          for (const part of item.group) {
            stagedLocations.set(part, previousLocations.get(part));
          }
        } else {
          stagedBatches.push(this.uploadBatch(item.group));
        }
      }
      const error = this.context.getError();
      if (error !== 0) {
        throw new Error(`WebGL replacement allocation failed with error ${error}.`);
      }
    } catch (error) {
      for (const batch of stagedBatches) {
        if (!retained.has(batch)) this.context.deleteVertexArray(batch.vertexArray);
      }
      for (const buffer of this.buffers.slice(previousBuffers.length)) {
        this.context.deleteBuffer(buffer);
      }
      this.context.bindVertexArray(null);
      this.buffers = previousBuffers;
      this.geometryBytes = previousGeometryBytes;
      this.geometryBuffers = previousGeometryBuffers;
      this.partLocations = previousLocations;
      throw error;
    }
    const releasedBuffers = new Set();
    for (const batch of this.batches) {
      if (!retained.has(batch)) {
        this.context.deleteVertexArray(batch.vertexArray);
        releasedBuffers.add(batch.instanceBuffer);
      }
    }
    for (const [geometry, buffers] of this.geometryBuffers) {
      if (!geometries.has(geometry)) {
        for (const buffer of buffers.values()) releasedBuffers.add(buffer);
        this.geometryBuffers.delete(geometry);
      }
    }
    for (const buffer of releasedBuffers) this.context.deleteBuffer(buffer);
    this.buffers = this.buffers.filter(buffer => !releasedBuffers.has(buffer));
    this.geometryBytes = [...geometries].reduce((total, geometry) => total + geometryBufferBytes(geometry), 0) + renderParts.length * INSTANCE_STRIDE * 4;
    this.batches = stagedBatches;
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.updateBatches.clear();
    this.shadowsDirty = true;
    this.updateParts(renderParts);
    return parts.length;
  }

  createSkinTexture(cache, identity, matrices, groupSize) {
    if (cache.has(identity)) return cache.get(identity);
    const context = this.context;
    const texelCount = matrices ? matrices.length / 4 : identity.positions.length / 3 * 2;
    const layout = skinTextureLayout(texelCount, context.getParameter(context.MAX_TEXTURE_SIZE), groupSize);
    const data = matrices ? new Float32Array(layout.width * layout.height * 4) : packSkinInfluences(identity, layout);
    if (matrices) data.set(matrices);
    const record = this.createPackedTexture(layout, data);
    record.pose = matrices ? identity : null;
    cache.set(identity, record);
    return record;
  }

  createMorphTexture(geometry, pose) {
    if (this.morphTextures.has(geometry)) return this.morphTextures.get(geometry);
    const info = validateMorphGeometry(geometry, pose);
    const layout = skinTextureLayout(info.vertexCount * info.targetCount * 2, this.context.getParameter(this.context.MAX_TEXTURE_SIZE), 2);
    const record = this.createPackedTexture(layout, packMorphTargets(geometry, layout));
    record.info = info;
    this.morphTextures.set(geometry, record);
    return record;
  }

  createPackedTexture(layout, data) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    try {
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA32F, layout.width, layout.height, 0, context.RGBA, context.FLOAT, data);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    }
    return { ...layout, texture, data };
  }

  updateParts(parts, { shadows = true } = {}) {
    this.updatePartIdentities ??= new Set();
    this.updatePartIdentities.clear();
    this.updateSkins.clear();
    this.updateMorphs ??= new Set();
    this.updateMorphs.clear();
    this.updateBatches.clear();
    // Preflight every part before touching packed data or submitting GPU writes.
    for (const part of parts) {
      this.updatePartIdentities.add(part);
      const location = this.partLocations.get(part);
      if (!location) throw new Error(`Unknown part identity: ${part.name}`);
      if (part.castShadow !== undefined && typeof part.castShadow !== 'boolean') throw new TypeError('castShadow must be a boolean');
      if ((part.castShadow !== false) !== location.batch.castShadow) throw new Error(`Shadow casting changes require a new renderer: ${part.name}`);
      if (part.geometry !== location.geometry) throw new Error(`Geometry changes require a new renderer: ${part.name}`);
      if (renderPass(part.material) !== batchPass(location.batch)) throw new Error(`Moving a part into or out of the liquid or foam pass requires replaceParts: ${part.name}`);
      if ((part.skin ?? null) !== location.skin || part.skin?.jointMatrices !== location.jointMatrices || part.geometry.skinIndices !== location.skinIndices || part.geometry.skinWeights !== location.skinWeights) throw new Error(`Skin identity changes require a new renderer: ${part.name}`);
      if (part.skin) {
        if (PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Skinned parts require a standard material tag.');
        validateSkinPose(part.skin, part.geometry, part.matrix);
        this.updateSkins.add(location.batch.skinTexture);
      }
      if ((part.morph ?? null) !== (location.morph ?? null) || part.morph?.weights !== location.morphWeights || part.geometry.morphTargets !== location.morphTargets) throw new Error(`Morph identity changes require a new renderer: ${part.name}`);
      if (part.morph) {
        if (PROCEDURAL_MATERIAL_TAGS.has(part.material.tag)) throw new Error('Morphed parts require a standard material tag.');
        validateMorphTransform(part.morph, location.batch.morphTexture.info, part.matrix, part.skin);
        this.updateMorphs.add(part.morph);
      }
      if ((part.material.map ?? null) !== location.map) throw new Error(`Texture map changes require a new renderer: ${part.name}`);
      validateMaterialMaps(part.material);
      const normalScale = part.material.normalScale ?? DEFAULT_NORMAL_SCALE;
      const mapState = location.mapState;
      for (let index = 0; index < MATERIAL_MAPS.length; index++) {
        if ((part.material[MATERIAL_MAPS[index]] ?? null) !== mapState[index]) throw new Error(`Material map or scale changes require a new renderer: ${part.name}`);
      }
      if (normalScale[0] !== mapState[5] || normalScale[1] !== mapState[6] || (part.material.occlusionStrength ?? 1) !== mapState[7]) throw new Error(`Material map or scale changes require a new renderer: ${part.name}`);
      validateTransform(part, location.normalMatrix);
    }
    // A palette upload also changes consumers absent from the submitted part list.
    if (this.updateSkins.size) {
      for (const [part, location] of this.partLocations) {
        if (!location.skin || !this.updateSkins.has(location.batch.skinTexture) || this.updatePartIdentities.has(part)) continue;
        const committedMatrix = location.committedMatrix ?? location.batch.instanceData.subarray(location.index * INSTANCE_STRIDE, location.index * INSTANCE_STRIDE + 16);
        validateSkinPose(location.skin, location.geometry, committedMatrix);
      }
    }
    // Shared weights also affect batches absent from the submitted part list.
    for (const [part, location] of this.partLocations) {
      if (!location.morph || this.updatePartIdentities.has(part)) continue;
      if (!this.updateMorphs.has(location.morph) && !this.updateSkins.has(location.batch.skinTexture)) continue;
      const committedMatrix = location.committedMatrix ?? location.batch.instanceData.subarray(location.index * INSTANCE_STRIDE, location.index * INSTANCE_STRIDE + 16);
      validateMorphTransform(location.morph, location.batch.morphTexture.info, committedMatrix, location.skin);
    }
    this.updateBatches.clear();
    for (const part of parts) {
      const location = this.partLocations.get(part);
      packInstance(location.batch.instanceData, location.index, part, location.normalMatrix);
      this.updateBatches.add(location.batch);
    }
    for (const batch of this.updateBatches) {
      this.context.bindBuffer(this.context.ARRAY_BUFFER, batch.instanceBuffer);
      this.context.bufferSubData(this.context.ARRAY_BUFFER, 0, batch.instanceData);
    }
    for (const record of this.updateSkins) {
      // Each texture record belongs to one pose and keeps its padded upload buffer.
      const pose = record.pose;
      record.data.set(pose.jointMatrices);
      this.context.bindTexture(this.context.TEXTURE_2D, record.texture);
      this.context.texSubImage2D(this.context.TEXTURE_2D, 0, 0, 0, record.width, record.height, this.context.RGBA, this.context.FLOAT, record.data);
    }
    for (const batch of this.batches ?? []) {
      if (batch.morph && this.updateMorphs.has(batch.morph)) batch.morphWeights.set(batch.morph.weights);
    }
    if (shadows && parts.length > 0) this.shadowsDirty = true;
    return parts.length;
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
    context.activeTexture(context.TEXTURE0);
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
    const lightView = mat4.lookAt(mat4.create(), light.eye, light.target, light.up ?? [0, 1, 0]);
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
    for (const batch of this.batches) if (!batch.floor && batch.castShadow) this.drawBatch(batch);
    context.disable(context.POLYGON_OFFSET_FILL);
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    this.shadowsDirty = false;
  }

  resize() {
    const plan = planRenderSize({ width: Math.max(1, this.canvas.clientWidth), height: Math.max(1, this.canvas.clientHeight), pixelRatio: this.pixelRatio, samples: this.samples, memoryBudgetMiB: this.memoryBudgetMiB, geometryBytes: this.geometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !this.benchmark, depth: this.depth, maximumSize: Math.min(this.context.getParameter(this.context.MAX_RENDERBUFFER_SIZE), this.context.getParameter(this.context.MAX_TEXTURE_SIZE)) });
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
    if (this.depthTexture) context.deleteTexture(this.depthTexture);
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
    this.depthTexture = null;
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
    if (this.depth) {
      this.depthTexture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, this.depthTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, width, height, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.depthTexture, 0);
    }
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

  initializeEnvironment(map) {
    const context = this.context;
    context.useProgram(this.program);
    context.uniform1i(this.uniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    context.uniform1i(this.uniforms.environmentBrdf, ENVIRONMENT_BRDF_UNIT);
    if (this.liquidProgram) {
      context.useProgram(this.liquidProgram);
      context.uniform1i(this.liquidUniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    }
    this.bindEnvironmentTextures(this.whiteTexture, this.whiteTexture);
    if (!this.benchmark && map) this.prepareEnvironment(map);
  }

  bindEnvironmentTextures(specularTexture, brdfTexture) {
    const context = this.context;
    context.activeTexture(context.TEXTURE0 + ENVIRONMENT_SPECULAR_UNIT);
    context.bindTexture(context.TEXTURE_2D, specularTexture);
    context.activeTexture(context.TEXTURE0 + ENVIRONMENT_BRDF_UNIT);
    context.bindTexture(context.TEXTURE_2D, brdfTexture);
  }

  // Prefilters a map the first time it is seen; maps spread from one created map share its data and reuse the GPU textures. Returns true when new textures were built.
  prepareEnvironment(map) {
    assertEnvironmentMap(map);
    if (this.environmentResources?.data === map.data) return false;
    estimateEnvironmentBytes(map, this.capabilities.maximumTextureSize);
    const resources = createEnvironmentResources(this.context, map, { compileProgram, fullscreenVertex });
    this.environmentResources?.dispose();
    this.environmentResources = resources;
    this.textureBytes += resources.bytes - this.environmentBytes;
    this.environmentBytes = resources.bytes;
    return true;
  }

  // Binds the prefiltered textures for this frame and returns the active map, or null for the built-in studio lighting.
  activateEnvironment(map) {
    if (this.benchmark || !map) {
      this.bindEnvironmentTextures(this.whiteTexture, this.whiteTexture);
      return null;
    }
    if (this.prepareEnvironment(map)) this.resize();
    this.bindEnvironmentTextures(this.environmentResources.specularTexture, this.environmentResources.brdfTexture);
    return map;
  }

  applyEnvironmentUniforms(map, uniforms = this.uniforms) {
    const context = this.context;
    context.uniform1f(uniforms.environmentEnabled, map ? 1 : 0);
    if (!map) return;
    if (uniforms['environmentIrradiance[0]']) context.uniform3fv(uniforms['environmentIrradiance[0]'], this.environmentResources.irradiance);
    context.uniform1f(uniforms.environmentIntensity, map.intensity);
    context.uniform2f(uniforms.environmentRotation, Math.cos(map.rotation), Math.sin(map.rotation));
    context.uniform1f(uniforms.environmentLevelMax, this.environmentResources.levelCount - 1);
  }

  drawEnvironmentBackground(map, frame, exposure) {
    if (!map?.showBackground || this.transparent) return false;
    const context = this.context;
    if (!this.environmentBackgroundProgram) {
      this.environmentBackgroundProgram = compileProgram(context, fullscreenVertex, environmentBackgroundFragment);
      const names = ['inverseViewProjection', 'eye', 'backgroundLevel', 'exposure', 'hdrEnabled', 'environmentSpecular', 'environmentRotation', 'environmentIntensity', 'environmentLevelMax'];
      this.environmentBackgroundUniforms = Object.fromEntries(names.map(name => [name, context.getUniformLocation(this.environmentBackgroundProgram, name)]));
    }
    const uniforms = this.environmentBackgroundUniforms;
    const levelMax = this.environmentResources.levelCount - 1;
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.environmentBackgroundProgram);
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(uniforms.eye, frame.eye);
    context.uniform1f(uniforms.backgroundLevel, map.backgroundBlur * levelMax);
    context.uniform1f(uniforms.exposure, exposure);
    context.uniform1f(uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform1i(uniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    context.uniform2f(uniforms.environmentRotation, Math.cos(map.rotation), Math.sin(map.rotation));
    context.uniform1f(uniforms.environmentIntensity, map.intensity);
    context.uniform1f(uniforms.environmentLevelMax, levelMax);
    context.drawArrays(context.TRIANGLES, 0, 3);
    return true;
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

  resolveFrame(frame, effects, environment, volume) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
    context.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, this.canvas.width, this.canvas.height, context.COLOR_BUFFER_BIT | (this.depth ? context.DEPTH_BUFFER_BIT : 0), context.NEAREST);
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
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, this.depthTexture ?? this.whiteTexture);
    context.uniform1i(this.postUniforms.sceneDepth, 1);
    context.activeTexture(context.TEXTURE3);
    context.bindTexture(context.TEXTURE_2D, this.shadowTexture);
    context.uniform1i(this.postUniforms.volumeShadowMap, 3);
    context.uniformMatrix4fv(this.postUniforms.volumeLightProjection, false, this.lightProjection);
    context.uniform3fv(this.postUniforms.volumeLightDirection, environment.lightDirection);
    context.uniform3fv(this.postUniforms.volumeLightColor, this.lighting.keyColor);
    context.uniform1f(this.postUniforms.volumeDensity, volume.density);
    context.uniform3fv(this.postUniforms.volumeMinimum, volume.minimum);
    context.uniform3fv(this.postUniforms.volumeMaximum, volume.maximum);
    context.uniform3fv(this.postUniforms.volumeColor, volume.color);
    context.uniform3fv(this.postUniforms.volumeAmbient, volume.ambient);
    context.uniform3fv(this.postUniforms.volumeDrift, volume.drift);
    context.uniform1i(this.postUniforms.volumeSteps, volume.steps);
    context.uniform1f(this.postUniforms.volumeAnisotropy, volume.anisotropy);
    context.uniform1f(this.postUniforms.volumeNoiseAmount, volume.noiseAmount);
    context.uniform1f(this.postUniforms.volumeNoiseScale, volume.noiseScale);
    context.uniform1f(this.postUniforms.volumeMaxDistance, volume.maxDistance);
    context.uniform1f(this.postUniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
    context.activeTexture(context.TEXTURE2);
    context.bindTexture(context.TEXTURE_2D, effects.bloom.strength > 0 ? this.bloomTargets[1].texture : this.whiteTexture);
    context.uniform1i(this.postUniforms.bloomTexture, 2);
    context.uniform1f(this.postUniforms.bloomStrength, effects.bloom.strength);
    context.uniform1f(this.postUniforms.transparent, this.transparent ? 1 : 0);
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

  drawTranslucent(frame, environment, assemblyAmount, environmentMap) {
    const liquids = this.batches.filter(batch => batchPass(batch) === 'liquid');
    const foams = this.batches.filter(batch => batchPass(batch) === 'foam');
    if (liquids.length === 0 && foams.length === 0) return;
    const optics = resolveLiquidOptics({ ...environment.liquid, ...frame.liquid });
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    // Liquids refract the opaque scene, so resolve it into frameTexture before drawing them on top.
    context.bindFramebuffer(context.READ_FRAMEBUFFER, this.multisampleFramebuffer);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, this.resolveFramebuffer);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
    context.bindFramebuffer(context.FRAMEBUFFER, this.multisampleFramebuffer);
    context.viewport(0, 0, width, height);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    context.useProgram(this.liquidProgram);
    const uniforms = this.liquidUniforms;
    context.uniformMatrix4fv(uniforms.viewProjection, false, this.viewProjection);
    context.uniformMatrix4fv(uniforms.lightProjection, false, this.lightProjection);
    context.uniform3fv(uniforms.eye, frame.eye);
    context.uniform2f(uniforms.resolution, width, height);
    context.uniform1f(uniforms.exposure, frame.exposure ?? 1);
    context.uniform1f(uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform1f(uniforms.worldMode, this.world ? 1 : 0);
    context.uniform1f(uniforms.daylight, environment.daylight);
    context.uniform3fv(uniforms.lightDirection, environment.lightDirection);
    context.uniform3fv(uniforms.keyColor, this.lighting.keyColor);
    context.uniform1f(uniforms.ambientIntensity, this.lighting.ambientIntensity);
    context.uniform3fv(uniforms.fogColor, environment.fogColor);
    context.uniform1f(uniforms.fogDensity, environment.fogDensity);
    context.uniform4f(uniforms.liquidOptics, optics.thickness, optics.ior, optics.refraction, optics.scattering);
    context.uniform2f(uniforms.foamShape, optics.foamOpacity, optics.foamSoftness);
    this.applyEnvironmentUniforms(environmentMap, uniforms);
    context.uniform1f(uniforms.time, frame.time ?? 0);
    context.uniform1f(uniforms.wind, frame.wind ?? 0.3);
    context.uniform1f(uniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniform3fv(uniforms.explosionCenter, environment.explosionCenter);
    context.uniform1f(uniforms.assemblyAmount, assemblyAmount);
    if (uniforms.skinEnabled) context.uniform1f(uniforms.skinEnabled, 0);
    if (uniforms.morphEnabled) context.uniform1f(uniforms.morphEnabled, 0);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, this.frameTexture);
    context.uniform1i(uniforms.sceneColor, 0);
    for (const batch of liquids) {
      context.bindVertexArray(batch.vertexArray);
      context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, batch.instanceCount);
    }
    if (foams.length > 0) {
      context.enable(context.BLEND);
      context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
      context.depthMask(false);
      for (const batch of foams) {
        context.bindVertexArray(batch.vertexArray);
        context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, batch.instanceCount);
      }
      context.depthMask(true);
      context.disable(context.BLEND);
    }
    context.bindVertexArray(null);
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
    if (this.hasMorphs) {
      const uniforms = textured ? this.uniforms : this.depthMorphUniforms;
      this.context.uniform1f(uniforms.morphEnabled, batch.morph ? 1 : 0);
      if (batch.morph) {
        this.context.uniform1i(uniforms.morphVertexCount, batch.morphTexture.info.vertexCount);
        this.context.uniform1i(uniforms.morphTargetCount, batch.morphTexture.info.targetCount);
        this.context.uniform1fv(uniforms['morphWeights[0]'], batch.morphWeights);
        this.context.activeTexture(this.context.TEXTURE0 + 8);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.morphTexture.texture);
      }
    }
    if (this.hasSkins) {
      const uniforms = textured ? this.uniforms : this.depthSkinUniforms;
      this.context.uniform1f(uniforms.skinEnabled, batch.skin ? 1 : 0);
      if (batch.skin) {
        this.context.activeTexture(this.context.TEXTURE0 + 6);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.influenceTexture.texture);
        this.context.uniform1i(uniforms.skinInfluences, 6);
        this.context.activeTexture(this.context.TEXTURE0 + 7);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.skinTexture.texture);
        this.context.uniform1i(uniforms.jointPalette, 7);
      }
    }
    if (textured && !this.benchmark) {
      for (let index = 0; index < MATERIAL_MAPS.length; index++) {
        this.context.activeTexture(this.context.TEXTURE0 + index + 1);
        this.context.bindTexture(this.context.TEXTURE_2D, batch.textures[index]);
        this.context.uniform1i(this.uniforms[MAP_UNIFORMS[index]], index + 1);
        this.context.uniform1f(this.uniforms[MAP_FLAGS[index]], batch.mapState[index] ? 1 : 0);
      }
      this.context.uniform2f(this.uniforms.normalScale, batch.mapState[5], batch.mapState[6]);
      this.context.uniform1f(this.uniforms.occlusionStrength, batch.mapState[7]);
    }
    this.context.bindVertexArray(batch.vertexArray);
    this.context.drawElementsInstanced(this.context.TRIANGLES, batch.indexCount, this.context.UNSIGNED_INT, 0, batch.instanceCount);
  }

  render(frame) {
    const { eye, target = [0, 1.2, 0], armorColor = [0.53, 0.39, 0.24], armorSurface = [0.88, 0.32], exposure = 1, inspection = false } = frame;
    const effects = resolveEffects(frame.effects);
    const environment = { lightDirection: [-3, 6, 4], fogColor: [0.35, 0.43, 0.43], fogDensity: 0.006, daylight: 1, explosionCenter: [0, 0, 0], ...this.environment, ...frame.environment };
    const volume = resolveVolumeFog(environment.volumeFog);
    if (volume.density > 0) {
      if (!this.depth || !this.hdr || this.transparent || this.benchmark) throw new Error('Volume fog requires depth:true, active HDR and an opaque canvas');
      if (!Number.isFinite(frame.time ?? 0) || Math.abs(frame.time ?? 0) > 1e6) throw new RangeError('Volume time must be finite and within ±1000000 seconds');
      const direction = environment.lightDirection;
      const lightLength = direction?.length === 3 ? Math.hypot(...direction) : NaN;
      if (!Number.isFinite(lightLength) || lightLength < 1e-6 || !Array.from(direction).every(component => typeof component === 'number' && Math.abs(component) <= 1e6)) throw new RangeError('Volume light direction must have a finite nonzero length and bounded components');
    }
    updateLightingState(this.lighting, environment, { world: this.world });
    const start = performance.now();
    const context = this.context;
    const assemblyAmount = Math.max(0, Math.min(1, frame.assemblyAmount ?? 0));
    if (this.assemblyAmount !== assemblyAmount || this.shadowsDirty) {
      this.assemblyAmount = assemblyAmount;
      this.createShadowMap();
    }
    const environmentMap = this.activateEnvironment(environment.map);
    applyProjection(this.projection, frame, this.canvas.width / this.canvas.height, { world: this.world });
    mat4.lookAt(this.view, eye, target, frame.up ?? [0, 1, 0]);
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.invert(this.inverseViewProjection, this.viewProjection);
    context.bindFramebuffer(context.FRAMEBUFFER, this.benchmark ? null : this.multisampleFramebuffer);
    context.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (this.transparent) {
      context.clearColor(0, 0, 0, 0);
    } else {
      context.clearColor(0.145, 0.162, 0.177, 1);
    }
    context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
    const environmentBackgroundDrawn = this.drawEnvironmentBackground(environmentMap, frame, exposure);
    if (this.world && !this.benchmark && !environmentBackgroundDrawn) this.drawSky(frame);
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
    context.uniform1i(this.uniforms.pointLightCount, this.lighting.pointCount);
    context.uniform4fv(this.uniforms['pointLightPositions[0]'], this.lighting.positions);
    context.uniform4fv(this.uniforms['pointLightColors[0]'], this.lighting.colors);
    context.uniform1fv(this.uniforms['pointLightRadii[0]'], this.lighting.radii);
    context.uniform3fv(this.uniforms.keyColor, this.lighting.keyColor);
    context.uniform1f(this.uniforms.fillIntensity, this.lighting.fillIntensity);
    context.uniform1f(this.uniforms.ambientIntensity, this.lighting.ambientIntensity);
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
    this.applyEnvironmentUniforms(environmentMap);
    for (const batch of this.batches) {
      if (this.benchmark || batchPass(batch) === 'opaque') this.drawBatch(batch, true);
    }
    context.bindVertexArray(null);
    if (!this.benchmark) this.drawTranslucent(frame, environment, assemblyAmount, environmentMap);
    if (!this.benchmark) this.resolveFrame(frame, effects, environment, volume);
    this.cpuMilliseconds = performance.now() - start;
  }

  dispose() {
    this.releaseFrameTargets();
    this.batches.forEach((batch) => this.context.deleteVertexArray(batch.vertexArray));
    this.buffers.forEach((buffer) => this.context.deleteBuffer(buffer));
    this.geometryBuffers?.clear();
    this.context.deleteTexture(this.shadowTexture);
    this.context.deleteFramebuffer(this.shadowFramebuffer);
    this.context.deleteProgram(this.program);
    this.context.deleteProgram(this.depthProgram);
    if (this.postProgram) this.context.deleteProgram(this.postProgram);
    if (this.skyProgram) this.context.deleteProgram(this.skyProgram);
    if (this.bloomProgram) this.context.deleteProgram(this.bloomProgram);
    if (this.environmentBackgroundProgram) this.context.deleteProgram(this.environmentBackgroundProgram);
    this.environmentResources?.dispose();
    for (const texture of this.textures.values()) this.context.deleteTexture(texture);
    this.textures.clear();
    for (const cache of [this.skinTextures, this.influenceTextures, this.morphTextures]) {
      for (const record of cache?.values() ?? []) this.context.deleteTexture(record.texture);
      cache?.clear();
    }
    this.partLocations.clear();
    this.updatePartIdentities?.clear();
    this.updateSkins?.clear();
    this.updateMorphs?.clear();
    this.updateBatches?.clear();
  }
}
