import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeRecipe } from '../bench/agent-modeling/check.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { AGENT_PART_TYPES, AGENT_PART_CATALOG } from '../src/agent-part-catalog.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { expandParts } from '../src/agent-parts.js';

const PIPE_POINTS = [[0, 0.1, 0], [1, 0.1, 0], [1, 0.1, 1], [1, 1, 1]];

function recipeWithParts(parts, extra = {}) {
  return { format: '67js.scene', schemaVersion: 1, nodes: [], parts, ...extra };
}

function defaultPart(type) {
  return { id: `${type}-1`, type, ...(type === 'pipe' ? { points: PIPE_POINTS } : {}) };
}

function bounds(scene, id) {
  return scene.inspect({ ids: [id], includeBounds: true }).nodes[0].bounds;
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} is not ${expected}`);
}

test('every part type expands, builds and leaves a plain recipe without parts', () => {
  assert.deepEqual([...AGENT_PART_TYPES].sort(), Object.keys(AGENT_PART_CATALOG).sort());
  for (const type of AGENT_PART_TYPES) {
    const scene = createAgentScene(recipeWithParts([defaultPart(type)]));
    const recipe = scene.exportRecipe();
    assert.equal(Object.hasOwn(recipe, 'parts'), false, type);
    assert.ok(recipe.nodes.length >= 2 || type === 'gear', type);
    assert.ok(recipe.nodes.every(node => node.id.startsWith(`${type}-1.`)), type);
  }
});

test('expansion is deterministic and each node sits where its relations solve', () => {
  for (const type of AGENT_PART_TYPES.filter(name => name !== 'gear')) {
    const part = defaultPart(type);
    assert.deepEqual(expandParts([part]), expandParts([part]), type);
    const scene = createAgentScene(recipeWithParts([part]));
    for (const node of expandParts([part]).nodes) {
      const box = bounds(scene, node.id);
      for (const axis of [0, 1, 2]) {
        near((box.min[axis] + box.max[axis]) / 2, node.translation[axis], `${node.id} axis ${axis}`);
      }
    }
  }
});

test('parts built with defaults pass the suite checks of the same object', async () => {
  const suiteParts = {
    bolt: { id: 'bolt-1', type: 'bolt' },
    window: { id: 'window-1', type: 'window' },
    table: { id: 'table-1', type: 'table' },
    chair: { id: 'chair-1', type: 'chair' },
    gear: { id: 'gear-1', type: 'gear' },
  };
  for (const [taskId, part] of Object.entries(suiteParts)) {
    const recipe = createAgentScene(recipeWithParts([part])).exportRecipe();
    const grade = await gradeRecipe(taskById(taskId), recipe);
    assert.equal(grade.pass, true, `${taskId}: ${JSON.stringify(grade.results.filter(result => !result.pass))}`);
  }
});

test('at moves the part and on stands it on another node, centred', () => {
  const recipe = recipeWithParts([
    { id: 'desk', type: 'table', at: [2, 0, 3] },
    { id: 'light', type: 'lamp', on: 'desk.top' },
  ]);
  const scene = createAgentScene(recipe);
  const top = bounds(scene, 'desk.top');
  const base = bounds(scene, 'light.base');
  near(top.min[0], 2 - 0.6, 'table at x');
  near(base.min[1], top.max[1], 'lamp base rests on the top');
  near((base.min[0] + base.max[0]) / 2, (top.min[0] + top.max[0]) / 2, 'lamp centred on x');
  near((base.min[2] + base.max[2]) / 2, (top.min[2] + top.max[2]) / 2, 'lamp centred on z');
  const shade = bounds(scene, 'light.shade');
  near(shade.max[1], top.max[1] + 0.45, 'lamp keeps its height');
});

test('moving or resizing the anchor carries the rest of the part', () => {
  const scene = createAgentScene(recipeWithParts([{ id: 'desk', type: 'table' }]));
  scene.apply([{ type: 'set-node', id: 'desk.top', scale: [2, 0.04, 1], translation: [1, 0.73, 0] }], { expectedRevision: scene.revision });
  const top = bounds(scene, 'desk.top');
  const leg = bounds(scene, 'desk.leg-right-front');
  near(leg.max[0], top.max[0] - 0.05, 'right leg follows the wider top');
  near(leg.max[2], top.max[2] - 0.05, 'front leg follows the deeper top');
  near(leg.max[1], top.min[1], 'leg stays under the top');
});

test('add-part adds a part to a live scene and reuses shared geometry', () => {
  const scene = createAgentScene(recipeWithParts([{ id: 'a', type: 'crate' }]));
  scene.apply([{ type: 'add-part', part: { id: 'b', type: 'crate', at: [1, 0, 0] } }], { expectedRevision: scene.revision });
  const recipe = scene.exportRecipe();
  assert.equal(recipe.nodes.filter(node => node.id.startsWith('b.')).length, 6);
  assert.equal(recipe.geometries.filter(geometry => geometry.id === 'part-box').length, 1);
  assert.throws(() => scene.apply([{ type: 'add-part', part: { id: 'b', type: 'crate' } }], { expectedRevision: scene.revision }), /Duplicate nodes ID/);
});

test('a material ID replaces the main body material', () => {
  const recipe = recipeWithParts([{ id: 'desk', type: 'table', material: 'oak' }], { materials: [{ id: 'oak', color: [0.5, 0.3, 0.1] }] });
  const nodes = createAgentScene(recipe).exportRecipe().nodes;
  assert.ok(nodes.every(node => node.material === 'oak'));
});

test('the pipe follows its points with joints and flanges', () => {
  const scene = createAgentScene(recipeWithParts([{ id: 'line', type: 'pipe', points: PIPE_POINTS, radius: 0.05 }]));
  const ids = scene.exportRecipe().nodes.map(node => node.id);
  assert.deepEqual(ids.filter(id => id.includes('run')), ['line.run-1', 'line.run-2', 'line.run-3']);
  assert.equal(ids.filter(id => id.includes('joint')).length, 2);
  assert.equal(ids.filter(id => id.includes('flange')).length, 2);
  const run = bounds(scene, 'line.run-3');
  near(run.max[1] - run.min[1], 0.9, 'last run climbs 0.9 m');
});

test('capabilities list every part with defaults and ranges', () => {
  const listed = AGENT_SCENE_CAPABILITIES.parts.types;
  assert.deepEqual(Object.keys(listed).sort(), [...AGENT_PART_TYPES].sort());
  assert.match(listed.table, /width 1\.2, depth 0\.75/);
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('add-part'));
});

const HOSTILE_PARTS = [
  ['unknown type', { id: 'x', type: 'throne' }, /needs a type/],
  ['no type', { id: 'x' }, /needs a type/],
  ['prototype type', { id: 'x', type: '__proto__' }, /needs a type/],
  ['constructor type', { id: 'x', type: 'constructor' }, /needs a type/],
  ['missing id', { type: 'table' }, /id of 1 to 64/],
  ['long id', { id: 'a'.repeat(65), type: 'table' }, /id of 1 to 64/],
  ['blank id', { id: '   ', type: 'table' }, /id of 1 to 64/],
  ['unknown field', { id: 'x', type: 'table', colour: 'red' }, /unknown field "colour"/],
  ['unknown field on a window', { id: 'x', type: 'window', points: [] }, /unknown field "points"/],
  ['negative size', { id: 'x', type: 'table', width: -1 }, /width must be a number from 0.2 to 4/],
  ['huge size', { id: 'x', type: 'table', width: 1e9 }, /width must be/],
  ['NaN size', { id: 'x', type: 'table', width: Number.NaN }, /finite, acyclic JSON/],
  ['string size', { id: 'x', type: 'table', width: '2' }, /width must be/],
  ['fractional count', { id: 'x', type: 'chair', slats: 2.5 }, /slats must be a whole number/],
  ['too many columns', { id: 'x', type: 'window', columns: 7 }, /columns must be a whole number from 1 to 6/],
  ['too many teeth', { id: 'x', type: 'gear', teeth: 1e6 }, /teeth must be/],
  ['frame leaves no panes', { id: 'x', type: 'window', frame: 0.3, width: 0.5 }, /leave no room/],
  ['legs do not fit', { id: 'x', type: 'table', width: 0.2, leg: 0.3 }, /legs do not fit/],
  ['gear radii', { id: 'x', type: 'gear', rootRadius: 0.2 }, /boreRadius < rootRadius < outerRadius/],
  ['bolt head', { id: 'x', type: 'bolt', headFlats: 0.01 }, /narrower than the shaft/],
  ['at and on', { id: 'x', type: 'table', at: [0, 0, 0], on: 'floor' }, /both at and on/],
  ['at not finite', { id: 'x', type: 'table', at: [Number.POSITIVE_INFINITY, 0, 0] }, /finite, acyclic JSON/],
  ['at too far', { id: 'x', type: 'table', at: [1e9, 0, 0] }, /at must be/],
  ['at wrong length', { id: 'x', type: 'table', at: [0, 0] }, /at must be/],
  ['on not text', { id: 'x', type: 'table', on: 7 }, /on must be/],
  ['on for a pipe', { id: 'x', type: 'pipe', points: PIPE_POINTS, on: 'floor' }, /placed with at/],
  ['material not text', { id: 'x', type: 'table', material: {} }, /material must be/],
  ['pipe without points', { id: 'x', type: 'pipe' }, /points must be 2 to 16/],
  ['pipe with one point', { id: 'x', type: 'pipe', points: [[0, 0, 0]] }, /points must be 2 to 16/],
  ['pipe with 17 points', { id: 'x', type: 'pipe', points: Array.from({ length: 17 }, (_, index) => [index, 0, 0]) }, /points must be 2 to 16/],
  ['pipe point not finite', { id: 'x', type: 'pipe', points: [[0, 0, 0], [Number.NaN, 0, 0]] }, /finite, acyclic JSON/],
  ['pipe far away', { id: 'x', type: 'pipe', points: [[0, 0, 0], [1e9, 0, 0]] }, /points must be 2 to 16/],
  ['diagonal pipe step', { id: 'x', type: 'pipe', points: [[0, 0, 0], [1, 1, 0]] }, /exactly one coordinate/],
  ['repeated pipe point', { id: 'x', type: 'pipe', points: [[0, 0, 0], [0, 0, 0]] }, /exactly one coordinate/],
  ['short pipe step', { id: 'x', type: 'pipe', points: [[0, 0, 0], [0.01, 0, 0]], radius: 0.05 }, /shorter than the radius/],
];

for (const [name, part, message] of HOSTILE_PARTS) {
  test(`hostile part rejected: ${name}`, () => {
    assert.throws(() => createAgentScene(recipeWithParts([part])), message);
  });
}

test('hostile parts lists are rejected', () => {
  assert.throws(() => createAgentScene(recipeWithParts('table')), /array of at most 64/);
  assert.throws(() => createAgentScene(recipeWithParts(null)), /array of at most 64/);
  assert.throws(() => createAgentScene(recipeWithParts(Array.from({ length: 65 }, (_, index) => ({ id: `t${index}`, type: 'crate' })))), /at most 64/);
  assert.throws(() => createAgentScene(recipeWithParts([null])), /needs a type/);
  assert.throws(() => createAgentScene(recipeWithParts([{ id: 'x', type: 'crate' }, { id: 'x', type: 'crate' }])), /Duplicate part ID/);
  assert.throws(() => createAgentScene(recipeWithParts([{ id: 'x', type: 'table', on: 'nowhere' }])), /no node has that ID/);
  assert.throws(() => createAgentScene(recipeWithParts([{ id: 'x', type: 'table', material: 'missing' }])), /missing/);
  assert.throws(() => createAgentScene(recipeWithParts([{ id: 'x.top', type: 'table' }, { id: 'x', type: 'table' }], { nodes: [{ id: 'x.top' }] })), /./);
});

test('a prototype-polluting key is refused before expansion', () => {
  const part = JSON.parse('{"id":"x","type":"table","__proto__":{"width":99}}');
  assert.throws(() => createAgentScene(recipeWithParts([part])), /Invalid JSON key/);
  assert.equal({}.width, undefined);
});

test('the parts of a recipe the user stacks can chain: lamp on a table on a user floor', () => {
  const recipe = recipeWithParts([{ id: 'desk', type: 'table', on: 'floor' }, { id: 'light', type: 'lamp', on: 'desk.top' }], {
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.4, 0.4, 0.4] }],
    nodes: [{ id: 'floor', geometry: 'slab', material: 'stone', translation: [0, -0.05, 0], scale: [6, 0.1, 6] }],
  });
  const scene = createAgentScene(recipe);
  near(bounds(scene, 'desk.leg-left-back').min[1], 0, 'table legs on the floor top');
  near(bounds(scene, 'light.base').min[1], 0.75, 'lamp on the table top');
});
