// One bounded expression language, two dialects. An expression is JSON data, never code: it is read by walking plain
// objects against a fixed table of operators held in a Map, compiled once into closures and checked against its limits
// before anything runs. No string is executed or used as a property name.
//
// This module owns what both dialects share: the limits check, number literals, the walk, and the table of math
// operators with their operand counts. A dialect adds what only it has:
//   - `src/mesh-fields.js`: element attributes, noise and vectors, evaluated once per mesh element.
//   - `src/motion-expression.js`: motion time and node reads, evaluated once per sampled time.
//
// A compiled value is { kind: 'scalar', evaluate(argument) } or { kind: 'vector', parts: [evaluateX, evaluateY,
// evaluateZ] }. The argument is whatever the dialect evaluates over: an element index or a motion context. Only the
// field dialect makes vectors.
//
// A dialect is { maxNodes, maxDepth, messages: { nodes, depth, number }, reject(message, state), compileOther(node,
// state, depth) }. `reject` returns the Error to throw for a message. `state` holds `dialect` and `nodeCount` plus
// anything the dialect needs while compiling.

export const MAX_LITERAL = 1e6;
export const MAX_OPERANDS = 8;
export const COMPONENTS = Object.freeze({ x: 0, y: 1, z: 2 });

export const scalarValue = evaluate => ({ kind: 'scalar', evaluate });
export const constantScalar = number => scalarValue(() => number);
export const vectorValue = (partX, partY, partZ) => ({ kind: 'vector', parts: [partX, partY, partZ] });

export function partsOf(value) {
  return value.kind === 'vector' ? value.parts : [value.evaluate, value.evaluate, value.evaluate];
}

export function isBoundedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_LITERAL;
}

/** Compile one node. Counts it, checks the limits and number literals, and hands every other node to the dialect. */
export function compileNode(node, state, depth) {
  const { dialect } = state;
  state.nodeCount += 1;
  if (state.nodeCount > dialect.maxNodes) throw dialect.reject(dialect.messages.nodes, state);
  if (depth > dialect.maxDepth) throw dialect.reject(dialect.messages.depth, state);
  if (typeof node === 'number') {
    if (!isBoundedNumber(node)) throw dialect.reject(dialect.messages.number, state);
    return constantScalar(node);
  }
  return dialect.compileOther(node, state, depth);
}

/**
 * The math operators both languages have, as pure functions of numbers with the operand counts they take. The two
 * languages disagree on the edge cases of a few of them, so each dialect passes its own `semantics`: divide, modulo,
 * power, squareRoot and smoothstep. A comparison gives 1 or 0. `if` is not here: what counts as true differs.
 */
export function createMathOperators({ divide, modulo, power, squareRoot, smoothstep }) {
  const entry = (min, max, compute) => ({ min, max, compute });
  return new Map([
    ['add', entry(2, MAX_OPERANDS, (left, right) => left + right)],
    ['mul', entry(2, MAX_OPERANDS, (left, right) => left * right)],
    ['min', entry(2, MAX_OPERANDS, Math.min)],
    ['max', entry(2, MAX_OPERANDS, Math.max)],
    ['sub', entry(2, 2, (left, right) => left - right)],
    ['div', entry(2, 2, divide)],
    ['mod', entry(2, 2, modulo)],
    ['pow', entry(2, 2, power)],
    ['clamp', entry(3, 3, (input, low, high) => Math.min(high, Math.max(low, input)))],
    ['mix', entry(3, 3, (start, end, fraction) => start + (end - start) * fraction)],
    ['smoothstep', entry(3, 3, smoothstep)],
    ['neg', entry(1, 1, number => -number)],
    ['abs', entry(1, 1, Math.abs)],
    ['sqrt', entry(1, 1, squareRoot)],
    ['sin', entry(1, 1, Math.sin)],
    ['cos', entry(1, 1, Math.cos)],
    ['floor', entry(1, 1, Math.floor)],
    ['fract', entry(1, 1, number => number - Math.floor(number))],
    ['lt', entry(2, 2, (left, right) => (left < right ? 1 : 0))],
    ['gt', entry(2, 2, (left, right) => (left > right ? 1 : 0))],
  ]);
}

/**
 * Turn an operator's pure function of numbers into a builder over compiled operands. A number operand gives a number.
 * Where an operand is a vector, the function runs on each component and a number is spread to all three.
 * Operators with more than three operands fold left to right: add, mul, min, max.
 */
export function buildLifted({ max, compute }) {
  const lifted = lift(compute);
  if (max <= 3) return lifted;
  return operands => operands.slice(1).reduce((total, next) => lifted([total, next]), operands[0]);
}

// Fixed-arity calls, not a spread: fields run this once per mesh element.
function applyAcross(compute, evaluators) {
  const [first, second, third] = evaluators;
  if (evaluators.length === 1) return argument => compute(first(argument));
  if (evaluators.length === 2) return argument => compute(first(argument), second(argument));
  return argument => compute(first(argument), second(argument), third(argument));
}

function lift(compute) {
  return operands => {
    if (operands.every(operand => operand.kind === 'scalar')) {
      return scalarValue(applyAcross(compute, operands.map(operand => operand.evaluate)));
    }
    const vectorPart = axis => applyAcross(compute, operands.map(operand => partsOf(operand)[axis]));
    return vectorValue(vectorPart(0), vectorPart(1), vectorPart(2));
  };
}
