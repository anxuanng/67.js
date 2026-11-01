import { createTracer } from './ray-query.js';
import {
  MAX_BAKE_PARTS, averageMapColor, buildWorld, createDirectIrradiance, createGatherer, emittedRadiance, hitNormal, normalizeLights, sceneScale, validatePart, withReach,
} from './light-bake.js';

// The half of reflection probes that needs no GPU and no renderer: validating a probe list, placing the automatic probe
// and tracing the maps. It is pure data in and out, so a bake worker can run it. reflection-probes.js turns the traces
// into maps and gives parts their probe.

export const MAXIMUM_PROBES = 4;
export const PROBE_MAP_WIDTH = 64;
// An automatic probe is only worth placing in a room: below this share of rays hitting a part the scene is open air.
export const ENCLOSED_HIT_FRACTION = 0.9;
const PROBE_SAMPLES = 32;
const PROBE_BOUNCES = 2;

const MAX_PROBE_PIXELS = 65536;

// A metal part has no diffuse albedo, but a probe that showed it black would hide the one thing a reflection is for.
function probeAlbedo(material) {
  const metallic = material.metallic ?? 0;
  const keep = 1 - metallic * 0.5;
  const mapAverage = averageMapColor(material.map);
  return material.color.map((channel, index) => Math.max(channel, 0) * keep * mapAverage[index]);
}

/**
 * The radiance seen from each probe position, as one equirectangular map per probe (rows from straight up, the centre
 * looking toward -Z, the layout of `createEnvironmentMap`). A ray that hits a part returns its emission plus the direct
 * light and the bounced light it receives, shaded as the bake shades a texel; a ray that leaves the scene returns
 * `missRadiance(direction, out)`. `rotation` stores the map the way an environment of that rotation expects it, so a
 * lookup that applies the rotation finds the true direction. Returns `{ data, width, height, hitFraction }` for each
 * probe; the same input gives the same bytes.
 */
export function traceProbeMaps(parts, lighting, positions, { width = 64, samples = 32, bounces = 2, rotation = 0, missRadiance = null, maxSeconds = 60 } = {}) {
  const height = width / 2;
  if (!Number.isInteger(width) || width < 8 || width * height > MAX_PROBE_PIXELS) throw new RangeError(`Probe width must be an even integer from 8 whose map has at most ${MAX_PROBE_PIXELS} pixels.`);
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_BAKE_PARTS) throw new RangeError(`Probes take from 1 to ${MAX_BAKE_PARTS} parts.`);
  parts.forEach(validatePart);
  const lights = normalizeLights(lighting);
  const world = buildWorld(parts);
  const scale = sceneScale(world.positions);
  const offset = scale * 1e-4;
  const tracer = createTracer(world);
  const directIrradiance = createDirectIrradiance(tracer, withReach(lights, parts), offset, scale);
  const albedoOfPart = parts.map(part => probeAlbedo(part.material));
  const emissionOfPart = parts.map(part => emittedRadiance(part.material));
  const gather = createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples, bounces });
  const started = performance.now();
  const rotationCosine = Math.cos(rotation);
  const rotationSine = Math.sin(rotation);
  const direction = [0, 0, 0];
  const point = [0, 0, 0];
  const normal = [0, 0, 0];
  const bounced = [0, 0, 0];
  const missed = [0, 0, 0];
  return positions.map((position, probeIndex) => {
    const data = new Float32Array(width * height * 3);
    let hits = 0;
    for (let row = 0; row < height; row++) {
      const polar = (row + 0.5) / height * Math.PI;
      for (let column = 0; column < width; column++) {
        if (performance.now() - started > maxSeconds * 1000) throw new Error(`Probe trace passed maxSeconds (${maxSeconds}).`);
        const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
        const mappedX = Math.sin(polar) * Math.sin(azimuth);
        const mappedZ = -Math.sin(polar) * Math.cos(azimuth);
        direction[0] = rotationCosine * mappedX + rotationSine * mappedZ;
        direction[1] = Math.cos(polar);
        direction[2] = -rotationSine * mappedX + rotationCosine * mappedZ;
        const target = (row * width + column) * 3;
        const hit = tracer.trace(position[0], position[1], position[2], direction[0], direction[1], direction[2], Infinity, false);
        if (hit.nearestTriangle < 0) {
          if (missRadiance) {
            missRadiance(direction, missed);
            data.set(missed, target);
          }
          continue;
        }
        hits++;
        for (let axis = 0; axis < 3; axis++) point[axis] = position[axis] + direction[axis] * hit.nearestDistance;
        hitNormal(world, hit.nearestTriangle, direction, normal);
        const owner = world.triangleOwner[hit.nearestTriangle];
        const direct = directIrradiance(point, normal, owner);
        gather(point, normal, (probeIndex + 7777) * 1_000_003 + row * width + column, bounced);
        for (let channel = 0; channel < 3; channel++) {
          data[target + channel] = emissionOfPart[owner][channel] + albedoOfPart[owner][channel] * (direct[channel] / Math.PI + bounced[channel]);
        }
      }
    }
    return { data, width, height, hitFraction: hits / (width * height) };
  });
}

