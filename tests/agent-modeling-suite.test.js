import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { TASKS, taskById } from '../bench/agent-modeling/tasks.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';

const failedKinds = grade => grade.results.filter(result => !result.pass).map(result => result.label ?? result.kind);

test('every task has a reference solution that passes all its checks', async () => {
  assert.deepEqual(Object.keys(REFERENCES).sort(), TASKS.map(task => task.id).sort());
  for (const task of TASKS) {
    const grade = await gradeRecipe(task, REFERENCES[task.id]);
    assert.equal(grade.pass, true, `${task.id}: ${JSON.stringify(grade.results.filter(result => !result.pass))}`);
  }
});

test('checks reject objects that miss the asked-for features', async () => {
  const plainCrate = structuredClone(REFERENCES.crate);
  plainCrate.geometries[0].edits = plainCrate.geometries[0].edits.slice(0, 6);
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('crate'), plainCrate)).sort(),
    ['raised lid', 'recessed panel on +X', 'recessed panel on -Z', 'size', 'volume'].sort());

  const noUv = await gradeRecipe(taskById('crate-uv'), REFERENCES.crate);
  assert.deepEqual(failedKinds(noUv), ['uv']);

  const solidWindow = structuredClone(REFERENCES.window);
  solidWindow.geometries[0].edits = solidWindow.geometries[0].edits.slice(0, 2);
  assert.ok(failedKinds(await gradeRecipe(taskById('window'), solidWindow)).includes('four open panes'));

  const floatingTable = structuredClone(REFERENCES.table);
  floatingTable.nodes = floatingTable.nodes.map(node => ({ ...node, translation: [node.translation[0], node.translation[1] + 0.1, node.translation[2]] }));
  assert.ok(failedKinds(await gradeRecipe(taskById('table'), floatingTable)).includes('ground'));

  const elevenTeeth = structuredClone(REFERENCES.gear);
  elevenTeeth.geometries[0].contour = elevenTeeth.geometries[0].contour.slice(0, 55);
  assert.ok(failedKinds(await gradeRecipe(taskById('gear'), elevenTeeth)).includes('tips'));
});

test('an invalid recipe fails every check with the reason', async () => {
  const grade = await gradeRecipe(taskById('bolt'), { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [{ id: 'x', geometry: 'missing' }] });
  assert.equal(grade.passed, 0);
  assert.match(grade.results[0].detail, /recipe failed/);
});
