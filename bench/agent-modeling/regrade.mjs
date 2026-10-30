// Grades a finished run's saved recipes again after a checker fix, without spending another agent run.
// node bench/agent-modeling/regrade.mjs <run name>
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gradeRecipe, recipeFeatures } from './check.mjs';
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
  record.pass = grade.pass;
  record.passed = grade.passed;
  record.total = grade.total;
  record.failed = grade.results.filter(result => !result.pass).map(result => `${result.label ?? result.kind}: ${result.detail}`);
  console.log(`${record.task.padEnd(9)} ${record.pass ? 'PASS' : 'FAIL'} ${record.passed}/${record.total}${record.failed.length ? `  ${record.failed.join(' | ')}` : ''}`);
}
summary.passed = summary.records.filter(record => record.pass).length;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${summary.passed}/${summary.tasks} passed.`);