/** Validates the probe list of a recipe: up to MAXIMUM_PROBES of `{ position, radius? }`. */
export function normalizeProbeList(list) {
  if (!Array.isArray(list) || list.length > MAXIMUM_PROBES) {
    throw new RangeError(`bake.probes must be false or a list of at most ${MAXIMUM_PROBES} probes.`);
  }
  return list.map((probe, index) => {
    const label = `bake.probes[${index}]`;
    const validPosition = Array.isArray(probe?.position) && probe.position.length === 3 && probe.position.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6);
    if (!validPosition) {
      throw new TypeError(`${label} needs position [x, y, z].`);
    }
    for (const key of Object.keys(probe)) {
      if (key !== 'position' && key !== 'radius') {
        throw new TypeError(`${label} has an unknown field ${key}; use position and radius.`);
      }
    }
    if (probe.radius !== undefined && !(Number.isFinite(probe.radius) && probe.radius > 0 && probe.radius <= 1e6)) {
      throw new RangeError(`${label}.radius must be a number above 0.`);
    }
    return { position: [...probe.position], ...(probe.radius === undefined ? {} : { radius: probe.radius }) };
  });
}

export function worldBounds(part) {
  const { positions } = part.geometry;
  const { matrix } = part;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { minimum, maximum };
}

export function boundsCentre({ minimum, maximum }) {
  return minimum.map((value, axis) => (value + maximum[axis]) / 2);
}

/** The probe a room gets by default: the middle of the parts' bounds, reaching every corner of it. */
export function roomCentreProbe(parts) {
  const total = { minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity] };
  for (const part of parts) {
    const bounds = worldBounds(part);
    for (let axis = 0; axis < 3; axis++) {
      total.minimum[axis] = Math.min(total.minimum[axis], bounds.minimum[axis]);
      total.maximum[axis] = Math.max(total.maximum[axis], bounds.maximum[axis]);
    }
  }
  const diagonal = Math.hypot(...total.maximum.map((value, axis) => value - total.minimum[axis]));
  return { position: boundsCentre(total), radius: diagonal / 2 };
}

// A ray that leaves the scene reads the environment map the scene is lit by, turned the way the renderer turns it.
function environmentMissRadiance(map) {
  const cosine = Math.cos(map.rotation);
  const sine = Math.sin(map.rotation);
  return (direction, out) => {
    const mappedX = cosine * direction[0] - sine * direction[2];
    const mappedZ = sine * direction[0] + cosine * direction[2];
    const column = Math.min(map.width - 1, Math.floor((Math.atan2(mappedX, -mappedZ) / (2 * Math.PI) + 0.5) * map.width));
    const row = Math.min(map.height - 1, Math.floor(Math.acos(Math.min(Math.max(direction[1], -1), 1)) / Math.PI * map.height));
    const offset = (row * map.width + column) * map.channels;
    for (let channel = 0; channel < 3; channel++) {
      out[channel] = map.data[offset + channel] * map.intensity;
    }
  };
}

function skyMissRadiance(environment) {
  const bottom = environment.skyBottom ?? [0.62, 0.70, 0.67];
  const top = environment.skyTop ?? [0.20, 0.38, 0.52];
  return (direction, out) => {
    const blend = Math.min(Math.max((direction[1] + 0.15) / 0.85, 0), 1);
    const smooth = blend * blend * (3 - 2 * blend);
    for (let channel = 0; channel < 3; channel++) {
      out[channel] = bottom[channel] + (top[channel] - bottom[channel]) * smooth;
    }
  };
}

/**
 * Traces the probes of `specs`: a list of `{ position, radius? }` (a missing radius reaches the whole scene), or
 * `'room'` for one probe in the middle of the parts, kept only when the scene is enclosed. `parts` need world `matrix`
 * values. Returns `{ traced, automatic, requested, skipped, seconds }`, where each traced probe holds its position,
 * radius, equirectangular `data` and the share of rays that hit a part. The same input gives the same bytes.
 */
export function traceProbes(parts, lighting, specs, options = {}) {
  const { environment = {}, environmentMap = null, rotation = 0, samples = PROBE_SAMPLES, bounces = PROBE_BOUNCES, maxSeconds = 60 } = options;
  const automatic = specs === 'room';
  const requested = automatic ? [roomCentreProbe(parts)] : normalizeProbeList(specs);
  const sceneRadius = roomCentreProbe(parts).radius * 2;
  const started = performance.now();
  const positions = requested.map(probe => probe.position);
  const maps = requested.length === 0 ? [] : traceProbeMaps(parts, lighting, positions, { width: PROBE_MAP_WIDTH, samples, bounces, rotation, missRadiance: environmentMap ? environmentMissRadiance(environmentMap) : skyMissRadiance(environment), maxSeconds });
  const traced = [];
  requested.forEach((spec, index) => {
    if (automatic && maps[index].hitFraction < ENCLOSED_HIT_FRACTION) {
      return;
    }
    traced.push({ position: spec.position, radius: spec.radius ?? sceneRadius, ...maps[index] });
  });
  return {
    traced,
    automatic,
    requested: requested.length,
    skipped: automatic && traced.length === 0 ? 'open scene: under 90 percent of rays from the room centre hit a part' : null,
    seconds: (performance.now() - started) / 1000,
  };
}
