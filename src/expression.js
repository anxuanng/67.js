import { denseArray } from './motion-validation.js';

// One bounded expression language. An expression is JSON data, never code: it is read by walking plain objects against
// a fixed table of operators held in a Map, compiled once into closures and checked against its limits before
// anything runs. No string is executed or used as a property name.
//
// The operators are the same everywhere, and so are their results: `div`, `mod` and `pow` give 0 instead of a
// non-finite number, `sqrt` of a negative is 0, `if` takes its second operand when the condition is not 0, and
// `smoothstep` with equal edges is a step. An operator's operands are an array, `{"add": [1, 2]}`; an operator with one
// operand may also write it bare, `{"neg": x}`.
//
// What differs is the context an expression runs in, and so the inputs it may read:
//   - field (`src/mesh-fields.js`): per mesh element. Attributes, noise, random, vectors and vector operators.
//   - motion (`src/motion-expression.js`): per sampled time. `time` and reads of node values.
// A context rejects the other's inputs with a message that says so.
//
// A compiled value is { kind: 'scalar', evaluate(argument) } or { kind: 'vector', parts: [evaluateX, evaluateY,
// evaluateZ] }. The argument is an element index or a motion context. Only fields make vectors.
//
// A dialect is { name, accepts, maxNodes, maxDepth, operators, sourceNames, reject(message, state), compileInput(node,
// state, depth) }. `accepts` completes "use ...", `operators` is a Map, `reject` returns the Error to throw, and
// `compileInput` returns a compiled value for an input of its own context or undefined. `state` holds `dialect` and
// `nodeCount` plus anything the dialect needs while compiling.

export const MAX_LITERAL = 1e6;
export const MAX_OPERANDS = 8;
export const COMPONENTS = Object.freeze({ x: 0, y: 1, z: 2 });
const MAX_REPORTED_KEY_LENGTH = 24;
const VECTOR_OPERATOR_NAMES = Object.freeze(['vec', 'dot', 'cross', 'distance', 'length', 'normalize', 'x', 'y', 'z']);
const FIELD_INPUT_NAMES = new Set([...VECTOR_OPERATOR_NAMES, 'attr', 'noise', 'random']);
const OPERAND_WORDS = new Map([[1, 'one operand'], [2, 'two operands'], [3, 'three operands']]);

export const scalarValue = evaluate => ({ kind: 'scalar', evaluate });
export const constantScalar = number => scalarValue(() => number);
export const vectorValue = (partX, partY, partZ) => ({ kind: 'vector', parts: [partX, partY, partZ] });

export function partsOf(value) {
  return value.kind === 'vector' ? value.parts : [value.evaluate, value.evaluate, value.evaluate];
}

export function isBoundedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_LITERAL;
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function describeKey(key) {
  const clipped = key.length > MAX_REPORTED_KEY_LENGTH ? `${key.slice(0, MAX_REPORTED_KEY_LENGTH)}...` : key;
  return JSON.stringify(clipped);
}

// ---------------------------------------------------------------------------------------------------------------
// Operators.

// Fixed-arity calls, not a spread: fields run this once per mesh element.
function applyAcross(compute, evaluators) {
  const [first, second, third] = evaluators;
  if (evaluators.length === 1) return argument => compute(first(argument));
  if (evaluators.length === 2) return argument => compute(first(argument), second(argument));
  return argument => compute(first(argument), second(argument), third(argument));
}

/**
 * Build an operator from a pure function of numbers. Where an operand is a vector, the function runs on each component
 * and a number is spread to all three. Operators with more than three operands fold left to right: add, mul, min, max.
 */
export function liftOperator(min, max, compute) {
  const lifted = operands => {
    if (operands.every(operand => operand.kind === 'scalar')) {
      return scalarValue(applyAcross(compute, operands.map(operand => operand.evaluate)));
    }
    const vectorPart = axis => applyAcross(compute, operands.map(operand => partsOf(operand)[axis]));
    return vectorValue(vectorPart(0), vectorPart(1), vectorPart(2));
  };
  const build = max <= 3 ? lifted : operands => operands.slice(1).reduce((total, next) => lifted([total, next]), operands[0]);
  return { min, max, build };
}

