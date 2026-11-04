// Strict checks for GLSL snippets that an agent sends as data. Nothing here touches WebGL: the checks run on the text
// before any compile, so a snippet that breaks a rule never reaches a driver. The post-process pass (user-pass.js) is the
// first user; a material fragment hook can reuse validateShaderSnippet, validateSnippetUniforms and mapShaderInfoLog.
//
// A snippet is one GLSL ES 3.00 fragment of at most 4 KB. It declares no uniforms (they come from a separate object),
// has no preprocessor, no `while` or `do`, and only counted `for` loops over integer literals, so every snippet ends.

export const SNIPPET_LIMITS = Object.freeze({
  maxBytes: 4096,
  maxPasses: 4,
  maxUniforms: 16,
  maxLoopIterations: 64,
  // Loop iterations of one call, with nested loops multiplied and helper function calls counted in.
  maxLoopWork: 4096,
});

export const UNIFORM_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
export const UNIFORM_TYPES = Object.freeze(['float', 'vec2', 'vec3', 'vec4', 'int']);
const VECTOR_LENGTHS = Object.freeze({ vec2: 2, vec3: 3, vec4: 4 });
// The engine's own names start with this; a snippet may not write it, so it cannot reach or shadow engine internals.
export const ENGINE_PREFIX = 'u67_';
const ALLOWED_BUILTIN_VARIABLE = 'gl_FragCoord';

// GLSL ES 3.00 keywords and reserved words that fit the uniform name pattern.
const RESERVED_WORDS = new Set(`attribute const uniform varying break continue do for while if else in out inout float int void bool
  true false discard return mat2 mat3 mat4 vec2 vec3 vec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 bvec2 bvec3 bvec4 struct precision highp
  mediump lowp layout centroid flat smooth patch sample buffer shared coherent volatile restrict readonly writeonly resource common
  partition active asm class union enum typedef template this packed goto inline noinline public static extern external interface
  long short double half fixed unsigned superp input output filter namespace using sizeof cast switch case default uint
  sampler2D sampler3D samplerCube`.split(/\s+/));

export class ShaderSnippetError extends Error {
  constructor(label, problem, hint, position) {
    const where = position ? ` line ${position.line}, column ${position.column}` : '';
    super(`${label}${where}: ${problem} Fix: ${hint}`);
    this.name = 'ShaderSnippetError';
    this.line = position?.line ?? null;
    this.column = position?.column ?? null;
    this.hint = hint;
  }
}

