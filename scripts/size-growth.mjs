// The growth gate. A pull request is measured against the base branch, so no pull request edits a number that another one edits.
import { signedBytes } from './size-budget.mjs';

const CORE_ALLOWANCE_BYTES = 64;
const OTHER_ALLOWANCE_FRACTION = 0.02;
const OTHER_ALLOWANCE_FLOOR_BYTES = 64;
export const ARCHIVE_NAME = 'archive';

function isTightBundle(name) {
  return name.startsWith('entry:core') || name.startsWith('scene:');
}

// Core and the scenes get a small fixed allowance, because every app pays for them. Other entries get a percentage.
export function growthAllowance(name, baseGzip) {
  if (isTightBundle(name)) return CORE_ALLOWANCE_BYTES;
  return Math.max(OTHER_ALLOWANCE_FLOOR_BYTES, Math.floor(baseGzip * OTHER_ALLOWANCE_FRACTION));
}

// Reads the lines of one size note, "- entry:core: why it is worth it". A line without a reason does not count.
export function parseSizeNote(text) {
  const accepted = new Map();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\s*(?:[-*]\s+)?`?([\w:+.-]+)`?:\s+(\S.*)$/);
    if (match) accepted.set(match[1], match[2].trim());
  }
  return accepted;
}

export function acceptInstruction(name) {
  return `Reduce it, or accept it: add changes/<issue>.size.md to this pull request with the line "- ${name}: <why it is worth the bytes>", and say why in the pull request.`;
}

// Compares each bundle with the same bundle on the base branch. A bundle the base does not have is reported, not failed.
export function compareToBase(measured, baseMeasured, accepted = new Map()) {
  const rows = [];
  const problems = [];
  for (const [name, size] of Object.entries(measured)) {
    const baseGzip = baseMeasured[name]?.gzip;
    const growth = baseGzip === undefined ? null : size.gzip - baseGzip;
    const allowance = baseGzip === undefined ? null : growthAllowance(name, baseGzip);
    const isAccepted = accepted.has(name);
    rows.push({ name, min: size.min, gzip: size.gzip, base: baseGzip ?? null, growth, allowance, accepted: isAccepted });
    if (growth !== null && growth > allowance && !isAccepted) {
      problems.push(`${name} grew by ${growth} bytes gzip against the base branch (${baseGzip} to ${size.gzip}), over its allowance of ${allowance}. ${acceptInstruction(name)}`);
    }
  }
  return { rows, problems };
}

function noteFor(row) {
  if (row.growth === null) return 'new, reported only';
  if (row.growth <= row.allowance) return '';
  return row.accepted ? 'accepted' : 'OVER';
}

export function formatGrowthRows(rows) {
  const header = `${'bundle'.padEnd(30)}${'gzip'.padStart(10)}${'base'.padStart(10)}${'growth'.padStart(10)}${'allowed'.padStart(10)}  note`;
  const lines = rows.map(row => [
    row.name.padEnd(30), String(row.gzip).padStart(10), String(row.base ?? '-').padStart(10),
    signedBytes(row.growth).padStart(10), String(row.allowance ?? '-').padStart(10), `  ${noteFor(row)}`,
  ].join(''));
  return [header, ...lines].join('\n');
}

// The packed archive is measured like a bundle, against the archive of the base branch. It gets 2% of that archive, because
// every consumer downloads it and 2% is what the other entries get. An archive line in a size note accepts more.
export function archiveAllowance(baseBytes) {
  return Math.floor(baseBytes * OTHER_ALLOWANCE_FRACTION);
}

export function archiveGrowthProblem(archiveBytes, baseBytes, accepted = new Map()) {
  const allowance = archiveAllowance(baseBytes);
  const growth = archiveBytes - baseBytes;
  if (growth <= allowance || accepted.has(ARCHIVE_NAME)) return null;
  return `The source package is ${archiveBytes} bytes, ${growth} more than the ${baseBytes} bytes of the base branch, over its allowance of ${allowance}. ${acceptInstruction(ARCHIVE_NAME)}`;
}

// The ceiling in bench/size/budgets.json is a release report like the other absolute budgets. --absolute enforces it.
export function archiveCeilingProblem(archiveBytes, ceiling) {
  if (archiveBytes <= ceiling) return null;
  return `The source package is ${archiveBytes} bytes, over its release ceiling of ${ceiling} in bench/size/budgets.json by ${archiveBytes - ceiling}. A release refreshes it.`;
}
