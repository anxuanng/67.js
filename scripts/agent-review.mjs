export const REVIEW_LIMITS = Object.freeze({ minimumShots: 1, maximumShots: 4,
  minimumDimension: 64, maximumDimension: 480, defaultWidth: 384, defaultHeight: 384,
  labelHeight: 24, maximumLabelLength: 48, maximumGridWidth: 960, maximumGridHeight: 1008,
  maximumImageBytes: 1024 * 1024, maximumPendingFrames: 1 });

function fields(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TypeError(`Invalid or unknown ${name} fields.`);
  }
}

function clock(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new RangeError(`${name} must be finite and within zero and 3600.`);
  }
  return value;
}

/** Validate before leasing the source renderer. Camera relationships use the sampled pose. */
export function normalizeReview(input) {
  fields(input, ['sessionId', 'expectedRevision', 'width', 'height', 'shots'], 'review');
  if (typeof input.sessionId !== 'string' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError('Review requires a sessionId and a safe nonnegative expectedRevision.');
  }
  const width = input.width === undefined ? REVIEW_LIMITS.defaultWidth : input.width;
  const height = input.height === undefined ? REVIEW_LIMITS.defaultHeight : input.height;
  if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 480)) {
    throw new RangeError('Review dimensions must be integers from 64 to 480.');
  }
  if (!Array.isArray(input.shots) || input.shots.length < 1 || input.shots.length > 4) {
    throw new RangeError('Review requires one to four shots.');
  }
  const shots = input.shots.map((shot, index) => {
    fields(shot, ['label', 'camera', 'animation', 'motionTime', 'rendererTime'], 'shot');
    if (shot.label !== undefined && (typeof shot.label !== 'string' || shot.label.length > 48)) {
      throw new TypeError('Shot label must be a string of at most 48 characters.');
    }
    if (shot.camera !== undefined) {
      fields(shot.camera, ['eye', 'target', 'up', 'fov', 'near', 'far'], 'camera');
      for (const [field, value] of Object.entries(shot.camera)) {
        const components = ['eye', 'target', 'up'].includes(field) ? value : [value];
        if (!Array.isArray(components) || components.length !== (['eye', 'target', 'up'].includes(field) ? 3 : 1) ||
            !components.every(component => Number.isFinite(component) && Number.isFinite(Math.fround(component)))) {
          throw new RangeError('Shot camera must contain finite Float32 values.');
        }
      }
    }
    if (shot.animation !== undefined) {
      fields(shot.animation, ['clip', 'time'], 'animation');
      if (!Number.isSafeInteger(shot.animation.clip) || shot.animation.clip < 0) throw new RangeError('Invalid animation clip.');
      clock(shot.animation.time, 'Animation time');
    }
    const motionTime = shot.motionTime ?? null;
    if (motionTime !== null) clock(motionTime, 'Motion time');
    return { label: shot.label ?? `View ${index + 1}`,
      ...(shot.camera === undefined ? {} : { camera: structuredClone(shot.camera) }),
      ...(shot.animation === undefined ? {} : { animation: structuredClone(shot.animation) }),
      motionTime, rendererTime: clock(shot.rendererTime === undefined ? 0 : shot.rendererTime, 'Renderer time') };
  });
  const columns = shots.length > 1 ? 2 : 1;
  return { sessionId: input.sessionId, expectedRevision: input.expectedRevision, width, height, shots,
    gridWidth: width * columns, gridHeight: (height + REVIEW_LIMITS.labelHeight) * Math.ceil(shots.length / columns), columns };
}
