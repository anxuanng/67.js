import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lathe, extrude, tube } from '../src/modeling.js';
import { MODELING_CASES } from './fixtures/modeling-cases.mjs';

// modeling-golden.json holds what the former three.js generators produced for each case.
const golden = JSON.parse(readFileSync(new URL('./fixtures/modeling-golden.json', import.meta.url), 'utf8'));
const generators = { lathe, extrude, tube };
const TOLERANCE = 1e-4;

// Adding zero turns -0 into 0: the former generators signed some zeros differently, which no consumer can see.
function hashOf(values) {
  const unsigned = values.constructor.from(values, value => value + 0);
  return createHash('sha256').update(Buffer.from(unsigned.buffer)).digest('hex').slice(0, 16);
}

function measure(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let offset = 0; offset < p.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[offset + axis]);
      max[axis] = Math.max(max[axis], p[offset + axis]);
    }
  }
  let volume = 0;
  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset] * 3;
    const b = mesh.indices[offset + 1] * 3;
    const c = mesh.indices[offset + 2] * 3;
    volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return { min, max, volume };
}

for (const item of MODELING_CASES) {
  test(`modeling output matches the former generator: ${item.name}`, () => {
    const input = item.kind === 'lathe' ? item.profile : item.kind === 'tube' ? item.path : item.contour;
    const mesh = generators[item.kind](input, item.options);
    const expected = golden[item.name];
    const measured = measure(mesh);
    assert.ok(Math.abs(measured.volume - expected.volume) < TOLERANCE, `volume ${measured.volume} against ${expected.volume}`);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(measured.min[axis] - expected.min[axis]) < TOLERANCE, `min ${axis}`);
      assert.ok(Math.abs(measured.max[axis] - expected.max[axis]) < TOLERANCE, `max ${axis}`);
    }
    if (item.kind === 'extrude') return;
    assert.equal(mesh.positions.length / 3, expected.vertices);
    assert.equal(mesh.indices.length / 3, expected.triangles);
    assert.equal(hashOf(mesh.positions), expected.positions);
    assert.equal(hashOf(mesh.normals), expected.normals);
    assert.equal(hashOf(mesh.uvs), expected.uvs);
    assert.equal(hashOf(mesh.indices), expected.indices);
  });
}
