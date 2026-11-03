// Named easing curves for keyframe segments. The formulas are Blender's (Graph Editor, F-Curve easing), written for a
// segment that runs from progress 0 to 1, so a name gives the same value as the same Blender easing on a one-unit change.
// `cubic-bezier(x1, y1, x2, y2)` follows the CSS definition.

const FAMILIES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ', 'Back', 'Bounce', 'Elastic'];
const DIRECTIONS = ['In', 'Out', 'InOut'];

const BACK_IN_OUT_FACTOR = 1.525;
const FULL_TURN = 2 * Math.PI;
const BEZIER_NEWTON_STEPS = 8;
const BEZIER_BISECTION_STEPS = 48;
const BEZIER_PRECISION = 1e-7;

export const EASING_NAMES = Object.freeze(['linear', ...FAMILIES.flatMap(family => DIRECTIONS.map(direction => `ease${direction}${family}`))]);
const NAME_SET = new Set(EASING_NAMES);
const NAME_BY_LOWERCASE = new Map(EASING_NAMES.map(name => [name.toLowerCase(), name]));
// A name, optionally followed by comma separated numbers in parentheses.
const EASING_PATTERN = /^([A-Za-z][A-Za-z-]*)\s*(?:\(([^()]*)\))?$/;
const BEZIER_X_BOUNDS = [0, 1];
const BEZIER_Y_BOUNDS = [-4, 5];

// Back takes an overshoot, as easeOutBack(3). Elastic takes an amplitude (a multiple of the change) and a period (a
// fraction of the segment), as easeOutElastic(1.5, 0.4). Blender stores both in absolute units; over a one-unit change in
// one frame they are the same numbers.
const PARAMETERS_BY_FAMILY = {
  Back: [{ name: 'overshoot', bounds: [0, 10], fallback: () => 1.70158 }],
  Elastic: [
    { name: 'amplitude', bounds: [1, 10], fallback: () => 1 },
    { name: 'period', bounds: [0.05, 2], fallback: direction => (direction === 'InOut' ? 0.45 : 0.3) },
  ],
};

export const EASING_HELP = 'linear, cubic-bezier(x1, y1, x2, y2), or ease<In|Out|InOut><Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Bounce|Elastic>, such as easeOutBack; Back takes (overshoot) and Elastic (amplitude, period)';

function powerIn(exponent) {
  return progress => progress ** exponent;
}

function powerOut(exponent) {
  return progress => 1 - (1 - progress) ** exponent;
}

function powerInOut(exponent) {
  return progress => {
    if (progress < 0.5) return 2 ** (exponent - 1) * progress ** exponent;
    return 1 - (-2 * progress + 2) ** exponent / 2;
  };
}

// Blender 5.2 rescales 2^(10x) so the curve runs exactly from 0 to 1.
const EXPONENTIAL_FLOOR = 2 ** -10;
const EXPONENTIAL_SCALE = 1 - EXPONENTIAL_FLOOR;

function exponentialIn(progress) {
  return (2 ** (10 * (progress - 1)) - EXPONENTIAL_FLOOR) / EXPONENTIAL_SCALE;
}

function exponentialOut(progress) {
  return (1 - 2 ** (-10 * progress)) / EXPONENTIAL_SCALE;
}

function bounceOut(progress) {
  if (progress < 1 / 2.75) return 7.5625 * progress * progress;
  if (progress < 2 / 2.75) {
    const shifted = progress - 1.5 / 2.75;
    return 7.5625 * shifted * shifted + 0.75;
  }
  if (progress < 2.5 / 2.75) {
    const shifted = progress - 2.25 / 2.75;
    return 7.5625 * shifted * shifted + 0.9375;
  }
  const shifted = progress - 2.625 / 2.75;
  return 7.5625 * shifted * shifted + 0.984375;
}

function elasticDecay(shifted, amplitude, period, phase) {
  return amplitude * 2 ** (10 * shifted) * Math.sin((shifted - phase) * FULL_TURN / period);
}

function elasticPhase(amplitude, period) {
  return period / FULL_TURN * Math.asin(1 / amplitude);
}

