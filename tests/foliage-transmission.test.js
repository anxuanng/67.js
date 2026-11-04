import assert from 'node:assert/strict';
import test from 'node:test';
import { worldMaterialSlots } from '../src/world-material-shader.js';

// Issue #394: the lower tree levels are a few big, flat cards. Seen from below, a card shows its back face, and light
// from above reaches it only by passing through the leaf. The transmission term must follow the face the viewer sees,
// and the shadow test must not remove it entirely, because the shadow on a card's underside is the card's own.

test('foliage transmission lights the face the viewer sees', () => {
  const { worldLight } = worldMaterialSlots;
  assert.match(worldLight, /CANOPY_TAG\) radiance \+= .*gl_FrontFacing \? -normal : normal/);
});

test('foliage transmission keeps most of its light under a shadow', () => {
  const { worldLight } = worldMaterialSlots;
  assert.match(worldLight, /mix\(visibility, 1\.0, 0\.7\)/);
});
