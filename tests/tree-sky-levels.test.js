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
      // The sky gain of a level moves its mean on purpose; the floor of the visibility keeps a very dense crown from
      // matching exactly, so a small absolute margin applies too.
      const expected = levelZeroMean * (gains[index]?.sky ?? 1);
      const allowedDifference = Math.max(0.1 * expected, 0.02);
      const difference = Math.abs(coverageMeanSkyVisibility(geometry) - expected);
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

test('level 0 keeps the sky visibility it measures from its own leaves', () => {
  const first = createTree('broadleaf', 5);
  const second = createTree('broadleaf', 5);
  assert.deepEqual(foliageGeometry(first.levels[0]).skyVisibility, foliageGeometry(second.levels[0]).skyVisibility);
});

test('the fitted gains only touch levels 1 to 3 and stay in a sane range', () => {
  for (const [species, levels] of Object.entries(TREE_LEVEL_GAINS)) {
    assert.ok(SPECIES.includes(species), `${species} is not a tree species`);
    for (const [level, gain] of Object.entries(levels)) {
      assert.ok(Number(level) >= 1 && Number(level) <= 3, `${species} level ${level}`);
      assert.ok(gain.color > 0.2 && gain.color < 5, `${species} level ${level} colour gain ${gain.color}`);
      assert.ok(gain.sky >= 0.25 && gain.sky <= 4, `${species} level ${level} sky gain ${gain.sky}`);
    }
  }
});
