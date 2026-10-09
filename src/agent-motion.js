import { createAnimationClip, compileAnimationSampler } from './animation.js';
import { createCameraPath } from './camera-path.js';

const PROPERTIES = {
  node: { translation: 3, rotation: 4, scale: 3 },
  material: { color: 3, emissiveColor: 3, emission: 1, metallic: 1, roughness: 1 },
  camera: { eye: 3, target: 3, fov: 1, roll: 1 },
};
const INTERPOLATIONS = ['LINEAR', 'STEP', 'SMOOTH', 'CUBICSPLINE'];
const CAMERA_DEFAULTS = { eye: [4, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 1000 };

function knownKeys(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`Unknown or unsupported ${label} field: ${String(key)}.`);
    }
  }
}

function finite(value, label) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${label} must be finite at Float32 precision.`);
  }
  return value;
}

function bounded(value, minimum, maximum, label) {
  finite(value, label);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${label} must be within ${minimum} and ${maximum}.`);
  }
  return value;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).some((key, index) => key !== String(index))) {
    throw new TypeError(`${label} must be a bounded dense array.`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, index), 'value')) {
      throw new TypeError(`${label} cannot contain accessors.`);
    }
  }
  return value;
}

function valueFrom(value, size, label) {
  if (size === 1) {
    return finite(value, label);
  }
  denseArray(value, size, label);
  if (value.length !== size) {
    throw new TypeError(`${label} needs ${size} components.`);
  }
  return value.map(component => finite(component, label));
}

function validateValue(kind, property, value) {
  const components = typeof value === 'number' ? [value] : value;
  for (const component of components) {
    finite(component, `${kind} ${property}`);
  }
  if (property === 'scale' && components.some(component => Math.fround(component) <= 0)) {
    throw new RangeError('Motion scale must remain positive at Float32 precision.');
  }
  if (kind === 'material') {
    if (components.some(component => component < 0)) {
      throw new RangeError(`Motion ${property} cannot be negative.`);
    }
    if (['color', 'metallic', 'roughness'].includes(property) && components.some(component => component > 1)) {
      throw new RangeError(`Motion ${property} must stay within zero and one.`);
    }
  }
  if (kind === 'camera' && property === 'fov' && (Math.fround(value) <= 0 || Math.fround(value) >= 180)) {
    throw new RangeError('Motion fov must stay between zero and 180 at Float32 precision.');
  }
}

function coreProperty(track) {
  if (track.property === 'rotation') {
    return 'rotation';
  }
  return PROPERTIES[track.kind][track.property] === 1 ? 'value' : 'translation';
}

function copiedKeyframe(keyframe, interpolation) {
  const result = {
    time: keyframe.time,
    value: Array.isArray(keyframe.value) ? [...keyframe.value] : keyframe.value,
  };
  if (interpolation === 'CUBICSPLINE') {
    result.inTangent = Array.isArray(keyframe.inTangent) ? [...keyframe.inTangent] : keyframe.inTangent;
    result.outTangent = Array.isArray(keyframe.outTangent) ? [...keyframe.outTangent] : keyframe.outTangent;
  }
  return result;
}

function normalizedKeyframe(keyframe, track, duration, interpolation) {
  knownKeys(keyframe, ['time', 'value', 'inTangent', 'outTangent'], 'motion keyframe');
  const size = PROPERTIES[track.kind][track.property];
  const result = {
    time: bounded(keyframe.time, 0, duration, 'Keyframe time'),
    value: valueFrom(keyframe.value, size, 'Keyframe value'),
  };
  validateValue(track.kind, track.property, result.value);
  if (interpolation === 'CUBICSPLINE') {
    result.inTangent = valueFrom(keyframe.inTangent, size, 'Incoming tangent');
    result.outTangent = valueFrom(keyframe.outTangent, size, 'Outgoing tangent');
  } else if (Object.hasOwn(keyframe, 'inTangent') || Object.hasOwn(keyframe, 'outTangent')) {
    throw new TypeError('Tangents require CUBICSPLINE interpolation.');
  }
  return result;
}

/** Normalize bounded authored data without storing bindings or sampled poses. */
export function normalizeAgentMotion(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, ['duration', 'loop', 'tracks'], 'motion');
  const duration = bounded(input.duration, 0.1, 30, 'Motion duration');
  const loop = input.loop === undefined ? false : input.loop;
  if (typeof loop !== 'boolean') {
    throw new TypeError('Motion loop must be boolean.');
  }
  denseArray(input.tracks, 128, 'Motion tracks');
  if (!input.tracks.length) {
    throw new RangeError('Motion needs at least one track. Use null to clear it.');
  }
  const nodes = new Set((recipe.nodes ?? []).map(node => node.id));
  const materials = new Set((recipe.materials ?? []).map(material => material.id));
  const identities = new Set();
  let keyframeCount = 0;
  const tracks = input.tracks.map((track, index) => {
    knownKeys(track, ['kind', 'id', 'property', 'interpolation', 'keyframes'], 'motion track');
    if (!Object.hasOwn(PROPERTIES, track.kind) || !Object.hasOwn(PROPERTIES[track.kind], track.property)) {
      throw new RangeError('Unsupported motion target or property.');
    }
    if (track.kind === 'camera') {
      if (Object.hasOwn(track, 'id')) {
        throw new TypeError('Camera tracks cannot have an ID.');
      }
    } else {
      if (typeof track.id !== 'string' || !track.id.trim() || track.id.length > 128) {
        throw new TypeError('Motion target IDs need 1 to 128 characters.');
      }
      const references = track.kind === 'node' ? nodes : materials;
      if (!references.has(track.id)) {
        throw new RangeError(`Motion target was not found: ${track.id}.`);
      }
    }
    const identity = JSON.stringify([track.kind, track.id ?? null, track.property]);
    if (identities.has(identity)) {
      throw new RangeError('Duplicate motion target property.');
    }
    identities.add(identity);
    const interpolation = track.interpolation ?? 'LINEAR';
    if (!INTERPOLATIONS.includes(interpolation)) {
      throw new RangeError('Unsupported motion interpolation.');
    }
    denseArray(track.keyframes, 64, 'Motion keyframes');
    keyframeCount += track.keyframes.length;
    if (keyframeCount > 2048) {
      throw new RangeError('Motion exceeds 2048 total keyframes.');
    }
    const keyframes = track.keyframes.map(keyframe => normalizedKeyframe(keyframe, track, duration, interpolation));
    const clip = createAnimationClip({
      duration, loop,
      tracks: [{ target: String(index), property: coreProperty(track), interpolation, keyframes }],
    });
    const result = {
      kind: track.kind,
      property: track.property,
      interpolation,
      keyframes: clip.tracks[0].keyframes.map(keyframe => copiedKeyframe(keyframe, interpolation)),
    };
    if (track.kind !== 'camera') {
      result.id = track.id;
    }
    return result;
  });
  return { duration, loop, tracks };
}

