import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloth } from '../src/cloth.js';
import { createMeshData } from '../src/mesh-data.js';
import { bakeMaterialPattern, normalizeMaterialPattern } from '../src/material-patterns.js';

// Names and kinds that come from the caller pick an own entry of a table or object, never one inherited from
// Object.prototype (CodeQL js/remote-property-injection and js/unvalidated-dynamic-method-call).

function triangleMesh(attributes) {
  return createMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    faceOffsets: new Uint32Array([0, 3]),
    cornerVertices: new Uint32Array([0, 1, 2]),
    attributes,
  });
}

test('a mesh attribute cannot be named after a prototype key', () => {
  const attribute = { data: new Float32Array(3), size: 1 };
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const point = JSON.parse(`{"${name}": 0}`);
    point[name] = attribute;
    assert.throws(() => triangleMesh({ point }), /reserved/, name);
  }
  assert.equal(triangleMesh({ point: { height: attribute } }).attributes.point.height.size, 1);
});

test('a cloth collider needs a known kind and a pin needs an existing particle', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const triangles = new Uint32Array([0, 1, 2]);
  assert.throws(() => createCloth(positions, triangles, { colliders: [{ kind: 'constructor' }] }), /collider kind must be one of ball, capsule, box/);
  assert.throws(() => createCloth(positions, triangles, { colliders: [{ kind: 'toString' }] }), /collider kind/);
  assert.throws(() => createCloth(positions, triangles, { pinned: ['__proto__'] }), /pinned particle/);
  assert.throws(() => createCloth(positions, triangles, { pinned: [3] }), /pinned particle 3 does not exist/);
  assert.ok(createCloth(positions, triangles, { pinned: [0], colliders: [{ kind: 'ball', center: [0, -1, 0], radius: 0.5 }] }));
});

test('baking a pattern refuses a type that is not its own sampler', () => {
  const pattern = normalizeMaterialPattern({ type: 'bricks' });
  assert.throws(() => bakeMaterialPattern({ ...pattern, type: 'constructor' }), /type must be one of/);
});
