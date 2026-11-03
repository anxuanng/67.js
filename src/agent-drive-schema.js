// Shape checks for the `drive` entry of an asset recipe's motion and of a placed asset. Pure validation with no vehicle
// code, so the recipe normalizers and the MCP server can use it without loading the drive (agent-drive.js).

export const DRIVE_LIMITS = Object.freeze({ maxPathPoints: 512, maxLegs: 32, maxWheels: 8, maxNodeReferences: 64, maxLights: 16 });

const DRIVE_FIELDS = [
  'path', 'legs', 'speed', 'cruiseSpeed', 'acceleration', 'braking', 'startSpeed', 'endSpeed', 'maxLateralAcceleration',
  'startTime', 'steering', 'maxSteerAngle', 'fullBrakeDeceleration', 'rollGain', 'pitchGain',
  'wheels', 'body', 'forwardAxis', 'wheelbase', 'lights',
];
const NUMBER_OPTIONS = DRIVE_FIELDS.slice(2, 9).concat(['startTime', 'maxSteerAngle', 'fullBrakeDeceleration', 'rollGain', 'pitchGain', 'wheelbase']);
const WHEEL_FIELDS = ['id', 'node', 'nodes', 'side', 'axle', 'radius', 'center', 'steerable', 'spinSign'];
const LIGHT_FIELDS = ['headlights', 'tailLights'];
const HEADLIGHT_FIELDS = ['id', 'position', 'direction'];
const TAIL_LIGHT_FIELDS = ['id', 'material', 'signal', 'off', 'on'];
const CAMERA_PATH_FIELDS = ['duration', 'loop', 'eye'];

function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}. Allowed fields: ${allowed.join(', ')}.`);
  }
}

function vector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => !Number.isFinite(component))) {
    throw new TypeError(`${label} must be three finite numbers.`);
  }
  return [...value];
}

function nodeReference(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256) throw new TypeError(`${label} must be a node label or id of 1 to 256 characters.`);
  return value;
}

function normalizePath(path, label) {
  if (Array.isArray(path)) {
    if (path.length < 2 || path.length > DRIVE_LIMITS.maxPathPoints) {
      throw new RangeError(`${label} needs 2 to ${DRIVE_LIMITS.maxPathPoints} points.`);
    }
    return path.map((point, index) => vector(point, `${label} point ${index}`));
  }
  knownKeys(path, CAMERA_PATH_FIELDS, label);
  if (!path.eye || !Array.isArray(path.eye.keyframes) || path.eye.keyframes.length > DRIVE_LIMITS.maxPathPoints) {
    throw new TypeError(`${label} is an array of [x, y, z] points or a camera path { duration, eye: { keyframes } }.`);
  }
  return structuredClone(path);
}

function normalizeWheels(wheels) {
  if (wheels === 'auto') return wheels;
  if (!Array.isArray(wheels) || wheels.length < 2 || wheels.length > DRIVE_LIMITS.maxWheels) {
    throw new RangeError(`wheels is 'auto' or a list of 2 to ${DRIVE_LIMITS.maxWheels} wheels.`);
  }
  return wheels.map((wheel, index) => {
    knownKeys(wheel, WHEEL_FIELDS, `wheel ${index}`);
    const references = wheel.nodes ?? [wheel.node];
    if (!Array.isArray(references) || !references.length || references.length > DRIVE_LIMITS.maxNodeReferences) {
      throw new TypeError(`wheel ${index} needs a node, or nodes listing tire, hub and bolts.`);
    }
    references.forEach(reference => nodeReference(reference, `wheel ${index} node`));
    return structuredClone(wheel);
  });
}

function normalizeLights(lights) {
  knownKeys(lights, LIGHT_FIELDS, 'drive lights');
  const result = {};
  if (lights.headlights !== undefined) {
    if (!Array.isArray(lights.headlights) || lights.headlights.length > DRIVE_LIMITS.maxLights) throw new RangeError(`headlights lists at most ${DRIVE_LIMITS.maxLights} lamps.`);
    result.headlights = lights.headlights.map((light, index) => {
      knownKeys(light, HEADLIGHT_FIELDS, `headlight ${index}`);
      const lamp = { position: vector(light.position, `headlight ${index} position`) };
      if (light.id !== undefined) lamp.id = String(light.id);
      if (light.direction !== undefined) lamp.direction = vector(light.direction, `headlight ${index} direction`);
      return lamp;
    });
  }
  if (lights.tailLights !== undefined) {
    if (!Array.isArray(lights.tailLights) || lights.tailLights.length > DRIVE_LIMITS.maxLights) throw new RangeError(`tailLights lists at most ${DRIVE_LIMITS.maxLights} lamps.`);
    result.tailLights = lights.tailLights.map((light, index) => {
      knownKeys(light, TAIL_LIGHT_FIELDS, `tail light ${index}`);
      if (typeof light.material !== 'string' || !light.material) throw new TypeError(`tail light ${index} needs the material id whose emission it drives.`);
      if (light.signal !== 'brake' && light.signal !== 'reverse') throw new RangeError(`tail light ${index} signal must be brake or reverse.`);
      return structuredClone(light);
    });
  }
  return result;
}

/** Validate the shape of a drive entry and return its canonical JSON. Numbers are checked when the drive is built. */
export function normalizeDrive(input) {
  knownKeys(input, DRIVE_FIELDS, 'drive');
  if ((input.path === undefined) === (input.legs === undefined)) throw new TypeError('A drive needs exactly one of path or legs.');
  const result = {};
  if (input.path !== undefined) result.path = normalizePath(input.path, 'drive path');
  if (input.legs !== undefined) {
    if (!Array.isArray(input.legs) || !input.legs.length || input.legs.length > DRIVE_LIMITS.maxLegs) throw new RangeError(`legs lists 1 to ${DRIVE_LIMITS.maxLegs} legs.`);
    result.legs = input.legs.map((leg, index) => {
      knownKeys(leg, ['path', 'direction', 'pause'], `leg ${index}`);
      if (leg.direction !== undefined && leg.direction !== 'forward' && leg.direction !== 'reverse') throw new RangeError(`leg ${index} direction must be forward or reverse.`);
      return { ...structuredClone(leg), path: normalizePath(leg.path, `leg ${index} path`) };
    });
  }
  for (const field of NUMBER_OPTIONS) {
    if (input[field] !== undefined) {
      if (!Number.isFinite(input[field])) throw new TypeError(`drive ${field} must be a finite number.`);
      result[field] = input[field];
    }
  }
  if (input.steering !== undefined) {
    if (input.steering !== 'ackermann' && input.steering !== 'shared') throw new RangeError("drive steering must be 'ackermann' or 'shared'.");
    result.steering = input.steering;
  }
  if (input.forwardAxis !== undefined) {
    if (!['+x', '-x', '+z', '-z'].includes(input.forwardAxis)) throw new RangeError('drive forwardAxis must be +x, -x, +z or -z.');
    result.forwardAxis = input.forwardAxis;
  }
  if (input.wheels !== undefined) result.wheels = normalizeWheels(input.wheels);
  if (input.body !== undefined) {
    if (!Array.isArray(input.body) || !input.body.length || input.body.length > DRIVE_LIMITS.maxNodeReferences) throw new RangeError(`drive body lists 1 to ${DRIVE_LIMITS.maxNodeReferences} nodes.`);
    result.body = input.body.map(reference => nodeReference(reference, 'drive body node'));
  }
  if (input.lights !== undefined) result.lights = normalizeLights(input.lights);
  return result;
}
