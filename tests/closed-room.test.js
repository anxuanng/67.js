import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { closedRoomShare, CLOSED_ROOM_SHARE } from '../src/closed-room.js';

const WALL = 0.2;

function wall(id, translation, scale) {
  return { id, geometry: 'box', material: 'stone', translation, scale };
}

// A 10 x 6 x 10 room built from six slabs, or the same room with the roof left out.
function roomRecipe({ roof = true, bake } = {}) {
  const slabs = [
    wall('floor', [0, -3, 0], [10, WALL, 10]),
    wall('north', [0, 0, -5], [10, 6, WALL]),
    wall('south', [0, 0, 5], [10, 6, WALL]),
    wall('west', [-5, 0, 0], [WALL, 6, 10]),
    wall('east', [5, 0, 0], [WALL, 6, 10]),
  ];
  if (roof) slabs.push(wall('roof', [0, 3, 0], [10, WALL, 10]));
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: slabs,
    ...(bake ? { bake } : {}),
  };
}

function diagnosticKinds(recipe) {
  const inspection = createAgentScene(recipe).inspect();
  return (inspection.diagnostics ?? []).map(entry => entry.kind);
}

test('a closed room without a bake gets a diagnostic that names the bake', () => {
  const inspection = createAgentScene(roomRecipe()).inspect();
  const found = inspection.diagnostics.find(entry => entry.kind === 'closed-room-without-bake');
  assert.ok(found, 'expected closed-room-without-bake');
  assert.equal(found.severity, 'warning');
  assert.match(found.fix, /"bake"/);
});

test('a room with a bake, a room with its roof off and a lone solid get no closed room diagnostic', () => {
  assert.ok(!diagnosticKinds(roomRecipe({ roof: false })).includes('closed-room-without-bake'));
  const solid = { ...roomRecipe(), nodes: [wall('block', [0, 0, 0], [4, 4, 4])] };
  assert.ok(!diagnosticKinds(solid).includes('closed-room-without-bake'));
});

test('the ray test counts only inner faces: a room is closed, a solid around the centre is not', () => {
  const matrices = parts => new Map(parts.map(part => [part.name, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])]));
  const triangle = (a, b, c) => ({ positions: new Float32Array([...a, ...b, ...c]), indices: new Uint32Array([0, 1, 2]) });
  // Two large triangles on opposite sides of the centre, wound to face it or to face away from it.
  const facingCentre = [
    { name: 'near', geometry: triangle([-9, -9, -5], [9, -9, -5], [0, 9, -5]) },
    { name: 'far', geometry: triangle([-9, -9, 5], [0, 9, 5], [9, -9, 5]) },
  ];
  const facingAway = [
    { name: 'near', geometry: triangle([-9, -9, -5], [0, 9, -5], [9, -9, -5]) },
    { name: 'far', geometry: triangle([-9, -9, 5], [9, -9, 5], [0, 9, 5]) },
  ];
  assert.ok(closedRoomShare(facingCentre, matrices(facingCentre)) > 0);
  assert.equal(closedRoomShare(facingAway, matrices(facingAway)), 0);
  assert.equal(closedRoomShare([], new Map()), null);
  assert.ok(CLOSED_ROOM_SHARE <= 1);
});

test('the closed room diagnostic disappears once the recipe asks for a bake', async () => {
  const recipe = roomRecipe({ bake: { preset: 'draft' } });
  await loadAgentSceneModules(recipe);
  assert.ok(!diagnosticKinds(recipe).includes('closed-room-without-bake'));
});
