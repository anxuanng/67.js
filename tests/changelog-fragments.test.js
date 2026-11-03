import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldIntoChangelog, readFragments } from '../scripts/changelog-fragments.mjs';

const changelog = '# Changelog\n\n## 0.14.0\n\n- Old note.\n';

async function withFragments(files, check) {
  const folder = await mkdtemp(join(tmpdir(), 'fragments-'));
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
    await check(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('fragments are read in name order, skipping the README and empty files', async () => {
  await withFragments({ 'b.md': '- B.\n', 'a.md': '\n- A.\n\n', 'README.md': 'Format.', 'empty.md': '\n', '337.size.md': '- entry:core: why' }, async (folder) => {
    const fragments = await readFragments(folder);
    assert.deepEqual(fragments.map((fragment) => fragment.name), ['a.md', 'b.md']);
  });
});

test('folding puts the notes above the newest release and keeps their text', async () => {
  await withFragments({ 'b.md': '- B, with `code` and **bold**.\r\n', 'a.md': '- A one.\n\n- A two.\n' }, async (folder) => {
    const fragments = await readFragments(folder);
    const folded = foldIntoChangelog(changelog, '0.15.0', fragments);
    assert.equal(folded, '# Changelog\n\n## 0.15.0\n\n- A one.\n\n- A two.\n- B, with `code` and **bold**.\n\n## 0.14.0\n\n- Old note.\n');
    assert.equal(foldIntoChangelog(changelog, '0.15.0', await readFragments(folder)), folded);
  });
});

test('folding refuses a repeated version, a bad version and an empty list', () => {
  assert.throws(() => foldIntoChangelog(changelog, '0.14.0', [{ name: 'a.md', text: '- A.' }]), /already has/);
  assert.throws(() => foldIntoChangelog(changelog, 'next', [{ name: 'a.md', text: '- A.' }]), /valid version/);
  assert.throws(() => foldIntoChangelog(changelog, '0.15.0', []), /No change fragments/);
});
