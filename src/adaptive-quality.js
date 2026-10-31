// GPU frame timing and adaptive resolution for live viewing (issue 37).
//
// Adaptive resolution trades picture size for speed, so it must never touch an export: a viewer builds one only
// when it is not exporting, and `createAdaptiveResolution` refuses to build one otherwise.

const GPU_TIMER_EXTENSION = 'EXT_disjoint_timer_query_webgl2';
const NANOSECONDS_PER_MILLISECOND = 1e6;

/**
 * Times the GPU work between `begin()` and `end()`. A result arrives a few frames later, so `milliseconds` holds
 * the latest finished measurement (null until the first one). Returns null when the browser has no timer queries.
 */
export function createGpuTimer(context) {
  const extension = context.getExtension(GPU_TIMER_EXTENSION);
  if (!extension) return null;
  const pending = [];
  let active = false;
  const timer = {
    milliseconds: null,
    begin() {
      if (active) return;
      const query = context.createQuery();
      context.beginQuery(extension.TIME_ELAPSED_EXT, query);
      pending.push(query);
      active = true;
    },
    end() {
      if (!active) return;
      context.endQuery(extension.TIME_ELAPSED_EXT);
      active = false;
    },
    collect() {
      const disjoint = context.getParameter(extension.GPU_DISJOINT_EXT);
      // The newest query is still open while a measurement is running, and cannot be read yet.
      while (pending.length > (active ? 1 : 0)) {
        const query = pending[0];
        if (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) break;
        if (!disjoint) timer.milliseconds = context.getQueryParameter(query, context.QUERY_RESULT) / NANOSECONDS_PER_MILLISECOND;
        context.deleteQuery(query);
        pending.shift();
      }
      if (disjoint) timer.milliseconds = null;
      return timer.milliseconds;
    },
    dispose() {
      if (active) context.endQuery(extension.TIME_ELAPSED_EXT);
      pending.forEach(query => context.deleteQuery(query));
      pending.length = 0;
      active = false;
    },
  };
  return timer;
}

/**
 * Chooses a resolution scale between `minimumScale` and 1 from measured frame times. It lowers the scale a step
 * when the average of the last `window` frames is over `targetMilliseconds`, and raises it a step only after the
 * average has stayed under `raiseBelow` of the target for `window` frames, so the size does not flicker. The scale
 * only takes values on the grid of `step`, and never falls under `minimumScale`.
 */
export class AdaptiveResolution {
  constructor({ targetMilliseconds = 1000 / 60, minimumScale = 0.5, step = 0.125, window = 20, raiseBelow = 0.6 } = {}) {
    if (!(targetMilliseconds > 0)) throw new RangeError('targetMilliseconds must be above 0.');
    if (!(minimumScale > 0) || minimumScale > 1) throw new RangeError('minimumScale must be above 0 and at most 1.');
    if (!(step > 0) || step >= 1) throw new RangeError('step must be above 0 and below 1.');
    if (!Number.isInteger(window) || window < 1) throw new RangeError('window must be a whole number of frames.');
    this.targetMilliseconds = targetMilliseconds;
    this.minimumScale = minimumScale;
    this.step = step;
    this.window = window;
    this.raiseBelow = raiseBelow;
    this.scale = 1;
    this.recent = [];
  }

  /** Adds a frame time and returns the scale to use for the next frame. */
  update(frameMilliseconds) {
    if (!Number.isFinite(frameMilliseconds) || frameMilliseconds < 0) return this.scale;
    this.recent.push(frameMilliseconds);
    if (this.recent.length < this.window) return this.scale;
    const average = this.recent.reduce((total, value) => total + value, 0) / this.recent.length;
    this.recent.length = 0;
    if (average > this.targetMilliseconds) this.scale = Math.max(this.minimumScale, this.scale - this.step);
    else if (average < this.targetMilliseconds * this.raiseBelow) this.scale = Math.min(1, this.scale + this.step);
    return this.scale;
  }
}

/** The adaptive resolution for a live viewer; throws when the viewer is exporting, because exports keep full quality. */
export function createAdaptiveResolution({ exporting, ...options }) {
  if (exporting) throw new Error('Adaptive resolution never applies to an export.');
  return new AdaptiveResolution(options);
}
