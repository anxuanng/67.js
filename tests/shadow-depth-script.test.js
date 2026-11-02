import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const uvAvailable = spawnSync('uv', ['--version']).status === 0;

// The script measures shadow depth from reference renders; its self test uses a small synthetic image and no renderer.
test('shadow-depth.py passes its self test on a synthetic lit and shadowed image', { skip: !uvAvailable && 'uv is not installed', timeout: 120000 }, () => {
  const run = spawnSync(
    'uv',
    ['run', '--no-project', '--python', '3.12', '--with', 'pillow', '--with', 'numpy', '--with', 'scipy', 'python', '-I', 'bench/reference/shadow-depth.py', '--self-test'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /shadow-depth self-test ok/);
});
