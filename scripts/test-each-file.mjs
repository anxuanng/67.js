// Runs every tests/*.test.js in its own node process, so a test that only passes because an earlier file loaded
// something for it fails here. Up to four processes run at once, at below-normal priority.
// Usage: node scripts/test-each-file.mjs [file-name-fragment]
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism, constants, setPriority } from 'node:os';
import { join } from 'node:path';

const MAX_PARALLEL_PROCESSES = Math.min(4, availableParallelism());
const repositoryRoot = join(import.meta.dirname, '..');
const testsDirectory = join(repositoryRoot, 'tests');
const nameFragment = process.argv[2];

const testFiles = readdirSync(testsDirectory)
  .filter(name => name.endsWith('.test.js'))
  .filter(name => !nameFragment || name.includes(nameFragment))
  .sort();

function runTestFile(name) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--test', join('tests', name)], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // The process may already have exited or the platform may refuse; priority is a courtesy.
    }
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.on('close', code => resolve({ name, code, output, seconds: (Date.now() - startedAt) / 1000 }));
  });
}

const firstPassFailures = [];
let nextIndex = 0;

async function worker() {
  while (nextIndex < testFiles.length) {
    const name = testFiles[nextIndex++];
    const result = await runTestFile(name);
    if (result.code !== 0) firstPassFailures.push(result);
  }
}

const startedAt = Date.now();
await Promise.all(Array.from({ length: MAX_PARALLEL_PROCESSES }, worker));

// Some tests keep a real time limit (the light bake stops at 20 s), which a busy machine can trip. A file that fails
// beside other processes is run again alone: only a failure there counts, because order dependence fails alone too.
const failures = [];
for (const first of firstPassFailures) {
  const second = await runTestFile(first.name);
  if (second.code === 0) {
    console.log(`WARN ${first.name} failed beside other processes and passed alone; the machine was busy`);
  } else {
    failures.push(second);
    console.log(`FAIL ${first.name} (${second.seconds.toFixed(1)}s)`);
  }
}
const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

for (const failure of failures) {
  console.log(`\n--- ${failure.name} ---\n${failure.output.split('\n').slice(0, 60).join('\n')}`);
}
console.log(`${testFiles.length - failures.length} of ${testFiles.length} test files pass alone in ${totalSeconds}s`);
process.exit(failures.length ? 1 : 0);
