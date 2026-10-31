import { knownKeys } from './motion-validation.js';
import { COMPONENTS, compileNode, createOperators, isPlainObject, liftOperator, scalarValue } from './expression.js';

// Bounded motion expressions: the motion context of the one expression language in expression.js, for drivers and
// constraint influence. An expression is data, never code. See that file for the operators and how they behave.
//
//   { "mul": [{ "node": "wheel", "property": "rotation", "component": "x" }, 0.01] }
//   { "clamp": [{ "mul": ["time", 0.5] }, 0, 1] }
//
// The string "time" is the motion time in seconds. A node read takes a component (x, y or z) of a node's translation,
// scale, or rotation (Euler XYZ in degrees), in "local" (default) or "world" space. Vectors, attributes and noise
// belong to fields and are rejected here. sin and cos take radians.

export const MAX_EXPRESSION_NODES = 64;
export const MAX_EXPRESSION_DEPTH = 8;
const READ_PROPERTIES = ['translation', 'rotation', 'scale'];

// The one operator that differs from fields. A driver that divides by zero is a mistake the agent should hear about:
// the result is non-finite and `evaluate` rejects it, where a field turns it into 0.
const OPERATORS = createOperators();
OPERATORS.set('div', liftOperator(2, 2, (left, right) => left / right));

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

function compileInput(node, state) {
  if (node === 'time') return scalarValue(context => context.time);
  if (isPlainObject(node) && Object.hasOwn(node, 'node')) return compileRead(node, state);
  return undefined;
}

const MOTION_DIALECT = Object.freeze({
  name: 'motion',
  accepts: 'a number, "time", a node read or an operator object',
  maxNodes: MAX_EXPRESSION_NODES,
  maxDepth: MAX_EXPRESSION_DEPTH,
  operators: OPERATORS,
  sourceNames: Object.freeze(['time', 'node']),
  reject: (message, state) => new TypeError(`${state.label}: ${message}`),
  compileInput,
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