const FAMILY_CURVES = {
  Sine: {
    In: progress => 1 - Math.cos(progress * Math.PI / 2),
    Out: progress => Math.sin(progress * Math.PI / 2),
    InOut: progress => -(Math.cos(Math.PI * progress) - 1) / 2,
  },
  Quad: { In: powerIn(2), Out: powerOut(2), InOut: powerInOut(2) },
  Cubic: { In: powerIn(3), Out: powerOut(3), InOut: powerInOut(3) },
  Quart: { In: powerIn(4), Out: powerOut(4), InOut: powerInOut(4) },
  Quint: { In: powerIn(5), Out: powerOut(5), InOut: powerInOut(5) },
  Expo: {
    In: exponentialIn,
    Out: exponentialOut,
    InOut: progress => (progress < 0.5 ? exponentialIn(2 * progress) / 2 : 0.5 + exponentialOut(2 * progress - 1) / 2),
  },
  Circ: {
    In: progress => 1 - Math.sqrt(1 - progress * progress),
    Out: progress => Math.sqrt(1 - (progress - 1) ** 2),
    InOut: progress => {
      if (progress < 0.5) return -0.5 * (Math.sqrt(1 - (2 * progress) ** 2) - 1);
      return 0.5 * (Math.sqrt(1 - (2 * progress - 2) ** 2) + 1);
    },
  },
  Bounce: {
    In: progress => 1 - bounceOut(1 - progress),
    Out: bounceOut,
    InOut: progress => (progress < 0.5 ? (1 - bounceOut(1 - 2 * progress)) / 2 : bounceOut(2 * progress - 1) / 2 + 0.5),
  },
};

function backCurve(direction, overshoot) {
  if (direction === 'In') return progress => progress * progress * ((overshoot + 1) * progress - overshoot);
  if (direction === 'Out') {
    return progress => {
      const shifted = progress - 1;
      return shifted * shifted * ((overshoot + 1) * shifted + overshoot) + 1;
    };
  }
  const scaled = overshoot * BACK_IN_OUT_FACTOR;
  return progress => {
    const doubled = progress * 2;
    if (doubled < 1) return 0.5 * doubled * doubled * ((scaled + 1) * doubled - scaled);
    const shifted = doubled - 2;
    return 0.5 * (shifted * shifted * ((scaled + 1) * shifted + scaled) + 2);
  };
}

function elasticCurve(direction, amplitude, period) {
  const phase = elasticPhase(amplitude, period);
  const easeIn = progress => {
    if (progress === 0) return 0;
    if (progress === 1) return 1;
    return -elasticDecay(progress - 1, amplitude, period, phase);
  };
  // Blender 5.2 builds out and in-out by mirroring the in curve.
  if (direction === 'In') return easeIn;
  if (direction === 'Out') return progress => 1 - easeIn(1 - progress);
  return progress => (progress < 0.5 ? easeIn(2 * progress) / 2 : 1 - easeIn(2 * (1 - progress)) / 2);
}

function bezierCurve(x1, y1, x2, y2) {
  const coordinate = (first, second, parameter) => {
    const inverse = 1 - parameter;
    return 3 * inverse * inverse * parameter * first + 3 * inverse * parameter * parameter * second + parameter ** 3;
  };
  const slope = parameter => {
    const inverse = 1 - parameter;
    return 3 * inverse * inverse * x1 + 6 * inverse * parameter * (x2 - x1) + 3 * parameter * parameter * (1 - x2);
  };
  return progress => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    let parameter = progress;
    for (let step = 0; step < BEZIER_NEWTON_STEPS; step++) {
      const error = coordinate(x1, x2, parameter) - progress;
      if (Math.abs(error) < BEZIER_PRECISION) return coordinate(y1, y2, parameter);
      const derivative = slope(parameter);
      if (Math.abs(derivative) < 1e-6) break;
      parameter -= error / derivative;
    }
    let low = 0;
    let high = 1;
    parameter = progress;
    for (let step = 0; step < BEZIER_BISECTION_STEPS; step++) {
      if (coordinate(x1, x2, parameter) < progress) low = parameter;
      else high = parameter;
      parameter = (low + high) / 2;
    }
    return coordinate(y1, y2, parameter);
  };
}

function finiteWithin(value, bounds, label) {
  if (!Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
    throw new RangeError(`${label} must be a number from ${bounds[0]} to ${bounds[1]}.`);
  }
  return value;
}

