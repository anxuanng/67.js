// Prints the coverage of docs/parity.md for each section of the Blender manual: npm run parity
import { readFile } from 'node:fs/promises';
import { ledgerCoverage, parseLedger } from './parity-ledger.mjs';

const ledgerText = await readFile(new URL('../docs/parity.md', import.meta.url), 'utf8');
const { manualRows } = parseLedger(ledgerText);
const { overall, sections } = ledgerCoverage(manualRows);

function percentDone(counts) {
  const inScope = counts.total - counts['out of scope'];
  if (inScope === 0) return 'n/a';
  return `${Math.round((counts.done / inScope) * 100)}%`;
}

function printLine(name, counts) {
  const numbers = [counts.done, counts.partial, counts.missing, counts['out of scope'], counts.compared];
  const cells = numbers.map(value => String(value).padStart(8));
  console.log(`${name.padEnd(32)}${cells.join('')}${percentDone(counts).padStart(8)}`);
}

console.log(`${''.padEnd(32)}${['done', 'partial', 'missing', 'out', 'compared', 'done%'].map(title => title.padStart(8)).join('')}`);
for (const [section, counts] of sections) printLine(section, counts);
const modifierRows = manualRows.filter(row => row.path.startsWith('Modeling > Modifiers'));
printLine('  of which Modifiers', ledgerCoverage(modifierRows).overall);
printLine('All rows', overall);

const unowned = manualRows.filter(row => ['partial', 'missing'].includes(row.status) && row.issues.length === 0);
console.log(`\nRows are not equal in size. "compared" counts done rows with Blender evidence.`);
console.log(`Rows that are not done and have no issue: ${unowned.length}`);
for (const row of unowned) console.log(`  ${row.status.padEnd(8)}${row.path}`);
