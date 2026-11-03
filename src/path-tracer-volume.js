import { resolveVolumeFog } from './volumetric.js';

// Homogeneous fog for the path tracer: a box of uniform scattering medium with the colour, density and anisotropy of the
// rasterizer's `environment.volumeFog`. Distances to the next scattering event are drawn from the exact free-flight
// distribution, so the cost is one random number per ray segment and there is no step count to trade against quality.
// The rasterizer's noise, drift and ambient term are not traced: the medium is uniform and lit only by the scene's lights.

/** The medium the tracer reads, or null when the environment has no fog. Throws what the rasterizer throws for bad input. */
export function resolveTraceVolume(volumeFog) {
  if (!volumeFog) return null;
  const resolved = resolveVolumeFog(volumeFog);
  if (!(resolved.density > 0)) return null;
  return {
    density: resolved.density,
    minimum: resolved.minimum,
    maximum: resolved.maximum,
    albedo: resolved.color,
    anisotropy: resolved.anisotropy,
    maxDistance: resolved.maxDistance,
  };
}

/**
 * Where the ray is inside the box, as distances along it: writes `[entry, exit]` into `out`
 * clipped to `[0, limit]` and returns true, or returns false when the ray misses the box in that range.
 */
export function volumeInterval(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  let entry = 0;
  let exit = Math.min(limit, volume.maxDistance);
  for (let axis = 0; axis < 3; axis++) {
    const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
    const direction = axis === 0 ? directionX : axis === 1 ? directionY : directionZ;
    if (direction === 0) {
      if (origin < volume.minimum[axis] || origin > volume.maximum[axis]) return false;
      continue;
    }
    const first = (volume.minimum[axis] - origin) / direction;
    const second = (volume.maximum[axis] - origin) / direction;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  if (!(entry < exit)) return false;
  out[0] = entry;
  out[1] = exit;
  return true;
}

/** Henyey-Greenstein value per steradian; `cosine` is between the path direction and the direction toward the light. */
export function henyeyGreensteinPhase(anisotropy, cosine) {
  const squared = anisotropy * anisotropy;
  return (1 - squared) / (4 * Math.PI * (1 + squared - 2 * anisotropy * cosine) ** 1.5);
}

/**
 * Draws the cosine of the scattering angle from Henyey-Greenstein. The probability density of the drawn direction is
 * `henyeyGreensteinPhase(anisotropy, cosine)`, so a scatter keeps its throughput times the albedo.
 */
export function sampleHenyeyGreensteinCosine(anisotropy, unit) {
  if (Math.abs(anisotropy) < 1e-3) return 1 - 2 * unit;
  const squared = anisotropy * anisotropy;
  const ratio = (1 - squared) / (1 - anisotropy + 2 * anisotropy * unit);
  return Math.max(-1, Math.min(1, (1 + squared - ratio * ratio) / (2 * anisotropy)));
}
