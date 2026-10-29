import test from 'node:test';
import assert from 'node:assert/strict';
import { GRASS_LEVELS, GRASS_PRESETS, createGrass } from '../src/grass.js';
import { vertexShader } from '../src/shaders.js';

const smallArea = { minX: -6, maxX: 6, minZ: -6, maxZ: 6 };
// A light density keeps the suite fast; blade shape and level rules do not depend on it.
const quick = { area: smallArea, density: 40 };

function bladeRoots(part) {
  const { positions, uvs } = part.geometry;
  const roots = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    // The two root vertices are consecutive; their midpoint is the blade's root whatever its width.
    if (uvs[vertex * 2 + 1] === 1 && uvs[vertex * 2] === 0) {
      const x = (positions[vertex * 3] + positions[vertex * 3 + 3]) / 2 + part.matrix[12];
      const z = (positions[vertex * 3 + 2] + positions[vertex * 3 + 5]) / 2 + part.matrix[14];
      roots.push([x, z]);
    }
  }
  return roots;
}

test('the same options and seed build identical blades', () => {
  const first = createGrass({ ...quick, seed: 4, eye: [0, 1.5, 0] });
  const second = createGrass({ ...quick, seed: 4, eye: [0, 1.5, 0] });
  assert.equal(first.parts.length, second.parts.length);
  first.parts.forEach((part, index) => assert.deepEqual(part.geometry.positions, second.parts[index].geometry.positions));
  const other = createGrass({ ...quick, seed: 5, eye: [0, 1.5, 0] });
  assert.notDeepEqual(first.parts[0].geometry.positions, other.parts[0].geometry.positions);
});

test('parts are rigid, untextured, double-sided grass with no shadow by default', () => {
  const grass = createGrass({ ...quick, eye: [0, 1.5, 0] });
  assert.ok(grass.parts.length > 0);
  for (const part of grass.parts) {
    assert.equal(part.material.tag, 'grass');
    assert.equal(part.material.doubleSided, true);
    assert.equal(part.material.map, undefined);
    assert.equal(part.castShadow, false);
    assert.ok(part.geometry.colors && part.geometry.uvs);
  }
  assert.equal(createGrass({ ...quick, castShadow: true }).parts[0].castShadow, true);
});

test('coarser levels keep a stable subset of the same blades', () => {
  const near = createGrass({ area: { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, eye: [2, 1, 2] });
  const nearRoots = bladeRoots(near.parts[0]);
  const coarse = createGrass({ area: { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, eye: [2, 1, 2 + GRASS_LEVELS[1].distance - 1] });
  assert.equal(coarse.stats().levelCounts[1], 1);
  const coarseRoots = bladeRoots(coarse.parts[0]);
  assert.ok(coarseRoots.length > 0 && coarseRoots.length < nearRoots.length * 0.5);
  // Float32 midpoints of blades of different widths differ in the last bits, so match within a millimetre.
  const hasNearTwin = ([x, z]) => nearRoots.some(([nearX, nearZ]) => Math.abs(nearX - x) < 1e-3 && Math.abs(nearZ - z) < 1e-3);
  for (const root of coarseRoots) assert.ok(hasNearTwin(root), 'every coarse blade also exists at full detail');
});

test('blades stand on the terrain and taper from a dark root to a light tip', () => {
  const terrainHeight = (x, z) => 2 + x * 0.1 + Math.sin(z * 0.5);
  const grass = createGrass({ ...quick, terrainHeight, eye: [0, 3, 0] });
  const part = grass.parts.find(candidate => grass.stats().levelCounts[0] > 0 && candidate.geometry.positions.length > 0);
  const { positions, uvs, colors } = part.geometry;
  let rootBrightness = 0;
  let tipBrightness = 0;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const brightness = colors[vertex * 3] + colors[vertex * 3 + 1] + colors[vertex * 3 + 2];
    if (uvs[vertex * 2 + 1] === 1) {
      const x = positions[vertex * 3] + part.matrix[12];
      const z = positions[vertex * 3 + 2] + part.matrix[14];
      assert.ok(Math.abs(positions[vertex * 3 + 1] - terrainHeight(x, z)) < 0.02, 'roots sit on the ground');
      rootBrightness += brightness;
    }
    if (uvs[vertex * 2 + 1] === 0) tipBrightness += brightness;
  }
  assert.ok(tipBrightness > rootBrightness * 0.5, 'tips (one vertex per blade) outshine roots (two per blade)');
});

test('a zero mask clears grass and partial masks thin it', () => {
  assert.equal(createGrass({ ...quick, mask: () => 0 }).parts.length, 0);
  const full = createGrass({ ...quick, eye: [0, 1.5, 0] }).stats().triangles;
  const half = createGrass({ ...quick, eye: [0, 1.5, 0], mask: (x) => (x < 0 ? 1 : 0) }).stats().triangles;
  assert.ok(half > full * 0.35 && half < full * 0.65);
});

test('update reports level changes, culls far tiles and stays quiet when nothing moves', () => {
  const grass = createGrass({ area: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 }, density: 4, eye: [0, 1.5, 0] });
  const before = grass.stats();
  assert.equal(grass.update([0, 1.5, 0]), false);
  assert.ok(before.levelCounts[0] > 0 && before.levelCounts[2] > 0);
  assert.ok(before.visibleTiles < before.tiles, 'corners beyond the cull distance are dropped');
  assert.equal(grass.update([30, 1.5, 30]), true);
  assert.notDeepEqual(grass.stats().levelCounts, before.levelCounts);
  assert.equal(grass.update([300, 1.5, 300]), true);
  assert.equal(grass.parts.length, 0);
});

test('every preset builds, and bad options fail with clear errors', () => {
  for (const preset of Object.keys(GRASS_PRESETS)) assert.ok(createGrass({ ...quick, preset }).parts.length > 0, preset);
  assert.throws(() => createGrass({ ...quick, preset: 'moss' }), /Unknown grass preset/);
  assert.throws(() => createGrass({}), /area/);
  assert.throws(() => createGrass({ ...quick, density: 0 }), /density/);
  assert.throws(() => createGrass({ ...quick, height: [0.5, 0.2] }), /height/);
  assert.throws(() => createGrass({ ...quick, tip: [1, 1] }), /tip colour/);
  assert.throws(() => createGrass({ ...quick, mask: 1 }), /mask/);
  assert.throws(() => createGrass({ ...quick }).update([0, 1]), /eye/);
});

test('groundColor sits between the root and tip colours', () => {
  const grass = createGrass({ ...quick });
  const { base, tip } = GRASS_PRESETS.meadow;
  grass.groundColor.forEach((channel, index) => assert.ok(channel >= base[index] && channel <= tip[index]));
});

test('grass wind bends by blade height (uv) and rolls across the field as gusts', () => {
  assert.match(vertexShader, /vec3 grassWind\(/);
  assert.match(vertexShader, /if \(surfaceTag == 7\.0 && leafUv\.x > -0\.5\) return grassWind\(/, 'grass without UVs keeps the height-based sway');
  assert.match(vertexShader, /float gust = /);
});
