import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_SCENE_CAPABILITIES, DEFAULT_AMBIENT_OCCLUSION, DEFAULT_EXPOSURE,DEFAULT_LIGHTING_SETUP, LIGHTING_SETUP_NAMES } from '../src/agent-scene-capabilities.js';
import { agentEnvironmentMap, environmentPatchWithSetup, normalizeAgentLook } from '../src/agent-look.js';
import { createLightingSetupMap, lightingSetupFields } from '../src/lighting-setups.js';
import { resolveEffects } from '../src/effects.js';

test('every named setup has fields and a finite environment map', () => {
  for (const name of LIGHTING_SETUP_NAMES) {
    const fields = lightingSetupFields(name);
    assert.equal(fields.lightDirection.length, 3);
    const map = createLightingSetupMap(name);
    assert.equal(map.kind, 'environment-map');
    assert.ok(map.data.every(Number.isFinite));
    assert.ok(map.data.some(value => value > 0));
  }
});

test('setups differ from each other', () => {
  const averages = LIGHTING_SETUP_NAMES.map(name => createLightingSetupMap(name).data.reduce((sum, value) => sum + value, 0));
  assert.equal(new Set(averages.map(value => value.toFixed(3))).size, LIGHTING_SETUP_NAMES.length);
});

test('a recipe with no lighting settings gets the default setup and occlusion', () => {
  const look = normalizeAgentLook({});
  assert.equal(look.environment.setup, DEFAULT_LIGHTING_SETUP);
  assert.equal(look.effects.ambientOcclusion, DEFAULT_AMBIENT_OCCLUSION);
  assert.equal(look.effects.exposure, DEFAULT_EXPOSURE);
  assert.deepEqual(look.environment.lightDirection, lightingSetupFields(DEFAULT_LIGHTING_SETUP).lightDirection);
});

test('a named setup supplies its fields and explicit fields win', () => {
  const sunset = normalizeAgentLook({ environment: { setup: 'sunset' } }).environment;
  assert.deepEqual(sunset.keyColor, lightingSetupFields('sunset').keyColor);
  const overridden = normalizeAgentLook({ environment: { setup: 'sunset', keyIntensity: 2 } }).environment;
  assert.equal(overridden.keyIntensity, 2);
});

test('an unknown setup is rejected with the valid names', () => {
  assert.throws(() => normalizeAgentLook({ environment: { setup: 'moonlit' } }), /daylight/);
});

test('switching setup resets setup fields, and fields in the patch still win', () => {
  const patch = environmentPatchWithSetup({ setup: 'studio', fillIntensity: 0.5 });
  assert.deepEqual(patch.keyColor, lightingSetupFields('studio').keyColor);
  assert.equal(patch.fillIntensity, 0.5);
  assert.deepEqual(environmentPatchWithSetup({ keyIntensity: 3 }), { keyIntensity: 3 });
});

test('occlusion zero turns the pass off and the radius is bounded', () => {
  assert.equal(normalizeAgentLook({ effects: { ambientOcclusion: 0 } }).effects.ambientOcclusion, 0);
  assert.throws(() => normalizeAgentLook({ effects: { ambientOcclusion: 2 } }), /Ambient occlusion/);
  assert.throws(() => normalizeAgentLook({ effects: { ambientOcclusionRadius: 0 } }), /radius/);
});

test('the engine itself keeps occlusion off unless asked', () => {
  assert.equal(resolveEffects({}).ambientOcclusion, 0);
});

test('the same inputs return the same environment map object', () => {
  const environment = normalizeAgentLook({}).environment;
  assert.equal(agentEnvironmentMap(environment), agentEnvironmentMap(environment));
  assert.equal(agentEnvironmentMap(environment).data, agentEnvironmentMap({ ...environment, environmentIntensity: 2 }).data);
});

test('capabilities list the setups and the occlusion default', () => {
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.lightingSetups], [...LIGHTING_SETUP_NAMES]);
  assert.equal(AGENT_SCENE_CAPABILITIES.ambientOcclusion.default, DEFAULT_AMBIENT_OCCLUSION);
});