function validateRadiance(material) {
  const emission = material.emission ?? 0;
  const color = material.emissiveColor ?? material.color ?? [0.5, 0.5, 0.5];
  for (const component of color) {
    const radiance = Math.fround(component) * Math.fround(emission);
    if (!Number.isFinite(Math.fround(radiance))) {
      throw new RangeError('Motion emissive radiance exceeds Float32 range.');
    }
    if (material.tag === 'unlit' && radiance > 65500) {
      throw new RangeError('Motion unlit radiance exceeds the HDR range.');
    }
  }
}

/** Retains published maps and vectors. A failed sample leaves them unchanged. */
export function compileAgentMotion(input, recipe) {
  const motion = normalizeAgentMotion(input, recipe);
  if (motion === null) {
    return null;
  }
  const ordinaryTracks = motion.tracks.filter(track => track.kind !== 'camera');
  const clip = createAnimationClip({
    duration: motion.duration,
    loop: motion.loop,
    tracks: ordinaryTracks.map((track, index) => ({
      target: String(index),
      property: coreProperty(track),
      interpolation: track.interpolation,
      keyframes: track.keyframes,
    })),
  });
  const sampler = compileAnimationSampler(clip);
  const output = { nodes: new Map(), materials: new Map(), camera: null };
  const bindings = ordinaryTracks.map((track, index) => {
    const patches = track.kind === 'node' ? output.nodes : output.materials;
    if (!patches.has(track.id)) {
      patches.set(track.id, {});
    }
    const patch = patches.get(track.id);
    const size = PROPERTIES[track.kind][track.property];
    patch[track.property] = size === 1 ? 0 : new Float64Array(size);
    return { track, patch, staged: sampler.tracks[index].output };
  });
  const baselines = new Map((recipe.materials ?? []).map(material => [material.id, structuredClone(material)]));
  const cameraTracks = motion.tracks.filter(track => track.kind === 'camera');
  const cameraInput = {
    ...structuredClone(CAMERA_DEFAULTS),
    ...structuredClone(recipe.camera ?? {}),
    duration: motion.duration,
    loop: motion.loop,
  };
  for (const track of cameraTracks) {
    cameraInput[track.property] = { interpolation: track.interpolation, keyframes: track.keyframes };
  }
  const cameraPath = cameraTracks.length ? createCameraPath(cameraInput) : null;
  const stagedCamera = cameraPath ? { eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3) } : null;
  if (cameraPath) {
    output.camera = {
      eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3),
      fov: 45, near: cameraInput.near, far: cameraInput.far, projection: 'perspective',
    };
  }
  const materialSamples = new Map([...output.materials.keys()].map(id => [id, { ...baselines.get(id) }]));
  return Object.freeze({
    sample(time) {
      bounded(time, 0, 3600, 'Motion sample time');
      sampler.sample(time);
      for (const { track, staged } of bindings) {
        const value = staged.length === 1 ? staged[0] : staged;
        validateValue(track.kind, track.property, value);
        if (track.kind === 'material') {
          materialSamples.get(track.id)[track.property] = value;
        }
      }
      for (const material of materialSamples.values()) {
        validateRadiance(material);
      }
      if (cameraPath) {
        cameraPath.sample(time, stagedCamera);
        for (const field of ['fov', 'near', 'far']) {
          finite(stagedCamera[field], `Camera ${field}`);
        }
        if (Math.fround(stagedCamera.fov) <= 0 || Math.fround(stagedCamera.fov) >= 180 ||
            Math.fround(stagedCamera.near) <= 0 || Math.fround(stagedCamera.far) <= Math.fround(stagedCamera.near)) {
          throw new RangeError('Sampled camera lens is invalid at Float32 precision.');
        }
      }
      // Publish only after every track, material product and camera pose passes.
      for (const { track, patch, staged } of bindings) {
        if (staged.length === 1) {
          patch[track.property] = staged[0];
        } else {
          patch[track.property].set(staged);
        }
      }
      if (cameraPath) {
        for (const field of ['eye', 'target', 'up']) {
          output.camera[field].set(stagedCamera[field]);
        }
        for (const field of ['fov', 'near', 'far']) {
          output.camera[field] = stagedCamera[field];
        }
      }
      return output;
    },
  });
}
