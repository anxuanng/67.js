import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureToolCost } from '../scripts/measure-tool-cost.mjs';

const budgets = JSON.parse(readFileSync(new URL('../bench/tool-cost-budgets.json', import.meta.url), 'utf8'));
const report = await measureToolCost();

test('the tool schemas an agent reads on every turn stay under their total budget', () => {
  assert.ok(report.schemaTotal.bytes <= budgets.schemaTotalBytes,
    `tool schemas are ${report.schemaTotal.bytes} bytes, over the ${budgets.schemaTotalBytes} budget. Move rare detail into scene_capabilities or reference a shared schema; raise bench/tool-cost-budgets.json only for a feature that needs it.`);
});

test('each large tool schema and every small one stays under its own budget', () => {
  for (const row of report.schemas) {
    const budget = budgets.schemaToolBytes[row.name] ?? budgets.schemaOtherToolBytes;
    assert.ok(row.bytes <= budget, `${row.name} is ${row.bytes} bytes, over its ${budget} budget.`);
  }
});

test('typical results stay under their budgets', () => {
  for (const row of report.results) {
    const budget = budgets.resultBytes[row.name];
    assert.ok(budget !== undefined, `${row.name} has no result budget; add one to bench/tool-cost-budgets.json.`);
    assert.ok(row.bytes <= budget, `${row.name} result is ${row.bytes} bytes, over its ${budget} budget.`);
  }
});

test('a small mesh change as a mesh_edit call is smaller than rewriting the recipe', () => {
  const { meshEditCall, rewriteCall } = report.comparison;
  assert.ok(meshEditCall.bytes * 3 < rewriteCall.bytes, `mesh_edit ${meshEditCall.bytes} B against rewrite ${rewriteCall.bytes} B`);
});