/** Rejects an object that carries a field outside `allowed`, naming the allowed ones. */
export function requireKnownFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}. Allowed fields: ${allowed.join(', ')}.`);
  }
}

function positionOf(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    if (text[cursor] === '\n') {
      line++;
      lineStart = cursor + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

// Comments become spaces (newlines stay), so the text that was checked is the text the driver compiles and line numbers hold.
function blankComments(source, label) {
  let result = '';
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair === '//') {
      while (index < source.length && source[index] !== '\n') {
        result += ' ';
        index++;
      }
    } else if (pair === '/*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) {
        throw new ShaderSnippetError(label, 'This block comment never closes.', 'Close it with */ or use // comments.', positionOf(source, index));
      }
      for (; index < end + 2; index++) result += source[index] === '\n' ? '\n' : ' ';
    } else {
      result += source[index];
      index++;
    }
  }
  return result;
}

function checkCharacters(source, label) {
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    const printable = code >= 0x20 && code <= 0x7e;
    if (source[index] === '\\') {
      throw new ShaderSnippetError(label, 'A backslash is not allowed.', 'Remove it; a line continuation can hide code from the checks.', positionOf(source, index));
    }
    if (!printable && code !== 0x0a && code !== 0x0d && code !== 0x09) {
      throw new ShaderSnippetError(label, `Character code ${code} is not allowed.`, 'Use plain ASCII text and newlines only.', positionOf(source, index));
    }
  }
}

const TOKEN_PATTERN = /[A-Za-z_][A-Za-z0-9_]*|\d[\w.]*|\.\d[\w.]*|\+\+|--|<<=|>>=|<=|>=|==|!=|&&|\|\||\^\^|<<|>>|[-+*/%&|^]=|\S/g;

function tokenize(text) {
  return [...text.matchAll(TOKEN_PATTERN)].map(match => ({ text: match[0], index: match.index }));
}

const isIdentifier = token => token !== undefined && /^[A-Za-z_]/.test(token.text);

function checkIdentifiers(tokens, text, label) {
  for (const token of tokens) {
    if (!isIdentifier(token)) continue;
    const position = positionOf(text, token.index);
    const word = token.text;
    if (word === 'while' || word === 'do') {
      throw new ShaderSnippetError(label, `"${word}" loops are not allowed.`,
        `Use a for loop with integer literal bounds of at most ${SNIPPET_LIMITS.maxLoopIterations}, for example for (int i = 0; i < 8; i++) { ... }.`, position);
    }
    if (['uniform', 'layout', 'attribute', 'varying', 'buffer', 'shared'].includes(word)) {
      throw new ShaderSnippetError(label, `"${word}" declarations are not allowed in a snippet.`,
        'Declare values in the uniforms object of the pass; the engine writes their declarations. Use the provided inputs for the rest.', position);
    }
    if (word.startsWith('gl_') && word !== ALLOWED_BUILTIN_VARIABLE) {
      throw new ShaderSnippetError(label, `"${word}" is not allowed; only ${ALLOWED_BUILTIN_VARIABLE} may start with gl_.`,
        `Take the pixel position from ${ALLOWED_BUILTIN_VARIABLE} or the uv argument.`, position);
    }
    if (word.startsWith(ENGINE_PREFIX)) {
      throw new ShaderSnippetError(label, `"${word}" starts with ${ENGINE_PREFIX}, which the engine keeps for its own names.`,
        `Rename it without the ${ENGINE_PREFIX} prefix.`, position);
    }
  }
}

function matchingIndex(tokens, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].text === open) depth++;
    if (tokens[index].text === close && --depth === 0) return index;
  }
  return -1;
}

const INTEGER_LITERAL = /^(0|[1-9]\d*)$/;
const FOR_HEADER_HINT = `Write the header as for (int i = 0; i < 8; i++) with integer literals, at most ${SNIPPET_LIMITS.maxLoopIterations} iterations.`;

// for ( int NAME = N ; NAME <op> N ; step ) { ... } with decimal literals; returns the variable and its iteration count.
function parseForLoop(tokens, forIndex, text, label) {
  const position = positionOf(text, tokens[forIndex].index);
  const fail = (problem, at = forIndex) => {
    throw new ShaderSnippetError(label, problem, FOR_HEADER_HINT, positionOf(text, tokens[Math.min(at, tokens.length - 1)].index));
  };
  const texts = tokens.slice(forIndex).map(token => token.text);
  if (texts[1] !== '(' || texts[2] !== 'int' || !isIdentifier(tokens[forIndex + 3]) || texts[4] !== '=') {
    fail('This for loop must declare one counter: int NAME = literal.');
  }
  const variable = texts[3];
  if (!INTEGER_LITERAL.test(texts[5] ?? '') || texts[6] !== ';') fail('The counter must start at an integer literal.', forIndex + 5);
  if (texts[7] !== variable || !['<', '<=', '>', '>=', '!='].includes(texts[8]) || !INTEGER_LITERAL.test(texts[9] ?? '') || texts[10] !== ';') {
    fail('The loop test must compare the counter with an integer literal.', forIndex + 7);
  }
  let stepDelta;
  let headerEnd;
  if (texts[11] === variable && (texts[12] === '++' || texts[12] === '--') && texts[13] === ')') {
    stepDelta = texts[12] === '++' ? 1 : -1;
    headerEnd = 13;
  } else if ((texts[11] === '++' || texts[11] === '--') && texts[12] === variable && texts[13] === ')') {
    stepDelta = texts[11] === '++' ? 1 : -1;
    headerEnd = 13;
  } else if (texts[11] === variable && (texts[12] === '+=' || texts[12] === '-=') && INTEGER_LITERAL.test(texts[13] ?? '') && texts[14] === ')') {
    stepDelta = Number(texts[13]) * (texts[12] === '+=' ? 1 : -1);
    headerEnd = 14;
  } else {
    fail('The loop step must be i++, ++i, i--, --i, i += N or i -= N.', forIndex + 11);
  }
  if (texts[headerEnd + 1] !== '{') fail('The loop body must be inside { }.', forIndex + headerEnd + 1);
  let counter = Number(texts[5]);
  const limit = Number(texts[9]);
  const compare = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '!=': (a, b) => a !== b }[texts[8]];
  let iterations = 0;
  while (compare(counter, limit) && iterations <= SNIPPET_LIMITS.maxLoopIterations) {
    counter += stepDelta;
    iterations++;
  }
  if (iterations > SNIPPET_LIMITS.maxLoopIterations) {
    throw new ShaderSnippetError(label, `This for loop runs more than ${SNIPPET_LIMITS.maxLoopIterations} iterations.`,
      `Lower the bound or raise the step so the loop runs at most ${SNIPPET_LIMITS.maxLoopIterations} times.`, position);
  }
  const bodyStart = forIndex + headerEnd + 1;
  const bodyEnd = matchingIndex(tokens, bodyStart, '{', '}');
  if (bodyEnd === -1) fail('The loop body never closes.', bodyStart);
  return { variable, iterations, bodyStart, bodyEnd };
}

const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '++', '--', '<<=', '>>=', '&=', '|=', '^=']);

function checkCounterUntouched(tokens, loop, text, label) {
  for (let index = loop.bodyStart + 1; index < loop.bodyEnd; index++) {
    if (tokens[index].text !== loop.variable) continue;
    const touched = ASSIGNMENTS.has(tokens[index + 1]?.text) || ['++', '--'].includes(tokens[index - 1]?.text);
    if (touched) {
      throw new ShaderSnippetError(label, `The loop counter "${loop.variable}" is changed inside its loop body.`,
        'Leave the counter alone in the body; copy it to another variable if you need to change it.', positionOf(text, tokens[index].index));
    }
  }
}

// Function definitions at depth 0: name -> token range of the body.
function findFunctions(tokens) {
  const functions = new Map();
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text === '{') {
      if (depth === 0 && tokens[index - 1]?.text === ')') {
        let open = index - 1;
        let parentheses = 0;
        for (; open >= 0; open--) {
          if (tokens[open].text === ')') parentheses++;
          if (tokens[open].text === '(' && --parentheses === 0) break;
        }
        const end = matchingIndex(tokens, index, '{', '}');
        if (open > 0 && end !== -1 && isIdentifier(tokens[open - 1])) functions.set(tokens[open - 1].text, { start: index, end });
      }
      depth++;
    }
    if (tokens[index].text === '}') depth--;
  }
  return functions;
}

// Loop iterations of one run of tokens[start..end]: a loop multiplies its body, a call to a function of the snippet adds that function's work.
function loopWork(tokens, start, end, loopsByIndex, functions, working, workOfFunction) {
  let total = 0;
  for (let index = start; index < end; index++) {
    const loop = loopsByIndex.get(index);
    if (loop) {
      total += loop.iterations * loopWork(tokens, loop.bodyStart + 1, loop.bodyEnd, loopsByIndex, functions, working, workOfFunction);
      index = loop.bodyEnd;
    } else if (functions.has(tokens[index].text) && tokens[index + 1]?.text === '(' && !working.has(tokens[index].text)) {
      total += workOfFunction(tokens[index].text);
    }
  }
  return Math.max(1, total);
}

function checkLoopWork(tokens, loops, text, label) {
  const loopsByIndex = new Map(loops.map(loop => [loop.forIndex, loop]));
  const functions = findFunctions(tokens);
  const memo = new Map();
  const working = new Set();
  function workOfFunction(name) {
    if (!memo.has(name)) {
      working.add(name);
      const { start, end } = functions.get(name);
      memo.set(name, loopWork(tokens, start + 1, end, loopsByIndex, functions, working, workOfFunction));
      working.delete(name);
    }
    return memo.get(name);
  }
  let worst = 1;
  let worstName = null;
  for (const name of functions.keys()) {
    const work = workOfFunction(name);
    if (work > worst) {
      worst = work;
      worstName = name;
    }
  }
  if (worst > SNIPPET_LIMITS.maxLoopWork) {
    const start = functions.get(worstName).start;
    throw new ShaderSnippetError(label, `Function ${worstName} can run ${worst} loop iterations per pixel, over the limit of ${SNIPPET_LIMITS.maxLoopWork}.`,
      'Shorten the loops or the nesting; nested loops multiply and every call to a helper counts its loops again.', positionOf(text, tokens[start].index));
  }
  return worst;
}

/**
 * Checks one snippet and returns { source, loopWork }, where `source` is the snippet with comments blanked: compile that
 * text, not the original. Throws ShaderSnippetError (line, column, hint) at the first rule it breaks.
 *
 * options.label: names the snippet in messages. options.requiredFunction: { pattern, example } when the snippet must
 * define an entry function. options.maxBytes: lower than the default 4 KB to tighten the limit.
 */
export function validateShaderSnippet(source, options = {}) {
  const label = options.label ?? 'Shader snippet';
  const maxBytes = Math.min(options.maxBytes ?? SNIPPET_LIMITS.maxBytes, SNIPPET_LIMITS.maxBytes);
  if (typeof source !== 'string' || source.trim() === '') {
    throw new ShaderSnippetError(label, 'The fragment is empty or not a string.', 'Send the GLSL text as a string.');
  }
  if (source.length > maxBytes) {
    throw new ShaderSnippetError(label, `The fragment is ${source.length} bytes; the limit is ${maxBytes}.`, 'Shorten the snippet or move constants into uniforms.');
  }
  checkCharacters(source, label);
  const text = blankComments(source, label);
  const preprocessor = text.indexOf('#');
  if (preprocessor !== -1) {
    throw new ShaderSnippetError(label, 'Preprocessor lines (#) are not allowed.', 'Remove the # line; write constants as const float name = value; and use plain code instead of #define.', positionOf(text, preprocessor));
  }
  const tokens = tokenize(text);
  checkIdentifiers(tokens, text, label);
  const loops = [];
  tokens.forEach((token, index) => {
    if (token.text !== 'for') return;
    const loop = { ...parseForLoop(tokens, index, text, label), forIndex: index };
    checkCounterUntouched(tokens, loop, text, label);
    loops.push(loop);
  });
  const work = checkLoopWork(tokens, loops, text, label);
  if (options.requiredFunction && !options.requiredFunction.pattern.test(text)) {
    throw new ShaderSnippetError(label, 'The entry function is missing.', `Define ${options.requiredFunction.example}.`);
  }
  return { source: text, loopWork: work };
}

function checkFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${label} must be a finite number. Fix: send plain JSON numbers, not strings, NaN or Infinity.`);
  }
  return value;
}

