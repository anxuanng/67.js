import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';
import { REFERENCES } from '../bench/agent-modeling/references.mjs';
import { DESK_START, DESK_START_PLAIN } from '../bench/agent-modeling/desk.mjs';

const failedKinds = grade => grade.results.filter(result => !result.pass).map(result => result.kind);

test('the desk has 12 parts and the relations version differs from the plain one only by relations', () => {
  assert.equal(DESK_START.nodes.length, 12);
  const stripped = DESK_START.nodes.map(({ relations, ...node }) => node);
  assert.deepEqual(stripped, DESK_START_PLAIN.nodes);
});

test('both desk tasks accept their reference and reject a desk whose parts were left behind', async () => {
  for (const id of ['desk-resize', 'desk-resize-plain']) {
    assert.equal((await gradeRecipe(taskById(id), REFERENCES[id])).pass, true, id);
  }
  const widenedOnly = structuredClone(REFERENCES['desk-resize-plain']);
  widenedOnly.nodes = widenedOnly.nodes.map(node => (node.id === 'top' ? node : structuredClone(DESK_START_PLAIN.nodes.find(start => start.id === node.id))));
  const failures = failedKinds(await gradeRecipe(taskById('desk-resize-plain'), widenedOnly));
  assert.ok(failures.includes('touches'));
  assert.ok(failures.includes('centreAt'));
});
