import { resolveShadowLight } from './shadow-light.js';

/**
 * Diagnostics for a frame that renders without error but not as asked. They use the shape of `agent-diagnostics.js`
 * (kind, severity, target, message, fix) and are read from `renderer.diagnostics`.
 */
const SHADOW_DISAGREEMENT_DEGREES = 10;
const NO_DIAGNOSTICS = Object.freeze([]);

function angleBetweenDegrees(first, second) {
  const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  const lengths = Math.hypot(...first) * Math.hypot(...second);
  if (!(lengths > 1e-6)) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / lengths))) * 180 / Math.PI;
}

function shadowDirectionProblem(world, lightDirection, shadowBounds) {
  const light = resolveShadowLight(world, lightDirection, shadowBounds);
  const towardShadowEye = light.eye.map((value, axis) => value - light.target[axis]);
  const degrees = angleBetweenDegrees(towardShadowEye, lightDirection);
  if (degrees < SHADOW_DISAGREEMENT_DEGREES) return null;
  return {
    kind: 'shadow-light-direction-mismatch', severity: 'warning', target: 'shadowBounds.eye',
    message: `shadowBounds.eye points ${Math.round(degrees)} degrees away from environment.lightDirection. The eye decides where shadows fall; lightDirection only moves the shading.`,
    fix: 'Remove shadowBounds.eye so the shadow follows lightDirection, or set lightDirection to the direction from shadowBounds.target to shadowBounds.eye.',
  };
}

export function frameDiagnostics({ world, depth, effects, lightDirection, shadowBounds }) {
  const problems = [];
  if (effects.ambientOcclusion > 0 && !depth) {
    problems.push({
      kind: 'ambient-occlusion-without-depth', severity: 'warning', target: 'effects.ambientOcclusion',
      message: `effects.ambientOcclusion is ${effects.ambientOcclusion} but the renderer was built without depth, so the occlusion pass is skipped.`,
      fix: 'Construct the renderer with depth: true, or set effects.ambientOcclusion to 0.',
    });
  }
  if (shadowBounds?.eye && lightDirection) {
    const problem = shadowDirectionProblem(world, lightDirection, shadowBounds);
    if (problem) problems.push(problem);
  }
  return problems.length ? problems : NO_DIAGNOSTICS;
}