function inferType(value) {
  if (typeof value === 'number') return 'float';
  if (Array.isArray(value)) return `vec${value.length}`;
  return null;
}

/**
 * Checks a pass's uniforms and returns them as { name: { type, value } }. A bare number means float and an array of 2 to 4
 * numbers means vec2 to vec4; an int is written { type: 'int', value: 4 }. `reservedNames` are inputs the engine provides.
 */
export function validateSnippetUniforms(uniforms, { label = 'Shader snippet', reservedNames = [] } = {}) {
  if (uniforms === undefined) return {};
  if (!uniforms || typeof uniforms !== 'object' || Array.isArray(uniforms)) {
    throw new TypeError(`${label} uniforms must be an object of name: value. Fix: for example { "levels": 4 }.`);
  }
  const names = Object.keys(uniforms);
  if (names.length > SNIPPET_LIMITS.maxUniforms) {
    throw new RangeError(`${label} has ${names.length} uniforms; the limit is ${SNIPPET_LIMITS.maxUniforms}. Fix: pack values into vec4 uniforms.`);
  }
  const result = {};
  for (const name of names) {
    const where = `${label} uniform "${name}"`;
    if (!UNIFORM_NAME_PATTERN.test(name)) {
      throw new RangeError(`${where}: the name must match ${UNIFORM_NAME_PATTERN}. Fix: start with a lowercase letter, then letters and digits, 32 characters at most.`);
    }
    if (RESERVED_WORDS.has(name) || reservedNames.includes(name)) {
      throw new RangeError(`${where}: the name is a GLSL keyword or an input the engine provides. Fix: pick another name.`);
    }
    const entry = uniforms[name];
    const explicit = entry && typeof entry === 'object' && !Array.isArray(entry);
    const type = explicit ? entry.type : inferType(entry);
    const value = explicit ? entry.value : entry;
    if (explicit) requireKnownFields(entry, ['type', 'value'], where);
    if (!UNIFORM_TYPES.includes(type)) {
      throw new TypeError(`${where}: type must be one of ${UNIFORM_TYPES.join(', ')}. Fix: send a number, an array of 2 to 4 numbers, or { "type": "int", "value": 4 }.`);
    }
    if (type === 'float') {
      checkFiniteNumber(value, where);
    } else if (type === 'int') {
      if (!Number.isInteger(value) || Math.abs(value) > 2 ** 31 - 1) throw new RangeError(`${where}: an int value must be a whole number within 32 bits.`);
    } else if (!Array.isArray(value) || value.length !== VECTOR_LENGTHS[type]) {
      throw new RangeError(`${where}: a ${type} value is an array of ${VECTOR_LENGTHS[type]} numbers.`);
    } else {
      value.forEach((component, index) => checkFiniteNumber(component, `${where}[${index}]`));
    }
    result[name] = { type, value: Array.isArray(value) ? [...value] : value };
  }
  return result;
}

/** The `uniform` lines for validated uniforms, one per line, in name order. */
export function snippetUniformDeclarations(uniforms) {
  return Object.keys(uniforms).sort().map(name => `uniform ${uniforms[name].type} ${name};`).join('\n');
}

/**
 * Rewrites a driver info log so every line number refers to the snippet. `headerLines` counts the lines the engine put
 * before the snippet in the compiled source; `snippet` is the checked text, used to quote the offending line.
 */
export function mapShaderInfoLog(log, { headerLines, snippet }) {
  const snippetLines = snippet.split('\n');
  return String(log).replace(/\0/g, '').trim().split('\n').map(line => {
    const match = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(line.trim());
    if (!match) return line;
    const absolute = Number(match[2]);
    const mapped = absolute - headerLines;
    if (mapped < 1 || mapped > snippetLines.length) return `${match[1]}: engine wrapper line ${absolute}: ${match[3]}`;
    return `${match[1]}: snippet line ${mapped}: ${match[3]}\n    | ${snippetLines[mapped - 1].trim()}`;
  }).join('\n');
}
