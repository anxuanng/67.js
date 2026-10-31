import { denseArray, knownKeys } from './motion-validation.js';
import {
  COMPONENTS, MAX_LITERAL, MAX_OPERANDS, buildLifted, compileNode, createMathOperators, scalarValue,
} from './expression.js';

// Bounded motion expressions: a small JSON language for drivers and constraint influence. An expression is data, never
// code. It is read by walking plain objects against a fixed table of operators, compiled once into closures and checked
// against its limits before anything runs. No string is executed, and operator names come from a Map.
// This is the motion dialect of the one expression language in expression.js; mesh-fields.js is the field dialect.
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
const READ_PROPERTIES = ['translation', 'rotation', 'scale'];
const OPERAND_COUNT_TEXT = new Map([[1, 'one operand'], [2, 'two operands'], [3, 'three operands']]);

// Where the two dialects disagree, a motion expression keeps plain arithmetic: a division by zero or the square root
// of a negative number gives a non-finite value, which `evaluate` rejects instead of hiding it as the field dialect does.
const motionSemantics = Object.freeze({
  divide: (left, right) => left / right,
  modulo: (left, right) => left - right * Math.floor(left / right),
  power: Math.pow,
  squareRoot: Math.sqrt,
  smoothstep: (low, high, value) => {
    const fraction = Math.min(1, Math.max(0, (value - low) / (high - low)));
    return fraction * fraction * (3 - 2 * fraction);
  },
});

const OPERATORS = createMathOperators(motionSemantics);
OPERATORS.set('saturate', { min: 1, max: 1, compute: value => Math.min(1, Math.max(0, value)) });
OPERATORS.set('atan2', { min: 2, max: 2, compute: Math.atan2 });
OPERATORS.set('if', { min: 3, max: 3, compute: (condition, thenValue, otherwiseValue) => (condition > 0 ? thenValue : otherwiseValue) });

function describeOperandCount(operator) {
  if (operator.min === operator.max) return OPERAND_COUNT_TEXT.get(operator.min);
  return `${operator.min} to ${operator.max} operands`;
}

function compileRead(input, state) {
  const { label, nodeIds } = state;
  knownKeys(input, ['node', 'property', 'component', 'space'], `${label} node read`);
  if (!nodeIds.has(input.node)) throw new RangeError(`${label}: node ${JSON.stringify(input.node)} is not in this scene.`);
  if (!READ_PROPERTIES.includes(input.property)) throw new RangeError(`${label}: property must be translation, rotation or scale.`);
  if (!Object.hasOwn(COMPONENTS, input.component)) throw new RangeError(`${label}: component must be x, y or z.`);
  const space = input.space ?? 'local';
  if (space !== 'local' && space !== 'world') throw new RangeError(`${label}: space must be local or world.`);
  state.reads.add(input.node);
  const component = COMPONENTS[input.component];
  return scalarValue(context => context.read(input.node, input.property, component, space));
}

function compileOperator(input, state, depth) {
  const { label } = state;
  const keys = Object.keys(input);
  if (keys.length !== 1) throw new TypeError(`${label}: an operator object has exactly one key, such as {"add": [1, 2]}.`);
  const [name] = keys;
  const operands = denseArray(input[name], MAX_OPERANDS, `${label} ${name} operands`).map(operand => compileNode(operand, state, depth + 1));
  const operator = OPERATORS.get(name);
  if (!operator) throw new RangeError(`${label}: unknown operator ${JSON.stringify(name.slice(0, 24))}.`);
  if (operands.length < operator.min || operands.length > operator.max) {
    throw new RangeError(`${label}: ${name} takes ${describeOperandCount(operator)}.`);
  }
  return buildLifted(operator)(operands);
}

function compileOther(input, state, depth) {
  if (input === 'time') return scalarValue(context => context.time);
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError(`${state.label}: use a number, "time", a node read or an operator object.`);
  }
  return Object.hasOwn(input, 'node') ? compileRead(input, state) : compileOperator(input, state, depth);
}

const MOTION_DIALECT = Object.freeze({
  maxNodes: MAX_EXPRESSION_NODES,
  maxDepth: MAX_EXPRESSION_DEPTH,
  messages: Object.freeze({
    nodes: ` has more than ${MAX_EXPRESSION_NODES} parts.`,
    depth: ` nests deeper than ${MAX_EXPRESSION_DEPTH} levels.`,
    number: `: a number must be finite and within ${MAX_LITERAL}.`,
  }),
  reject: (message, state) => new RangeError(`${state.label}${message}`),
  compileOther,
});

/**
 * Compile an expression. `evaluate({ time, read })` returns a finite number; `read(id, property, component, space)`
 * supplies node values. `reads` lists the node IDs the expression looks at.
 */
export function compileMotionExpression(input, nodeIds, label) {
  const state = { dialect: MOTION_DIALECT, nodeCount: 0, label, nodeIds, reads: new Set() };
  const { evaluate: evaluateTree } = compileNode(input, state, 0);
  return Object.freeze({
    reads: [...state.reads],
    evaluate(context) {
      const value = evaluateTree(context);
      if (!Number.isFinite(value)) throw new RangeError(`${label} produced ${value} at time ${context.time}; it must stay finite.`);
      return value;
    },
  });
}
