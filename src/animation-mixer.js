import { mat4, quat } from 'gl-matrix';
import { compileAnimationSampler, retainAnimationMaterial } from './animation.js';

const MATERIAL_PROPERTIES = new Set(['emission', 'metallic', 'roughness']);
const MINIMUM_POSITIVE_VALUE = 1e-8;

function finiteTime(time) {
  if (!Number.isFinite(time)) throw new TypeError('Mixer times must be finite.');
  return time;
}

function validWeight(weight) {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError('Action weights must be finite and within [0, 1].');
  return weight;
}

function capturedBinding(part) {
  if (!(part.matrix instanceof Float32Array) || part.matrix.length !== 16 || !part.matrix.every(Number.isFinite)) {
    throw new TypeError('Mixer parts need finite Float32Array matrices.');
  }
  if (part.matrix[3] !== 0 || part.matrix[7] !== 0 || part.matrix[11] !== 0 || part.matrix[15] !== 1) {
    throw new RangeError('Mixer matrices must be affine transforms.');
  }
  const originalMatrix = mat4.clone(part.matrix);
  const translation = mat4.getTranslation(new Float64Array(3), originalMatrix);
  const scale = mat4.getScaling(new Float64Array(3), originalMatrix);
  if (scale.some(component => component < Math.fround(MINIMUM_POSITIVE_VALUE))) throw new RangeError('Mixer matrices need nonzero positive scale.');
  const rotationMatrix = mat4.clone(originalMatrix);
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) rotationMatrix[column * 4 + row] /= scale[column];
  }
  if (mat4.determinant(rotationMatrix) < 0.9999) throw new RangeError('Mixer matrices cannot contain shear or reflected scale.');
  const rotation = quat.normalize(new Float64Array(4), mat4.getRotation(new Float64Array(4), rotationMatrix));
  return {
    part,
    originalMatrix,
    matrix: mat4.create(),
    base: { translation, rotation, scale, material: { ...part.material } },
    translation: new Float64Array(translation),
    rotation: new Float64Array(rotation),
    scale: new Float64Array(scale),
    properties: new Map(),
    material: null,
    hasTransform: false,
    transformWeight: 0,
  };
}

function propertyBinding(binding, property) {
  const materialProperty = MATERIAL_PROPERTIES.has(property);
  let base;
  let output;
  if (materialProperty) {
    const value = binding.base.material[property] ?? (property === 'emission' ? 0 : NaN);
    if (!Number.isFinite(value) || value < 0 || property === 'metallic' && value > 1 || property === 'roughness' && (value <= 0 || value > 1)) {
      throw new RangeError(`Mixer base ${property} must stay within its material range.`);
    }
    base = new Float64Array([value]);
    output = new Float64Array(1);
  } else {
    base = binding.base[property];
    if (!base) throw new RangeError(`Unsupported mixer property: ${property}`);
    output = binding[property];
  }
  return { binding, property, base, output, materialProperty, weight: 0 };
}

function timelineState(action, time) {
  const timeline = action.timeline;
  let lower = -1;
  let upper = timeline.length;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (timeline[middle].at <= time) lower = middle;
    else upper = middle;
  }
  return lower < 0 ? action.initial : timeline[lower];
}

function effectiveWeight(state, time) {
  if (!state.playing) return 0;
  if (time >= state.fadeEnd) return state.toWeight;
  if (time <= state.at) return state.fromWeight;
  const progress = (time - state.at) / (state.fadeEnd - state.at);
  return state.fromWeight * (1 - progress) + state.toWeight * progress;
}

function controlState(action, at) {
  finiteTime(at);
  const timeline = action.timeline;
  if (timeline.length && at < timeline[timeline.length - 1].at) {
    throw new RangeError('Schedule action controls in nondecreasing time order.');
  }
  return timelineState(action, at);
}

function playState(action, { at = 0, offset = 0, timeScale = 1, weight = 1 } = {}) {
  controlState(action, at);
  finiteTime(offset);
  if (!Number.isFinite(timeScale)) throw new TypeError('Action timeScale must be finite.');
  validWeight(weight);
  return { at, playing: true, origin: at, offset, timeScale, fromWeight: weight, toWeight: weight, fadeEnd: at };
}

