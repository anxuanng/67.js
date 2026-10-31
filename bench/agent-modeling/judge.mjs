// The vision judge's side of the look score. This script never calls a model: it prints what a judge needs, and
// stores what a judge answered, under the judge's model name.
//
// node bench/agent-modeling/judge.mjs prompt <run> <task>
// node bench/agent-modeling/judge.mjs record <run> <task> --model <name> --scores <shape,proportions,features,surface> [--note <text>]
//
// `prompt` prints the rubric, the task prompt and the image paths (candidate, then reference, per camera). Give them
// to a vision model with no other context. Images come from `look.mjs` (run it first: regrade.mjs does) and
// `node bench/agent-modeling/look.mjs --references`.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LOOK_VIEWS } from './look-cameras.mjs';
import { taskById } from './tasks.mjs';

const repository = resolve(import.meta.dirname, '../..');
export const CRITERIA = ['shape', 'proportions', 'features', 'surface'];
export const CRITERION_MAXIMUM = 3;

function summaryPathOf(runName) {
  return join(repository, 'bench', 'agent-modeling', 'results', `${runName}.json`);
}

/** Turns the four criterion scores into one judge record. Throws on a missing, fractional or out-of-range score. */
export function judgeRecord(scores, note) {
  if (scores.length !== CRITERIA.length) throw new RangeError(`Give ${CRITERIA.length} scores: ${CRITERIA.join(', ')}.`);
  for (const score of scores) {
    if (!Number.isInteger(score) || score < 0 || score > CRITERION_MAXIMUM) throw new RangeError(`Each score is a whole number from 0 to ${CRITERION_MAXIMUM}.`);
  }
  const total = scores.reduce((sum, score) => sum + score, 0);
  return {
    criteria: Object.fromEntries(CRITERIA.map((name, index) => [name, scores[index]])),
    total,
    score: Number((total / (CRITERIA.length * CRITERION_MAXIMUM)).toFixed(4)),
    ...(note ? { note } : {}),
  };
}

async function printPrompt(runName, taskId) {
  const summary = JSON.parse(await readFile(summaryPathOf(runName), 'utf8'));
  const record = summary.records.find(candidate => candidate.task === taskId);
  if (!record?.look?.images?.length) throw new Error(`No look images for ${taskId} in ${runName}. Run regrade.mjs first.`);
  const rubric = await readFile(join(import.meta.dirname, 'rubric.md'), 'utf8');
  console.log(rubric);
  console.log(`Task prompt:\n${taskById(taskId).prompt}\n`);
  for (const [index, { name }] of LOOK_VIEWS.entries()) {
    console.log(`Camera ${name}:`);
    console.log(`  candidate: ${record.look.images[index]}`);
    console.log(`  reference: artifacts/agent-modeling/references/${taskId}-${name}.png`);
  }
}

async function storeRecord(runName, taskId, { model, scores, note }) {
  if (!model || !scores) throw new Error('record needs --model and --scores.');
  const summaryPath = summaryPathOf(runName);
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const record = summary.records.find(candidate => candidate.task === taskId);
  if (!record?.look) throw new Error(`No look record for ${taskId} in ${runName}.`);
  record.look.judges = { ...record.look.judges, [model]: judgeRecord(scores.split(',').map(Number), note) };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`${taskId} judged by ${model}: ${record.look.judges[model].total}/${CRITERIA.length * CRITERION_MAXIMUM}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { model: { type: 'string' }, scores: { type: 'string' }, note: { type: 'string' } },
  });
  const [command, runName, taskId] = positionals;
  if (command === 'prompt') await printPrompt(runName, taskId);
  else if (command === 'record') await storeRecord(runName, taskId, values);
  else throw new Error('Use: prompt <run> <task>, or record <run> <task> --model <name> --scores a,b,c,d');
}
