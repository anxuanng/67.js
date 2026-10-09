import assert from 'node:assert/strict';
import test from 'node:test';
import { addDetailOffsets, assemblyOffset } from '../src/assembly.js';
import { createModel } from '../src/model.js';

test('detail planning is deterministic and leaves assembled source objects untouched', () => {
  const sharedAssembly = { layer: 'interior', section: 'Structural frame', offset: [0, 0, 0] };
  const source = [0, 1, 2].map(index => ({ name: 'Frame screw', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 0.1, 1, 0, 1]), geometry: {}, material: {}, assembly: sharedAssembly }));
  const originalMatrices = source.map(part => Array.from(part.matrix));
  const planned = addDetailOffsets(source);
  const repeat = addDetailOffsets(source);
  assert.deepEqual(planned.map(part => part.assembly.detailOffset), repeat.map(part => part.assembly.detailOffset));
  assert.equal(sharedAssembly.detailOffset, undefined);
  planned.forEach((part, index) => {
    assert.equal(part.matrix, source[index].matrix);
    assert.equal(part.geometry, source[index].geometry);
    assert.equal(part.material, source[index].material);
    assert.notEqual(part.assembly, sharedAssembly);
    assert.deepEqual(Array.from(source[index].matrix), originalMatrices[index]);
  });
});

test('all individual accessories have distinct finite movement and reversible full-explosion bounds', () => {
  const parts = createModel();
  const translations = new Set();
  const sectionDetails = new Map();
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const { offset, detailOffset, section } = part.assembly;
    assert.equal(detailOffset.length, 3);
    assert.ok(detailOffset.every(Number.isFinite));
    assert.ok(Math.hypot(...detailOffset) > 0.1, 'every component moves, including the stationary structural frame');
    const translation = assemblyOffset(part, 1);
    assert.deepEqual(translation, offset.map((value, axis) => value + detailOffset[axis]));
    assert.deepEqual(assemblyOffset(part, 0), [0, 0, 0]);
    const key = translation.map(value => value.toFixed(6)).join(',');
    assert.ok(!translations.has(key), `individual full translation: ${section} / ${part.name}`);
    translations.add(key);
    if (!sectionDetails.has(section)) sectionDetails.set(section, new Set());
    const detailKey = detailOffset.map(value => value.toFixed(6)).join(',');
    assert.ok(!sectionDetails.get(section).has(detailKey), 'details within each section do not travel as a single block');
    sectionDetails.get(section).add(detailKey);
    const matrix = part.matrix;
    const positions = part.geometry.positions;
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const assembled = matrix[axis] * positions[vertex] + matrix[axis + 4] * positions[vertex + 1] + matrix[axis + 8] * positions[vertex + 2] + matrix[axis + 12];
        const expanded = assembled + translation[axis];
        assert.ok(Math.abs(expanded - translation[axis] - assembled) < 1e-12, 'translation reverses exactly within floating-point tolerance');
        minimum[axis] = Math.min(minimum[axis], expanded);
        maximum[axis] = Math.max(maximum[axis], expanded);
      }
    }
  }
  assert.equal(translations.size, 574);
  assert.equal(sectionDetails.size, 20);
  assert.ok(minimum[1] >= 0.045);
  assert.ok(maximum[1] <= 5.5);
  assert.ok(Math.max(Math.abs(minimum[0]), Math.abs(maximum[0])) <= 4.8);
  assert.ok(Math.max(Math.abs(minimum[2]), Math.abs(maximum[2])) <= 3.4);
  console.log(JSON.stringify({ individuallyExplodableParts: translations.size, sections: sectionDetails.size, minimum, maximum }));
});

test('export displacement exactly matches the staged shader smoothstep', () => {
  const part = { assembly: { offset: [1, 2, -3], detailOffset: [0.5, -0.4, 0.2] } };
  assert.deepEqual(assemblyOffset(part, -1), [0, 0, 0]);
  assert.deepEqual(assemblyOffset(part, 0.2), [0.2, 0.4, -0.6000000000000001]);
  assert.deepEqual(assemblyOffset(part, 0.3), [0.3, 0.6, -0.8999999999999999]);
  const halfway = assemblyOffset(part, 0.65);
  const expected = [0.9, 1.1, -1.85];
  halfway.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-12));
  assert.deepEqual(assemblyOffset(part, 1), [1.5, 1.6, -2.8]);
  assert.deepEqual(assemblyOffset(part, 2), assemblyOffset(part, 1));
  assert.deepEqual(assemblyOffset({}, 0.8), [0, 0, 0]);
  assert.throws(() => assemblyOffset(part, NaN), /finite/);
  assert.throws(() => assemblyOffset(part, Infinity), /finite/);
});

test('coincident rubber pads and steel shoes detach into visibly separate axial lanes', () => {
  const parts = createModel();
  for (const section of ['Left track assembly', 'Right track assembly']) {
    const shoes = parts.filter(part => part.assembly.section === section && part.name === 'Caterpillar steel shoe');
    const pads = parts.filter(part => part.assembly.section === section && part.name === 'Caterpillar rubber traction pad');
    assert.equal(shoes.length, pads.length);
    shoes.forEach((shoe, index) => {
      assert.ok(Math.abs(shoe.assembly.detailOffset[0] - pads[index].assembly.detailOffset[0]) > 0.4);
    });
  }
});
