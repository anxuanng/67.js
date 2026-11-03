import assert from 'node:assert/strict';
import test from 'node:test';
import { createFragmentShader, fragmentShader, SHADER_FEATURES } from '../src/shaders.js';
import '../src/material-layer-shaders.js';
import '../src/world-material-shader.js';

test('the default fragment shader keeps every feature', () => {
  assert.equal(fragmentShader, createFragmentShader(SHADER_FEATURES));
  assert.match(fragmentShader, /#define TAG_WATER false/, 'the world materials load with their own module, so the default shader leaves them out');
  assert.match(fragmentShader, /#define USES_NORMAL_MAP \(hasNormalMap > 0\.5\)/);
});

test('a mapped normal takes the sky light below the surface plane out of the ambient term', () => {
  assert.match(fragmentShader, /vec3 geometricNormal = normal;\s+if \(USES_NORMAL_MAP\) normal = /);
  assert.match(fragmentShader, /float horizon = 0\.5 \+ 0\.5 \* dot\(normal, geometricNormal\);\s+occlusion \*= horizon \* horizon;/);
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

test('the two fill lights compile in only for a renderer whose fill intensity is above 0', () => {
  assert.match(createFragmentShader([]), /#define FILL_ON false/);
  assert.match(createFragmentShader(['fill']), /#define FILL_ON \(true\)/);
  assert.match(fragmentShader, /#define FILL_ON \(true\)/);
});

test('every feature condition is a macro that the shader body uses', () => {
  for (const line of fragmentShader.split('\n').filter(text => text.startsWith('#define ') && text.includes('('))) {
    const macro = line.split(' ')[1];
    const uses = fragmentShader.split(macro).length - 1;
    assert.ok(uses > 1, `${macro} is defined but never used`);
  }
});

test('anisotropy and iridescence compile in only when a material asks for them', () => {
  const plain = createFragmentShader([]);
  assert.doesNotMatch(plain, /anisotropicSpecular|filmReflectance|materialAnisotropy|materialIridescence/);
  const withAnisotropy = createFragmentShader(['anisotropy']);
  assert.match(withAnisotropy, /uniform vec2 materialAnisotropy;/);
  assert.doesNotMatch(withAnisotropy, /materialIridescence/);
  const withIridescence = createFragmentShader(['iridescence']);
  assert.match(withIridescence, /uniform vec3 materialIridescence;/);
  assert.doesNotMatch(withIridescence, /materialAnisotropy/);
});
