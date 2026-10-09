import { mat4, quat } from 'gl-matrix';

const PROPERTY_SIZES = { translation: 3, rotation: 4, scale: 3, value: 1, emission: 1, metallic: 1, roughness: 1 };
const INTERPOLATIONS = new Set(['LINEAR', 'STEP', 'SMOOTH']);

function normalizedValue(property, value) {
  const size = PROPERTY_SIZES[property];
  if (size === 1) {
    if (!Number.isFinite(value)) throw new TypeError('Numeric keyframes must be finite.');
    if (property === 'emission' && value < 0) throw new RangeError('Emission keyframes cannot be negative.');
    if (['metallic', 'roughness'].includes(property) && (value > 1 || value < 0 || property === 'roughness' && value === 0)) {
      throw new RangeError(`${property} keyframes must stay within their material range.`);
    }
    return value;
  }
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== size || !Array.from(value).every(Number.isFinite)) {
    throw new TypeError(`${property} keyframes need ${size} finite values.`);
  }
  const result = Array.from(value);
  if (property === 'rotation') {
    const length = Math.hypot(...result);
    if (length < 1e-8) throw new RangeError('Rotation keyframes cannot be zero quaternions.');
    return Object.freeze(result.map(component => component / length));
  }
  if (property === 'scale' && result.some(component => component <= 0)) throw new RangeError('Scale keyframes must stay positive.');
  return Object.freeze(result);
}

/** Keyframes are absolute local transforms. Input order does not affect sampling. */
export function createAnimationClip({ duration, loop = false, tracks = [] } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Clip duration must be positive and finite.');
  if (typeof loop !== 'boolean' || !Array.isArray(tracks)) throw new TypeError('Clip loop must be boolean and tracks must be an array.');
  const properties = new Set();
  const compiled = tracks.map(track => {
    if (!track || typeof track.target !== 'string' || !track.target.trim()) throw new TypeError('Every track needs a target name.');
    if (!Object.hasOwn(PROPERTY_SIZES, track.property)) throw new RangeError(`Unknown animation property: ${track.property}`);
    const identity = `${track.target}\u0000${track.property}`;
    if (properties.has(identity)) throw new RangeError('Each target property can have only one track.');
    properties.add(identity);
    const interpolation = track.interpolation ?? 'LINEAR';
    if (!INTERPOLATIONS.has(interpolation)) throw new RangeError(`Unknown interpolation: ${interpolation}`);
    if (!Array.isArray(track.keyframes) || !track.keyframes.length) throw new RangeError('Tracks need at least one keyframe.');
    const keyframes = track.keyframes.map(keyframe => {
      if (!keyframe || !Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > duration) {
        throw new RangeError('Keyframe times must be within the clip duration.');
      }
      return Object.freeze({ time: keyframe.time, value: normalizedValue(track.property, keyframe.value) });
    }).sort((first, second) => first.time - second.time);
    for (let index = 1; index < keyframes.length; index++) {
      if (keyframes[index].time === keyframes[index - 1].time) throw new RangeError('Keyframe times must be distinct.');
    }
    return Object.freeze({ target: track.target, property: track.property, interpolation, keyframes: Object.freeze(keyframes) });
  });
  return Object.freeze({ duration, loop, tracks: Object.freeze(compiled) });
}

function sampleTrack(track, time) {
  const keyframes = track.keyframes;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  const copy = value => typeof value === 'number' ? value : [...value];
  if (time <= first.time) return copy(first.value);
  if (time >= last.time) return copy(last.value);
  let lower = 0;
  let upper = keyframes.length - 1;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (keyframes[middle].time <= time) lower = middle;
    else upper = middle;
  }
  const start = keyframes[lower];
  const end = keyframes[upper];
  if (track.interpolation === 'STEP') return copy(start.value);
  let progress = (time - start.time) / (end.time - start.time);
  if (track.interpolation === 'SMOOTH') progress = progress * progress * (3 - 2 * progress);
  if (track.property === 'rotation') return Array.from(quat.slerp(quat.create(), start.value, end.value, progress));
  if (typeof start.value === 'number') return start.value + (end.value - start.value) * progress;
  return start.value.map((value, axis) => value + (end.value[axis] - value) * progress);
}

export function sampleAnimationClip(clip, time) {
  if (!Number.isFinite(time)) throw new TypeError('Animation time must be finite.');
  const clipTime = clip.loop ? ((time % clip.duration) + clip.duration) % clip.duration : Math.max(0, Math.min(clip.duration, time));
  return clip.tracks.map(track => ({ target: track.target, property: track.property, value: sampleTrack(track, clipTime) }));
}

/** Bind once before playback. Matrix identities and untracked initial components stay stable. */
export function createAnimationPlayer(clip, parts) {
  const namedParts = new Map();
  for (const part of parts) {
    if (namedParts.has(part.name)) throw new RangeError(`Duplicate animated part name: ${part.name}`);
    namedParts.set(part.name, part);
  }
  const bindings = new Map();
  for (const track of clip.tracks) {
    const part = namedParts.get(track.target);
    if (!part) throw new RangeError(`Animation target was not found: ${track.target}`);
    if (track.property === 'value') throw new RangeError('Value tracks are sampled directly, rather than bound to parts.');
    if (!bindings.has(track.target)) {
      if (!(part.matrix instanceof Float32Array) || part.matrix.length !== 16 || !Array.from(part.matrix).every(Number.isFinite)) {
        throw new TypeError('Animated parts need a finite Float32Array matrix.');
      }
      const translation = mat4.getTranslation(new Float32Array(3), part.matrix);
      const scale = mat4.getScaling(new Float32Array(3), part.matrix);
      if (Array.from(scale).some(value => value < 1e-8)) throw new RangeError('Animated matrices must have nonzero scale.');
      const rotationMatrix = mat4.clone(part.matrix);
      for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) rotationMatrix[column * 4 + row] /= scale[column];
      }
      if (mat4.determinant(rotationMatrix) < 0.9999) throw new RangeError('Animated matrices must use rotation and positive scale without shear.');
      const rotation = quat.normalize(quat.create(), mat4.getRotation(quat.create(), rotationMatrix));
      bindings.set(track.target, { part, translation, scale, rotation });
    }
  }
  return {
    clip,
    apply(time) {
      const sampled = sampleAnimationClip(clip, time);
      const transforms = new Map();
      for (const value of sampled) {
        const binding = bindings.get(value.target);
        if (['emission', 'metallic', 'roughness'].includes(value.property)) {
          binding.part.material = { ...binding.part.material, [value.property]: value.value };
        } else {
          if (!transforms.has(value.target)) transforms.set(value.target, { ...binding });
          transforms.get(value.target)[value.property] = value.value;
        }
      }
      for (const transform of transforms.values()) {
        mat4.fromRotationTranslationScale(transform.part.matrix, transform.rotation, transform.translation, transform.scale);
      }
      return parts;
    },
  };
}
