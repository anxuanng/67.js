import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/${metadata.version}`, { signal: AbortSignal.timeout(30000) });
if (response.ok) {
  const published = await response.json();
  if (published.version !== metadata.version) throw new Error('Registry returned an unexpected version.');
  console.log(`${metadata.name}@${metadata.version} is already published.`);
} else {
  if (response.status !== 404) throw new Error(`Registry version check failed: HTTP ${response.status}.`);
  if (!process.env.GITHUB_ACTIONS || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('Run this release through the GitHub Actions trusted publisher.');
  if (!process.env.npm_execpath) throw new Error('Run this script through npm run publish:ci.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'publish', '--access', 'public'], { windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm publish failed with exit code ${result.status}.`);
}
