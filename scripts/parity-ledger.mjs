// Reads docs/parity.md into rows, and counts them. The report script and the ledger test share this file.
export const LEDGER_STATUSES = Object.freeze(['done', 'partial', 'missing', 'out of scope']);
const COMPARED_EVIDENCE_PREFIXES = ['../tests/fixtures/blender/', '../bench/reference/'];
const MANUAL_HEADING = '## Blender manual';
const OTHER_WORK_HEADING = '## Work outside the manual';

function splitRow(line) {
  return line.slice(1, -1).split('|').map(cell => cell.trim());
}

function tableLines(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`The ledger has no "${heading}" section.`);
  const rest = markdown.slice(start + heading.length);
  const nextHeading = rest.search(/^## /m);
  const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  return section.split(/\r?\n/).filter(line => line.startsWith('|')).slice(2);
}

function evidenceLinks(cell) {
  return [...cell.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
}

function issueNumbers(cell) {
  return [...cell.matchAll(/#(\d+)/g)].map(match => Number(match[1]));
}

export function parseLedger(markdown) {
  const manualRows = tableLines(markdown, MANUAL_HEADING).map(line => {
    const [path, status, note, evidence, issues] = splitRow(line);
    return { path, status, note, evidence: evidenceLinks(evidence), issues: issueNumbers(issues) };
  });
  const otherWork = tableLines(markdown, OTHER_WORK_HEADING).map(line => {
    const [work, status, note, issues] = splitRow(line);
    return { work, status, note, issues: issueNumbers(issues) };
  });
  return { manualRows, otherWork };
}

export function isComparedWithBlender(row) {
  return row.evidence.some(link => COMPARED_EVIDENCE_PREFIXES.some(prefix => link.startsWith(prefix)));
}

function emptyCounts() {
  return { done: 0, partial: 0, missing: 0, 'out of scope': 0, total: 0, compared: 0 };
}

function addRow(counts, row) {
  counts[row.status] += 1;
  counts.total += 1;
  if (row.status === 'done' && isComparedWithBlender(row)) counts.compared += 1;
}

export function ledgerCoverage(rows) {
  const overall = emptyCounts();
  const sections = new Map();
  for (const row of rows) {
    const section = row.path.split(' > ')[0];
    if (!sections.has(section)) sections.set(section, emptyCounts());
    addRow(sections.get(section), row);
    addRow(overall, row);
  }
  return { overall, sections };
}

// A row covers its whole subtree, so a section that is out of scope needs one row. A section with finer rows needs no
// row of its own, because each of its pages is checked in turn.
export function uncoveredManualPaths(manualPaths, rows) {
  const rowPaths = rows.map(row => row.path);
  return manualPaths.filter(path => {
    const hasRow = rowPaths.includes(path);
    const hasAncestorRow = rowPaths.some(rowPath => path.startsWith(`${rowPath} > `));
    const hasDescendantRow = rowPaths.some(rowPath => rowPath.startsWith(`${path} > `));
    return !hasRow && !hasAncestorRow && !hasDescendantRow;
  });
}
