import assert from 'node:assert/strict';
import test from 'node:test';
import { createFragmentShader } from '../src/shaders.js';
import { ALL_LIGHTS_MASK, materialLayerState } from '../src/material-layers.js';
import { MAX_AREA_LIGHTS } from '../src/light-limits.js';
import { applyLightLinks, lightMaskFor, AREA_FIRST_BIT, POINT_FIRST_BIT, SPOT_FIRST_BIT, SUN_BIT } from '../src/light-linking.js';

function part(name) {
  return { name, geometry: {}, matrix: new Float32Array(16), material: { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.5 } };
}

const PARTS = ['left', 'right', 'floor'].map(part);

test('a scene whose lights all reach every part keeps its parts', () => {
  const environment = { pointLights: [{ position: [0, 1, 0] }], spotLights: [], areaLights: [] };
  assert.equal(applyLightLinks(PARTS, environment), PARTS);
});

test('an affects list limits a light to the named parts and leaves the others at full mask', () => {
  const environment = {
    pointLights: [{ affects: ['left'] }, { affects: ['right', 'floor'] }],
    spotLights: [{ affects: ['floor'] }],
    areaLights: [{}],
  };
  const [left, right, floor] = applyLightLinks(PARTS, environment);
  const point = index => 1 << (POINT_FIRST_BIT + index);
  const spot = 1 << SPOT_FIRST_BIT;
  const area = 1 << AREA_FIRST_BIT;
  const sun = 1 << SUN_BIT;
  assert.equal(left.material.lightMask, sun | point(0) | area);
  assert.equal(right.material.lightMask, sun | point(1) | area);
  assert.equal(floor.material.lightMask, sun | point(1) | spot | area);
  assert.equal(PARTS[0].material.lightMask, undefined, 'the input parts are not changed');
});

test('keyAffects limits the sun', () => {
  const [left, right] = applyLightLinks(PARTS, { pointLights: [], keyAffects: ['left'] });
  assert.equal(left.material.lightMask & 1, 1);
  assert.equal(right.material.lightMask & 1, 0);
});

test('a bad affects value is named in the error', () => {
  assert.throws(() => applyLightLinks(PARTS, { pointLights: [{ affects: 'left' }] }), /pointLights\[0\] affects/);
  assert.throws(() => applyLightLinks(PARTS, { pointLights: [{ affects: [3] }] }), /affects/);
});

test('lightMaskFor treats a null list as every part', () => {
  assert.equal(lightMaskFor('anything', [[0, null], [3, new Set(['other'])]]), 1);
});

test('the layer state carries the mask and defaults to every light', () => {
  assert.equal(materialLayerState({})[21], ALL_LIGHTS_MASK);
  assert.equal(materialLayerState({ lightMask: 5 })[21], 5);
  assert.equal(AREA_FIRST_BIT + MAX_AREA_LIGHTS, 32);
});

test('the mask test compiles in only with the feature', () => {
  const linked = createFragmentShader(['lightLinking']);
  for (const statement of [`lightLinked(${POINT_FIRST_BIT} + index)`, `lightLinked(${SPOT_FIRST_BIT} + index)`, `lightLinked(${AREA_FIRST_BIT} + index)`, 'float(lightLinked(0))']) {
    assert.ok(linked.includes(statement), statement);
  }
  const plain = createFragmentShader([]);
  assert.doesNotMatch(plain, /lightLink/);
});
