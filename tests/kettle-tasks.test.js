import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { KETTLE_START, KETTLE_START_PLAIN } from '../bench/agent-modeling/kettle.mjs';

const failedKinds = grade => grade.results.filter(result => !result.pass).map(result => result.label ?? result.kind);

test('both kettle tasks accept their reference and reject a resized body whose parts were left behind', async () => {
  for (const id of ['kettle-resize', 'kettle-resize-plain']) {
    assert.equal((await gradeRecipe(taskById(id), REFERENCES[id])).pass, true, id);
  }
  const strandedParts = structuredClone(REFERENCES['kettle-resize-plain']);
  strandedParts.nodes = strandedParts.nodes.map(node => (node.id === 'body' ? node : structuredClone(KETTLE_START_PLAIN.nodes.find(start => start.id === node.id))));
  const failures = failedKinds(await gradeRecipe(taskById('kettle-resize-plain'), strandedParts));
  assert.ok(failures.includes('size'));
  assert.ok(failures.includes('touches'));
});

test('the unchanged kettle fails the resize task, and its relations recipe is the one the task starts from', async () => {
  assert.ok(failedKinds(await gradeRecipe(taskById('kettle-resize'), KETTLE_START)).includes('size'));
  assert.equal(taskById('kettle-resize').startRecipe, KETTLE_START);
  assert.ok(KETTLE_START.nodes.some(node => node.relations));
  assert.ok(!KETTLE_START_PLAIN.nodes.some(node => node.relations));
});
