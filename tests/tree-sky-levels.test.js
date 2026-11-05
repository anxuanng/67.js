import assert from 'node:assert/strict';
import test from 'node:test';
import { createTree } from '../src/vegetation.js';
import { TREE_LEVEL_GAINS } from '../src/tree-level-gains.js';
import { coverageMean, matchMeanVisibility, vertexCoverage } from '../src/tree-sky.js';

// Issue #394: a lower level of detail worked out its own sky visibility from its few, large vertices, which put the
// far levels at the floor (0.04 to 0.06) where level 0 sees 0.08 to 0.12. Under sky light they drew near black.
// Issue #432: the match is now a mean over the leaf each vertex stands for (its share of the triangle areas), not over the
// vertices. A clump has few vertices for a lot of leaf, so the plain mean no longer says how much sky the leaf sees.

const SPECIES = ['broadleaf', 'birch', 'conifer', 'palm', 'bush'];

function foliageGeometry(level) {
  return level.parts.find(part => part.role === 'foliage').geometry;
}

function coverageMeanSkyVisibility(geometry) {
  return coverageMean(geometry.skyVisibility, vertexCoverage(geometry.positions, geometry.indices));
}

for (const species of SPECIES) {
  test(`every level of a ${species} sees about as much sky as level 0, weighted by the leaf it stands for`, () => {
    const tree = createTree(species, 3);
    const levelZeroMean = coverageMeanSkyVisibility(foliageGeometry(tree.levels[0]));
    const gains = TREE_LEVEL_GAINS[species] ?? {};
    tree.levels.forEach((level, index) => {
      const geometry = foliageGeometry(level);
      assert.equal(geometry.skyVisibility.length, geometry.positions.length / 3);
      // The sky gain of a level moves its mean on purpose, and a vertex stops at full sky, so a large gain can fall short of
      // level 0's mean times the gain. The floor of the visibility keeps a very dense crown from matching exactly too.
      const gain = gains[index]?.sky ?? 1;
      const levelMean = coverageMeanSkyVisibility(geometry);
      if (gain > 1.5) {
        assert.ok(levelMean >= levelZeroMean * 1.2 && levelMean <= 1, `${species} level ${index} has a mean of ${levelMean.toFixed(3)} against ${levelZeroMean.toFixed(3)} at level 0`);
        return;
      }
      const expected = levelZeroMean * gain;
      const allowedDifference = Math.max(0.1 * expected, 0.02);
      const difference = Math.abs(levelMean - expected);
      assert.ok(difference <= allowedDifference, `${species} level ${index} differs from level 0 by ${difference.toFixed(3)}`);
    });
  });
}

test('the level match weights each vertex by its share of the leaf area', () => {
  // Two triangles: a small one whose corners see little sky and a large one whose corners see a lot.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 20, 0, 0, 10, 20, 0]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const coverage = vertexCoverage(positions, indices);
  assert.ok(Math.abs(coverage[0] - 0.5 / 3) < 1e-6);
  assert.ok(Math.abs(coverage[3] - 100 / 3) < 1e-4);
  const visibility = new Float32Array([0.1, 0.1, 0.1, 0.5, 0.5, 0.5]);
  const plainMean = 0.3;
  const weightedMean = coverageMean(visibility, coverage);
  assert.ok(weightedMean > 0.49, `weighted mean ${weightedMean}`);
  const matched = matchMeanVisibility(visibility, 0.25, coverage);
  assert.ok(Math.abs(coverageMean(matched, coverage) - 0.25) < 0.005);
  assert.notEqual(Math.round(coverageMean(matched, coverage) * 1000), Math.round(plainMean * 1000));
});

test('a tree whose far level carries more leaf area than its species usually does gets a larger colour gain', () => {
  // Seeds of one broadleaf differ in how much clump area level 2 has against level 0; the colour of level 2 follows it.
  const leafArea = geometry => vertexCoverage(geometry.positions, geometry.indices).reduce((sum, share) => sum + share, 0);
  const rows = [1, 2, 3, 4, 5, 6].map(seed => {
    const tree = createTree('broadleaf', seed);
    const zero = foliageGeometry(tree.levels[0]);
    const two = foliageGeometry(tree.levels[2]);
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    return { logArea: Math.log(leafArea(two) / leafArea(zero)), colorRatio: mean(two.colors) / mean(zero.colors) };
  }).sort((first, second) => first.logArea - second.logArea);
  const smallest = rows[0];
  const largest = rows[rows.length - 1];
  const expected = Math.exp(TREE_LEVEL_GAINS.broadleaf.areaExponent * (largest.logArea - smallest.logArea));
  // Leaf colours differ a little between seeds, so the measured step only has to land near the expected one.
  assert.ok(Math.abs(largest.colorRatio / smallest.colorRatio / expected - 1) < 0.1, `colour step ${(largest.colorRatio / smallest.colorRatio).toFixed(3)} against ${expected.toFixed(3)}`);
});

test('the standing clump cards of a far level face every way, so the crown is as bright from every side', () => {
  // Before #432 every standing card of a crown faced one world direction, and level 2 drew three times darker from one side.
  // The facing comes from the triangles themselves, since the shading normals may be blended toward the crown.
  for (const species of SPECIES) {
    const { positions, indices } = foliageGeometry(createTree(species, 3).levels[2]);
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (let corner = 0; corner < indices.length; corner += 3) {
      const point = index => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
      const [a, b, c] = [point(indices[corner]), point(indices[corner + 1]), point(indices[corner + 2])];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...normal);
      if (length === 0 || Math.abs(normal[1] / length) > 0.5) continue;
      const horizontal = Math.hypot(normal[0], normal[2]);
      sumX += normal[0] / horizontal;
      sumZ += normal[2] / horizontal;
      count++;
    }
    // The mean facing of the standing triangles: 1 when all face one way (main before this change), near 0 when they spread evenly.
    const resultant = Math.hypot(sumX, sumZ) / count;
    assert.ok(count > 0 && resultant < 0.3, `${species} standing cards lean one way (${resultant.toFixed(2)} of ${count})`);
  }
});

test('level 0 keeps the sky visibility it measures from its own leaves', () => {
  const first = createTree('broadleaf', 5);
  const second = createTree('broadleaf', 5);
  assert.deepEqual(foliageGeometry(first.levels[0]).skyVisibility, foliageGeometry(second.levels[0]).skyVisibility);
});

test('the fitted gains only touch levels 1 to 3 and stay in a sane range', () => {
  for (const [species, { areaExponent, ...levels }] of Object.entries(TREE_LEVEL_GAINS)) {
    assert.ok(SPECIES.includes(species), `${species} is not a tree species`);
    assert.ok(areaExponent >= 0 && areaExponent <= 1, `${species} area exponent ${areaExponent}`);
    for (const [level, gain] of Object.entries(levels)) {
      assert.ok(Number.isFinite(gain.area), `${species} level ${level} has no mean leaf area ratio`);
      assert.ok(Number(level) >= 1 && Number(level) <= 3, `${species} level ${level}`);
      assert.ok(gain.color > 0.2 && gain.color < 5, `${species} level ${level} colour gain ${gain.color}`);
      // A conifer's far clumps sit inside a dark cone, so its sky gain is large; a vertex still stops at full sky.
      assert.ok(gain.sky >= 0.25 && gain.sky <= 16, `${species} level ${level} sky gain ${gain.sky}`);
    }
  }
});
