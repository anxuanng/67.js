import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { removeLocalPaths, totalsByModel, totalsOf } from '../bench/agent-modeling/aggregate.mjs';

const record = (task, model, pass, extra = {}) => ({ task, model, pass, toolCalls: 3, toolErrors: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.25, ...extra });

test('totals count success rate, calls, errors, tokens and cost for each model and task', () => {
  const records = [
    record('crate', 'sonnet', true), record('crate', 'sonnet', false), record('bolt', 'sonnet', true),
    record('crate', 'haiku', false, { costUsd: 0.05 }),
  ];
  const byModel = totalsByModel(records);
  assert.deepEqual(Object.keys(byModel), ['sonnet', 'haiku']);
  assert.equal(byModel.sonnet.runs, 3);
  assert.equal(byModel.sonnet.successRate, 0.667);
  assert.equal(byModel.sonnet.toolCalls, 9);
  assert.equal(byModel.sonnet.costUsd, 0.75);
  assert.equal(byModel.sonnet.tasks.crate.passed, 1);
  assert.equal(byModel.haiku.successRate, 0);
  assert.equal(totalsOf([]).successRate, null);
});

test('local paths are removed from recorded text', () => {
  assert.equal(removeLocalPaths('imported from C:\\Users\\someone\\code\\src\\file.js (x)'), 'imported from <local path> (x)');
  assert.equal(removeLocalPaths('see /home/someone/code/file.js'), 'see <local path>');
  assert.equal(removeLocalPaths('no path here'), 'no path here');
});

test('no recorded result holds a local path', async () => {
  const directory = new URL('../bench/agent-modeling/results/', import.meta.url);
  for (const name of await readdir(directory)) {
    const text = await readFile(new URL(name, directory), 'utf8');
    assert.equal(removeLocalPaths(text), text, `${name} holds a local path`);
  }
});
