import { readFile, writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(metadata.version)) throw new Error('Release version must be valid semver.');
if (metadata.name !== '@codepawlhq/67js') throw new Error('Unexpected package name.');

function run(executable, argumentsList, capture = false) {
  const result = spawnSync(executable, argumentsList, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`Release command failed: ${result.error?.message ?? result.stderr ?? executable}`);
  return result.stdout?.trim();
}

const commit = run('git', ['rev-parse', 'HEAD'], true);
if (process.argv.includes('--require-clean') && run('git', ['status', '--porcelain'], true)) throw new Error('Commit release changes before production preparation.');
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.lib.config.js']);
const releases = resolve(root, 'public/releases');
await mkdir(releases, { recursive: true });
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npmCli)) throw new Error('npm CLI unavailable. Run preparation through npm run prepare:release.');
const packResult = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', releases], true));
const packed = Array.isArray(packResult) ? packResult[0] : packResult[metadata.name];
if (!packed?.filename) throw new Error('npm pack did not return a package archive.');
const tarball = `/releases/${packed.filename}`;
const integrity = `sha512-${createHash('sha512').update(await readFile(resolve(releases, packed.filename))).digest('base64')}`;
await cp(resolve(root, 'build'), resolve(releases, metadata.version), { recursive: true });
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.browser.config.js']);
await copyFile(resolve(root, 'build-browser/67.module.js'), resolve(releases, metadata.version, '67.module.js'));
await copyFile(resolve(root, 'CHANGELOG.md'), resolve(root, 'public/changelog.md'));

let registryVersion = null;
let registryPublished = false;
try {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(metadata.name)}`, { signal: AbortSignal.timeout(5000) });
  if (response.ok) {
    const registry = await response.json();
    registryVersion = registry['dist-tags']?.latest ?? null;
    registryPublished = Boolean(registry.versions?.[metadata.version]);
  }
} catch {
  // The downloadable package remains usable when the external registry is unavailable.
}

const release = {
  version: metadata.version,
  packageName: metadata.name,
  packageAlias: '67js',
  commit,
  installCommand: registryPublished ? `npm install 67js@npm:${metadata.name}@${metadata.version}` : `npm install 67js@https://67js.codepawl.com${tarball}`,
  tarball,
  module: `/releases/${metadata.version}/67.module.js`,
  registryPublished,
  registryVersion,
  integrity,
  packageBytes: packed.size,
  api: './getting-started.html#api',
  changelog: '/changelog.md',
};
await writeFile(resolve(root, 'public/release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(`Prepared ${metadata.name}@${metadata.version}: ${packed.size} bytes, commit ${commit.slice(0, 8)}, registry published ${registryPublished}.`);
