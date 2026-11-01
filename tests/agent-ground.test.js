import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { agentGroundPlacement, createAgentGround, placeAgentGround } from '../src/agent-ground.js';
import { normalizeAgentLook } from '../src/agent-look.js';

function boxPart(center, size) {
  const [halfX, halfY, halfZ] = size.map(value => value / 2);
  const corners = [];
  for (const x of [-halfX, halfX]) for (const y of [-halfY, halfY]) for (const z of [-halfZ, halfZ]) corners.push(x, y, z);
  return { geometry: { positions: new Float32Array(corners) }, matrix: mat4.fromTranslation(mat4.create(), center) };
}

const defaultEnvironment = normalizeAgentLook({}).environment;

test('an object with nothing under it gets a floor at its lowest height', () => {
  const placement = agentGroundPlacement([boxPart([1, 2, 3], [2, 1, 2])], defaultEnvironment);
  assert.equal(placement.height, 1.5);
  assert.deepEqual(placement.center, [1, 3]);
  assert.ok(placement.radius >= 2);
});

test('a wide thin lowest part counts as the recipe own floor', () => {
  const slab = boxPart([0, -0.05, 0], [10, 0.1, 10]);
  const crate = boxPart([0, 0.5, 0], [1, 1, 1]);
  assert.equal(agentGroundPlacement([slab, crate], defaultEnvironment), null);
});

test('a lone flat object, such as a gear lying down, still gets a floor', () => {
  const gear = boxPart([0, 0.01, 0], [0.2, 0.02, 0.2]);
  assert.equal(agentGroundPlacement([gear], defaultEnvironment).height, 0);
});

test('a room floor counts as a floor although its walls are as wide', () => {
  const floor = boxPart([0, -0.05, 0], [6, 0.1, 6]);
  const backWall = boxPart([0, 1.5, -3], [6, 3, 0.2]);
  const sideWall = boxPart([-3, 1.5, 0], [0.2, 3, 6]);
  assert.equal(agentGroundPlacement([floor, backWall, sideWall], defaultEnvironment), null);
});

test('a raised tabletop, a tall wall and a small plate do not count as a floor', () => {
  const legs = boxPart([0, 0.35, 0], [1.2, 0.7, 0.7]);
  const top = boxPart([0, 0.75, 0], [1.2, 0.05, 0.7]);
  assert.ok(agentGroundPlacement([legs, top], defaultEnvironment));
  const wall = boxPart([0, 1, 0], [10, 2, 0.2]);
  assert.ok(agentGroundPlacement([wall, boxPart([0, 0.5, 3], [1, 1, 1])], defaultEnvironment));
});

test('environment.ground false removes it, and the field stays out of recipes that do not set it', () => {
  const off = normalizeAgentLook({ environment: { ground: false } }).environment;
  assert.equal(agentGroundPlacement([boxPart([0, 0, 0], [1, 1, 1])], off), null);
  assert.equal('ground' in defaultEnvironment, false);
  assert.throws(() => normalizeAgentLook({ environment: { ground: 'no' } }), /ground/);
});

test('the placement is deterministic and moves the floor part in place', () => {
  const parts = [boxPart([0, 1, 0], [1, 2, 1])];
  const placement = agentGroundPlacement(parts, defaultEnvironment);
  assert.deepEqual(placement, agentGroundPlacement(parts, defaultEnvironment));
  const floor = createAgentGround(placement);
  const matrixObject = floor.matrix;
  placeAgentGround(floor, { ...placement, height: 4 });
  assert.equal(floor.matrix, matrixObject);
  assert.equal(floor.matrix[13], 4);
  assert.equal(floor.material.tag, 'surface');
});

test('the automatic floor is a mid-dark tone, so a pale object and its contact shadow stand out from it', () => {
  const placement = agentGroundPlacement([boxPart([0, 0.5, 0], [1, 1, 1])], defaultEnvironment);
  const floorColor = createAgentGround(placement).material.color;
  const luminance = 0.2126 * floorColor[0] + 0.7152 * floorColor[1] + 0.0722 * floorColor[2];
  assert.ok(luminance < 0.3, `floor luminance ${luminance} is too close to the backdrop`);
});
