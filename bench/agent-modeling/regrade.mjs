// Grades a finished run's saved recipes again after a checker fix, without spending another agent run.
// node bench/agent-modeling/regrade.mjs <run name>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gradeRecipe, recipeFeatures } from './check.mjs';
import { scoreLookSafely } from './look.mjs';
import { taskById } from './tasks.mjs';

const repository = resolve(import.meta.dirname, '../..');
const [runName] = process.argv.slice(2);
const summaryPath = join(repository, 'bench', 'agent-modeling', 'results', `${runName}.json`);
const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
for (const record of summary.records) {
  let recipe;
  try {
    recipe = JSON.parse(await readFile(join(repository, 'artifacts', 'agent-modeling', runName, `${record.task}.recipe.json`), 'utf8'));
  } catch {
    continue;
  }
  const grade = await gradeRecipe(taskById(record.task), recipe);
  record.features = recipeFeatures(recipe);
  // Keep a judge's score when the same recipe is scored again.
  const judges = record.look?.judges;
  record.look = await scoreLookSafely(record.task, recipe, { imageDirectory: join(repository, 'artifacts', 'agent-modeling', runName, 'look') });
  if (judges) record.look.judges = judges;
  record.pass = grade.pass;
  record.passed = grade.passed;
  record.total = grade.total;
  record.failed = grade.results.filter(result => !result.pass).map(result => `${result.label ?? result.kind}: ${result.detail}`);
  const lookText = record.look?.silhouette ? `look ${record.look.silhouette.mean}` : 'look n/a';
  console.log(`${record.task.padEnd(9)} ${record.pass ? 'PASS' : 'FAIL'} ${record.passed}/${record.total} ${lookText}${record.failed.length ? `  ${record.failed.join(' | ')}` : ''}`);
}
summary.passed = summary.records.filter(record => record.pass).length;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${summary.passed}/${summary.tasks} passed.`);
