import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene } from '../src/agent-scene.js';
import { dielectricReflectance, materialLayerState, validateMaterialLayers } from '../src/material-layers.js';

function recipeWithMaterial(material) {
  return {
    format: '67js.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', ...material }],
    nodes: [{ id: 'block', geometry: 'box', material: 'finish' }],
  };
}

test('a plain material keeps the 4 percent dielectric reflectance and no layers', () => {
  const state = materialLayerState({});
  assert.deepEqual(dielectricReflectance({}).map(value => Number(value.toFixed(6))), [0.04, 0.04, 0.04]);
  assert.equal(state[3], 0, 'clearcoat');
  assert.equal(state[9], 0, 'transmission');
  assert.deepEqual(state.slice(5, 8), [0, 0, 0], 'sheen colour');
});

test('ior, specular and specular colour set the dielectric reflectance', () => {
  const water = dielectricReflectance({ ior: 1.33 });
  assert.ok(Math.abs(water[0] - 0.02) < 0.0005);
  const weak = dielectricReflectance({ specular: 0.5, specularColor: [1, 0.5, 0] });
  assert.ok(Math.abs(weak[0] - 0.02) < 1e-9);
  assert.ok(Math.abs(weak[1] - 0.01) < 1e-9);
  assert.equal(weak[2], 0);
});

test('every layer value is checked at the boundary and the error names the fix', () => {
  const cases = [
    [{ clearcoat: 1.5 }, /clearcoat must be between 0 and 1, got 1.5\. Use a number inside that range/],
    [{ clearcoatRoughness: -0.1 }, /clearcoatRoughness must be between 0 and 1/],
    [{ transmission: 'half' }, /transmission must be between 0 and 1/],
    [{ thickness: -1 }, /thickness must be between 0 and 1000/],
    [{ ior: 0.9 }, /ior must be between 1 and 2.5/],
    [{ sheenRoughness: 2 }, /sheenRoughness must be between 0 and 1/],
    [{ specular: NaN }, /specular must be between 0 and 4/],
    [{ attenuationColor: [1, 1] }, /attenuationColor must be three linear RGB numbers between 0 and 1\. Pass \[red, green, blue\]/],
    [{ sheenColor: [0, 2, 0] }, /sheenColor must be three linear RGB numbers/],
    [{ attenuationDistance: 0 }, /attenuationDistance must be a finite number above 0.*Leave it out for no absorption/],
    [{ tag: 'unlit', transmission: 0.5 }, /transmission needs a standard PBR material tag.*Use the surface tag/],
  ];
  for (const [material, message] of cases) assert.throws(() => validateMaterialLayers(material), message);
  assert.doesNotThrow(() => validateMaterialLayers({ clearcoat: 1, ior: 2.5, transmission: 0, attenuationDistance: Infinity }));
});

test('recipes accept layer fields and reject out of range values', () => {
  const scene = createAgentScene(recipeWithMaterial({ clearcoat: 1, clearcoatRoughness: 0.05, sheenColor: [0.4, 0.2, 0.2], transmission: 0.9, thickness: 0.4, ior: 1.45, attenuationColor: [0.7, 0.9, 0.8], attenuationDistance: 3 }));
  const material = scene.exportRecipe().materials[0];
  assert.equal(material.clearcoat, 1);
  assert.equal(material.transmission, 0.9);
  assert.deepEqual(material.attenuationColor, [0.7, 0.9, 0.8]);
  assert.throws(() => createAgentScene(recipeWithMaterial({ ior: 3 })), /ior must be between 1 and 2.5/);
  assert.throws(() => createAgentScene(recipeWithMaterial({ clearcoat: 2 })), /clearcoat must be between 0 and 1/);
});

test('a transmissive recipe material draws in the pass that sees the opaque scene', () => {
  const scene = createAgentScene(recipeWithMaterial({ transmission: 1, thickness: 0.2 }));
  assert.equal(scene.parts[0].material.transmission, 1);
});

test('layers survive a GLB export and import with their extensions declared', async () => {
  const material = { color: [0.2, 0.5, 0.7], roughness: 0.4, metallic: 0, emission: 0, clearcoat: 0.8, clearcoatRoughness: 0.2, transmission: 0.7, thickness: 0.5, ior: 1.4, attenuationColor: [0.5, 0.8, 0.9], attenuationDistance: 2, sheenColor: [0.3, 0.2, 0.1], sheenRoughness: 0.6, specular: 0.8, specularColor: [1, 0.9, 0.8] };
  const bytes = exportGlb([{ name: 'cube', geometry: box(0), matrix: mat4.create(), material }]);
  const asset = await parseGltf(bytes);
  const imported = asset.parts[0].material;
  for (const field of ['clearcoat', 'clearcoatRoughness', 'transmission', 'thickness', 'ior', 'attenuationDistance', 'sheenRoughness', 'specular']) {
    assert.ok(Math.abs(imported[field] - material[field]) < 1e-6, field);
  }
  for (const field of ['attenuationColor', 'sheenColor', 'specularColor']) {
    imported[field].forEach((value, index) => assert.ok(Math.abs(value - material[field][index]) < 1e-6, field));
  }
  assert.deepEqual(asset.warnings, []);
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  assert.equal(gltf.scene.children.length > 0, true);
});

test('a plain export declares no layer extension and an invalid layer is rejected', () => {
  const plain = exportGlb([{ name: 'cube', geometry: box(0), matrix: mat4.create(), material: { color: [0.2, 0.5, 0.7], roughness: 0.4, metallic: 0 } }]);
  assert.equal(Buffer.from(plain).includes('KHR_materials_clearcoat'), false);
  assert.throws(() => exportGlb([{ name: 'cube', geometry: box(0), matrix: mat4.create(), material: { color: [0.2, 0.5, 0.7], roughness: 0.4, metallic: 0, clearcoat: 3 } }]), /clearcoat must be between 0 and 1/);
});
