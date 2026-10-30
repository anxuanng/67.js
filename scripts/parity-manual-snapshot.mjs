// Writes the contents of the Blender manual to a fixture, so tests can find ledger gaps without the network.
// Run it when the ledger moves to a new Blender release: node scripts/parity-manual-snapshot.mjs
import { writeFile } from 'node:fs/promises';

const MANUAL_URL = 'https://docs.blender.org/manual/en/latest/';
const OUTPUT_PATH = new URL('../tests/fixtures/blender-manual-toc.json', import.meta.url);
const DEFAULT_DEPTH = 3;
const DEEPER_SECTIONS = [
  { prefix: 'Modeling > Modifiers > ', depth: 4 },
  { prefix: 'Animation & Rigging > Constraints > ', depth: 4 },
];
const PAGES_WITHOUT_FEATURES = new Set(['Introduction', 'Tips', 'Examples', 'Limitations']);
const FIRST_SECTION = 'User Interface';
const LAST_SECTION = 'Advanced';

function parseEntries(html) {
  const pattern = /<li class="toctree-l(\d)[^"]*"><a class="reference internal" href="[^"]*">([^<]*)<\/a>/g;
  const entries = [];
  for (const match of html.matchAll(pattern)) {
    const title = match[2].replace(/&amp;/g, '&').trim();
    entries.push({ level: Number(match[1]), title });
  }
  return entries;
}

// The page holds the tree twice: once in the sidebar and once in its body.
function firstCopy(entries) {
  const firstTitle = entries[0].title;
  const secondStart = entries.findIndex((entry, index) => index > 0 && entry.level === 1 && entry.title === firstTitle);
  return secondStart < 0 ? entries : entries.slice(0, secondStart);
}

function withPaths(entries) {
  const stack = [];
  return entries.map(entry => {
    stack.length = entry.level - 1;
    stack[entry.level - 1] = entry.title;
    return { ...entry, path: stack.join(' > ') };
  });
}

function featureSections(entries) {
  const start = entries.findIndex(entry => entry.level === 1 && entry.title === FIRST_SECTION);
  const lastStart = entries.findIndex(entry => entry.level === 1 && entry.title === LAST_SECTION);
  const end = entries.findIndex((entry, index) => index > lastStart && entry.level === 1);
  return entries.slice(start, end);
}

function isWithinDepth(entry) {
  const deeper = DEEPER_SECTIONS.find(section => entry.path.startsWith(section.prefix));
  return entry.level <= (deeper?.depth ?? DEFAULT_DEPTH);
}

const response = await fetch(MANUAL_URL);
if (!response.ok) throw new Error(`The manual returned HTTP ${response.status}.`);
const html = await response.text();
const version = html.match(/<title>(Blender [^<]*?) Manual/)?.[1];
if (!version) throw new Error('The manual page has no Blender version in its title.');

const paths = featureSections(withPaths(firstCopy(parseEntries(html))))
  .filter(isWithinDepth)
  .filter(entry => !PAGES_WITHOUT_FEATURES.has(entry.title))
  .map(entry => entry.path);
await writeFile(OUTPUT_PATH, `${JSON.stringify({ version, source: MANUAL_URL, paths }, null, 1)}\n`);
console.log(`Wrote ${paths.length} paths from the ${version} manual.`);
