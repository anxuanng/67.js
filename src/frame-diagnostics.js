/**
 * Diagnostics for a frame that renders without error but not as asked. They use the shape of `agent-diagnostics.js`
 * (kind, severity, target, message, fix) and are read from `renderer.diagnostics`.
 */
const NO_DIAGNOSTICS = Object.freeze([]);

export function frameDiagnostics({ depth, effects }) {
  const problems = [];
  if (effects.ambientOcclusion > 0 && !depth) {
    problems.push({
      kind: 'ambient-occlusion-without-depth', severity: 'warning', target: 'effects.ambientOcclusion',
      message: `effects.ambientOcclusion is ${effects.ambientOcclusion} but the renderer was built without depth, so the occlusion pass is skipped.`,
      fix: 'Construct the renderer with depth: true, or set effects.ambientOcclusion to 0.',
    });
  }
  return problems.length ? problems : NO_DIAGNOSTICS;
}
