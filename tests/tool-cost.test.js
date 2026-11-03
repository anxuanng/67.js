import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureToolCost } from '../scripts/measure-tool-cost.mjs';
import { ceilingProblems, costsFrom } from '../scripts/tool-cost-growth.mjs';

const budgets = JSON.parse(readFileSync(new URL('../bench/tool-cost-budgets.json', import.meta.url), 'utf8'));
const report = await measureToolCost();
const costs = costsFrom(report);

// Growth against the base branch is checked by npm run tool-cost, and tests/tool-cost-growth.test.js tests its rules.
// The ceilings are release numbers: a pull request past one is reported by npm run tool-cost and never fails here.
test('every typical result has a release ceiling, and the budget file holds no history string', () => {
  for (const name of Object.keys(costs).filter(key => key.startsWith('result:'))) {
    const ceiling = budgets.resultBytes[name.slice('result:'.length)];
    assert.ok(ceiling !== undefined, `${name} has no release ceiling; run npm run tool-cost:release.`);
  }
  assert.equal(budgets.measured, undefined, 'bench/tool-cost-budgets.json holds no history string. Git history keeps it.');
});

test('the release ceilings come back as a list of problems', () => {
  assert.ok(Array.isArray(ceilingProblems(costs, budgets)));
});

test('a small mesh change as a mesh_edit call is smaller than rewriting the recipe', () => {
  const { meshEditCall, rewriteCall } = report.comparison;
  assert.ok(meshEditCall.bytes * 3 < rewriteCall.bytes, `mesh_edit ${meshEditCall.bytes} B against rewrite ${rewriteCall.bytes} B`);
});
