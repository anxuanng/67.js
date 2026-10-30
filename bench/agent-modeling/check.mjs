// Grades an exported recipe against a task's checks. CLI: node bench/agent-modeling/check.mjs <task-id> <recipe.json>
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { measureRecipe } from './measure.mjs';
import { taskById } from './tasks.mjs';

const AXES = { x: 0, y: 1, z: 2 };
const SIZE_TOLERANCE = 0.03;
const SIZE_FLOOR = 0.003;
const GROUND_TOLERANCE = 0.005;

const round = value => Number(value.toPrecision(4));

function checkOne(check, measures) {
  switch (check.kind) {
    case 'lint':
      return { pass: measures.lintProblems === 0 && measures.closedParts === measures.parts, detail: measures.lintProblems ? measures.problemKinds.join(', ') : `${measures.closedParts}/${measures.parts} parts closed` };
    case 'parts':
      return { pass: measures.parts <= check.max, detail: `${measures.parts} parts` };
    case 'size': {
      const failures = [];
      check.expected.forEach((expected, axis) => {
        if (expected === null) return;
        const allowed = Math.max(expected * SIZE_TOLERANCE, SIZE_FLOOR);
        if (Math.abs(measures.size[axis] - expected) > allowed) failures.push(`${'xyz'[axis]} ${round(measures.size[axis])} vs ${expected}`);
      });
      return { pass: failures.length === 0, detail: failures.join('; ') || measures.size.map(round).join(' x ') };
    }
    case 'extent': {
      const values = check.axes.map(axis => measures.size[AXES[axis]]);
      return { pass: values.every(value => value >= check.min && value <= check.max), detail: values.map(round).join(', ') };
    }
    case 'ground': {
      const centreX = (measures.bounds.min[0] + measures.bounds.max[0]) / 2;
      const centreZ = (measures.bounds.min[2] + measures.bounds.max[2]) / 2;
      const footprint = Math.max(measures.size[0], measures.size[2]);
      // The mug's handle moves its bounds off centre, so that task checks only the ground.
      const centred = check.centred === false || Math.abs(centreX) <= Math.max(0.05 * footprint, SIZE_FLOOR) && Math.abs(centreZ) <= Math.max(0.05 * footprint, SIZE_FLOOR);
      return { pass: Math.abs(measures.bounds.min[1]) <= GROUND_TOLERANCE && centred, detail: `min y ${round(measures.bounds.min[1])}, centre ${round(centreX)}, ${round(centreZ)}` };
    }
    case 'holes':
      return { pass: measures.holes === check.equals, detail: measures.holes === null ? 'not closed' : `${measures.holes} through holes` };
    case 'volume':
      return { pass: measures.volume >= check.min && measures.volume <= check.max, detail: `${round(measures.volume)} m3` };
    case 'section': {
      const loops = measures.section(check.axis, check.at);
      return { pass: loops === check.equals, detail: `${loops} loops at ${check.axis} = ${check.at}` };
    }
    case 'through': {
      const blockedOpen = check.open.filter(point => measures.lineHits(check.axis, point) > 0);
      const missing = check.solid.filter(point => measures.lineHits(check.axis, point) === 0);
      const problems = [...blockedOpen.map(point => `blocked at ${point}`), ...missing.map(point => `missing at ${point}`)];
      return { pass: problems.length === 0, detail: problems.join('; ') || `${check.open.length} open, ${check.solid.length} solid along ${check.axis}` };
    }
    case 'pattern': {
      const found = measures.patternTypes.filter(type => check.types.includes(type));
      return { pass: found.length > 0, detail: measures.patternTypes.join(', ') || 'no material pattern' };
    }
    case 'tips':
      return { pass: measures.tips === check.equals, detail: `${measures.tips} tips` };
    case 'triangles':
      return { pass: measures.triangles >= check.min, detail: `${measures.triangles} triangles` };
    case 'uv': {
      const everyPart = measures.uv.parts === measures.uv.of;
      return { pass: everyPart && measures.uv.stretch <= check.maxStretch, detail: everyPart ? `stretch ${round(measures.uv.stretch)}` : `${measures.uv.parts}/${measures.uv.of} nodes have UVs` };
    }
    default:
      throw new TypeError(`Unknown check kind ${check.kind}.`);
  }
}

/** What a recipe was built from, to see which tools agents actually reach for: geometry types and mesh operations. */
export function recipeFeatures(recipe) {
  const geometries = recipe.geometries ?? [];
  const operations = geometries.flatMap(geometry => [...(geometry.edits ?? []), ...(geometry.stack ?? [])].map(edit => edit.op));
  return { geometryTypes: [...new Set(geometries.map(geometry => geometry.type))], meshOperations: [...new Set(operations)] };
}

/** Grade a recipe: { pass, passed, total, results: [{ kind, label, pass, detail }] }. An invalid recipe fails every check. */
export async function gradeRecipe(task, recipe) {
  let measures;
  try {
    measures = await measureRecipe(recipe);
  } catch (error) {
    const results = task.checks.map(check => ({ kind: check.kind, label: check.label, pass: false, detail: `recipe failed: ${error.message}` }));
    return { pass: false, passed: 0, total: results.length, results };
  }
  const results = task.checks.map(check => ({ kind: check.kind, ...(check.label ? { label: check.label } : {}), ...checkOne(check, measures) }));
  const passed = results.filter(result => result.pass).length;
  return { pass: passed === results.length, passed, total: results.length, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [taskId, recipePath] = process.argv.slice(2);
  const grade = await gradeRecipe(taskById(taskId), JSON.parse(await readFile(recipePath, 'utf8')));
  console.log(JSON.stringify(grade, null, 2));
  process.exitCode = grade.pass ? 0 : 1;
}