function fadeState(action, weight, at, duration, previous = controlState(action, at)) {
  validWeight(weight);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(at + duration) || at + duration <= at) {
    throw new RangeError('Fade duration must produce a finite end time after its start.');
  }
  if (!previous.playing) throw new RangeError('Play the action before scheduling its fade.');
  return { ...previous, at, fromWeight: effectiveWeight(previous, at), toWeight: weight, fadeEnd: at + duration };
}

function accumulate(property, sample, weight) {
  const combinedWeight = property.weight + weight;
  if (property.weight === 0) property.output.set(sample);
  else {
    const progress = weight / combinedWeight;
    if (property.property === 'rotation') quat.slerp(property.output, property.output, sample, progress);
    else {
      for (let axis = 0; axis < property.output.length; axis++) {
        property.output[axis] = property.output[axis] * (1 - progress) + sample[axis] * progress;
      }
    }
  }
  property.weight = combinedWeight;
}

function finishProperty(property) {
  const output = property.output;
  if (property.weight < 1 && property.weight > 0) {
    if (property.property === 'rotation') quat.slerp(output, property.base, output, property.weight);
    else {
      for (let axis = 0; axis < output.length; axis++) {
        output[axis] = output[axis] * property.weight + property.base[axis] * (1 - property.weight);
      }
    }
  }
  for (let axis = 0; axis < output.length; axis++) {
    if (!Number.isFinite(output[axis])) throw new RangeError('Mixed animation output must be finite.');
    if (property.property === 'scale' || property.property === 'roughness') output[axis] = Math.max(MINIMUM_POSITIVE_VALUE, output[axis]);
    if (property.property === 'emission') output[axis] = Math.max(0, output[axis]);
    if (property.property === 'metallic') output[axis] = Math.max(0, output[axis]);
    if (property.property === 'metallic' || property.property === 'roughness') output[axis] = Math.min(1, output[axis]);
  }
  if (property.property === 'rotation') {
    const length = Math.hypot(output[0], output[1], output[2], output[3]);
    if (!Number.isFinite(length) || length === 0) throw new RangeError('Mixed rotation must be a finite nonzero quaternion.');
    for (let axis = 0; axis < 4; axis++) output[axis] /= length;
  }
  if (!property.materialProperty) property.binding.transformWeight += property.weight;
}

