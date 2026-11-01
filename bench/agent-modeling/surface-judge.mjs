// Reference-free look question: does the object sit on a surface, with a believable contact shadow?
// A headless Claude Code session that may only read images answers 0 to 3 for the three cameras of one task.
// node bench/agent-modeling/surface-judge.mjs --claude <path> --model <name> --label <name> --directory <image directory> --tasks a,b
// Images are <directory>/<task>-front.png, -side.png and -three-quarter.png. The answer is printed as JSON.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { LOOK_VIEWS } from './look-cameras.mjs';

export const SURFACE_QUESTION = `You see three renders of one 3D object (front, side, three-quarter). Answer one question only: does the object sit on a surface, with a believable contact shadow under it?
0 = it floats in empty space, no surface and no shadow.
1 = a surface or a shadow is hinted but the object still looks detached.
2 = it sits on a surface, but the contact or shadow is weak or wrong in some view.
3 = it clearly sits on a surface with a believable contact shadow in every view.
Ignore shape, colour and detail. Open every image with the Read tool. Give one sentence, then as the very last line exactly: SURFACE: <0-3>`;

function askJudge({ claude, model, directory, taskId }) {
  const paths = LOOK_VIEWS.map(({ name }) => `${directory}/${taskId}-${name}.png`);
  const result = spawnSync(claude, ['-p', '--model', model, '--output-format', 'json', '--allowedTools', 'Read', '--max-budget-usd', '0.3'],
    { input: `${SURFACE_QUESTION}\n\nImages:\n${paths.join('\n')}`, encoding: 'utf8', timeout: 600000 });
  const parsed = JSON.parse(result.stdout);
  const match = /SURFACE:\s*([0-3])/.exec(parsed.result ?? '');
  return { task: taskId, score: match ? Number(match[1]) : null, costUsd: parsed.total_cost_usd ?? 0, note: String(parsed.result ?? '').split('\n').find(line => line.trim()) };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`) {
  const { values } = parseArgs({ options: { claude: { type: 'string' }, model: { type: 'string' }, label: { type: 'string' }, directory: { type: 'string' }, tasks: { type: 'string' } } });
  const records = values.tasks.split(',').map(taskId => askJudge({ claude: values.claude, model: values.model, directory: values.directory, taskId }));
  console.log(JSON.stringify({ label: values.label, model: values.model, question: 'does the object sit on a surface, with a believable contact shadow', records }, null, 2));
}
