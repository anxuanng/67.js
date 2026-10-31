import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMotionExpression } from '../src/motion-expression.js';
import { evaluateField, pointSetContext, validateField } from '../src/mesh-fields.js';

const nodeIds = new Set(['wheel']);
const motionValue = (expression, time = 0) => {
  const compiled = compileMotionExpression(expression, nodeIds, 'Driver');
  return compiled.evaluate({ time, read: () => 0 });
};
const fieldValue = expression => {
  const points = new Float64Array([0, 0, 0]);
  return evaluateField(expression, pointSetContext(points, points)).values[0];
};
const bothContexts = expression => [motionValue(expression), fieldValue(expression)];

test('both contexts give the same result for the same operator', () => {
  const cases = [
    [{ if: [-1, 10, 20] }, 10],
    [{ if: [0, 10, 20] }, 20],
    [{ smoothstep: [1, 1, 0.5] }, 0],
    [{ smoothstep: [1, 1, 2] }, 1],
    [{ sqrt: [-4] }, 0],
    [{ pow: [-8, 0.5] }, 0],
    [{ mod: [5, 0] }, 0],
    [{ sqrt: 9 }, 3],
    [{ neg: [3] }, -3],
    [{ neg: 3 }, -3],
    [{ and: [1, 2] }, 1],
    [{ lte: [2, 2] }, 1],
    [{ atan2: [0, 1] }, 0],
    [{ saturate: [5] }, 1],
    [{ add: [true, 1] }, 2],
  ];
  for (const [expression, expected] of cases) {
    assert.deepEqual(bothContexts(expression), [expected, expected], JSON.stringify(expression));
  }
});

test('a division by zero is 0 in a field and an error in a driver', () => {
  assert.equal(fieldValue({ div: [1, 0] }), 0);
  assert.throws(() => motionValue({ div: [1, 0] }), /finite/);
});

test('each context rejects the other context\'s inputs and says so', () => {
  assert.throws(() => motionValue({ attr: 'position' }), /field input.*motion expression/);
  assert.throws(() => motionValue({ noise: { scale: 2 } }), /field input/);
  assert.throws(() => motionValue({ dot: [1, 2] }), /field input/);
  assert.throws(() => motionValue([1, 2, 3]), /field input/);
  assert.throws(() => validateField('time'), /motion input.*field expression/);
  assert.throws(() => validateField({ node: 'wheel', property: 'translation', component: 'x' }), /motion input/);
});
