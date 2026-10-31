import { bakeLightmaps } from './light-bake.js';
import { knownKeys, finiteNumber } from './agent-recipe-checks.js';
import { BAKE_PRESETS, BAKE_RANGES, BAKE_MAXIMUM_SECONDS } from './agent-scene-capabilities.js';

// Recipe `bake`: bounced light written into lightmaps when the scene builds. This module loads on demand, so scenes
// without a bake never download the ray tracer.

const BAKE_FIELDS = ['preset', 'samples', 'bounces', 'texelsPerUnit'];
const BAKED_MATERIAL_FIELDS = ['emission', 'emissiveColor', 'emissiveMap', 'lightMap', 'lightMapScale'];

/** Validates a recipe bake section and returns the plain, resolved form stored in the recipe (null clears it). */
export function normalizeAgentBake(input) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, BAKE_FIELDS, 'bake');
  if (input.preset !== undefined && !Object.hasOwn(BAKE_PRESETS, input.preset)) {
    throw new RangeError(`Bake preset must be one of ${Object.keys(BAKE_PRESETS).join(', ')}.`);
  }
  const resolved = { ...BAKE_PRESETS[input.preset ?? 'standard'] };
  for (const [field, [minimum, maximum]] of Object.entries(BAKE_RANGES)) {
    if (input[field] === undefined) {
      continue;
    }
    resolved[field] = finiteNumber(input[field], `Bake ${field}`, minimum, maximum);
  }
  for (const field of ['samples', 'bounces']) {
    if (!Number.isInteger(resolved[field])) {
      throw new RangeError(`Bake ${field} must be an integer.`);
    }
  }
  return resolved;
}

// The baked part keeps reading every other material field from the live material, so motion tracks still drive it.
function liveBakedMaterial(liveMaterial, bakedMaterial) {
  const output = {};
  for (const field of Object.keys(bakedMaterial)) {
    const source = BAKED_MATERIAL_FIELDS.includes(field) ? bakedMaterial : liveMaterial;
    Object.defineProperty(output, field, { enumerable: true, get: () => source[field] });
  }
  return Object.freeze(output);
}

/**
 * Bakes the parts at the world matrices given by name (a retained part's own matrix is only refreshed after a commit).
 * Returns the new parts, which share the originals' matrices so poses still move them, and a report: texels,
 * rayWork, seconds, skipped parts with reasons.
 */
export function bakeAgentParts(parts, worldMatrices, environment, settings, generatedGeometryNames = new Set()) {
  const sunScale = environment.keyIntensity ?? 1;
  const lighting = {
    pointLights: environment.pointLights,
    keyColor: Array.from(environment.keyColor, channel => channel * sunScale),
    lightDirection: environment.lightDirection,
  };
  // A hair or particle host is drawn from geometry built every frame, which has no lightmap UVs.
  const snapshots = parts.map(part => ({
    ...part,
    matrix: worldMatrices.get(part.name),
    material: { ...part.material },
    generatesGeometry: generatedGeometryNames.has(part.name),
  }));
  const { parts: bakedSnapshots, report } = bakeLightmaps(snapshots, lighting, { ...settings, maxSeconds: BAKE_MAXIMUM_SECONDS });
  const bakedParts = parts.map((part, index) => {
    if (bakedSnapshots[index] === snapshots[index]) {
      return part;
    }
    const { geometry, material } = bakedSnapshots[index];
    return Object.freeze({ ...part, geometry, material: liveBakedMaterial(part.material, material) });
  });
  return { parts: Object.freeze(bakedParts), report: { ...settings, texels: report.texels, rayWork: report.rayWork, seconds: report.seconds,
    bakedParts: report.parts.length, skipped: report.skipped } };
}
