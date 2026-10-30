import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_STATUSES, isComparedWithBlender, ledgerCoverage, parseLedger, uncoveredManualPaths,
} from '../scripts/parity-ledger.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const docsDirectory = resolve(testDirectory, '../docs');
const ledgerText = readFileSync(resolve(docsDirectory, 'parity.md'), 'utf8');
const manual = JSON.parse(readFileSync(resolve(testDirectory, 'fixtures/blender-manual-toc.json'), 'utf8'));
const { manualRows, otherWork } = parseLedger(ledgerText);
const FIRST_GOAL_ISSUE = 24;
const LAST_GOAL_ISSUE = 69;

test('every page in the Blender manual has a ledger row', () => {
  assert.deepEqual(uncoveredManualPaths(manual.paths, manualRows), []);
});

test('every ledger row names a real manual path, once', () => {
  const known = new Set(manual.paths);
  const seen = new Set();
  for (const row of manualRows) {
    assert.ok(known.has(row.path), `Unknown manual path: ${row.path}`);
    assert.ok(!seen.has(row.path), `Duplicate row: ${row.path}`);
    seen.add(row.path);
  }
});

test('every status is known, and every row says why', () => {
  for (const row of [...manualRows, ...otherWork]) {
    assert.ok(LEDGER_STATUSES.includes(row.status), `Unknown status "${row.status}" on ${row.path ?? row.work}`);
    assert.ok(row.note.length > 0, `Empty note on ${row.path ?? row.work}`);
  }
});

test('a done row links to evidence that exists', () => {
  const doneRows = manualRows.filter(row => row.status === 'done');
  assert.ok(doneRows.length > 0);
  for (const row of doneRows) assert.ok(row.evidence.length > 0, `No evidence on ${row.path}`);
});

test('every evidence link resolves to a file', () => {
  for (const row of manualRows) {
    for (const link of row.evidence) {
      assert.ok(existsSync(resolve(docsDirectory, link)), `${row.path} links to a missing file: ${link}`);
    }
  }
});

test('an out of scope row has no issue, because nothing is planned', () => {
  for (const row of manualRows.filter(candidate => candidate.status === 'out of scope')) {
    assert.deepEqual(row.issues, [], `${row.path} is out of scope and has an issue`);
  }
});

test('every issue under the goal maps to a ledger row', () => {
  const mapped = new Set([...manualRows, ...otherWork].flatMap(row => row.issues));
  for (let issue = FIRST_GOAL_ISSUE; issue <= LAST_GOAL_ISSUE; issue += 1) {
    assert.ok(mapped.has(issue), `Issue #${issue} has no ledger row`);
  }
});

test('coverage counts rows by section, and only Blender evidence counts as compared', () => {
  const rows = [
    { path: 'Physics > Cloth', status: 'done', evidence: ['../tests/fixtures/blender/cloth.json'] },
    { path: 'Physics > Fluid', status: 'done', evidence: ['../tests/physics.test.js'] },
    { path: 'Rendering > Cameras', status: 'missing', evidence: [] },
  ];
  assert.ok(isComparedWithBlender(rows[0]));
  assert.ok(!isComparedWithBlender(rows[1]));
  const { overall, sections } = ledgerCoverage(rows);
  assert.equal(overall.total, 3);
  assert.equal(overall.compared, 1);
  assert.equal(sections.get('Physics').done, 2);
  assert.equal(sections.get('Rendering').missing, 1);
});

test('a row covers its subtree only', () => {
  const rows = [{ path: 'Grease Pencil' }];
  assert.deepEqual(uncoveredManualPaths(['Grease Pencil > Modifiers', 'Grease Pencils'], rows), ['Grease Pencils']);
});

test('a section with finer rows needs no row, and its other pages still do', () => {
  const rows = [{ path: 'Physics > Cloth' }];
  assert.deepEqual(uncoveredManualPaths(['Physics', 'Physics > Cloth', 'Physics > Fluid'], rows), ['Physics > Fluid']);
});
