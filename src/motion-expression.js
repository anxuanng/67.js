import { denseArray, knownKeys } from './motion-validation.js';

// Bounded motion expressions: a small JSON language for drivers and constraint influence. An expression is data, never
// code. It is read by walking plain objects against a fixed table of operators, compiled once into closures and checked
// against its limits before anything runs. No string is executed, and operator names come from a Map.
//
//   { "mul": [{ "node": "wheel", "property": "rotation", "component": "x" }, 0.01] }
//   { "clamp": [{ "mul": ["time", 0.5] }, 0, 1] }
//
// A number is a constant and the string "time" is the motion time in seconds. A node read takes a component (x, y or z)
// of a node's translation, scale, or rotation (Euler XYZ in degrees), in "local" (default) or "world" space.
// Operators: add mul min max (2 to 8 operands), sub div pow mod atan2 gt lt (2), neg abs sin cos sqrt floor fract
// saturate (1), clamp(x, low, high) mix(a, b, t) smoothstep(low, high, x) if(condition, then, otherwise) (3).
// sin and cos take radians; gt, lt and if use 1 and 0 for true and false.

export const MAX_EXPRESSION_NODES = 64;
export const MAX_EXPRESSION_DEPTH = 8;
const MAX_LITERAL = 1e6;
const MAX_OPERANDS = 8;
const COMPONENTS = Object.freeze({ x: 0, y: 1, z: 2 });
const READ_PROPERTIES = ['translation', 'rotation', 'scale'];

const smoothstep = (low, high, value) => {
  const fraction = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return fraction * fraction * (3 - 2 * fraction);
};

const UNARY = new Map([
  ['neg', value => -value], ['abs', Math.abs], ['sin', Math.sin], ['cos', Math.cos], ['sqrt', Math.sqrt],
  ['floor', Math.floor], ['fract', value => value - Math.floor(value)], ['saturate', value => Math.min(1, Math.max(0, value))],
]);
const VARIADIC = new Map([
  ['add', (left, right) => left + right], ['mul', (left, right) => left * right], ['min', Math.min], ['max', Math.max],
]);
const BINARY = new Map([
  ['sub', (left, right) => left - right], ['div', (left, right) => left / right], ['pow', Math.pow],
  ['mod', (left, right) => left - right * Math.floor(left / right)], ['atan2', Math.atan2],
  ['gt', (left, right) => (left > right ? 1 : 0)], ['lt', (left, right) => (left < right ? 1 : 0)],
]);
const TERNARY = new Map([
  ['clamp', (value, low, high) => Math.min(high, Math.max(low, value))],
  ['mix', (start, end, fraction) => start + (end - start) * fraction],
  ['smoothstep', smoothstep],
  ['if', (condition, thenValue, otherwiseValue) => (condition > 0 ? thenValue : otherwiseValue)],
]);

function compileRead(input, state, label) {
  knownKeys(input, ['node', 'property', 'component', 'space'], `${label} node read`);
  if (!state.nodeIds.has(input.node)) throw new RangeError(`${label}: node ${JSON.stringify(input.node)} is not in this scene.`);
  if (!READ_PROPERTIES.includes(input.property)) throw new RangeError(`${label}: property must be translation, rotation or scale.`);
  if (!Object.hasOwn(COMPONENTS, input.component)) throw new RangeError(`${label}: component must be x, y or z.`);
  const space = input.space ?? 'local';
  if (space !== 'local' && space !== 'world') throw new RangeError(`${label}: space must be local or world.`);
  state.reads.add(input.node);
  const component = COMPONENTS[input.component];
  return context => context.read(input.node, input.property, component, space);
}

function compileOperator(input, state, depth, label) {
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new TypeError(`${label}: an operator object has exactly one key, such as {"add": [1, 2]}.`);
  const [name] = keys;
  const operands = denseArray(input[name], MAX_OPERANDS, `${label} ${name} operands`).map(operand => compile(operand, state, depth + 1, label));
  const arity = (count, text) => {
    if (operands.length !== count) throw new RangeError(`${label}: ${name} takes ${text}.`);
  };
  if (UNARY.has(name)) {
    arity(1, 'one operand');
    const compute = UNARY.get(name);
    return context => compute(operands[0](context));
  }
  if (VARIADIC.has(name)) {
    if (operands.length < 2) throw new RangeError(`${label}: ${name} takes 2 to ${MAX_OPERANDS} operands.`);
    const compute = VARIADIC.get(name);
    return context => operands.slice(1).reduce((total, operand) => compute(total, operand(context)), operands[0](context));
  }
  if (BINARY.has(name)) {
    arity(2, 'two operands');
    const compute = BINARY.get(name);
    return context => compute(operands[0](context), operands[1](context));
  }
  if (TERNARY.has(name)) {
    arity(3, 'three operands');
    const compute = TERNARY.get(name);
    return context => compute(operands[0](context), operands[1](context), operands[2](context));
  }
  throw new RangeError(`${label}: unknown operator ${JSON.stringify(name.slice(0, 24))}.`);
}

function compile(input, state, depth, label) {
  state.count += 1;
  if (state.count > MAX_EXPRESSION_NODES) throw new RangeError(`${label} has more than ${MAX_EXPRESSION_NODES} parts.`);
  if (depth > MAX_EXPRESSION_DEPTH) throw new RangeError(`${label} nests deeper than ${MAX_EXPRESSION_DEPTH} levels.`);
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Math.abs(input) > MAX_LITERAL) throw new RangeError(`${label}: a number must be finite and within ${MAX_LITERAL}.`);
    return () => input;
  }
  if (input === 'time') return context => context.time;
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError(`${label}: use a number, "time", a node read or an operator object.`);
  return Object.hasOwn(input, 'node') ? compileRead(input, state, label) : compileOperator(input, state, depth, label);
}

/**
 * Compile an expression. `evaluate({ time, read })` returns a finite number; `read(id, property, component, space)`
 * supplies node values. `reads` lists the node IDs the expression looks at.
 */
export function compileMotionExpression(input, nodeIds, label) {
  const state = { count: 0, reads: new Set(), nodeIds };
  const evaluateTree = compile(input, state, 0, label);
  return Object.freeze({
    reads: [...state.reads],
    evaluate(context) {
      const value = evaluateTree(context);
      if (!Number.isFinite(value)) throw new RangeError(`${label} produced ${value} at time ${context.time}; it must stay finite.`);
      return value;
    },
  });
}
