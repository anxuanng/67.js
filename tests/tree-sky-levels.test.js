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

test('the standing clump cards of a far level face every way, so the crown is as bright from every side', () => {
  // Before #432 every standing card of a crown faced one world direction, and level 2 drew three times darker from one side.
  // The facing comes from the triangles themselves, since the shading normals may be blended toward the crown.
  for (const species of ['broadleaf', 'birch', 'conifer', 'palm', 'bush']) {
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

