import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';

// A closed room: a floor, four walls and a closed roof, lit by a sun.
function room(environment = {}) {
  const wall = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.5, 0.45, 0.4], roughness: 0.8 }],
    nodes: [
      wall('floor', [0, -0.05, 0], [10, 0.1, 10]),
      wall('wall-left', [-5, 2, 0], [0.2, 4, 10]),
      wall('wall-right', [5, 2, 0], [0.2, 4, 10]),
      wall('wall-front', [0, 2, 5], [10, 4, 0.2]),
      wall('wall-back', [0, 2, -5], [10, 4, 0.2]),
      wall('roof-a', [-2.5, 4.1, 0], [5.2, 0.2, 10.4]),
      wall('roof-b', [2.5, 4.1, 0], [5.2, 0.2, 10.4]),
    ],
    camera: { eye: [0, 1.5, 4], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 },
    environment,
  };
}

function floorHasSkyVisibility(scene) {
  return Boolean(scene.parts.find(part => part.name === 'floor').geometry.skyVisibility);
}

test('a closed room lit by a sun gets the floor sky trace by default', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [3, 3, 3] }))), true);
});

test('environment.floorSkyTrace false turns the trace off, and a non-boolean throws', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [3, 3, 3], floorSkyTrace: false }))), false);
  assert.throws(() => createAgentScene(room({ floorSkyTrace: 'no' })), /floorSkyTrace must be a boolean/);
});

test('a room with no sun and open ground are left as they were', () => {
  assert.equal(floorHasSkyVisibility(createAgentScene(room({ keyColor: [0, 0, 0] }))), false);
  const open = room({ keyColor: [3, 3, 3] });
  open.nodes = open.nodes.filter(node => node.id === 'floor' || node.id === 'roof-a');
  assert.equal(floorHasSkyVisibility(createAgentScene(open)), false);
});
