import test from 'node:test';
import assert from 'node:assert/strict';
import { approachValue } from '../src/preview-transition.js';

test('assembly approaches arbitrary targets smoothly without overshooting', () => {
  let position = 0;
  position = approachValue(position, 0.73, 1 / 60);
  assert.ok(position > 0 && position < 0.73);
  for (let frame = 0; frame < 120; frame++) position = approachValue(position, 0.73, 1 / 60);
  assert.equal(position, 0.73);
  const reversed = approachValue(position, 0.12, 1 / 60);
  assert.ok(reversed < position && reversed > 0.12);
});

test('transition timing is independent of display refresh and reaches fully assembled', () => {
  const sample = frequency => {
    let position = 1;
    for (let frame = 0; frame < frequency / 2; frame++) position = approachValue(position, 0, 1 / frequency);
    return position;
  };
  assert.ok(Math.abs(sample(60) - sample(144)) < 1e-12);
  assert.equal(approachValue(0.001, 0, 0.2), 0);
  assert.throws(() => approachValue(0, 1, -1), TypeError);
  assert.throws(() => approachValue(0, NaN, 0.1), TypeError);
});
