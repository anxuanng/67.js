// Totals for the suite's records, kept apart from run.mjs so tests can read them without starting a model.
// CLI: node bench/agent-modeling/aggregate.mjs <results file>... prints one table row per model.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LOCAL_PATH_PATTERN = /(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\s'"`)\]]*/g;

/** Replace anything that looks like a path under a user's home folder, so results never carry a local path. */
export function removeLocalPaths(text) {
  return String(text).replace(LOCAL_PATH_PATTERN, '<local path>');
}

const sum = (records, field) => records.reduce((total, record) => total + (record[field] ?? 0), 0);

/** Success rate, tool calls, tool errors, tokens and cost for one group of records. */
export function totalsOf(records) {
  const passed = records.filter(record => record.pass).length;
  return {
    runs: records.length,
    passed,
    successRate: records.length ? Number((passed / records.length).toFixed(3)) : null,
    toolCalls: sum(records, 'toolCalls'),
    toolErrors: sum(records, 'toolErrors'),
    inputTokens: sum(records, 'inputTokens'),
    outputTokens: sum(records, 'outputTokens'),
    costUsd: Number(sum(records, 'costUsd').toFixed(2)),
  };
}

/** Totals for each model, then for each task within that model, so a task's spread over its runs stays visible. */
export function totalsByModel(records) {
  const models = [...new Set(records.map(record => record.model ?? 'unknown'))];
  return Object.fromEntries(models.map(model => {
    const own = records.filter(record => (record.model ?? 'unknown') === model);
    const tasks = [...new Set(own.map(record => record.task))];
    return [model, { ...totalsOf(own), tasks: Object.fromEntries(tasks.map(task => [task, totalsOf(own.filter(record => record.task === task))])) }];
  }));
}

function formatRow(model, totals) {
  const rate = totals.successRate === null ? '?' : `${Math.round(totals.successRate * 100)}%`;
  return `${model.padEnd(24)} ${String(totals.passed).padStart(3)}/${String(totals.runs).padEnd(3)} ${rate.padStart(5)}  calls ${totals.toolCalls}  errors ${totals.toolErrors}  tokens ${totals.inputTokens} in / ${totals.outputTokens} out  $${totals.costUsd}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const records = [];
  for (const path of process.argv.slice(2)) records.push(...JSON.parse(await readFile(path, 'utf8')).records);
  for (const [model, totals] of Object.entries(totalsByModel(records))) {
    console.log(formatRow(model, totals));
    for (const [task, taskTotals] of Object.entries(totals.tasks)) console.log(`  ${formatRow(task, taskTotals)}`);
  }
}
