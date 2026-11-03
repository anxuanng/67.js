import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeBaseOf, pullRequestBaseOf, readAcceptedBundles } from '../scripts/size-base.mjs';
import { archiveAllowance, archiveCeilingProblem, archiveGrowthProblem, compareToBase, growthAllowance, parseSizeNote } from '../scripts/size-growth.mjs';

const size = gzip => ({ min: gzip * 3, gzip });

test('core and the scenes get a small fixed allowance, other entries a percentage', () => {
  assert.equal(growthAllowance('entry:core', 80000), 64);
  assert.equal(growthAllowance('scene:lit-box+lazy', 60000), 64);
  assert.equal(growthAllowance('entry:water-reflection', 27000), 540);
  assert.equal(growthAllowance('entry:texture-set', 800), 64);
});

test('a pull request that grows core past the allowance fails with the accept instruction', () => {
  const { problems } = compareToBase({ 'entry:core': size(80100) }, { 'entry:core': size(80000) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /entry:core grew by 100 bytes gzip against the base branch \(80000 to 80100\), over its allowance of 64/);
  assert.match(problems[0], /Reduce it, or accept it: add changes\/<issue>\.size\.md/);
  assert.match(problems[0], /- entry:core: <why it is worth the bytes>/);
});

test('growth inside the allowance, a shrink and a new bundle all pass', () => {
  const measured = { 'entry:core': size(80064), 'entry:model': size(14000), 'entry:fresh': size(500) };
  const base = { 'entry:core': size(80000), 'entry:model': size(14500) };
  const { rows, problems } = compareToBase(measured, base);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map(row => row.growth), [64, -500, null]);
});

test('a size note accepts only the bundles it names', () => {
  const accepted = parseSizeNote('- entry:core: the new lighting pass is worth it\r\nentry:gltf: loads KHR_lights\n\nNo colon here\n- entry:model:\n');
  assert.deepEqual([...accepted.keys()], ['entry:core', 'entry:gltf']);
  const measured = { 'entry:core': size(81000), 'scene:lit-box': size(70000) };
  const base = { 'entry:core': size(80000), 'scene:lit-box': size(66000) };
  const { problems } = compareToBase(measured, base, accepted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /scene:lit-box grew by 4000/);
});

test('the archive gets 2% of the base archive, and a note accepts more', () => {
  assert.equal(archiveAllowance(750000), 15000);
  assert.match(archiveGrowthProblem(765001, 750000), /765001 bytes, 15001 more than the 750000 bytes of the base branch, over its allowance of 15000\. Reduce it, or accept it/);
  assert.match(archiveGrowthProblem(765001, 750000), /- archive: <why it is worth the bytes>/);
  assert.equal(archiveGrowthProblem(765000, 750000), null);
  assert.equal(archiveGrowthProblem(700000, 750000), null);
  assert.equal(archiveGrowthProblem(790000, 750000, new Map([['archive', 'ships the new guide']])), null);
});

test('two pull requests that each grow the archive within the allowance both pass against their own base', () => {
  const mainBase = 750000;
  const firstPull = archiveGrowthProblem(mainBase + 14000, mainBase);
  const mainAfterFirst = mainBase + 14000;
  const secondPull = archiveGrowthProblem(mainAfterFirst + 14000, mainAfterFirst);
  assert.equal(firstPull, null);
  assert.equal(secondPull, null);
  assert.match(archiveGrowthProblem(mainAfterFirst + 16000, mainAfterFirst), /over its allowance of 15280/);
});

test('the release ceiling is a report that names the number a release refreshes', () => {
  assert.match(archiveCeilingProblem(741000, 740000), /over its release ceiling of 740000 in bench\/size\/budgets\.json by 1000/);
  assert.equal(archiveCeilingProblem(739000, 740000), null);
});

function git(folder, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: folder, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitFile(folder, path, text, message) {
  mkdirSync(join(folder, path, '..'), { recursive: true });
  writeFileSync(join(folder, path), text);
  git(folder, 'add', '.');
  git(folder, 'commit', '-q', '-m', message);
}

test('two pull requests that grow different entries merge in sequence without touching each other', () => {
  const folder = mkdtempSync(join(tmpdir(), 'size-sim-'));
  try {
    git(folder, 'init', '-q', '-b', 'main');
    commitFile(folder, 'src/model.js', 'export const model = 1;\n', 'base');
    commitFile(folder, 'src/nature.js', 'export const nature = 1;\n', 'base files');
    commitFile(folder, 'changes/100.size.md', '- entry:other: an earlier pull request, already merged\n', 'earlier note');
    git(folder, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    git(folder, 'checkout', '-q', '-b', 'grow-model');
    commitFile(folder, 'src/model.js', 'export const model = 2;\n', 'grow model');
    commitFile(folder, 'changes/201.size.md', '- entry:model: new joints\n', 'accept model');
    git(folder, 'checkout', '-q', 'main');
    git(folder, 'checkout', '-q', '-b', 'grow-nature');
    commitFile(folder, 'src/nature.js', 'export const nature = 2;\n', 'grow nature');
    commitFile(folder, 'changes/202.size.md', '- entry:nature: new trees\n', 'accept nature');

    assert.deepEqual([...readAcceptedBundles('origin/main', folder).keys()], ['entry:nature']);
    git(folder, 'checkout', '-q', 'grow-model');
    assert.deepEqual([...readAcceptedBundles('origin/main', folder).keys()], ['entry:model']);

    git(folder, 'checkout', '-q', 'main');
    git(folder, 'merge', '-q', '--no-ff', '-m', 'merge model', 'grow-model');
    git(folder, 'merge', '-q', '--no-ff', '-m', 'merge nature', 'grow-nature');
    assert.equal(readFileSync(join(folder, 'src/model.js'), 'utf8'), 'export const model = 2;\n');
    assert.equal(readFileSync(join(folder, 'src/nature.js'), 'utf8'), 'export const nature = 2;\n');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a pull request behind the base branch is compared with the base it was merged into, not the newest tip', () => {
  const folder = mkdtempSync(join(tmpdir(), 'size-behind-'));
  try {
    git(folder, 'init', '-q', '-b', 'main');
    commitFile(folder, 'src/core.js', 'export const core = 1;\n', 'base');
    const mergedInto = git(folder, 'rev-parse', 'HEAD').trim();

    git(folder, 'checkout', '-q', '-b', 'feature');
    commitFile(folder, 'src/model.js', 'export const model = 2;\n', 'grow model');
    commitFile(folder, 'changes/401.size.md', '- entry:model: new joints\n', 'accept model');

    // The base branch moves on after the merge was built, as when another pull request shrinks core.
    git(folder, 'checkout', '-q', 'main');
    commitFile(folder, 'src/core.js', 'export const core = 0;\n', 'shrink core');
    commitFile(folder, 'changes/402.size.md', '- entry:core: another pull request\n', 'another note');
    git(folder, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    // CI tests the merge of the pull request into the base as it was: the first parent is the base, the second the pull request.
    git(folder, 'checkout', '-q', '--detach', mergedInto);
    git(folder, 'merge', '-q', '--no-ff', '-m', 'merge ref', 'feature');

    assert.equal(pullRequestBaseOf(folder), mergedInto);
    assert.equal(mergeBaseOf(mergedInto, folder), mergedInto);
    assert.deepEqual([...readAcceptedBundles(mergedInto, folder).keys()], ['entry:model']);
    assert.equal(git(folder, 'diff', '--name-only', mergedInto, 'HEAD').includes('src/core.js'), false);

    git(folder, 'checkout', '-q', 'main');
    assert.equal(pullRequestBaseOf(folder), null);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
