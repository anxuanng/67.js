// Packs the library the way a release does and prints the archive size: node scripts/measure-archive.mjs --json
// The base measurement of the size check runs it inside a checkout of the base branch, so the numbers come from the base source.
// It builds the library and the MCP server like prepare-release.mjs, then asks npm for the size of the archive without writing one.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function run(arguments_, capture = false) {
  const result = spawnSync(process.execPath, arguments_, { encoding: 'utf8', windowsHide: true, stdio: capture ? 'pipe' : ['ignore', 2, 2], maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status !== 0) throw new Error(`${arguments_.join(' ')} failed: ${result.stderr ?? ''}`);
  return result.stdout;
}

// The MCP build records the source commit and refuses a folder that is not a repository. The unpacked base branch is one folder
// of files, so it gets a throwaway repository with one commit, which is clean like a release checkout.
function ensureRepository() {
  if (existsSync('.git')) return;
  const identity = ['-c', 'user.name=archive', '-c', 'user.email=archive@example.com', '-c', 'commit.gpgsign=false'];
  for (const command of [['init', '-q'], ['add', '-A'], [...identity, 'commit', '-q', '-m', 'base']]) {
    const result = spawnSync('git', command, { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES });
    if (result.status !== 0) throw new Error(`git ${command.join(' ')} failed: ${result.stderr}`);
  }
}

export function measureArchiveBytes() {
  ensureRepository();
  run(['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.lib.config.js']);
  run(['scripts/build-mcp.mjs']);
  const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const packResult = JSON.parse(run([npmCli, 'pack', '--ignore-scripts', '--dry-run', '--json'], true));
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  return packed.size;
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ archiveBytes: measureArchiveBytes() }));
}
