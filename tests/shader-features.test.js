import assert from 'node:assert/strict';
import test from 'node:test';
import { createFragmentShader, fragmentShader, SHADER_FEATURES } from '../src/shaders.js';

test('the default fragment shader keeps every feature', () => {
  assert.equal(fragmentShader, createFragmentShader(SHADER_FEATURES));
  assert.match(fragmentShader, /#define TAG_WATER \(surface\.w == 3\.0\)/);
  assert.match(fragmentShader, /#define USES_NORMAL_MAP \(hasNormalMap > 0\.5\)/);
});

test('a feature that a scene does not use becomes a constant false', () => {
  const plain = createFragmentShader([]);
  for (const macro of ['USES_NORMAL_MAP', 'USES_SPLAT', 'USES_MOSS', 'USES_ALPHA_MODE', 'TAG_WATER', 'TAG_FIRE']) {
    assert.match(plain, new RegExp(`#define ${macro} false`));
  }
  const withWater = createFragmentShader(['water']);
  assert.match(withWater, /#define TAG_WATER \(surface\.w == 3\.0\)/);
  assert.match(withWater, /#define TAG_FIRE false/);
});

test('every feature condition is a macro that the shader body uses', () => {
  for (const line of fragmentShader.split('\n').filter(text => text.startsWith('#define ') && text.includes('('))) {
    const macro = line.split(' ')[1];
    const uses = fragmentShader.split(macro).length - 1;
    assert.ok(uses > 1, `${macro} is defined but never used`);
  }
});
