import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene } from '../src/agent-scene.js';

// Golden positions come from scripts/blender-cloth.py (Blender's cloth solver, default stiffness, same mass per area).
const golden = JSON.parse(readFileSync(new URL('./fixtures/blender/cloth-golden.json', import.meta.url), 'utf8'));
const SEGMENTS = golden.segments;
const BALL_RADIUS = 0.4;

function recipe(nodes, cloth) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'grid', segments: SEGMENTS }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'paint', color: [1, 1, 1] }],
    nodes, cloth,
  };
}

function worldPositions(scene) {
  const part = scene.parts[0];
  const positions = part.geometry.positions;
  const matrix = part.matrix;
  const points = [];
  for (let index = 0; index < positions.length; index += 3) {
    points.push([0, 1, 2].map(axis => matrix[axis] * positions[index] + matrix[4 + axis] * positions[index + 1] + matrix[8 + axis] * positions[index + 2] + matrix[12 + axis]));
  }
  return points;
}

function meanDistance(ours, theirs) {
  const total = ours.reduce((sum, point, index) => sum + Math.hypot(...point.map((value, axis) => value - theirs[index][axis])), 0);
  return total / ours.length;
}

test('a hanging sheet ends where Blender hangs it, within 1 percent of the sheet height', () => {
  const scene = createAgentScene(recipe(
    [{ id: 'flag', geometry: 'sheet', material: 'paint', translation: [0, 2, 0], scale: [2, 1.5, 1] }],
    { duration: golden.seconds, sheets: [{ node: 'flag', pin: ['top'] }] },
  ));
  scene.sampleMotion(golden.seconds);
  const ours = worldPositions(scene);
  const theirs = golden.cases['hanging-flag'].positions;
  assert.ok(meanDistance(ours, theirs) / 1.5 < 0.01, 'mean vertex distance to the Blender bake');
  assert.ok(Math.abs(Math.min(...ours.map(point => point[1])) - Math.min(...theirs.map(point => point[1]))) < 0.01, 'free edge height');
});

test('a sheet dropped on a ball stays outside it in 67.js and in Blender, though the drape shapes differ', () => {
  const scene = createAgentScene(recipe(
    [{ id: 'sheet', geometry: 'sheet', material: 'paint', translation: [0, 1, 0], rotation: [-0.7071068, 0, 0, 0.7071068], scale: [1.6, 1.6, 1] },
      { id: 'ball', geometry: 'ball', material: 'paint', scale: [BALL_RADIUS, BALL_RADIUS, BALL_RADIUS] }],
    { duration: golden.seconds, sheets: [{ node: 'sheet' }], colliders: [{ node: 'ball', shape: 'ball' }] },
  ));
  scene.sampleMotion(golden.seconds);
  const nearest = points => Math.min(...points.map(point => Math.hypot(...point)));
  assert.ok(nearest(worldPositions(scene)) > BALL_RADIUS - 0.01, 'no 67.js particle inside the ball');
  assert.ok(nearest(golden.cases['drape-over-ball'].positions) > BALL_RADIUS - 0.03, 'no Blender vertex inside the ball');
});
