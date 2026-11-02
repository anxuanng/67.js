// Compares a fresh results file with a stored one and lists every score that got worse by more than a margin.
//   node bench/reference/compare-scores.mjs <fresh.json> [<stored.json>] [--margin 0.01]
// The stored file defaults to bench/reference/bake.json. Lower is better for every score except the "-pixels" counts, which are skipped.
// A scene or score that the fresh file does not hold is not compared, so a run of a few scenes checks only those.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MARGIN = 0.01;

export function findRegressions(stored, fresh, margin = DEFAULT_MARGIN) {
  const regressions = [];
  for (const [scene, storedScores] of Object.entries(stored.scores)) {
    const freshScores = fresh.scores[scene];
    if (!freshScores) continue;
    for (const [name, storedValue] of Object.entries(storedScores)) {
      const freshValue = freshScores[name];
      if (name.endsWith('-pixels') || typeof freshValue !== 'number') continue;
      if (freshValue > storedValue + margin) {
        regressions.push({ scene, name, stored: storedValue, fresh: freshValue });
      }
    }
  }
  return regressions;
}

export function describeRegressions(regressions, margin = DEFAULT_MARGIN) {
  return regressions
    .map(({ scene, name, stored, fresh }) => `${scene} ${name}: ${stored} stored, ${fresh} fresh (+${(fresh - stored).toFixed(4)}, margin ${margin})`)
    .join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const marginIndex = process.argv.indexOf('--margin');
  const margin = marginIndex >= 0 ? Number(process.argv[marginIndex + 1]) : DEFAULT_MARGIN;
  const positional = process.argv.slice(2).filter((argument, index, all) => !argument.startsWith('--') && all[index - 1] !== '--margin');
  const [freshPath, storedPath = fileURLToPath(new URL('bake.json', import.meta.url))] = positional;
  const regressions = findRegressions(JSON.parse(readFileSync(storedPath, 'utf8')), JSON.parse(readFileSync(freshPath, 'utf8')), margin);
  console.log(regressions.length ? `Regressed:\n${describeRegressions(regressions, margin)}` : 'No stored score got worse by more than the margin.');
  process.exitCode = regressions.length ? 1 : 0;
}
