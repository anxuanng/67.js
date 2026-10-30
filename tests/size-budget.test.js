import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { budgetFor, compareToBudgets, formatRows } from '../scripts/size-budget.mjs';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const budgetFile = readJson('../bench/size/budgets.json');
const baseline = readJson('../bench/size/baseline.json');
const manifest = readJson('../package.json');

test('a bundle over its budget is a problem that names the bundle and the fix', () => {
  const { problems } = compareToBudgets({ 'entry:core': { min: 10, gzip: 101 } }, { 'entry:core': 100 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /entry:core is 101 bytes gzip, over its budget of 100 by 1/);
  assert.match(problems[0], /Reduce it, or raise the budget/);
});

test('a bundle at its budget passes', () => {
  assert.deepEqual(compareToBudgets({ 'entry:core': { min: 10, gzip: 100 } }, { 'entry:core': 100 }).problems, []);
});

test('a new bundle needs a budget, and a budget needs a bundle', () => {
  const { problems } = compareToBudgets({ 'entry:new': { min: 1, gzip: 1 } }, { 'entry:gone': 1 });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /entry:new has no budget/);
  assert.match(problems[1], /entry:gone has a budget and no bundle/);
});

test('rows report the change from the baseline', () => {
  const { rows } = compareToBudgets(
    { first: { min: 5, gzip: 110 }, second: { min: 5, gzip: 90 }, third: { min: 5, gzip: 1 } },
    { first: 200, second: 200, third: 200 },
    { first: { gzip: 100 }, second: { gzip: 100 } },
  );
  assert.deepEqual(rows.map(row => row.change), [10, -10, null]);
  const report = formatRows(rows);
  assert.match(report, /\+10/);
  assert.match(report, /-10/);
  assert.match(report, /new/);
});

test('a budget leaves 2% of room, rounded up to 100 bytes', () => {
  assert.equal(budgetFor(10000), 10200);
  assert.equal(budgetFor(10001), 10300);
});

test('every package entry has a source file and a budget', () => {
  const addons = Object.keys(manifest.exports).filter(key => key.startsWith('./addons/'));
  assert.ok(addons.length > 0);
  for (const key of addons) {
    const name = key.slice('./addons/'.length);
    assert.ok(existsSync(new URL(`../src/${name}.js`, import.meta.url)), `No source for ${key}`);
    assert.ok(budgetFile.budgets[`entry:${name}`] > 0, `No budget for ${key}`);
  }
  assert.ok(budgetFile.budgets['entry:core'] > 0);
});

test('the baseline records the three.js version and its scene sizes', () => {
  assert.equal(baseline.threeVersion, manifest.devDependencies.three);
  assert.ok(baseline.three['lit-box'].gzip > 0);
  assert.ok(baseline.three['gltf-box'].gzip > 0);
});
