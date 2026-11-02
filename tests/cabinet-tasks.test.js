import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { CABINET_START, CABINET_START_PLAIN } from '../bench/agent-modeling/cabinet.mjs';

const failedKinds = grade => grade.results.filter(result => !result.pass).map(result => result.kind);

test('the cabinet has 10 parts and the relations version differs from the plain one only by relations', () => {
  assert.equal(CABINET_START.nodes.length, 10);
  const stripped = CABINET_START.nodes.map(({ relations, ...node }) => node);
  assert.deepEqual(stripped, CABINET_START_PLAIN.nodes);
});

test('both cabinet tasks accept their reference and reject a cabinet whose parts were left behind', async () => {
  for (const id of ['cabinet-resize', 'cabinet-resize-plain']) {
    assert.equal((await gradeRecipe(taskById(id), REFERENCES[id])).pass, true, id);
  }
  const bodyOnly = structuredClone(REFERENCES['cabinet-resize-plain']);
  bodyOnly.nodes = bodyOnly.nodes.map(node => (node.id === 'body' ? node : structuredClone(CABINET_START_PLAIN.nodes.find(start => start.id === node.id))));
  const failures = failedKinds(await gradeRecipe(taskById('cabinet-resize-plain'), bodyOnly));
  assert.ok(failures.includes('touches'));
  assert.ok(failures.includes('centreAt'));
});
