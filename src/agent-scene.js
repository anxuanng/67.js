import { mat4, mat3 } from 'gl-matrix';
import { box, cylinder, sphere, torus } from './geometry.js';
import { lathe, extrude, tube } from './modeling.js';
import { createSceneGraph } from './scene-graph.js';
import { applyProjection } from './camera.js';
import { normalizeAgentLook } from './agent-look.js';
import { normalizeAgentMotion, compileAgentMotion } from './agent-motion.js';
import { meshReport, generateMeshGeometry, MESH_SMOOTH_ANGLE_DEFAULT } from './agent-mesh.js';
import { normalizeMeshEdits, normalizeMeshStack } from './mesh-recipe.js';
import { expandInstancedNodes } from './mesh-instances.js';
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, MAX_MATERIAL_PATTERNS, RECIPE_ALPHA_MODES } from './agent-scene-capabilities.js';
import { materialPatternTextures, normalizeMaterialPattern } from './material-patterns.js';
export { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS };
export { normalizeAgentLook, resolveAgentShadow } from './agent-look.js';
export { needsMeshBooleans } from './agent-mesh.js';
export { loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader } from './mesh-boolean.js';

const DEFAULT_LIMITS = AGENT_SCENE_DEFAULT_LIMITS;
const MAX_MESH_REPORTS = 16;
const CAMERA_DEFAULTS = Object.freeze({ eye: [4, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 1000 });
const NODE_FIELDS = ['translation', 'rotation', 'scale', 'parent', 'label', 'geometry', 'material'];
const MATERIAL_FIELDS = ['color', 'metallic', 'roughness', 'emission', 'emissiveColor', 'opacity', 'alphaMode', 'doubleSided', 'pattern'];
const PATTERN_TEXTURE_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'boxMapScale', 'boxMapAxis'];
const CAMERA_FIELDS = Object.keys(CAMERA_DEFAULTS);
const LOOK_OPERATION_FIELDS = Object.freeze({
  'set-environment': 'environment',
  'set-effects': 'effects',
  'set-shadow': 'shadow',
});
const ADDITION_FIELDS = Object.freeze({
  'add-geometry': ['geometries', 'geometry'],
  'add-material': ['materials', 'material'],
  'add-node': ['nodes', 'node'],
});
const REMOVAL_FIELDS = Object.freeze({
  'remove-geometry': 'geometries',
  'remove-material': 'materials',
});


function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`Unknown ${label} field: ${key}.`);
    }
  }
}

function resolveLimits(input) {
  knownKeys(input, Object.keys(DEFAULT_LIMITS), 'limits');
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive safe integer.`);
    }
  }
  if (result.maxNodes > 4096) {
    throw new RangeError('maxNodes cannot exceed 4096.');
  }
  return Object.freeze(result);
}

// Copy only JSON data. Reject accessors before reading them and bound traversal before serialization.
function copiedJson(input, maximum) {
  let bytes = 0;
  const ancestors = new Set();
  const encoder = new TextEncoder();
  function charge(count) {
    bytes += count;
    if (bytes > maximum) {
      throw new RangeError('JSON exceeds maxRecipeBytes. Reduce the input.');
    }
  }
  function copy(value, depth) {
    if (depth > 64) {
      throw new RangeError('JSON nesting exceeds 64 levels.');
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : String(value).length);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > maximum) {
        throw new RangeError('JSON exceeds maxRecipeBytes.');
      }
      charge(encoder.encode(JSON.stringify(value)).length);
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError('Recipe must contain finite, acyclic JSON data.');
    }
    const array = Array.isArray(value);
    if (array && value.length > maximum) {
      throw new RangeError('JSON exceeds maxRecipeBytes.');
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Recipe objects must be plain JSON objects.');
    }
    ancestors.add(value);
    charge(2);
    const result = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('Invalid JSON key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('JSON accessors and hidden fields are unsupported.');
      }
      if (array && key !== String(result.length)) {
        throw new TypeError('JSON arrays must be dense without extra fields.');
      }
      charge(array ? 1 : encoder.encode(JSON.stringify(key)).length + 2);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) {
      throw new TypeError('JSON arrays must be dense without trailing holes.');
    }
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > maximum) {
    throw new RangeError('JSON exceeds maxRecipeBytes.');
  }
  return result;
}

function finite(value, label) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new TypeError(`${label} must be a finite Float32 number.`);
  }
  return value;
}

function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} needs ${length} numbers.`);
  }
  return value.map(component => finite(component, label));
}

