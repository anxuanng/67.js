// node scripts/merge-tree-level-gains.mjs <gains file> <colour cap> <sky cap> <fit json>...
// Writes the geometric mean, over the fit files of `measure-tree-level-luminance.mjs --fit`, of each species and level gain into the
// gains file (src/tree-level-gains.js), capped, and keeps its header. A cap of 99 leaves the gains as fitted (issue #432).
import { readFileSync, writeFileSync } from 'node:fs';
const [target, colorCapText, skyCapText, ...files] = process.argv.slice(2);
const colorCap = Number(colorCapText);
const skyCap = Number(skyCapText);
const fits = files.map(file => JSON.parse(readFileSync(file, 'utf8')).gains);
const header = readFileSync(target, 'utf8').split('export const')[0];
const geometricMean = values => Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
const rows = Object.keys(fits[0]).map(species => {
  const entries = Object.keys(fits[0][species]).map(level => {
    const color = Math.min(colorCap, geometricMean(fits.map(fit => fit[species][level].color)));
    const sky = Math.min(skyCap, geometricMean(fits.map(fit => fit[species][level].sky)));
    return `${level}: { color: ${Number(color.toFixed(3))}, sky: ${Number(sky.toFixed(3))} }`;
  });
  return `  ${species}: { ${entries.join(', ')} },`;
});
writeFileSync(target, `${header}export const TREE_LEVEL_GAINS = {\n${rows.join('\n')}\n};\n`);