function unknownEasing(name) {
  const base = typeof name === 'string' ? name.replace(/\(.*$/s, '').trim() : undefined;
  const suggestion = base === undefined ? undefined : NAME_BY_LOWERCASE.get(base.toLowerCase());
  const hint = suggestion ? ` Did you mean ${suggestion}?` : '';
  return new RangeError(`Unknown easing ${JSON.stringify(name)}.${hint} Use ${EASING_HELP}.`);
}

function splitName(name) {
  const direction = DIRECTIONS.find(candidate => name.startsWith(`ease${candidate}`) && FAMILIES.includes(name.slice(4 + candidate.length)));
  return { direction, family: name.slice(4 + direction.length) };
}

function numbersFrom(argumentText, name) {
  if (argumentText.trim() === '') return [];
  return argumentText.split(',').map(part => {
    const value = Number(part);
    if (part.trim() === '' || !Number.isFinite(value)) throw new RangeError(`${name} arguments must be finite numbers; got ${JSON.stringify(part.trim())}.`);
    return value;
  });
}

function bezierFrom(name, numbers) {
  if (numbers.length !== 4) throw new RangeError(`${name} needs four numbers: cubic-bezier(x1, y1, x2, y2).`);
  const [x1, y1, x2, y2] = numbers;
  finiteWithin(x1, BEZIER_X_BOUNDS, 'cubic-bezier x1');
  finiteWithin(x2, BEZIER_X_BOUNDS, 'cubic-bezier x2');
  finiteWithin(y1, BEZIER_Y_BOUNDS, 'cubic-bezier y1');
  finiteWithin(y2, BEZIER_Y_BOUNDS, 'cubic-bezier y2');
  return bezierCurve(x1, y1, x2, y2);
}

function namedCurveFrom(name, numbers) {
  const { direction, family } = splitName(name);
  const allowed = PARAMETERS_BY_FAMILY[family] ?? [];
  if (numbers.length > allowed.length) {
    const usage = allowed.length ? `${name}(${allowed.map(parameter => parameter.name).join(', ')})` : name;
    throw new RangeError(`${name} takes ${allowed.length ? `at most ${allowed.length} argument${allowed.length > 1 ? 's' : ''}` : 'no arguments'}: ${usage}.`);
  }
  const [first, second] = allowed.map((parameter, index) => (numbers[index] === undefined ? parameter.fallback(direction) : finiteWithin(numbers[index], parameter.bounds, `${name} ${parameter.name}`)));
  if (family === 'Back') return backCurve(direction, first);
  if (family === 'Elastic') return elasticCurve(direction, first, second);
  return FAMILY_CURVES[family][direction];
}

/** Compiles an easing string to a function from segment progress to eased progress, or throws a RangeError that says what is valid. */
export function parseEasing(text) {
  const match = typeof text === 'string' ? EASING_PATTERN.exec(text.trim()) : null;
  if (!match) throw unknownEasing(text);
  const name = match[1];
  const hasArguments = match[2] !== undefined;
  if (name === 'cubic-bezier') {
    if (!hasArguments) throw unknownEasing(text);
    return bezierFrom(name, numbersFrom(match[2], name));
  }
  if (!NAME_SET.has(name)) throw unknownEasing(text);
  if (name === 'linear') {
    if (hasArguments) throw new RangeError('linear takes no arguments.');
    return progress => progress;
  }
  return namedCurveFrom(name, hasArguments ? numbersFrom(match[2], name) : []);
}

/** Validates a keyframe's easing and returns the field to store ({ easing }), or undefined for a keyframe without one. */
export function normalizeKeyframeEasing(keyframe) {
  if (keyframe.easing === undefined) return undefined;
  parseEasing(keyframe.easing);
  return { easing: keyframe.easing.trim() };
}

const compiledByKeyframe = new WeakMap();

/** Maps linear segment progress (0 to 1) through the easing stored on a normalized keyframe. */
export function easedProgress(keyframe, progress) {
  let curve = compiledByKeyframe.get(keyframe);
  if (!curve) {
    curve = parseEasing(keyframe.easing);
    compiledByKeyframe.set(keyframe, curve);
  }
  return curve(progress);
}
