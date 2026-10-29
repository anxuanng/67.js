import test from 'node:test';
import assert from 'node:assert/strict';
import { groupParts } from '../src/renderer.js';
import { buildSplatPixels, packSplatParameters, resolveSplatSize, splatTextureBytes, validateSplatMaterial } from '../src/splat.js';
import { estimateTextureBytes } from '../src/budget.js';

function image(size, fill) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < data.length; index += 4) data.set(fill, index);
  return { width: size, height: size, data };
}

function layer(size = 8, extra = {}) {
  return {
    color: { image: image(size, [10, 20, 30, 255]), colorSpace: 'srgb' },
    normal: { image: image(size, [128, 128, 255, 255]), colorSpace: 'linear' },
    roughness: { image: image(size, [200, 200, 200, 255]), colorSpace: 'linear' },
    height: { image: image(size, [90, 90, 90, 255]), colorSpace: 'linear' },
    scale: 3,
    ...extra,
  };
}

function groundPart(material, geometry) {
  return { name: 'ground', geometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material };
}

const triangle = () => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) });

test('accepts one to four layers and rejects everything else', () => {
  validateSplatMaterial({ layers: [layer()] });
  validateSplatMaterial({ layers: [layer(), layer(), layer(), layer()], splat: { rules: [{}, { slope: [30, 90] }, { height: [0, 20], mask: 'g' }] } });
  assert.throws(() => validateSplatMaterial({ layers: [] }), /1 to 4/);
  assert.throws(() => validateSplatMaterial({ layers: Array.from({ length: 5 }, () => layer()) }), /1 to 4/);
  assert.throws(() => validateSplatMaterial({ layers: [{ scale: 2 }] }), /at least one/);
  assert.throws(() => validateSplatMaterial({ layers: [layer(8, { scale: 0 })] }), /positive/);
  assert.throws(() => validateSplatMaterial({ layers: [layer(8, { normal: { image: image(8, [0, 0, 0, 255]), colorSpace: 'srgb' } })] }), /linear/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { rules: [{ slope: [50, 20] }] } }), /minimum/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { rules: [{ slope: [0, 120] }] } }), /within/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { rules: [{ mask: 'a' }] } }), /maskMap/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { rules: [{}, {}] } }), /one entry per layer/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { triplanarStart: 70, triplanarEnd: 50 } }), /triplanarStart/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], map: { image: image(2, [0, 0, 0, 255]) } }), /replace/);
});

test('a weight texture needs bounds and a linear descriptor', () => {
  const maskMap = { image: image(4, [255, 0, 0, 255]), colorSpace: 'linear' };
  validateSplatMaterial({ layers: [layer()], splat: { maskMap, maskBounds: [-10, -10, 10, 10], rules: [{ mask: 'a' }] } });
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { maskMap } }), /maskBounds/);
  assert.throws(() => validateSplatMaterial({ layers: [layer()], splat: { maskMap: { ...maskMap, colorSpace: 'srgb' }, maskBounds: [0, 0, 1, 1] } }), /linear/);
});

test('packs per-layer rules for the shader', () => {
  const parameters = packSplatParameters({ layers: [layer(), layer(8, { triplanar: true, tint: [0.5, 1, 1] })], splat: { rules: [undefined, { slope: [35, 90], slopeSoftness: 6, mask: 'b', invertMask: true }], heightBlend: 0.3 } });
  assert.deepEqual([...parameters.layer.slice(0, 8)], [3, 1, 0, 0, 3, 1, 1, 1]);
  assert.deepEqual([...parameters.slope.slice(4, 8)], [35, 90, 6, 1]);
  assert.equal(parameters.mask[1], 2);
  assert.equal(parameters.maskInvert[1], 1);
  assert.equal(parameters.mask[0], -1);
  assert.ok(Math.abs(parameters.blend[0] - 0.3) < 1e-6);
  assert.equal(parameters.options[2], 2);
  assert.deepEqual([...parameters.tint.slice(4, 7)], [0.5, 1, 1]);
});

test('resizes layers to a common size and counts the texture bytes', () => {
  const material = { layers: [layer(8), layer(16)] };
  assert.equal(resolveSplatSize(material, 4096), 16);
  assert.equal(resolveSplatSize(material, 8), 8);
  assert.equal(resolveSplatSize({ ...material, splat: { textureSize: 4 } }, 4096), 4);
  assert.equal(splatTextureBytes(16, 2), 3 * 2 * estimateTextureBytes(16, 16));
  assert.equal(splatTextureBytes(16, 2, 4), 3 * 2 * estimateTextureBytes(16, 16) + estimateTextureBytes(4, 4));
  const pixels = buildSplatPixels(material.layers, 16);
  assert.equal(pixels.color.length, 16 * 16 * 4 * 2);
  assert.deepEqual([...pixels.color.slice(0, 4)], [10, 20, 30, 255]);
  assert.deepEqual([...pixels.packed.slice(0, 4)], [200, 90, 0, 255]);
  assert.deepEqual([...pixels.normal.slice(0, 4)], [128, 128, 255, 255]);
});

test('missing channels fall back to neutral texels', () => {
  const pixels = buildSplatPixels([{ color: layer().color }], 4);
  assert.deepEqual([...pixels.normal.slice(0, 4)], [128, 128, 255, 255]);
  assert.deepEqual([...pixels.packed.slice(0, 4)], [255, 128, 0, 255]);
});

test('parts batch together only with the same layers and splat rules', () => {
  const layers = [layer()];
  const splat = { rules: [{}] };
  const geometry = triangle();
  const base = { color: [1, 1, 1], metallic: 0, roughness: 1 };
  const first = groundPart({ ...base, layers, splat }, geometry);
  const second = groundPart({ ...base, layers, splat }, geometry);
  assert.equal(groupParts([first, second]).length, 1);
  assert.equal(groupParts([first, groundPart({ ...base, layers: [layer()], splat }, geometry)]).length, 2);
  assert.equal(groupParts([first, groundPart({ ...base, layers, splat: { rules: [{}] } }, geometry)]).length, 2);
  assert.equal(groupParts([first, groundPart({ ...base }, geometry)]).length, 2);
});

test('procedural material tags reject layers', () => {
  const part = groundPart({ color: [1, 1, 1], metallic: 0, roughness: 1, tag: 'terrain', layers: [layer()] }, triangle());
  assert.throws(() => groupParts([part]), /standard PBR/);
});
