// Finds the base branch measurement and the size notes of the current pull request. measure-size.mjs and smoke-package.mjs share it.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseSizeNote } from './size-growth.mjs';

export const DEFAULT_BASE_REF = 'origin/main';
const SIZE_NOTE_PATTERN = /^changes\/[^/]+\.size\.md$/;
const SCRIPTS_FOLDER = fileURLToPath(new URL('.', import.meta.url));
// A measuring method names the script that prints JSON for --json and the files that decide its numbers. A script that imports
// the source relative to itself runs from the base checkout (runInBase), so it measures the base source.
export const SIZE_METHOD = { script: join(SCRIPTS_FOLDER, 'measure-size.mjs'), runInBase: false, files: ['measure-size.mjs', 'size-base.mjs', 'size-budget.mjs', 'size-growth.mjs'] };
// CI caches this folder, keyed by the base commit, so a run on an unchanged base skips the second measurement.
export const BASE_CACHE_FOLDER = 'node_modules/.cache/size-base';
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function run(command, args, cwd = process.cwd()) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES });
}

export function baseRefExists(baseRef, cwd = process.cwd()) {
  return run('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], cwd).status === 0;
}

// The commit this branch grew from. On CI the checkout is the pull request merged into the base, so this is the base tip.
// On a branch that has not caught up with the base, it keeps work merged by others out of this branch's numbers.
export function mergeBaseOf(baseRef, cwd = process.cwd()) {
  const result = run('git', ['merge-base', baseRef, 'HEAD'], cwd);
  return result.status === 0 ? result.stdout.trim() : baseRef;
}

// The size notes this pull request adds. Notes already on the base branch belong to other pull requests.
export function addedSizeNoteFiles(baseRef, cwd = process.cwd()) {
  const committed = run('git', ['diff', '--name-only', '--diff-filter=A', mergeBaseOf(baseRef, cwd), 'HEAD', '--', 'changes'], cwd).stdout.split('\n');
  const uncommitted = run('git', ['ls-files', '--others', '--exclude-standard', '--', 'changes'], cwd).stdout.split('\n');
  return [...new Set([...committed, ...uncommitted].map(file => file.trim()))].filter(file => SIZE_NOTE_PATTERN.test(file));
}

export function readAcceptedBundles(baseRef, cwd = process.cwd()) {
  const accepted = new Map();
  if (!baseRefExists(baseRef, cwd)) return accepted;
  for (const file of addedSizeNoteFiles(baseRef, cwd)) {
    for (const [name, reason] of parseSizeNote(readFileSync(resolve(cwd, file), 'utf8'))) accepted.set(name, reason);
  }
  return accepted;
}

// The cache key holds everything that decides the base numbers: the base commit, the measuring method and the lock file.
function cacheFileFor(baseRef, method) {
  const hash = createHash('sha256');
  hash.update(mergeBaseOf(baseRef));
  hash.update(basename(method.script));
  for (const file of method.files) hash.update(readFileSync(join(SCRIPTS_FOLDER, file)));
  if (existsSync('package-lock.json')) hash.update(readFileSync('package-lock.json'));
  return join(BASE_CACHE_FOLDER, `${hash.digest('hex').slice(0, 24)}.json`);
}

async function measureCheckout(baseRef, method) {
  const folder = mkdtempSync(join(tmpdir(), 'size-base-'));
  const checkout = join(folder, 'base');
  try {
    mkdirSync(checkout);
    // A scratch index and checkout-index give the files the same line endings as this checkout, so both sides match on any system.
    const environment = { ...process.env, GIT_INDEX_FILE: join(folder, 'index') };
    const indexed = spawnSync('git', ['read-tree', mergeBaseOf(baseRef)], { encoding: 'utf8', windowsHide: true, env: environment });
    if (indexed.status !== 0) throw new Error(`Could not read ${baseRef}: ${indexed.stderr}`);
    const extracted = spawnSync('git', ['checkout-index', '--all', '--force', `--prefix=${checkout}/`], { encoding: 'utf8', windowsHide: true, env: environment });
    if (extracted.status !== 0) throw new Error(`Could not unpack ${baseRef}: ${extracted.stderr}`);
    if (existsSync('node_modules')) symlinkSync(resolve('node_modules'), join(checkout, 'node_modules'), 'junction');
    const { stdout } = await execFileAsync(process.execPath, [method.runInBase ? join(checkout, 'scripts', basename(method.script)) : method.script, '--json'], { cwd: checkout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
    return JSON.parse(stdout);
  } finally {
    rmSync(join(checkout, 'node_modules'), { force: true });
    rmSync(folder, { recursive: true, force: true });
  }
}

// Measures the base branch with this checkout's script, so both sides use the same method. It runs beside the
// measurement of the pull request, and a cached result for the same base commit skips it.
export async function measureBase(baseRef, method = SIZE_METHOD) {
  const cacheFile = cacheFileFor(baseRef, method);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const measured = await measureCheckout(baseRef, method);
  mkdirSync(BASE_CACHE_FOLDER, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(measured));
  return measured;
}
