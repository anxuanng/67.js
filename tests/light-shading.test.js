import assert from 'node:assert/strict';
import test from 'node:test';
import { createFragmentShader, fragmentShader, LIGHT_SHADING_FEATURE, SHADING_MODES, SHADER_FEATURES } from '../src/shaders.js';

test('the default shader and a shader built from every feature keep the full picture', () => {
  assert.match(fragmentShader, /#define LIGHT_SHADING false/);
  assert.equal(SHADER_FEATURES.includes(LIGHT_SHADING_FEATURE), false);
  assert.match(createFragmentShader(['environmentMap']), /#define LIGHT_SHADING false/);
});

test('the light shading feature turns the macro on and needs no module', () => {
  assert.match(createFragmentShader([LIGHT_SHADING_FEATURE, 'environmentMap']), /#define LIGHT_SHADING true/);
});

test('shading takes full or light', () => {
  assert.deepEqual([...SHADING_MODES], ['full', 'light']);
});
