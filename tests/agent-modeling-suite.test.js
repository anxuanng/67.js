import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { TASKS, taskById, taskPrompt } from '../bench/agent-modeling/tasks.mjs';
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
  solidWindow.geometries[0].holes = solidWindow.geometries[0].holes.slice(0, 2);
  assert.ok(failedKinds(await gradeRecipe(taskById('window'), solidWindow)).includes('four open panes'));

  const floatingTable = structuredClone(REFERENCES.table);
  floatingTable.nodes = floatingTable.nodes.map(node => ({ ...node, translation: [node.translation[0], node.translation[1] + 0.1, node.translation[2]] }));
  assert.ok(failedKinds(await gradeRecipe(taskById('table'), floatingTable)).includes('ground'));

  const elevenTeeth = structuredClone(REFERENCES.gear);
  elevenTeeth.geometries[0].contour = elevenTeeth.geometries[0].contour.slice(0, 55);
  assert.ok(failedKinds(await gradeRecipe(taskById('gear'), elevenTeeth)).includes('tips'));
});

function movedAlong(node, axis, amount) {
  const translation = [...node.translation];
  translation[axis] += amount;
  return { ...node, translation };
}

test('long tasks reject plausible wrong variants', async () => {
  const smoothPlate = structuredClone(REFERENCES['chamfer-plate']);
  smoothPlate.geometries[0].edits = smoothPlate.geometries[0].edits.filter(edit => edit.op !== 'bevel');
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('chamfer-plate'), smoothPlate)), ['chamfered top edge']);

  const fivePockets = structuredClone(REFERENCES['chamfer-plate']);
  fivePockets.geometries[0].edits.pop();
  assert.ok(failedKinds(await gradeRecipe(taskById('chamfer-plate'), fivePockets)).includes('plate outline and six pockets'));

  const squareRail = structuredClone(REFERENCES['slotted-rail']);
  squareRail.geometries[0].edits = squareRail.geometries[0].edits.filter(edit => edit.op !== 'bevel');
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('slotted-rail'), squareRail)), ['chamfered end edges']);

  const fourSlots = structuredClone(REFERENCES['slotted-rail']);
  fourSlots.geometries[0].edits.pop();
  const fourSlotFailures = failedKinds(await gradeRecipe(taskById('slotted-rail'), fourSlots));
  assert.ok(fourSlotFailures.includes('holes') && fourSlotFailures.includes('bar outline and five slots'));

  const unchangedCrate = failedKinds(await gradeRecipe(taskById('crate-revision'), REFERENCES.crate));
  assert.ok(unchangedCrate.includes('size') && unchangedCrate.includes('raised lid with the hole'));

  const throughHoleCrate = structuredClone(REFERENCES['crate-revision']);
  throughHoleCrate.geometries[0].edits.at(-1).scale = [0.03, 0.6, 0.03];
  assert.ok(failedKinds(await gradeRecipe(taskById('crate-revision'), throughHoleCrate)).includes('hole stops at 0.5 m'));

  const oldBracket = failedKinds(await gradeRecipe(taskById('bracket-revision'), REFERENCES.bracket));
  assert.ok(oldBracket.includes('size') && oldBracket.includes('holes'));

  const lopsidedWorkshop = structuredClone(REFERENCES.workshop);
  lopsidedWorkshop.nodes = lopsidedWorkshop.nodes.filter(node => node.id !== 'chair-leg-3').map(node => (node.id === 'mug' ? movedAlong(node, 1, 0.2) : node));
  const workshopFailures = failedKinds(await gradeRecipe(taskById('workshop'), lopsidedWorkshop));
  assert.ok(workshopFailures.includes('four table legs and four chair legs') && workshopFailures.includes('mug on the table'));
});

test('the robot shot needs both hands on target and a side-on camera', async () => {
  const task = taskById('robot-shot');
  const oneHand = structuredClone(REFERENCES['robot-shot']);
  oneHand.motion.ik.pop();
  assert.deepEqual(failedKinds(await gradeRecipe(task, oneHand)), ['assetReach']);

  const defaultFraming = structuredClone(REFERENCES['robot-shot']);
  defaultFraming.camera.eye = [4, 5, 6];
  assert.deepEqual(failedKinds(await gradeRecipe(task, defaultFraming)), ['shot']);

  const noCamera = structuredClone(REFERENCES['robot-shot']);
  delete noCamera.camera;
  assert.deepEqual(failedKinds(await gradeRecipe(task, noCamera)), ['shot']);
});

test('tasks that change an existing scene carry their starting recipe in the prompt', () => {
  for (const id of ['crate-revision', 'bracket-revision']) {
    const task = taskById(id);
    assert.ok(taskPrompt(task).includes(JSON.stringify(task.startRecipe)), id);
    assert.doesNotMatch(taskPrompt(task), /\n/);
  }
  assert.equal(taskPrompt(taskById('bolt')).includes('scene_create with exactly'), false);
});

test('the pillar court check rejects a grid with a wrong count or spacing', async () => {
  const fourByThree = structuredClone(REFERENCES['pillar-court']);
  fourByThree.nodes[0].instances.grid.counts = [4, 1, 3];
  const missingColumn = failedKinds(await gradeRecipe(taskById('pillar-court'), fourByThree));
  assert.ok(missingColumn.includes('fifteen pillars'), missingColumn.join(', '));
  assert.ok(missingColumn.includes('size'));

  const tooTight = structuredClone(REFERENCES['pillar-court']);
  tooTight.nodes[0].instances.grid.spacing = [3, 1, 5];
  assert.ok(failedKinds(await gradeRecipe(taskById('pillar-court'), tooTight)).includes('size'));
});

test('an invalid recipe fails every check with the reason', async () => {
  const grade = await gradeRecipe(taskById('bolt'), { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [{ id: 'x', geometry: 'missing' }] });
  assert.equal(grade.passed, 0);
  assert.match(grade.results[0].detail, /recipe failed/);
});

test('the tray-drop checks reject a box collider, a missing section and a body that falls through', async () => {
  const boxCollider = structuredClone(REFERENCES['tray-drop']);
  boxCollider.physics.bodies[0].shape = 'box';
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('tray-drop'), boxCollider)), ['tray is a fixed trimesh', 'balls rest on the pocket floor']);

  const noPhysics = structuredClone(REFERENCES['tray-drop']);
  delete noPhysics.physics;
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('tray-drop'), noPhysics)), ['tray is a fixed trimesh', 'balls rest on the pocket floor', 'seek back repeats the frame']);

  const fallingThrough = structuredClone(REFERENCES['tray-drop']);
  fallingThrough.physics.bodies[0].collidesWith = [1];
  assert.deepEqual(failedKinds(await gradeRecipe(taskById('tray-drop'), fallingThrough)), ['balls rest on the pocket floor']);
});
