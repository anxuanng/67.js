import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const kind of ['recipe', 'asset']) {
  test(`every preview path that reads a ${kind} scene works when the on-demand scene modules start unloaded`, () => {
    const script = fileURLToPath(new URL('./support/walk-preview-paths.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [script, kind], { encoding: 'utf8' });
    const failures = JSON.parse(output.trim().split('\n').at(-1));
    assert.deepEqual(failures, []);
  });
}
