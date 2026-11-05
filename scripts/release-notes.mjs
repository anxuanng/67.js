// Prints the release notes for a version: its CHANGELOG.md section and the npm install line.
// Usage: node scripts/release-notes.mjs [version]   (defaults to the version in package.json)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractVersionSection } from './changelog-fragments.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function releaseNotes(changelogText, version, packageName) {
  const section = extractVersionSection(changelogText, version);
  return `${section}\n\nInstall: \`npm install ${packageName}@${version}\`\n`;
}

async function main() {
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const version = process.argv[2] ?? metadata.version;
  const changelogText = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  process.stdout.write(releaseNotes(changelogText, version, metadata.name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
