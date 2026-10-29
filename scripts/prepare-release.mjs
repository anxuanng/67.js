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
run(process.execPath, ['scripts/build-mcp.mjs']);
const releases = resolve(root, 'public/releases');
await mkdir(releases, { recursive: true });
const npmCli = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npmCli)) throw new Error('npm CLI unavailable. Run preparation through npm run prepare:release.');
const packResult = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', releases], true));
const packed = Array.isArray(packResult) ? packResult[0] : packResult[metadata.name];
if (!packed?.filename) throw new Error('npm pack did not return a package archive.');
const tarball = `/releases/${packed.filename}`;
let archive = await readFile(resolve(releases, packed.filename));
let integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
await cp(resolve(root, 'build'), resolve(releases, metadata.version), { recursive: true });
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.browser.config.js']);
await copyFile(resolve(root, 'build-browser/67.module.js'), resolve(releases, metadata.version, '67.module.js'));
await copyFile(resolve(root, 'CHANGELOG.md'), resolve(root, 'public/changelog.md'));
await copyFile(resolve(root, 'docs/guide.md'), resolve(root, 'public/guide.md'));
await copyFile(resolve(root, 'docs/gltf.md'), resolve(root, 'public/gltf.md'));
const sourceDocuments = [
  'scene-graph.md', 'modeling.md', 'animation-curves.md', 'animation-mixer.md',
  'gltf-morph.md', 'morph-targets.md', 'skinning.md', 'physics.md',
  'export-glb.md', 'sculpt.md', 'surface.md', 'mesh-query.md', 'primitives.md', 'shrinkwrap.md', 'spume.md',
  'retarget.md',
  'vehicle.md',
  'vegetation.md', 'terrain.md',
  'camera-path.md', 'lighting.md', 'volumetric.md', 'film-physics.md',
  'surface-attachment.md', 'agent-scene.md', 'mcp.md', 'agent-look.md', 'agent-asset.md', 'agent-render-jobs.md', 'agent-motion.md', 'agent-character-motion.md', 'agent-review.md',
];
for (const name of sourceDocuments) {
  await copyFile(resolve(root, 'docs', name), resolve(root, 'public', name));
}

let registryVersion = null;
let registryPublished = false;
let publishedPackage;
try {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(metadata.name)}`, { signal: AbortSignal.timeout(5000) });
  if (response.ok) {
    const registry = await response.json();
    registryVersion = registry['dist-tags']?.latest ?? null;
    publishedPackage = registry.versions?.[metadata.version];
    registryPublished = Boolean(publishedPackage);
  }
} catch {
  // The downloadable package remains usable when the external registry is unavailable.
}

if (publishedPackage) {
  const canonicalURL = new URL(publishedPackage.dist.tarball);
  if (canonicalURL.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected registry archive origin.');
  const response = await fetch(canonicalURL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Canonical package download failed: HTTP ${response.status}.`);
  archive = Buffer.from(await response.arrayBuffer());
  integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (integrity !== publishedPackage.dist.integrity) throw new Error('Canonical package integrity verification failed.');
  await writeFile(resolve(releases, packed.filename), archive);
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
  packageBytes: archive.length,
  api: './docs.html#renderer-reference',
  changelog: '/changelog.md',
};
await writeFile(resolve(root, 'public/release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(`Prepared ${metadata.name}@${metadata.version}: ${packed.size} bytes, commit ${commit.slice(0, 8)}, registry published ${registryPublished}.`);
