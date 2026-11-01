import { planLightmaps, estimateBake, traceLightmaps } from './light-bake.js';
import { runKernel } from './kernel-offload.js';
import { knownKeys, finiteNumber } from './agent-recipe-checks.js';
import { BAKE_PRESETS, BAKE_RANGES, BAKE_MAXIMUM_SECONDS, BAKE_RAY_WORK_BUDGET } from './agent-scene-capabilities.js';

const PRESET_SAMPLES_FLOOR = 16;

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

function isPreset(settings) {
  return Object.values(BAKE_PRESETS).some(preset => Object.keys(preset).every(field => preset[field] === settings[field]));
}

function fits(plan, settings) {
  return estimateBake(plan, settings).rayWork <= BAKE_RAY_WORK_BUDGET;
}

// The densest texelsPerUnit, to two decimals, that still fits the budget at the given samples and bounces (0 when none does).
function largestFittingTexelsPerUnit(plan, settings) {
  let fitting = 0;
  let tooMuch = settings.texelsPerUnit;
  for (let step = 0; step < 12; step++) {
    const middle = Math.floor((fitting + tooMuch) / 2 * 100) / 100;
    if (middle <= fitting) {
      break;
    }
    if (fits(plan, { ...settings, texelsPerUnit: middle })) {
      fitting = middle;
    } else {
      tooMuch = middle;
    }
  }
  return fitting >= BAKE_RANGES.texelsPerUnit[0] ? fitting : 0;
}

function overBudgetMessage(plan, settings, rayWork) {
  const fittingSamples = Math.floor(BAKE_RAY_WORK_BUDGET * settings.samples / rayWork);
  const fittingTexelsPerUnit = largestFittingTexelsPerUnit(plan, settings);
  const choices = [];
  if (fittingSamples >= BAKE_RANGES.samples[0]) {
    choices.push(`samples ${fittingSamples} or fewer with texelsPerUnit ${settings.texelsPerUnit}`);
  }
  if (fittingTexelsPerUnit > 0) {
    choices.push(`texelsPerUnit ${fittingTexelsPerUnit} or less with samples ${settings.samples}`);
  }
  const advice = choices.length > 0 ? `At bounces ${settings.bounces} this scene fits ${choices.join(', or ')}.` : 'Remove parts or lights, or lower bounces.';
  return `The bake would need ${rayWork} units of ray work (texels x samples x bounces x rays per hit); the limit is ${BAKE_RAY_WORK_BUDGET}. ${advice}`;
}

/**
 * Keeps a bake inside the ray work budget before any ray is traced. The estimate counts texels, samples, bounces and lights,
 * and reads no clock, so the same recipe always resolves to the same settings. A preset is scaled down (samples first by a
 * fifth, texel density by a tenth, repeatedly); explicit samples or texelsPerUnit are never changed and fail instead.
 */
function fitSettingsToBudget(plan, settings) {
  const { rayWork } = estimateBake(plan, settings);
  if (rayWork <= BAKE_RAY_WORK_BUDGET) {
    return { used: settings, reduced: false };
  }
  if (!isPreset(settings)) {
    throw new RangeError(overBudgetMessage(plan, settings, rayWork));
  }
  let used = settings;
  while (!fits(plan, used)) {
    if (used.samples <= PRESET_SAMPLES_FLOOR && used.texelsPerUnit <= BAKE_RANGES.texelsPerUnit[0]) {
      throw new RangeError(`Even ${PRESET_SAMPLES_FLOOR} samples at texelsPerUnit ${BAKE_RANGES.texelsPerUnit[0]} is over the ray work limit of ${BAKE_RAY_WORK_BUDGET} for this scene. Remove parts or lights, or lower bounces.`);
    }
    used = {
      ...used,
      samples: Math.max(PRESET_SAMPLES_FLOOR, Math.floor(used.samples * 0.8)),
      texelsPerUnit: Math.max(BAKE_RANGES.texelsPerUnit[0], Math.round(used.texelsPerUnit * 0.9 * 100) / 100),
    };
  }
  return { used, reduced: true };
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
 * The light bake as a worker kernel: unwrap, budget fit and trace all run in the same place, because unwrapping and
 * tracing are both the heavy parts. Only the parts the bake changed travel back, as [index, part] pairs, because a part
 * that was left alone is the caller's own object and has nothing to send. An explicit setting over the budget throws
 * the same RangeError here as it would inline, and the worker sends it back with its message.
 */
export function bakeChangedParts(snapshots, lighting, settings) {
  const plan = planLightmaps(snapshots, lighting, { ...settings, maxSeconds: BAKE_MAXIMUM_SECONDS });
  const { used, reduced } = fitSettingsToBudget(plan, settings);
  const { parts, report } = traceLightmaps(plan, used);
  const changed = [];
  parts.forEach((part, index) => {
    if (part !== snapshots[index]) {
      changed.push([index, part]);
    }
  });
  return { changed, report, used, reduced };
}

/**
 * Bakes the parts at the world matrices given by name (a retained part's own matrix is only refreshed after a commit).
 * Returns the new parts, which share the originals' matrices so poses still move them, and a report: texels,
 * rayWork, seconds, skipped parts with reasons.
 */
export function bakeAgentParts(parts, worldMatrices, environment, settings, generatedGeometryGenerators = new Map()) {
  const sunScale = environment.keyIntensity ?? 1;
  const lighting = {
    pointLights: environment.pointLights,
    spotLights: environment.spotLights,
    areaLights: environment.areaLights,
    keyColor: Array.from(environment.keyColor, channel => channel * sunScale),
    lightDirection: environment.lightDirection,
  };
  // A hair, particle or cloth node is drawn from geometry built every frame, which has no lightmap UVs.
  const snapshots = parts.map(part => ({
    ...part,
    matrix: worldMatrices.get(part.name),
    material: { ...part.material },
    generatesGeometry: generatedGeometryGenerators.get(part.name) ?? false,
  }));
  const { changed, report, used, reduced } = runKernel('lightBake', [snapshots, lighting, settings], bakeChangedParts);
  const bakedSnapshots = snapshots.slice();
  for (const [index, part] of changed) {
    bakedSnapshots[index] = part;
  }
  const bakedParts = parts.map((part, index) => {
    if (bakedSnapshots[index] === snapshots[index]) {
      return part;
    }
    const { geometry, material } = bakedSnapshots[index];
    return Object.freeze({ ...part, geometry, material: liveBakedMaterial(part.material, material) });
  });
  return { parts: Object.freeze(bakedParts), report: { ...settings, used, reduced, texels: report.texels, rayWork: report.rayWork, seconds: report.seconds,
    bakedParts: report.parts.length, skipped: report.skipped } };
}