export function requireScalar(value, label) {
  if (value.kind !== 'scalar') throw new TypeError(`${label} needs a number, not a vector.`);
  return value.evaluate;
}

function compareOperator(compute) {
  const build = ([left, right]) => {
    const leftEvaluate = requireScalar(left, 'a comparison');
    const rightEvaluate = requireScalar(right, 'a comparison');
    return scalarValue(argument => (compute(leftEvaluate(argument), rightEvaluate(argument)) ? 1 : 0));
  };
  return { min: 2, max: 2, build };
}

function logicOperator(isAnd) {
  const build = operands => {
    const evaluators = operands.map(operand => requireScalar(operand, 'a logic operator'));
    return scalarValue(argument => {
      for (const evaluate of evaluators) {
        const isTrue = evaluate(argument) !== 0;
        if (isAnd && !isTrue) return 0;
        if (!isAnd && isTrue) return 1;
      }
      return isAnd ? 1 : 0;
    });
  };
  return { min: 2, max: MAX_OPERANDS, build };
}

function notOperator() {
  const build = ([operand]) => {
    const evaluate = requireScalar(operand, 'not');
    return scalarValue(argument => (evaluate(argument) === 0 ? 1 : 0));
  };
  return { min: 1, max: 1, build };
}

function ifOperator() {
  const build = ([condition, whenTrue, whenFalse]) => {
    const test = requireScalar(condition, 'if');
    const [trueX, trueY, trueZ] = partsOf(whenTrue);
    const [falseX, falseY, falseZ] = partsOf(whenFalse);
    if (whenTrue.kind === 'scalar' && whenFalse.kind === 'scalar') {
      return scalarValue(argument => (test(argument) !== 0 ? trueX(argument) : falseX(argument)));
    }
    return vectorValue(
      argument => (test(argument) !== 0 ? trueX(argument) : falseX(argument)),
      argument => (test(argument) !== 0 ? trueY(argument) : falseY(argument)),
      argument => (test(argument) !== 0 ? trueZ(argument) : falseZ(argument)),
    );
  };
  return { min: 3, max: 3, build };
}

function finiteOrZero(number) {
  return Number.isFinite(number) ? number : 0;
}

function smoothstep(edgeStart, edgeEnd, input) {
  if (edgeStart === edgeEnd) return input < edgeStart ? 0 : 1;
  const fraction = Math.min(1, Math.max(0, (input - edgeStart) / (edgeEnd - edgeStart)));
  return fraction * fraction * (3 - 2 * fraction);
}

