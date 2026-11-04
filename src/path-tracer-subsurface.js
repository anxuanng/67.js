import { buildFrame } from './path-tracer-shading.js';
import { subsurfaceUniformValues } from './subsurface-limits.js';

// Subsurface scattering for the path tracer, after the Random Walk model of Blender's Principled BSDF: light that enters
// a part walks through it with an isotropic phase function and per-channel mean free path (radius times scale, in metres),
// and leaves where the walk meets the part's own surface. A walk is capped at SUBSURFACE_WALK_STEPS scattering events, so a
// path never runs unbounded; a walk that hits the cap ends its path, which only removes light.

export const SUBSURFACE_WALK_STEPS = 32;
const MINIMUM_FREE_PATH = 1e-6;
const CHANNELS = 3;

export const WALK_OUTCOME = Object.freeze({ exit: 0, thin: 1, lost: 2 });

/** The traced form of a material's subsurface block: null when the weight is 0, so those parts take the unchanged code path. */
export function resolveTraceSubsurface(block) {
  if (!block || !(block.weight > 0)) return null;
  const [weight, ...rest] = subsurfaceUniformValues(block);
  const meanFreePath = rest.slice(0, CHANNELS).map(length => Math.max(length, MINIMUM_FREE_PATH));
  const color = rest[CHANNELS] < 0 ? null : rest.slice(CHANNELS, CHANNELS * 2);
  return { weight, meanFreePath, color };
}

/**
 * Single scattering albedo whose multiple scattering result is the wanted colour (Chiang, Bitterli and others, "Practical
 * and controllable subsurface scattering for production path tracing", the fit Cycles uses). 0 maps to 0 and 1 maps to 1.
 */
export function singleScatterAlbedo(multipleScatterAlbedo) {
  const albedo = Math.min(1, Math.max(0, multipleScatterAlbedo));
  const root = Math.sqrt(9.59217 + 41.6808 * albedo + 17.7126 * albedo * albedo);
  const offset = 4.09712 + 4.20863 * albedo - root;
  return Math.min(1, Math.max(0, 1 - offset * offset));
}

/**
 * Builds the walk for one tracer. `intersect(scene, origin, direction, hit)` is the tracer's nearest-hit query and `random.next()`
 * its random stream. The returned function starts at a surface point, walks inward from it, and reports how it ended:
 * exit (the exit hit is in `exitHit`, and `weight` was multiplied by the walk's throughput), thin (nothing of this part lies
 * behind the point, so the part is a card and the caller transmits through it) or lost (the walk ended inside).
 */
export function createRandomWalk(scene, random, intersect) {
  const frame = new Float64Array(9);
  const position = new Float64Array(3);
  const direction = new Float64Array(3);
  const extinction = new Float64Array(CHANNELS);
  const albedo = new Float64Array(CHANNELS);

  function pickInwardDirection(normal) {
    const radius = Math.sqrt(random.next());
    const angle = 2 * Math.PI * random.next();
    const height = Math.sqrt(Math.max(0, 1 - radius * radius));
    buildFrame(normal, frame);
    const across = radius * Math.cos(angle);
    const along = radius * Math.sin(angle);
    for (let axis = 0; axis < 3; axis++) direction[axis] = frame[axis] * across + frame[3 + axis] * along - normal[axis] * height;
  }

  function pickScatterDirection() {
    const height = 2 * random.next() - 1;
    const angle = 2 * Math.PI * random.next();
    const ring = Math.sqrt(Math.max(0, 1 - height * height));
    direction[0] = ring * Math.cos(angle);
    direction[1] = height;
    direction[2] = ring * Math.sin(angle);
  }

  function walk(subsurface, color, pointX, pointY, pointZ, normal, material, exitHit, weight) {
    for (let channel = 0; channel < CHANNELS; channel++) {
      extinction[channel] = 1 / subsurface.meanFreePath[channel];
      albedo[channel] = singleScatterAlbedo(color[channel]);
    }
    position[0] = pointX - normal[0] * scene.surfaceOffset;
    position[1] = pointY - normal[1] * scene.surfaceOffset;
    position[2] = pointZ - normal[2] * scene.surfaceOffset;
    pickInwardDirection(normal);
    for (let scatters = 0; ; scatters++) {
      const found = intersect(scene, position[0], position[1], position[2], direction[0], direction[1], direction[2], exitHit);
      const ownsBoundary = found && exitHit.material === material;
      if (!ownsBoundary) return scatters === 0 ? WALK_OUTCOME.thin : WALK_OUTCOME.lost;
      // One channel draws the distance; weighting by the mean density over the three channels keeps every channel unbiased.
      const hero = Math.min(CHANNELS - 1, Math.floor(random.next() * CHANNELS));
      const distance = -Math.log(1 - random.next()) / extinction[hero];
      if (distance >= exitHit.distance) {
        let survival = 0;
        for (let channel = 0; channel < CHANNELS; channel++) survival += Math.exp(-extinction[channel] * exitHit.distance) / CHANNELS;
        if (!(survival > 0)) return WALK_OUTCOME.lost;
        for (let channel = 0; channel < CHANNELS; channel++) weight[channel] *= Math.exp(-extinction[channel] * exitHit.distance) / survival;
        return WALK_OUTCOME.exit;
      }
      if (scatters === SUBSURFACE_WALK_STEPS) return WALK_OUTCOME.lost;
      let density = 0;
      for (let channel = 0; channel < CHANNELS; channel++) density += extinction[channel] * Math.exp(-extinction[channel] * distance) / CHANNELS;
      if (!(density > 0)) return WALK_OUTCOME.lost;
      for (let channel = 0; channel < CHANNELS; channel++) weight[channel] *= albedo[channel] * extinction[channel] * Math.exp(-extinction[channel] * distance) / density;
      position[0] += direction[0] * distance;
      position[1] += direction[1] * distance;
      position[2] += direction[2] * distance;
      pickScatterDirection();
    }
  }
  // The last direction of the walk, which the caller reads to orient the exit normal.
  walk.direction = direction;
  return walk;
}