function defaultValue(value, fallback) {
  return value === undefined ? fallback : value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be within ${minimum} and ${maximum}.`);
  }
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new TypeError('IDs must contain 1 to 128 characters.');
  }
  return value;
}

function resources(values, maximum, label, validate) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new RangeError(`${label} exceeds its resource limit or is not an array.`);
  }
  const seen = new Set();
  return values.map(value => {
    identifier(value?.id);
    if (seen.has(value.id)) {
      throw new RangeError(`Duplicate ${label} ID: ${value.id}.`);
    }
    seen.add(value.id);
    return validate(value);
  });
}

function materialFrom(value) {
  knownKeys(value, ['id', 'tag', ...MATERIAL_FIELDS], 'material');
  // A pattern brings its own colours, so the color field tints it and leaves it unchanged by default.
  const defaultColor = value.pattern === undefined ? [0.5, 0.5, 0.5] : [1, 1, 1];
  const result = { id: value.id, tag: defaultValue(value.tag, 'surface'), color: vector(defaultValue(value.color, defaultColor), 3, 'color'),
    metallic: defaultValue(value.metallic, 0), roughness: defaultValue(value.roughness, 0.5), emission: defaultValue(value.emission, 0) };
  if (!AGENT_SCENE_CAPABILITIES.materialTags.includes(result.tag)) {
    throw new RangeError(`Material tag must be one of ${AGENT_SCENE_CAPABILITIES.materialTags.join(', ')}.`);
  }
  if (value.pattern !== undefined) {
    if (result.tag !== 'surface') throw new RangeError('Material pattern needs the surface tag.');
    result.pattern = normalizeMaterialPattern(value.pattern);
  }
  result.opacity = defaultValue(value.opacity, 1);
  finite(result.opacity, 'opacity');
  if (result.opacity < 0 || result.opacity > 1) {
    throw new RangeError('opacity must be within zero and one.');
  }
  const requestedAlphaMode = defaultValue(value.alphaMode, 'opaque');
  if (!RECIPE_ALPHA_MODES.includes(requestedAlphaMode)) {
    throw new RangeError(`alphaMode must be one of ${RECIPE_ALPHA_MODES.join(', ')}.`);
  }
  // The renderer ignores opacity on opaque surfaces, so any opacity below one means blending.
  result.alphaMode = result.opacity < 1 ? 'blend' : requestedAlphaMode;
  result.doubleSided = defaultValue(value.doubleSided, false);
  if (typeof result.doubleSided !== 'boolean') {
    throw new TypeError('doubleSided must be boolean.');
  }
  for (const field of ['metallic', 'roughness']) {
    finite(result[field], field);
    if (result[field] < 0 || result[field] > 1) {
      throw new RangeError(`${field} must be within zero and one.`);
    }
  }
  finite(result.emission, 'emission');
  if (result.emission < 0 || result.color.some(component => component < 0 || component > 1)) {
    throw new RangeError('Emission must be nonnegative and color must be within zero and one.');
  }
  if (value.emissiveColor !== undefined) {
    result.emissiveColor = vector(value.emissiveColor, 3, 'emissiveColor');
    if (result.emissiveColor.some(component => component < 0)) {
      throw new RangeError('emissiveColor must be nonnegative.');
    }
  }
  const emissiveColor = result.emissiveColor ?? result.color;
  for (const component of emissiveColor) {
    const radiance = Math.fround(component) * Math.fround(result.emission);
    if (!Number.isFinite(Math.fround(radiance))) {
      throw new RangeError('Emissive radiance exceeds Float32 range.');
    }
    if (result.tag === 'unlit' && radiance > 65500) {
      throw new RangeError('Unlit emissive radiance exceeds the half-float HDR target range.');
    }
  }
  return result;
}

function nodeFrom(value) {
  knownKeys(value, ['id', 'geometry', 'material', ...NODE_FIELDS], 'node');
  const result = { ...value, parent: value.parent ?? null,
    translation: vector(defaultValue(value.translation, [0, 0, 0]), 3, 'translation'),
    rotation: vector(defaultValue(value.rotation, [0, 0, 0, 1]), 4, 'rotation'),
    scale: vector(defaultValue(value.scale, [1, 1, 1]), 3, 'scale') };
  if (result.parent !== null) {
    identifier(result.parent);
  }
  if (result.label !== undefined && (typeof result.label !== 'string' || result.label.length > 256)) {
    throw new TypeError('label must be a string of at most 256 characters.');
  }
  if (result.scale.some(component => component <= 0 || Math.fround(component) <= 0)) {
    throw new RangeError('scale must remain positive at Float32 precision.');
  }
  const length = Math.hypot(...result.rotation);
  if (length === 0) {
    throw new RangeError('rotation quaternion must be nonzero.');
  }
  result.rotation = result.rotation.map(component => component / length);
  if ((value.geometry !== undefined) !== (value.material !== undefined)) {
    throw new TypeError('Mesh nodes need both geometry and material IDs.');
  }
  if (value.geometry !== undefined) {
    identifier(value.geometry);
    identifier(value.material);
  }
  return result;
}

function cameraFrom(value = {}) {
  knownKeys(value, CAMERA_FIELDS, 'camera');
  const result = { ...CAMERA_DEFAULTS, ...value };
  result.eye = vector(result.eye, 3, 'eye');
  result.target = vector(result.target, 3, 'target');
  result.up = vector(result.up, 3, 'up');
  const upLength = Math.hypot(...result.up);
  if (upLength === 0) {
    throw new RangeError('Camera up must be nonzero.');
  }
  result.up = result.up.map(component => component / upLength);
  for (const field of ['fov', 'near', 'far']) {
    finite(result[field], field);
  }
  if (Math.fround(result.fov) <= 0 || Math.fround(result.fov) >= 180 || Math.fround(result.near) <= 0 || Math.fround(result.far) <= Math.fround(result.near)) {
    throw new RangeError('Camera needs 0 < fov < 180 and 0 < near < far at Float32 precision.');
  }
  if (result.eye.every((component, axis) => Math.fround(component) === Math.fround(result.target[axis]))) {
    throw new RangeError('Camera eye and target must differ at Float32 precision.');
  }
  const direction = result.target.map((component, axis) => component - result.eye[axis]);
  const directionLength = Math.hypot(...direction);
  const unitDirection = direction.map(component => component / directionLength);
  const crossLength = Math.hypot(unitDirection[1] * result.up[2] - unitDirection[2] * result.up[1],
    unitDirection[2] * result.up[0] - unitDirection[0] * result.up[2], unitDirection[0] * result.up[1] - unitDirection[1] * result.up[0]);
  if (Math.fround(crossLength) === 0) {
    throw new RangeError('Camera up must not be collinear with the view direction.');
  }
  const view = mat4.lookAt(mat4.create(), result.eye, result.target, result.up);
  const projection = applyProjection(mat4.create(), result, 1);
  for (const matrix of [view, projection]) {
    const determinant = mat4.determinant(matrix);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError('Camera matrices must remain finite and nonsingular at Float32 precision.');
    }
  }
  return result;
}

const GEOMETRY_FIELDS = {
  box: ['bevel', 'subdivisions'], cylinder: ['segments', 'bevel', 'bevelSegments'],
  sphere: ['segments', 'rings'], torus: ['tubeRadius', 'segments', 'sides', 'arc', 'start'],
  lathe: ['profile', 'segments', 'startAngle', 'sweep'],
  extrude: ['contour', 'holes', 'depth', 'steps', 'bevel', 'bevelThickness', 'bevelSegments'],
  tube: ['path', 'radius', 'segments', 'radialSegments', 'closed'],
  mesh: ['base', 'edits', 'stack', 'smoothAngle'],
};

function geometryEstimate(value) {
  if (!Object.hasOwn(GEOMETRY_FIELDS, value.type)) {
    throw new TypeError('Unsupported geometry type.');
  }
  knownKeys(value, ['id', 'type', ...GEOMETRY_FIELDS[value.type]], 'geometry');
  function detail(field, fallback, minimum, maximum) {
    return integer(value[field] ?? fallback, minimum, maximum, field);
  }
  function points(input, size, minimum) {
    if (!Array.isArray(input) || input.length < minimum || input.length > 4096) {
      throw new RangeError('Geometry point count exceeds its limit.');
    }
    for (const point of input) {
      vector(point, size, 'geometry point');
    }
    return input.length;
  }
  for (const field of GEOMETRY_FIELDS[value.type]) {
    if (value[field] !== undefined && !['profile', 'contour', 'holes', 'path', 'closed', 'base', 'edits', 'stack'].includes(field)) {
      finite(value[field], field);
    }
  }
  switch (value.type) {
    case 'box':
      return value.bevel === 0 ? 24 : 6 * (2 * detail('subdivisions', 6, 1, 128) + 2) ** 2;
    case 'cylinder':
      return (detail('segments', 80, 3, 2048) + 1) * 2 * (detail('bevelSegments', 6, 1, 128) + 1) + 2 * ((value.segments ?? 80) + 2);
    case 'sphere':
      return (detail('segments', 64, 3, 2048) + 1) * (detail('rings', 40, 2, 2048) + 1);
    case 'torus':
      return (detail('segments', 96, 3, 2048) + 1) * (detail('sides', 24, 3, 128) + 1) + 2 * ((value.sides ?? 24) + 2);
    case 'lathe':
      return (detail('segments', 64, 3, 2048) + 1) * points(value.profile, 2, 2);
    case 'tube':
      points(value.path, 3, value.closed ? 3 : 2);
      if (value.closed !== undefined && typeof value.closed !== 'boolean') {
        throw new TypeError('closed must be boolean.');
      }
      return (detail('segments', 64, 3, 2048) + 1) * (detail('radialSegments', 12, 3, 128) + 1);
    case 'extrude': {
      const holes = value.holes ?? [];
      if (!Array.isArray(holes) || holes.length > 128) {
        throw new RangeError('holes must contain at most 128 rings.');
      }
      const count = points(value.contour, 2, 3) + holes.reduce((total, hole) => total + points(hole, 2, 3), 0);
      if (count > 4096) {
        throw new RangeError('Extrude exceeds 4096 input points.');
      }
      const beveled = (value.bevel ?? 0) > 0 || (value.bevelThickness ?? value.bevel ?? 0) > 0;
      return 6 * (count + holes.length * 2 - 2) + 6 * count * (detail('steps', 1, 1, 256) + (beveled ? detail('bevelSegments', 3, 1, 32) * 2 : 0));
    }
    case 'mesh': {
      const base = value.base;
      if (!base || typeof base !== 'object' || Array.isArray(base) || base.type === 'mesh' || Object.hasOwn(base, 'id')) {
        throw new TypeError('mesh base must be a primitive or profile geometry record without an id (box, cylinder, sphere, torus, lathe, extrude or tube).');
      }
      let estimate = geometryEstimate({ id: 'base', ...base });
      for (const edit of normalizeMeshEdits(value.edits ?? [])) {
        if (edit.op === 'boolean') estimate += cutterEstimate(edit.cutter);
      }
      // Stack nodes multiply the mesh: arrays by their count, mirror and solidify at most by two.
      for (const node of normalizeMeshStack(value.stack ?? [])) estimate *= node.op === 'array' ? node.count : 2;
      if (value.smoothAngle !== undefined && (value.smoothAngle < 0 || value.smoothAngle > 180)) {
        throw new RangeError('smoothAngle is degrees from 0 to 180.');
      }
      // Edits can grow the mesh; the real size is checked against maxVertices after generation.
      return estimate * 2;
    }
  }
}

function cutterEstimate(cutter) {
  if (cutter.type === 'mesh' || Object.hasOwn(cutter, 'id')) {
    throw new TypeError('A boolean cutter must be a primitive or profile record without an id (box, cylinder, sphere, torus, lathe, extrude or tube).');
  }
  return geometryEstimate({ id: 'cutter', ...cutter });
}

function generateGeometry(value, maxVertices) {
  switch (value.type) {
    case 'box':
      return box(value.bevel, value.subdivisions);
    case 'cylinder':
      return cylinder(value.segments, value.bevel, value.bevelSegments);
    case 'sphere':
      return sphere(value.segments, value.rings);
    case 'torus':
      return torus(value.tubeRadius, value.segments, value.sides, value.arc, value.start);
    case 'lathe':
      return lathe(value.profile, { ...value, maxVertices });
    case 'extrude':
      return extrude(value.contour, { ...value, maxVertices });
    case 'tube':
      return tube(value.path, { ...value, maxVertices });
    case 'mesh':
      return generateMeshGeometry(() => generateGeometry(value.base, maxVertices), value.edits ?? [], {
        maxVertices, smoothAngle: value.smoothAngle ?? MESH_SMOOTH_ANGLE_DEFAULT,
        stack: value.stack ?? [], cacheKey: JSON.stringify(value.base),
        resolveCutter: cutter => {
          cutterEstimate(cutter);
          return generateGeometry(cutter, maxVertices);
        },
      });
  }
}

function compile(recipe, geometries, localBounds, limits) {
  const materials = new Map(recipe.materials.map(material => [material.id, material]));
  const graph = createSceneGraph(recipe.nodes.map(node => {
    if (node.geometry !== undefined && (!geometries.has(node.geometry) || !materials.has(node.material))) {
      throw new RangeError(`Unknown resource referenced by node ${node.id}.`);
    }
    return { name: node.id, parent: node.parent,
      matrix: mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale),
      geometry: geometries.get(node.geometry), material: materials.get(node.material) };
  }), limits);
  validateGraph(graph, localBounds);
  return graph;
}

function validateGraph(graph, localBounds) {
  const normal = mat3.create();
  for (const node of graph.nodes) {
    if (!mat3.normalFromMat4(normal, node.worldMatrix) || !normal.every(Number.isFinite)) {
      throw new RangeError(`Node ${node.name} normal transform exceeds Float32 range.`);
    }
    if (node.geometry) {
      const bounds = localBounds.get(node.geometry);
      for (let corner = 0; corner < 8; corner++) {
        const point = [0, 1, 2].map(axis => corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis]);
        for (let axis = 0; axis < 3; axis++) {
          const matrix = node.worldMatrix;
          // Bound every multiplication and possible addition order, before cancellation.
          const absoluteSum = Math.abs(matrix[axis] * point[0]) + Math.abs(matrix[4 + axis] * point[1]) +
            Math.abs(matrix[8 + axis] * point[2]) + Math.abs(matrix[12 + axis]);
          if (!Number.isFinite(Math.fround(absoluteSum))) {
            throw new RangeError(`Node ${node.name} world geometry bounds exceed Float32 range.`);
          }
        }
      }
    }
  }
}

function boundsFor(geometry, matrix) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const positions = geometry.positions;
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] + matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { min: minimum, max: maximum };
}

function normalizeRecipe(input, limits) {
  let recipe = copiedJson(input, limits.maxRecipeBytes);
  knownKeys(recipe, ['format', 'schemaVersion', 'geometries', 'materials', 'nodes', 'camera', 'environment', 'effects', 'shadow', 'motion'], 'recipe');
  if (recipe.format !== '67js.scene' || recipe.schemaVersion !== 1) {
    throw new RangeError('Expected 67js.scene schemaVersion 1.');
  }
  recipe.geometries = resources(recipe.geometries, limits.maxGeometries, 'geometries', value => {
    geometryEstimate(value);
    const definition = { id: value.id, type: value.type };
    for (const field of GEOMETRY_FIELDS[value.type]) {
      if (Object.hasOwn(value, field)) {
        definition[field] = value[field];
      }
    }
    return definition;
  });
  recipe.materials = resources(recipe.materials, limits.maxMaterials, 'materials', materialFrom);
  const distinctPatterns = new Set(recipe.materials.filter(material => material.pattern).map(material => JSON.stringify(material.pattern)));
  if (distinctPatterns.size > MAX_MATERIAL_PATTERNS) {
    throw new RangeError(`A scene holds at most ${MAX_MATERIAL_PATTERNS} different material patterns; it has ${distinctPatterns.size}. Reuse a pattern and tint it with color.`);
  }
  recipe.nodes = expandInstancedNodes(recipe.nodes, {
    maxNodes: limits.maxNodes,
    resolveSurface: id => {
      const definition = recipe.geometries.find(geometry => geometry.id === id);
      if (!definition) throw new RangeError(`Instances surface geometry ${JSON.stringify(id.slice(0, 48))} is not in geometries.`);
      return generateGeometry(definition, Math.min(limits.maxVertices, 1_000_000));
    },
  });
  recipe.nodes = resources(recipe.nodes, limits.maxNodes, 'nodes', nodeFrom);
  recipe.camera = cameraFrom(recipe.camera);
  const look = {};
  for (const field of ['environment', 'effects', 'shadow']) {
    if (Object.hasOwn(recipe, field)) {
      look[field] = recipe[field];
    }
  }
  Object.assign(recipe, normalizeAgentLook(look));
  if (Object.hasOwn(recipe, 'motion')) {
    recipe.motion = normalizeAgentMotion(recipe.motion, recipe);
  }
  recipe = copiedJson(recipe, limits.maxRecipeBytes);
  return recipe;
}

function geometryStats(records) {
  let vertices = 0;
  let geometryBytes = 0;
  let estimatedGeometryBytes = 0;
  for (const record of records) {
    vertices += record.vertices;
    geometryBytes += record.geometryBytes;
    estimatedGeometryBytes += record.estimatedVertices * 56;
  }
  return { vertices, geometryBytes, estimatedGeometryBytes };
}

function batchSignature(material) {
  // Textures are fixed per renderer, so a changed pattern rebuilds it like a changed tag does.
  return `${material.tag}|${material.alphaMode}|${material.opacity}|${material.doubleSided}|${JSON.stringify(material.pattern ?? null)}`;
}

function materialHandle(snapshot) {
  const holder = { snapshot };
  const output = {};
  for (const field of ['tag', ...MATERIAL_FIELDS]) {
    Object.defineProperty(output, field, {
      enumerable: true,
      get() {
        return holder.snapshot[field];
      },
    });
  }
  for (const field of PATTERN_TEXTURE_FIELDS) {
    Object.defineProperty(output, field, {
      enumerable: true,
      // Baked on first read, so validating or inspecting a recipe never pays for it.
      get() {
        return holder.snapshot.pattern ? materialPatternTextures(holder.snapshot.pattern)[field] : undefined;
      },
    });
  }
  return { holder, output: Object.freeze(output) };
}

function immutableMaterial(snapshot) {
  for (const field of ['color', 'emissiveColor']) {
    if (snapshot[field]) {
      Object.freeze(snapshot[field]);
    }
  }
  return Object.freeze(snapshot);
}

function retainedMatrices(parts) {
  for (const part of parts) {
    if (part.matrix.length !== 16 || part.matrix.byteLength !== 64) {
      throw new RangeError('Retained render matrices must not be detached.');
    }
  }
}

function cameraPoseFrom(pose) {
  const camera = cameraFrom({
    eye: Array.from(pose.eye), target: Array.from(pose.target), up: Array.from(pose.up),
    fov: pose.fov, near: pose.near, far: pose.far,
  });
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  for (const aspect of [1 / 16, 16]) {
    const projection = applyProjection(mat4.create(), camera, aspect);
    const combined = mat4.multiply(mat4.create(), projection, view);
    if (![projection, combined].every(matrix => matrix.every(Number.isFinite))) {
      throw new RangeError('Motion camera matrices exceed the supported Float32 aspect range.');
    }
  }
  return camera;
}

// Candidate buffers are private. A failed seek cannot publish half a pose to render handles.
function stagePose(stagedState, time) {
  const sampled = time === null ? null : stagedState.motionSampler?.sample(time);
  const graph = stagedState.poseGraph ?? stagedState.graph;
  if (stagedState.poseGraph) {
    for (const node of stagedState.recipe.nodes) {
      const patch = sampled?.nodes.get(node.id);
      const translation = patch?.translation ?? node.translation;
      const rotation = patch?.rotation ?? node.rotation;
      const scale = patch?.scale ?? node.scale;
      if (Array.from(scale).some(component => !Number.isFinite(Math.fround(component)) || Math.fround(component) <= 0)) {
        throw new RangeError('Motion scale must remain positive at Float32 precision.');
      }
      mat4.fromRotationTranslationScale(graph.getNode(node.id).localMatrix, rotation, translation, scale);
    }
    graph.update();
    validateGraph(graph, stagedState.localBounds);
  }
  const materialUpdates = [];
  for (const material of stagedState.recipe.materials) {
    const patch = sampled?.materials.get(material.id);
    let snapshot = material;
    if (patch) {
      const definition = { ...material, ...patch };
      for (const field of ['color', 'emissiveColor']) {
        if (definition[field]) {
          definition[field] = Array.from(definition[field]);
        }
      }
      snapshot = immutableMaterial(materialFrom(definition));
    }
    materialUpdates.push({ holder: stagedState.materialHandles.get(material.id).holder, snapshot });
  }
  const camera = sampled?.camera ? cameraPoseFrom(sampled.camera) : stagedState.recipe.camera;
  retainedMatrices(stagedState.parts);
  return { graph, materialUpdates, camera, time };
}

function publishPose(stagedState, pose) {
  for (const part of stagedState.parts) {
    Float32Array.prototype.set.call(part.matrix, pose.graph.getNode(part.name).worldMatrix);
  }
  for (const update of pose.materialUpdates) {
    update.holder.snapshot = update.snapshot;
  }
  stagedState.renderCamera = pose.camera;
  stagedState.motionTime = pose.time;
}

function removeNode(candidate, operation) {
  knownKeys(operation, ['type', 'id', 'recursive'], 'operation');
  identifier(operation.id);
  const recursive = operation.recursive === undefined ? false : operation.recursive;
  if (typeof recursive !== 'boolean') {
    throw new TypeError('recursive must be boolean.');
  }
  if (!candidate.nodes.some(node => node.id === operation.id)) {
    throw new RangeError(`Operation ID was not found: ${operation.id}.`);
  }
  const children = new Map();
  for (const node of candidate.nodes) {
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node.id);
    children.set(node.parent, siblings);
  }
  if (!recursive && (children.get(operation.id)?.length ?? 0) > 0) {
    throw new RangeError('Nonrecursive removal cannot remove a node with children. Remove children first or use recursive.');
  }
  const removed = new Set([operation.id]);
  const pending = [operation.id];
  if (recursive) {
    for (let cursor = 0; cursor < pending.length; cursor++) {
      for (const child of children.get(pending[cursor]) ?? []) {
        if (!removed.has(child)) {
          removed.add(child);
          pending.push(child);
        }
      }
    }
  }
  candidate.nodes = candidate.nodes.filter(node => !removed.has(node.id));
  return removed;
}

/** A bounded CPU authoring session. Render adapters must treat geometry as immutable. */
export function createAgentScene(input, inputLimits = {}) {
  const limits = resolveLimits(inputLimits);
  let state = null;
  let revision = 0;
  let topologyRevision = 0;
  const checkpoints = new Map();

  function ownedGeometryRecords() {
    const records = new Set(state?.geometryRecords.values() ?? []);
    for (const checkpoint of checkpoints.values()) {
      for (const record of checkpoint.geometryRecords.values()) {
        records.add(record);
      }
    }
    return records;
  }

  function stage(inputRecipe, preferred = null, removedNodes = new Set(), removedMaterials = new Set()) {
    const recipe = normalizeRecipe(inputRecipe, limits);
    if (state) {
      retainedMatrices(state.parts);
    }
    const ownedRecords = ownedGeometryRecords();
    const availableRecords = new Map();
    for (const record of ownedRecords) {
      availableRecords.set(record.signature, record);
    }
    const plans = recipe.geometries.map(definition => {
      const signature = JSON.stringify(definition);
      const preferredRecord = preferred?.geometryRecords.get(definition.id);
      const activeRecord = state?.geometryRecords.get(definition.id);
      const existing = [preferredRecord, activeRecord, availableRecords.get(signature)]
        .find(record => record?.signature === signature);
      return { definition, signature, existing, estimatedVertices: geometryEstimate(definition) };
    });
    const residentStats = geometryStats(ownedRecords);
    const pendingPlans = plans.filter(plan => !plan.existing);
    const pendingVertices = pendingPlans.reduce((total, plan) => total + plan.estimatedVertices, 0);
    if (residentStats.vertices + pendingVertices > limits.maxVertices ||
        residentStats.geometryBytes + pendingVertices * 56 > limits.maxGeometryBytes) {
      throw new RangeError('Geometry preflight exceeds peak maxVertices or maxGeometryBytes across active, checkpoint, and staged resources. Reduce detail or release checkpoints.');
    }

    // Validate references, hierarchy and matrix arithmetic before generating any new resource.
    const placeholders = new Map();
    const placeholderBounds = new Map();
    for (const plan of plans) {
      const geometry = plan.existing?.geometry ?? Object.freeze({});
      placeholders.set(plan.definition.id, geometry);
      placeholderBounds.set(geometry, plan.existing?.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] });
    }
    compile(recipe, placeholders, placeholderBounds, limits);

    const geometryRecords = new Map();
    for (const plan of plans) {
      let record = plan.existing;
      if (!record) {
        const geometry = Object.freeze(generateGeometry(plan.definition, Math.min(limits.maxVertices, 1_000_000)));
        const geometryBytes = Object.values(geometry).reduce((total, array) => total + array.byteLength, 0);
        const vertices = geometry.positions.length / 3;
        if (plan.definition.type === 'mesh') {
          if (residentStats.vertices + pendingVertices - plan.estimatedVertices + vertices > limits.maxVertices) {
            throw new RangeError(`Mesh ${plan.definition.id} has ${vertices} render vertices after its edits, which exceeds maxVertices across the scene. Reduce detail or edits.`);
          }
        } else if (vertices > plan.estimatedVertices || geometryBytes > plan.estimatedVertices * 56) {
          throw new RangeError('Generated geometry exceeds its conservative preflight bound.');
        }
        record = Object.freeze({
          signature: plan.signature, geometry,
          bounds: boundsFor(geometry, mat4.create()),
          vertices, geometryBytes, estimatedVertices: plan.estimatedVertices,
        });
      }
      geometryRecords.set(plan.definition.id, record);
    }
    const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
    const localBounds = new Map([...geometryRecords.values()].map(record => [record.geometry, record.bounds]));
    const graph = compile(recipe, geometries, localBounds, limits);
    const materialHandles = new Map();
    for (const material of recipe.materials) {
      const snapshot = immutableMaterial(material);
      const preferredHandle = preferred?.materialHandles.get(material.id);
      const activeHandle = removedMaterials.has(material.id) ? null : state?.materialHandles.get(material.id);
      // The renderer keeps tag, blending, opacity and sidedness per batch, so a handle is reused only when all match.
      const existing = [preferredHandle, activeHandle].find(handle => handle && batchSignature(handle.holder.snapshot) === batchSignature(material));
      const handle = existing ?? materialHandle(snapshot);
      materialHandles.set(material.id, handle);
    }
    const activeParts = new Map(state?.parts.map(part => [part.name, part]) ?? []);
    const preferredParts = new Map(preferred?.parts.map(part => [part.name, part]) ?? []);
    const nextParts = recipe.nodes.filter(node => node.geometry !== undefined).map(node => {
      const geometry = geometries.get(node.geometry);
      const material = materialHandles.get(node.material).output;
      const activePart = removedNodes.has(node.id) ? null : activeParts.get(node.id);
      const existing = [activePart, preferredParts.get(node.id)]
        .find(part => part?.geometry === geometry && part.material === material);
      return existing ?? Object.freeze({
        name: node.id, geometry, material,
        matrix: new Float32Array(graph.getNode(node.id).worldMatrix),
      });
    });
    retainedMatrices(nextParts);
    const sameParts = state && state.parts.length === nextParts.length &&
      state.parts.every((part, index) => part === nextParts[index]);
    const stagedState = {
      recipe, geometryRecords, geometries, graph, materialHandles,
      parts: sameParts ? state.parts : Object.freeze(nextParts),
      topologyChanged: Boolean(state && !sameParts),
      stats: geometryStats(geometryRecords.values()),
    };
    stagedState.localBounds = localBounds;
    stagedState.motionSampler = compileAgentMotion(recipe.motion ?? null, recipe);
    stagedState.poseGraph = stagedState.motionSampler ? compile(recipe, geometries, localBounds, limits) : null;
    stagedState.initialPose = stagePose(stagedState, stagedState.motionSampler ? 0 : null);
    return stagedState;
  }

  function commit(stagedState, incrementRevision) {
    publishPose(stagedState, stagedState.initialPose);
    if (stagedState.topologyChanged) {
      topologyRevision++;
    }
    state = stagedState;
    if (incrementRevision) {
      revision++;
    }
    return revision;
  }

  function expected(options) {
    knownKeys(options, ['expectedRevision'], 'transaction options');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== revision) {
      throw new RangeError('expectedRevision must match the current revision.');
    }
  }

  commit(stage(input), false);
  return Object.freeze({
    capabilities: AGENT_SCENE_CAPABILITIES,
    limits,
    get parts() {
      return state.parts;
    },
    get revision() {
      return revision;
    },
    get topologyRevision() {
      return topologyRevision;
    },
    get camera() {
      return structuredClone(state.renderCamera);
    },
    get motionTime() {
      return state.motionTime;
    },
    sampleMotion(time) {
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw new RangeError('Motion time must be null or within zero and 3600 seconds.');
      }
      if (time !== null && !state.motionSampler) {
        throw new RangeError('This procedural recipe has no motion.');
      }
      publishPose(state, stagePose(state, time));
      return state.motionTime;
    },
    get environment() {
      return structuredClone(state.recipe.environment);
    },
    get effects() {
      return structuredClone(state.recipe.effects);
    },
    get shadow() {
      return structuredClone(state.recipe.shadow);
    },
    exportRecipe() {
      return structuredClone(state.recipe);
    },
    apply(inputOperations, options = {}) {
      expected(options);
      if (!Array.isArray(inputOperations) || inputOperations.length === 0 || inputOperations.length > limits.maxOperations) {
        throw new RangeError('operations must contain 1 to maxOperations commands.');
      }
      const operations = copiedJson(inputOperations, limits.maxRecipeBytes);
      const candidate = structuredClone(state.recipe);
      const removedNodes = new Set();
      const removedMaterials = new Set();
      for (const operation of operations) {
        if (operation.type === 'set-motion') {
          knownKeys(operation, ['type', 'motion'], 'operation');
          if (!Object.hasOwn(operation, 'motion')) {
            throw new TypeError('set-motion requires motion; use null to clear it.');
          }
          candidate.motion = operation.motion;
          continue;
        }
        const lookField = Object.hasOwn(LOOK_OPERATION_FIELDS, operation.type) ? LOOK_OPERATION_FIELDS[operation.type] : null;
        if (lookField) {
          knownKeys(operation, ['type', lookField], 'operation');
          const patch = operation[lookField];
          // Spot and area lights are absent from a recipe until it sets them.
          const optionalFields = lookField === 'environment' ? ['spotLights', 'areaLights'] : [];
          knownKeys(patch, [...Object.keys(candidate[lookField]), ...optionalFields], lookField);
          const nestedField = lookField === 'environment' ? 'volumeFog' : lookField === 'effects' ? 'bloom' : null;
          const merged = { ...candidate[lookField], ...patch };
          if (nestedField && Object.hasOwn(patch, nestedField)) {
            knownKeys(patch[nestedField], Object.keys(candidate[lookField][nestedField]), nestedField);
            merged[nestedField] = { ...candidate[lookField][nestedField], ...patch[nestedField] };
          }
          candidate[lookField] = merged;
          continue;
        }
        const addition = Object.hasOwn(ADDITION_FIELDS, operation.type) ? ADDITION_FIELDS[operation.type] : null;
        if (addition) {
          const [collection, field] = addition;
          knownKeys(operation, ['type', field], 'operation');
          const record = operation[field];
          identifier(record?.id);
          if (operation.type === 'add-geometry') {
            geometryEstimate(record);
          } else if (operation.type === 'add-material') {
            materialFrom(record);
          } else {
            nodeFrom(record);
          }
          if (candidate[collection].some(existing => existing.id === record.id)) {
            throw new RangeError(`Duplicate ${collection} ID: ${record.id}.`);
          }
          candidate[collection].push(record);
          continue;
        }
        if (operation.type === 'edit-mesh') {
          knownKeys(operation, ['type', 'geometry', 'edits', 'replace'], 'operation');
          identifier(operation.geometry);
          const target = candidate.geometries.find(geometry => geometry.id === operation.geometry);
          if (!target) {
            throw new RangeError(`Geometry ID was not found: ${operation.geometry}.`);
          }
          if (target.type !== 'mesh') {
            throw new TypeError(`Geometry ${operation.geometry} is a ${target.type}. Add a mesh geometry with base: { type: '${target.type}', ... } to edit it.`);
          }
          if (operation.replace !== undefined && typeof operation.replace !== 'boolean') {
            throw new TypeError('replace must be boolean.');
          }
          if (!Array.isArray(operation.edits)) {
            throw new TypeError('edit-mesh needs an edits array.');
          }
          target.edits = operation.replace ? operation.edits : [...(target.edits ?? []), ...operation.edits];
          normalizeMeshEdits(target.edits);
          continue;
        }
        if (operation.type === 'set-mesh-stack') {
          knownKeys(operation, ['type', 'geometry', 'stack', 'apply'], 'operation');
          identifier(operation.geometry);
          const target = candidate.geometries.find(geometry => geometry.id === operation.geometry);
          if (!target) {
            throw new RangeError(`Geometry ID was not found: ${operation.geometry}.`);
          }
          if (target.type !== 'mesh') {
            throw new TypeError(`Geometry ${operation.geometry} is a ${target.type}. Only mesh geometries have a modifier stack.`);
          }
          const stack = operation.stack ?? target.stack ?? [];
          normalizeMeshStack(stack);
          const applied = operation.apply ?? 0;
          if (!Number.isInteger(applied) || applied < 0 || applied > stack.length) {
            throw new RangeError(`apply must be an integer from 0 to the stack length ${stack.length}.`);
          }
          // Applying moves the first nodes into the edit log, as Blender's Apply modifier does.
          target.edits = [...(target.edits ?? []), ...stack.slice(0, applied)];
          target.stack = stack.slice(applied);
          normalizeMeshEdits(target.edits);
          continue;
        }
        if (operation.type === 'remove-node') {
          for (const id of removeNode(candidate, operation)) {
            removedNodes.add(id);
          }
          continue;
        }
        const removal = Object.hasOwn(REMOVAL_FIELDS, operation.type) ? REMOVAL_FIELDS[operation.type] : null;
        if (removal) {
          knownKeys(operation, ['type', 'id'], 'operation');
          identifier(operation.id);
          const index = candidate[removal].findIndex(record => record.id === operation.id);
          if (index < 0) {
            throw new RangeError(`Operation ID was not found: ${operation.id}.`);
          }
          candidate[removal].splice(index, 1);
          if (operation.type === 'remove-material') {
            removedMaterials.add(operation.id);
          }
          continue;
        }
        let target;
        let fields;
        if (operation.type === 'set-node') {
          fields = NODE_FIELDS;
          target = candidate.nodes.find(node => node.id === operation.id);
        } else if (operation.type === 'set-material') {
          fields = MATERIAL_FIELDS;
          target = candidate.materials.find(material => material.id === operation.id);
        } else if (operation.type === 'set-camera') {
          fields = CAMERA_FIELDS;
          target = candidate.camera;
        } else {
          throw new TypeError('Unsupported operation type.');
        }
        knownKeys(operation, ['type', ...(operation.type === 'set-camera' ? [] : ['id']), ...fields], 'operation');
        if (!target) {
          throw new RangeError(`Operation ID was not found: ${operation.id}.`);
        }
        for (const field of fields) {
          if (Object.hasOwn(operation, field)) {
            target[field] = operation[field];
          }
        }
      }
      return commit(stage(candidate, null, removedNodes, removedMaterials), true);
    },
    inspect(options = {}) {
      knownKeys(options, ['ids', 'limit', 'includeBounds'], 'inspection');
      const maximum = integer(options.limit ?? Math.min(64, limits.maxNodes), 1, limits.maxNodes, 'inspection limit');
      if (options.includeBounds !== undefined && typeof options.includeBounds !== 'boolean') {
        throw new TypeError('includeBounds must be boolean.');
      }
      if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > limits.maxNodes)) {
        throw new RangeError('Inspection IDs exceed maxNodes.');
      }
      const selected = options.ids === undefined ? state.recipe.nodes : options.ids.map(id => {
        identifier(id);
        const node = state.recipe.nodes.find(value => value.id === id);
        if (!node) {
          throw new RangeError(`Inspection ID was not found: ${id}.`);
        }
        return node;
      });
      const nodes = selected.slice(0, maximum).map(node => {
        const geometry = state.geometries.get(node.geometry);
        const result = {
          id: node.id, label: node.label ?? node.id, parent: node.parent,
          geometry: node.geometry ?? null, material: node.material ?? null,
          vertices: geometry ? geometry.positions.length / 3 : 0,
          triangles: geometry ? geometry.indices.length / 3 : 0,
        };
        if (options.includeBounds) {
          result.bounds = geometry ? boundsFor(geometry, state.graph.getNode(node.id).worldMatrix) : null;
        }
        return result;
      });
      const resident = geometryStats(ownedGeometryRecords());
      return {
        revision, topologyRevision,
        ...(state.recipe.motion?.ik?.length ? { motionIk: compileAgentMotion(state.recipe.motion, state.recipe).sweepIk() } : {}),
        motion: state.recipe.motion ? { duration: state.recipe.motion.duration, loop: state.recipe.motion.loop, tracks: state.recipe.motion.tracks.length, time: state.motionTime } : null,
        boundsSpace: 'authored-base-world',
        counts: {
          nodes: state.recipe.nodes.length, parts: state.parts.length,
          geometries: state.geometries.size, materials: state.recipe.materials.length,
          vertices: state.stats.vertices,
        },
        geometryBytes: state.stats.geometryBytes,
        estimatedGeometryBytes: state.stats.estimatedGeometryBytes,
        residentGeometryBytes: resident.geometryBytes,
        residentGeometryVertices: resident.vertices,
        look: {
          world: state.recipe.environment.world,
          pointLights: state.recipe.environment.pointLights.length,
          spotLights: state.recipe.environment.spotLights?.length ?? 0,
          areaLights: state.recipe.environment.areaLights?.length ?? 0,
          volumeFogDensity: state.recipe.environment.volumeFog.density,
          exposure: state.recipe.effects.exposure,
        },
        nodes, truncated: selected.length > nodes.length,
      };
    },
    /** Polygon counts, parts, face tags and lint problems for recipe geometries (all, or the given IDs). */
    inspectMeshes(options = {}) {
      knownKeys(options, ['geometries'], 'mesh inspection');
      const requested = options.geometries ?? [...state.geometries.keys()];
      if (!Array.isArray(requested) || (options.geometries !== undefined && requested.length > MAX_MESH_REPORTS)) {
        throw new RangeError(`Inspect at most ${MAX_MESH_REPORTS} geometry IDs per call.`);
      }
      const selected = requested.slice(0, MAX_MESH_REPORTS);
      const meshes = selected.map(id => {
        identifier(id);
        const geometry = state.geometries.get(id);
        if (!geometry) {
          throw new RangeError(`Geometry ID was not found: ${id}. Known IDs: ${[...state.geometries.keys()].join(', ')}.`);
        }
        return { geometry: id, ...meshReport(geometry) };
      });
      return { revision, meshes, truncated: requested.length > selected.length };
    },
    checkpoint() {
      if (checkpoints.size >= limits.maxCheckpoints) {
        throw new RangeError('Checkpoint budget exhausted. Release a checkpoint.');
      }
      const handle = Object.freeze({});
      checkpoints.set(handle, {
        recipe: structuredClone(state.recipe),
        geometryRecords: new Map(state.geometryRecords),
        materialHandles: new Map(state.materialHandles),
        parts: state.parts,
      });
      return handle;
    },
    restore(handle, options = {}) {
      expected(options);
      const checkpoint = checkpoints.get(handle);
      if (!checkpoint) {
        throw new RangeError('Unknown or released checkpoint.');
      }
      return commit(stage(checkpoint.recipe, checkpoint), true);
    },
    releaseCheckpoint(handle) {
      if (!checkpoints.delete(handle)) {
        throw new RangeError('Unknown or released checkpoint.');
      }
    },
  });
}
