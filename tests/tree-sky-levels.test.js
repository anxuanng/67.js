import assert from 'node:assert/strict';
import test from 'node:test';
import { createTree } from '../src/vegetation.js';

// Issue #394: a lower level of detail worked out its own sky visibility from its few, large vertices, which put the
// far levels at the floor (0.04 to 0.06) where level 0 sees 0.08 to 0.12. Under sky light they drew near black.

function meanOf(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function foliageGeometry(level) {
  return level.parts.find(part => part.role === 'foliage').geometry;
}

for (const species of ['broadleaf', 'birch', 'conifer', 'palm', 'bush']) {
  test(`every level of a ${species} sees about as much sky as level 0`, () => {
    const tree = createTree(species, 3);
    const levelZeroMean = meanOf(foliageGeometry(tree.levels[0]).skyVisibility);
    // The floor of the visibility keeps a very dense crown from matching exactly, so a small absolute margin applies too.
    const allowedDifference = Math.max(0.1 * levelZeroMean, 0.02);
    tree.levels.forEach((level, index) => {
      const geometry = foliageGeometry(level);
      assert.equal(geometry.skyVisibility.length, geometry.positions.length / 3);
      const difference = Math.abs(meanOf(geometry.skyVisibility) - levelZeroMean);
      assert.ok(difference <= allowedDifference, `${species} level ${index} differs from level 0 by ${difference.toFixed(3)}`);
    });
  });
}

test('level 0 keeps the sky visibility it measures from its own leaves', () => {
  const first = createTree('broadleaf', 5);
  const second = createTree('broadleaf', 5);
  assert.deepEqual(foliageGeometry(first.levels[0]).skyVisibility, foliageGeometry(second.levels[0]).skyVisibility);
});
