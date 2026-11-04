import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeCloth, createCloth } from '../src/cloth.js';

// A square sheet in the plane y = 1, `size` particles a side, 0.1 m apart.
function sheetOf(size) {
  const positions = new Float32Array(size * size * 3);
  const triangles = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const index = row * size + column;
      positions.set([column * 0.1, 1, row * 0.1], index * 3);
      if (row < size - 1 && column < size - 1) {
        triangles.push(index, index + 1, index + size, index + 1, index + size + 1, index + size);
      }
    }
  }
  return { positions, triangles: Uint32Array.from(triangles), size };
}

const FRAME = 1 / 60;

function runFrames(cloth, frames) {
  for (let frame = 0; frame < frames; frame++) cloth.step(FRAME);
}

test('stepping matches bakeCloth frame for frame with the same inputs', () => {
  const { positions, triangles, size } = sheetOf(10);
  const options = { pinned: [0, size - 1], wind: [0, 0, 1.5], colliders: [{ kind: 'ball', center: [0.45, 0.4, 0.45], radius: 0.25 }] };
  const recording = bakeCloth(positions, triangles, { ...options, frameCount: 40 });
  const cloth = createCloth(positions, triangles, options);
  const stride = positions.length;
  for (let frame = 1; frame < 40; frame++) {
    cloth.step(FRAME);
    assert.deepEqual(cloth.positions, recording.frames.subarray(frame * stride, (frame + 1) * stride), `frame ${frame}`);
  }
});

test('positions is one Float32Array updated in place', () => {
  const { positions, triangles } = sheetOf(5);
  const cloth = createCloth(positions, triangles, { pinned: [0] });
  const before = cloth.positions;
  const startY = before[(4 * 5 + 4) * 3 + 1];
  runFrames(cloth, 10);
  assert.equal(cloth.positions, before);
  assert.ok(before instanceof Float32Array);
  assert.ok(before[(4 * 5 + 4) * 3 + 1] < startY);
});

test('pin and unpin work at runtime', () => {
  const { positions, triangles, size } = sheetOf(6);
  const corner = size - 1;
  const cloth = createCloth(positions, triangles, { pinned: [0] });
  const cornerHeight = () => cloth.positions[corner * 3 + 1];
  cloth.pin(corner);
  assert.equal(cloth.isPinned(corner), true);
  runFrames(cloth, 60);
  assert.ok(Math.abs(cornerHeight() - 1) < 1e-6, 'a pinned corner stays where it was pinned');
  cloth.unpin(corner);
  assert.equal(cloth.isPinned(corner), false);
  runFrames(cloth, 30);
  assert.ok(cornerHeight() < 0.99, 'an unpinned corner falls');
  assert.throws(() => cloth.pin(size * size), RangeError);
});

test('a moving pin drags the cloth', () => {
  const { positions, triangles, size } = sheetOf(8);
  const left = 0;
  const right = size - 1;
  const cloth = createCloth(positions, triangles, { pinned: [left, right] });
  const middle = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 3;
  const startX = cloth.positions[middle];
  for (let frame = 1; frame <= 60; frame++) {
    cloth.pin(left, [-0.002 * frame, 1, 0]);
    cloth.pin(right, [(size - 1) * 0.1 - 0.002 * frame, 1, 0]);
    cloth.step(FRAME);
  }
  assert.ok(Math.abs(cloth.positions[left * 3] - -0.12) < 1e-5, 'the pin reaches its target');
  assert.ok(cloth.positions[middle] < startX - 0.05, 'the middle of the sheet followed');
});

test('pinForce grows with load and balances the weight of a hanging sheet', () => {
  const { positions, triangles, size } = sheetOf(8);
  const top = Array.from({ length: size }, (unused, column) => column);
  const cloth = createCloth(positions, triangles, { pinned: top });
  const total = () => {
    const force = [0, 0, 0];
    let sum = 0;
    for (const pin of top) sum += cloth.pinForce(pin, force)[1];
    return sum;
  };
  runFrames(cloth, 240);
  const unloaded = total();
  const weight = cloth.particleMass * size * size * 9.81;
  assert.ok(unloaded < 0, 'the cloth pulls the pins down');
  // Hanging still, the pins hold the weight of the sheet; the solver is an estimate, so allow a wide band.
  assert.ok(Math.abs(unloaded) > weight * 0.5 && Math.abs(unloaded) < weight * 1.5, `${unloaded} N against ${weight} N of weight`);
  cloth.setExtraMass(size * size - 1, cloth.particleMass * size * size);
  runFrames(cloth, 240);
  assert.ok(Math.abs(total()) > Math.abs(unloaded) * 1.4, 'a heavy particle adds to what the pins carry');
});

test('tearing removes constraints past the threshold and lists them', () => {
  const { positions, triangles, size } = sheetOf(6);
  const cloth = createCloth(positions, triangles, { pinned: [0, size - 1], tearStretch: 1.4 });
  assert.deepEqual(cloth.broken, []);
  runFrames(cloth, 10);
  assert.equal(cloth.broken.length, 0, 'a sheet at rest does not tear');
  // Pull one corner far away from the other so the edges between them stretch past the limit.
  for (let frame = 1; frame <= 30; frame++) {
    cloth.pin(size - 1, [(size - 1) * 0.1 + 0.05 * frame, 1, 0]);
    cloth.step(FRAME);
  }
  assert.ok(cloth.broken.length > 0, 'stretched constraints broke');
  const [first] = cloth.broken;
  assert.ok(Number.isInteger(first.first) && Number.isInteger(first.second));
  assert.ok(['stretch', 'bend'].includes(first.kind));
  assert.equal(new Set(cloth.broken.map(entry => entry.constraint)).size, cloth.broken.length, 'each constraint is listed once');
  const intact = createCloth(positions, triangles, { pinned: [0, size - 1] });
  runFrames(intact, 10);
  assert.equal(intact.broken.length, 0);
});

test('tearForce breaks the edges that carry too much tension and breakConstraint tears by hand', () => {
  const { positions, triangles, size } = sheetOf(6);
  const top = Array.from({ length: size }, (unused, column) => column);
  const cloth = createCloth(positions, triangles, { pinned: top, tearForce: 0.0001 });
  cloth.setExtraMass(size * size - 1, 1);
  runFrames(cloth, 60);
  assert.ok(cloth.broken.some(entry => entry.kind === 'stretch'), 'a tiny force limit tears the loaded sheet');
  const manual = createCloth(positions, triangles, { pinned: [0] });
  manual.breakConstraint(0);
  assert.equal(manual.broken[0].constraint, 0);
  manual.breakConstraint(0);
  assert.equal(manual.broken.filter(entry => entry.constraint === 0).length, 1, 'breaking twice lists it once');
  assert.throws(() => manual.breakConstraint(-1), RangeError);
});

test('extra mass sags more', () => {
  const { positions, triangles, size } = sheetOf(8);
  const top = Array.from({ length: size }, (unused, column) => column);
  // The sheet hangs along z in the rest plane y = 1 and gravity pulls along y, so compare how far it dropped.
  const dropOf = extraKilograms => {
    const cloth = createCloth(positions, triangles, { pinned: top });
    const bottomMiddle = (size - 1) * size + Math.floor(size / 2);
    cloth.setExtraMass(bottomMiddle, extraKilograms);
    runFrames(cloth, 240);
    return 1 - cloth.positions[bottomMiddle * 3 + 1];
  };
  const light = dropOf(0);
  const heavy = dropOf(50);
  assert.ok(heavy > light, `${heavy} should sag more than ${light}`);
});
