import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function run(executable, argumentsList, capture = false) {
  const result = spawnSync(executable, argumentsList, { windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`Deployment step failed: ${result.error?.message ?? result.stderr ?? executable}`);
  return result.stdout?.trim();
}

if (run('git', ['status', '--porcelain'], true)) throw new Error('Commit changes before deployment.');
const commit = run('git', ['rev-parse', 'HEAD'], true);
const remoteCommit = run('git', ['ls-remote', 'origin', 'refs/heads/main'], true).split(/\s/)[0];
if (commit !== remoteCommit) throw new Error('Push this commit to origin/main before deployment.');
run(process.execPath, ['scripts/prepare-release.mjs', '--require-clean']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy']);
const release = JSON.parse(await readFile('dist/release.json', 'utf8'));
const response = await fetch('https://67js.codepawl.com/release.json', { cache: 'no-store', signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Live release verification failed: HTTP ${response.status}.`);
const live = await response.json();
if (live.commit !== commit || live.version !== release.version || live.integrity !== release.integrity) throw new Error('Live release differs from the pushed build.');
console.log(`Verified live ${live.packageName}@${live.version} at ${live.commit}.`);
