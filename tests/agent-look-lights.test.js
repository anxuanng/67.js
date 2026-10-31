import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentLook } from '../src/agent-look.js';

test('a default look omits spot and area lights so exported recipes keep their shape', () => {
  const { environment } = normalizeAgentLook();
  assert.equal(Object.hasOwn(environment, 'spotLights'), false);
  assert.equal(Object.hasOwn(environment, 'areaLights'), false);
  assert.equal(Object.hasOwn(environment.pointLights, 'castShadow'), false);
});

test('spot and area lights normalize with defaults and keep castShadow only when true', () => {
  const { environment } = normalizeAgentLook({ environment: {
    pointLights: [{ position: [0, 2, 0], castShadow: true }, { position: [1, 2, 0], castShadow: false }],
    spotLights: [{ position: [0, 3, 0], direction: [0, -1, 0], castShadow: true }],
    areaLights: [{ position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 2 }],
  } });
  assert.equal(environment.pointLights[0].castShadow, true);
  assert.equal(Object.hasOwn(environment.pointLights[1], 'castShadow'), false);
  assert.equal(environment.spotLights[0].angle, Math.PI / 4);
  assert.equal(environment.spotLights[0].penumbra, 0.15);
  assert.equal(environment.areaLights[0].width, 1);
});

test('look rejects an unknown spot light field and too many shadow casters', () => {
  assert.throws(() => normalizeAgentLook({ environment: { spotLights: [{ position: [0, 3, 0], direction: [0, -1, 0], cone: 1 }] } }), /Unknown spot light field/);
  const fivePointLights = [0, 1, 2, 3, 4].map(index => ({ position: [index, 1, 0], castShadow: true }));
  assert.throws(() => normalizeAgentLook({ environment: { pointLights: fivePointLights } }), /atlas/);
});