/** A new Map of the operators every context has; a dialect adds its own to it. */
export function createOperators() {
  return new Map([
    ['add', liftOperator(2, MAX_OPERANDS, (left, right) => left + right)],
    ['mul', liftOperator(2, MAX_OPERANDS, (left, right) => left * right)],
    ['min', liftOperator(2, MAX_OPERANDS, Math.min)],
    ['max', liftOperator(2, MAX_OPERANDS, Math.max)],
    ['sub', liftOperator(2, 2, (left, right) => left - right)],
    ['div', liftOperator(2, 2, (left, right) => (right === 0 ? 0 : left / right))],
    ['mod', liftOperator(2, 2, (left, right) => (right === 0 ? 0 : left - right * Math.floor(left / right)))],
    ['pow', liftOperator(2, 2, (base, exponent) => finiteOrZero(Math.pow(base, exponent)))],
    ['atan2', liftOperator(2, 2, Math.atan2)],
    ['clamp', liftOperator(3, 3, (input, low, high) => Math.min(high, Math.max(low, input)))],
    ['mix', liftOperator(3, 3, (start, end, fraction) => start + (end - start) * fraction)],
    ['smoothstep', liftOperator(3, 3, smoothstep)],
    ['neg', liftOperator(1, 1, number => -number)],
    ['abs', liftOperator(1, 1, Math.abs)],
    ['sqrt', liftOperator(1, 1, number => (number < 0 ? 0 : Math.sqrt(number)))],
    ['sin', liftOperator(1, 1, Math.sin)],
    ['cos', liftOperator(1, 1, Math.cos)],
    ['floor', liftOperator(1, 1, Math.floor)],
    ['ceil', liftOperator(1, 1, Math.ceil)],
    ['round', liftOperator(1, 1, Math.round)],
    ['fract', liftOperator(1, 1, number => number - Math.floor(number))],
    ['sign', liftOperator(1, 1, Math.sign)],
    ['saturate', liftOperator(1, 1, number => Math.min(1, Math.max(0, number)))],
    ['lt', compareOperator((left, right) => left < right)],
    ['lte', compareOperator((left, right) => left <= right)],
    ['gt', compareOperator((left, right) => left > right)],
    ['gte', compareOperator((left, right) => left >= right)],
    ['eq', compareOperator((left, right) => left === right)],
    ['and', logicOperator(true)],
    ['or', logicOperator(false)],
    ['not', notOperator()],
    ['if', ifOperator()],
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// The walk.

function describeOperandCount({ min, max }) {
  return min === max ? OPERAND_WORDS.get(min) : `${min} to ${max} operands`;
}

function compileOperator(name, operand, state, depth) {
  const { dialect } = state;
  const operator = dialect.operators.get(name);
  if (!operator) {
    const names = [...dialect.operators.keys(), ...dialect.sourceNames];
    throw dialect.reject(`unknown operator ${describeKey(name)}. Use one of ${names.join(', ')}.`, state);
  }
  const isBare = operator.max === 1 && !(Array.isArray(operand) && operand.length === 1);
  const operands = isBare ? [operand] : operand;
  const arityMessage = `${name} takes ${describeOperandCount(operator)}.`;
  if (!Array.isArray(operands)) throw dialect.reject(arityMessage, state);
  denseArray(operands, MAX_OPERANDS, `${name} operands`);
  if (operands.length < operator.min || operands.length > operator.max) throw dialect.reject(arityMessage, state);
  return operator.build(operands.map(child => compileNode(child, state, depth + 1)));
}

// The context an input belongs to, when it is not an operator.
function contextOfInput(node) {
  if (node === 'time' || (isPlainObject(node) && Object.hasOwn(node, 'node'))) return 'motion';
  if (Array.isArray(node) || (isPlainObject(node) && (Object.hasOwn(node, 'attr') || FIELD_INPUT_NAMES.has(Object.keys(node)[0])))) return 'field';
  return null;
}

/** Compile one node. Counts it, checks the limits and literals, then reads an input or an operator. */
export function compileNode(node, state, depth) {
  const { dialect } = state;
  state.nodeCount += 1;
  if (state.nodeCount > dialect.maxNodes) throw dialect.reject(`more than ${dialect.maxNodes} nodes.`, state);
  if (depth > dialect.maxDepth) throw dialect.reject(`nests deeper than ${dialect.maxDepth} levels.`, state);
  if (typeof node === 'number') {
    if (!isBoundedNumber(node)) throw dialect.reject(`a number must be finite and within ${MAX_LITERAL}.`, state);
    return constantScalar(node);
  }
  if (typeof node === 'boolean') return constantScalar(node ? 1 : 0);
  const input = dialect.compileInput(node, state, depth);
  if (input) return input;
  const foreignContext = contextOfInput(node);
  if (foreignContext && foreignContext !== dialect.name) {
    throw dialect.reject(`this is a ${foreignContext} input and a ${dialect.name} expression cannot use it. A ${dialect.name} expression takes ${dialect.accepts}.`, state);
  }
  if (!isPlainObject(node)) throw dialect.reject(`use ${dialect.accepts}.`, state);
  const keys = Object.keys(node);
  if (keys.length !== 1) throw dialect.reject(`an operator object has exactly one key, such as {"add": [1, 2]}; got ${keys.length}.`, state);
  return compileOperator(keys[0], node[keys[0]], state, depth);
}
