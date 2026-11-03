import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FOG_DENSITY, fittedFogDensity, sceneDiagonal } from '../src/fog-fit.js';

function slabPart(sizeX, sizeZ, offsetX = 0) {
  const halfX = sizeX / 2;
  const halfZ = sizeZ / 2;
  const positions = new Float32Array([-halfX, 0, -halfZ, halfX, 0, -halfZ, halfX, 0, halfZ, -halfX, 0, halfZ]);
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offsetX, 0, 0, 1]);
  return { geometry: { positions }, matrix };
}

test('a small scene keeps the default fog density', () => {
  assert.equal(fittedFogDensity([slabPart(20, 20)]), DEFAULT_FOG_DENSITY);
  assert.equal(fittedFogDensity([]), DEFAULT_FOG_DENSITY);
});

test('a 900 m scene gets a thinner fog that leaves its far side readable', () => {
  const parts = [slabPart(900, 900)];
  const density = fittedFogDensity(parts);
  const farSideDistance = sceneDiagonal(parts);
  assert.ok(density < DEFAULT_FOG_DENSITY / 4);
  assert.ok(Math.exp(-density * farSideDistance) >= 0.29, 'at least 29 percent of the contrast survives the full diagonal');
  assert.ok(Math.exp(-DEFAULT_FOG_DENSITY * farSideDistance) < 0.01, 'the fixed default hid the far side');
});

test('part transforms count toward the scene size', () => {
  const near = slabPart(10, 10);
  const far = slabPart(10, 10, 800);
  assert.ok(sceneDiagonal([near, far]) > 800);
});