/** Retains base poses and absolute-time control timelines for independent seeks. */
export function createAnimationMixer(parts) {
  if (!Array.isArray(parts)) throw new TypeError('Mixer parts must be an array.');
  const namedBindings = new Map();
  const bindings = [];
  for (const part of parts) {
    if (!part || typeof part.name !== 'string' || !part.name.trim()) throw new TypeError('Mixer parts need names.');
    if (namedBindings.has(part.name)) throw new RangeError(`Duplicate mixer part name: ${part.name}`);
    const binding = capturedBinding(part);
    namedBindings.set(part.name, binding);
    bindings.push(binding);
  }
  const properties = [];
  const actions = [];
  const clipActions = new Map();
  const actionRecords = new Map();
  let mixerTime = 0;

  function clipAction(clip) {
    if (clipActions.has(clip)) return clipActions.get(clip);
    const sampler = compileAnimationSampler(clip);
    const entries = [];
    const pending = [];
    for (const track of sampler.tracks) {
      const binding = namedBindings.get(track.target);
      if (!binding) throw new RangeError(`Mixer target was not found: ${track.target}`);
      if (track.property === 'value') throw new RangeError('Value tracks cannot bind to mixer parts.');
      const property = binding.properties.get(track.property) ?? propertyBinding(binding, track.property);
      if (!binding.properties.has(track.property)) pending.push(property);
      entries.push({ property, sample: track.output });
    }
    const action = {
      sampler,
      entries,
      timeline: [],
      initial: { at: -Infinity, playing: false, origin: 0, offset: 0, timeScale: 1, fromWeight: 0, toWeight: 0, fadeEnd: -Infinity },
    };
    const publicAction = Object.freeze({
      clip,
      play({ at = mixerTime, offset = 0, timeScale = 1, weight = 1 } = {}) {
        action.timeline.push(playState(action, { at, offset, timeScale, weight }));
        return publicAction;
      },
      stop(at = mixerTime) {
        const previous = controlState(action, at);
        action.timeline.push({ ...previous, at, playing: false, fromWeight: 0, toWeight: 0, fadeEnd: at });
        return publicAction;
      },
      fadeTo(weight, { at = mixerTime, duration } = {}) {
        action.timeline.push(fadeState(action, weight, at, duration));
        return publicAction;
      },
      getState(time = mixerTime) {
        finiteTime(time);
        const state = timelineState(action, time);
        let phase = 'stopped';
        if (state.playing) phase = time < state.fadeEnd ? 'fading' : 'playing';
        if (state === action.initial && action.timeline.length && action.timeline[0].playing) phase = 'scheduled';
        return {
          phase,
          playing: state.playing,
          weight: effectiveWeight(state, time),
          localTime: state.playing ? (time - state.origin) * state.timeScale + state.offset : null,
        };
      },
    });
    // Registration validates every target before publishing bindings or material copies.
    for (const property of pending) {
      const binding = property.binding;
      binding.properties.set(property.property, property);
      properties.push(property);
      if (property.materialProperty) {
        if (!binding.material) {
          binding.material = retainAnimationMaterial(binding.part);
        }
      } else binding.hasTransform = true;
    }
    actions.push(action);
    clipActions.set(clip, publicAction);
    actionRecords.set(publicAction, action);
    return publicAction;
  }

  const mixer = {
    clipAction,
    get time() { return mixerTime; },
    crossFade(from, to, { at = mixerTime, duration } = {}) {
      const source = actionRecords.get(from);
      const destination = actionRecords.get(to);
      if (!source || !destination || source === destination) throw new RangeError('Crossfade needs two distinct actions from this mixer.');
      const sourceState = fadeState(source, 0, at, duration);
      const previous = controlState(destination, at);
      const destinationStart = previous.playing ? previous : playState(destination, { at, weight: 0 });
      const destinationState = fadeState(destination, 1, at, duration, destinationStart);
      source.timeline.push(sourceState);
      destination.timeline.push(destinationState);
      return mixer;
    },
    apply(time) {
      finiteTime(time);
      for (let index = 0; index < properties.length; index++) {
        const property = properties[index];
        property.output.set(property.base);
        property.weight = 0;
      }
      for (let index = 0; index < bindings.length; index++) bindings[index].transformWeight = 0;
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        const state = timelineState(action, time);
        const weight = effectiveWeight(state, time);
        if (weight === 0) continue;
        action.sampler.sample((time - state.origin) * state.timeScale + state.offset);
        for (let trackIndex = 0; trackIndex < action.entries.length; trackIndex++) {
          const entry = action.entries[trackIndex];
          accumulate(entry.property, entry.sample, weight);
        }
      }
      for (let index = 0; index < properties.length; index++) finishProperty(properties[index]);
      for (let index = 0; index < bindings.length; index++) {
        const binding = bindings[index];
        if (!binding.hasTransform) continue;
        if (binding.transformWeight === 0) binding.matrix.set(binding.originalMatrix);
        else mat4.fromRotationTranslationScale(binding.matrix, binding.rotation, binding.translation, binding.scale);
        for (let component = 0; component < 16; component++) {
          if (!Number.isFinite(binding.matrix[component])) throw new RangeError('Mixed matrix exceeds the finite Float32 range.');
        }
      }
      // Scene writes and mixer time change only after every output passes validation.
      for (let index = 0; index < properties.length; index++) {
        const property = properties[index];
        if (property.materialProperty) property.binding.material[property.property] = property.output[0];
      }
      for (let index = 0; index < bindings.length; index++) {
        const binding = bindings[index];
        if (binding.hasTransform) binding.part.matrix.set(binding.matrix);
      }
      mixerTime = time;
      return parts;
    },
  };
  return mixer;
}
