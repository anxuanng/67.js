import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fragmentsFolder = resolve(root, 'changes');
const changelogPath = resolve(root, 'CHANGELOG.md');
const semver = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;

function isFragmentName(name) {
  return name.endsWith('.md') && name.toLowerCase() !== 'readme.md';
}

function trimBlankLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

// Reads every fragment in name order, so the same files always give the same text.
export async function readFragments(folder = fragmentsFolder) {
  const names = (await readdir(folder)).filter(isFragmentName).sort();
  const fragments = [];
  for (const name of names) {
    const text = trimBlankLines(await readFile(resolve(folder, name), 'utf8'));
    if (text) fragments.push({ name, text });
  }
  return fragments;
}

// Puts a version section above the newest one. Fragment text is copied as it is.
export function foldIntoChangelog(changelogText, version, fragments) {
  const changelog = changelogText.replace(/\r\n/g, '\n');
  if (!semver.test(version)) throw new Error(`Not a valid version: ${version}`);
  if (fragments.length === 0) throw new Error('No change fragments to fold.');
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')}$`, 'm').test(changelog)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }
  const section = `## ${version}\n\n${fragments.map((fragment) => fragment.text).join('\n')}\n\n`;
  const firstSection = changelog.search(/^## /m);
  if (firstSection === -1) return `${changelog.replace(/\s+$/, '')}\n\n${section.trimEnd()}\n`;
  return `${changelog.slice(0, firstSection)}${section}${changelog.slice(firstSection)}`;
}

async function main() {
  const [command, versionArgument] = process.argv.slice(2);
  const fragments = await readFragments();
  if (command === 'fold') {
    const version = versionArgument ?? JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
    const changelog = await readFile(changelogPath, 'utf8');
    await writeFile(changelogPath, foldIntoChangelog(changelog, version, fragments));
    for (const fragment of fragments) await rm(resolve(fragmentsFolder, fragment.name));
    console.log(`Folded ${fragments.length} fragments into CHANGELOG.md as ${version}.`);
    return;
  }
  if (fragments.length === 0) {
    console.log('No pending change notes.');
    return;
  }
  for (const fragment of fragments) console.log(`# changes/${fragment.name}\n${fragment.text}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
