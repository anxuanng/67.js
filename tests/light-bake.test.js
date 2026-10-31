import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { BAKE_LIMITS, MAX_BAKE_POINT_LIGHTS, bakeLightmaps, normalizeBakeOptions } from '../src/light-bake.js';

const cube = box(0, 1);

function placed(name, translation, scale, material = {}) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0, ...material } };
}

// A small closed room with a wall that hides the floor behind it from the lamp.
function smallRoom() {
  return [
    placed('floor', [0, -0.05, 0], [6, 0.1, 6]),
    placed('ceiling', [0, 3.05, 0], [6, 0.1, 6]),
    placed('back', [0, 1.5, -3.05], [6, 3.2, 0.1]),
    placed('left', [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('right', [3.05, 1.5, 0], [0.1, 3.2, 6]),
    placed('front', [0, 1.5, 3.05], [6, 3.2, 0.1]),
    placed('divider', [0, 1.5, 0], [0.1, 3, 3]),
  ];
}

const lamp = { pointLights: [{ position: [-1.5, 2.5, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };
const fastOptions = { samples: 8, bounces: 2, texelsPerUnit: 2, maxResolution: 32 };

function lightmapBytes(part) {
  return part.material.emissiveMap.image.data;
}

test('the same input bakes the same bytes', () => {
  const first = bakeLightmaps(smallRoom(), lamp, fastOptions);
  const second = bakeLightmaps(smallRoom(), lamp, fastOptions);
  assert.equal(first.parts.length, second.parts.length);
  first.parts.forEach((part, index) => {
    assert.deepEqual(Array.from(lightmapBytes(part)), Array.from(lightmapBytes(second.parts[index])));
    assert.equal(part.material.emission, second.parts[index].material.emission);
    assert.deepEqual(Array.from(part.geometry.uvs), Array.from(second.parts[index].geometry.uvs));
  });
});

test('a bake gives each part lightmap UVs and an srgb emissive map, and leaves its input alone', () => {
  const parts = smallRoom();
  const originalGeometry = parts[0].geometry;
  const { parts: baked } = bakeLightmaps(parts, lamp, fastOptions);
  const floor = baked[0];
  assert.equal(parts[0].geometry, originalGeometry);
  assert.equal(parts[0].material.emissiveMap, undefined);
  assert.equal(floor.material.emissiveMap.colorSpace, 'srgb');
  assert.deepEqual(floor.material.emissiveColor, [1, 1, 1]);
  assert.ok(floor.material.emission > 0);
  assert.equal(floor.geometry.uvs.length, floor.geometry.positions.length / 3 * 2);
  const { width, height, data } = floor.material.emissiveMap.image;
  assert.equal(data.length, width * height * 4);
});

test('light reaches a surface the lamp cannot see, and a dark scene bakes nothing', () => {
  const { parts: baked } = bakeLightmaps(smallRoom(), lamp, { ...fastOptions, samples: 32 });
  // The right half of the floor sits behind the divider, so it gets only bounced light, but not none.
  const floor = baked[0];
  const bytes = lightmapBytes(floor);
  const brightestChannel = Math.max(...bytes.filter((value, index) => index % 4 !== 3));
  assert.ok(brightestChannel > 0);
  const dark = bakeLightmaps(smallRoom(), { pointLights: [], keyColor: [0, 0, 0] }, fastOptions);
  dark.parts.forEach(part => assert.equal(part.material.emissiveMap, undefined));
});

test('parts that cannot take a lightmap are skipped with a reason and still block light', () => {
  const parts = smallRoom();
  parts.push(placed('painted', [1, 0.5, 1], [0.5, 1, 0.5], { map: { image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, colorSpace: 'srgb' } }));
  parts.push(placed('lamp-shade', [0, 2, 1], [0.2, 0.2, 0.2], { emission: 2 }));
  const { parts: baked, report } = bakeLightmaps(parts, lamp, fastOptions);
  assert.deepEqual(report.skipped.map(entry => entry.name), ['painted', 'lamp-shade']);
  assert.equal(baked[7], parts[7]);
  assert.equal(baked[8], parts[8]);
});

test('options are validated with their bounds', () => {
  assert.deepEqual(normalizeBakeOptions({}), Object.fromEntries(Object.entries(BAKE_LIMITS).map(([name, limit]) => [name, limit.fallback])));
  for (const [name, bad] of [['samples', 0], ['samples', 513], ['samples', Number.NaN], ['bounces', 5], ['maxResolution', 3], ['maxResolution', 1e9], ['texelsPerUnit', 0], ['texelsPerUnit', Infinity], ['maxSeconds', 0], ['maxSeconds', '60']]) {
    assert.throws(() => normalizeBakeOptions({ [name]: bad }), { name: 'RangeError', message: new RegExp(name) }, `${name} ${bad}`);
  }
  for (const bad of [null, [], 'fast', 3]) assert.throws(() => normalizeBakeOptions(bad), TypeError);
});

test('hostile parts and lights are refused before any ray is traced', () => {
  const withPosition = value => {
    const parts = smallRoom();
    const geometry = { ...cube, positions: Float32Array.from(cube.positions) };
    geometry.positions[4] = value;
    parts[0] = { ...parts[0], geometry };
    return parts;
  };
  assert.throws(() => bakeLightmaps(withPosition(Number.NaN), lamp, fastOptions), /non-finite position/);
  assert.throws(() => bakeLightmaps(withPosition(Infinity), lamp, fastOptions), /non-finite position/);
  const badIndex = smallRoom();
  badIndex[0] = { ...badIndex[0], geometry: { ...cube, indices: Uint32Array.from([0, 1, 9999]) } };
  assert.throws(() => bakeLightmaps(badIndex, lamp, fastOptions), /index past its last vertex/);
  const badMatrix = smallRoom();
  badMatrix[1] = { ...badMatrix[1], matrix: new Float32Array(15) };
  assert.throws(() => bakeLightmaps(badMatrix, lamp, fastOptions), /4x4 matrix/);
  const nanMatrix = smallRoom();
  nanMatrix[1].matrix[0] = Number.NaN;
  assert.throws(() => bakeLightmaps(nanMatrix, lamp, fastOptions), /4x4 matrix/);
  const noColor = smallRoom();
  noColor[1] = { ...noColor[1], material: { tag: 'surface' } };
  assert.throws(() => bakeLightmaps(noColor, lamp, fastOptions), /material color/);
  assert.throws(() => bakeLightmaps([], lamp, fastOptions), /from 1 to/);
  assert.throws(() => bakeLightmaps(null, lamp, fastOptions), /from 1 to/);
  const tooManyLights = { pointLights: Array.from({ length: MAX_BAKE_POINT_LIGHTS + 1 }, () => lamp.pointLights[0]) };
  assert.throws(() => bakeLightmaps(smallRoom(), tooManyLights, fastOptions), /at most 8 point lights/);
  for (const light of [{ position: [Number.NaN, 0, 0], intensity: 1 }, { position: [0, 0, 0], intensity: -1 }, { position: [0, 0, 0], intensity: Infinity }, { position: [0, 0], intensity: 1 }, { position: [0, 0, 0], intensity: 1, range: -2 }]) {
    assert.throws(() => bakeLightmaps(smallRoom(), { pointLights: [light] }, fastOptions), RangeError);
  }
  assert.throws(() => bakeLightmaps(smallRoom(), { keyColor: [1, 1, Number.NaN], lightDirection: [0, 1, 0] }, fastOptions), /keyColor/);
  assert.throws(() => bakeLightmaps(smallRoom(), null, fastOptions), TypeError);
});

test('a bake that would trace too many rays is refused up front', () => {
  const heavy = { samples: BAKE_LIMITS.samples.maximum, bounces: BAKE_LIMITS.bounces.maximum, texelsPerUnit: BAKE_LIMITS.texelsPerUnit.maximum, maxResolution: BAKE_LIMITS.maxResolution.maximum };
  assert.throws(() => bakeLightmaps(smallRoom(), lamp, heavy), /limit is/);
});

test('a bake that runs out of time throws instead of returning a partial result', () => {
  const slow = { samples: 256, bounces: 4, texelsPerUnit: 8, maxResolution: 128, maxSeconds: 1 };
  assert.throws(() => bakeLightmaps(smallRoom(), lamp, slow), /maxSeconds/);
});
