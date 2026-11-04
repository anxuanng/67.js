// node scripts/merge-tree-level-gains.mjs <gains file> <fit json>... [--measured <measure json>...]
// Merges the fits of `measure-tree-level-luminance.mjs --fit --seed N` (one per seed) into the gains file (src/tree-level-gains.js),
// keeping its header and each species' `areaExponent` (issue #432):
// - `color` and `sky` are the geometric mean over the fits;
// - `area` is the mean log ratio of a level's leaf area to level 0's over the fitted seeds, the point where the leaf area
//   correction in src/vegetation.js is 1. Each tree's own correction then cancels out of the mean.
// `--measured` takes plain runs of the probe (no --fit) drawn with the merged gains, and scales each colour gain so the geometric
// mean of the measured ratios lands on TARGET. TARGET sits below 1 because trees spread about ±15% around it, and a far level
// that is darker than level 0 by that much shows less than one that is brighter.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTree } from '../src/vegetation.js';
import { vertexCoverage } from '../src/tree-sky.js';

const TARGET = 0.97;
// Level 1 already draws within a few percent of level 0, so only the clump levels get gains.
const MERGED_LEVELS = ['2', '3'];
const argumentsGiven = process.argv.slice(2);
const measuredFlag = argumentsGiven.indexOf('--measured');
const [target, ...fitFiles] = measuredFlag >= 0 ? argumentsGiven.slice(0, measuredFlag) : argumentsGiven;
const measuredFiles = measuredFlag >= 0 ? argumentsGiven.slice(measuredFlag + 1) : [];
const fits = fitFiles.map(file => JSON.parse(readFileSync(file, 'utf8')));
const measured = measuredFiles.map(file => JSON.parse(readFileSync(file, 'utf8')));
const { TREE_LEVEL_GAINS: current } = await import(pathToFileURL(resolve(target)).href);

const logMean = values => values.reduce((sum, value) => sum + Math.log(value), 0) / values.length;
const leafArea = geometry => vertexCoverage(geometry.positions, geometry.indices).reduce((sum, share) => sum + share, 0);
const foliageOf = (tree, level) => tree.levels[level].parts.find(part => part.role === 'foliage').geometry;

const header = readFileSync(target, 'utf8').split('export const')[0];
const rows = Object.keys(fits[0].gains).map(species => {
  const trees = fits.map(fit => createTree(species, fit.seed));
  const areaExponent = current[species]?.areaExponent;
  const entries = MERGED_LEVELS.map(level => {
    let color = Math.exp(logMean(fits.map(fit => fit.gains[species][level].color)));
    const sky = Math.exp(logMean(fits.map(fit => fit.gains[species][level].sky)));
    const area = trees.reduce((sum, tree) => sum + Math.log(leafArea(foliageOf(tree, level)) / leafArea(foliageOf(tree, 0))), 0) / trees.length;
    if (measured.length) {
      const ratios = measured.flatMap(run => run[species].levels.find(entry => entry.level === Number(level)).before);
      color *= TARGET / Math.exp(logMean(ratios));
    }
    return `${level}: { color: ${Number(color.toFixed(3))}, sky: ${Number(sky.toFixed(3))}, area: ${Number(area.toFixed(4))} }`;
  });
  const exponent = areaExponent === undefined ? '' : `areaExponent: ${areaExponent}, `;
  return `  ${species}: { ${exponent}${entries.join(', ')} },`;
});
writeFileSync(target, `${header}export const TREE_LEVEL_GAINS = {\n${rows.join('\n')}\n};\n`);
console.log(rows.join('\n'));
