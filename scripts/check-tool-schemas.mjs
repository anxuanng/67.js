import { pathToFileURL } from 'node:url';
import { listTools } from './measure-tool-cost.mjs';

/*
 * Checks every MCP tool definition against rules other clients apply, without needing an account.
 *
 * Profiles:
 *   portable      Rules every client we know of enforces. A finding here is a bug in our schema.
 *   openai-strict OpenAI Structured Outputs with `strict: true` function tools.
 *                 Source: https://platform.openai.com/docs/guides/structured-outputs (supported schemas, 2026-10-31).
 *   gemini-subset Keywords outside the subset Gemini documents for structured output and function declarations.
 *                 Sources: https://ai.google.dev/gemini-api/docs/structured-output and
 *                 https://ai.google.dev/gemini-api/docs/function-calling (2026-10-31).
 *
 * The MCP specification makes JSON Schema 2020-12 the default dialect, so `$schema` and `prefixItems` are legal and
 * are not reported as portable findings.
 */

export const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const MAX_DESCRIPTION_CHARACTERS = 1024;
export const OPENAI_STRICT_MAX_PROPERTIES = 5000;
export const OPENAI_STRICT_MAX_DEPTH = 10;
export const OPENAI_STRICT_MAX_ENUM_VALUES = 1000;

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', '$comment', 'examples']);
const TYPE_DETERMINING_KEYWORDS = ['type', '$ref', 'anyOf', 'oneOf', 'allOf', 'const', 'enum', 'not'];
const SCHEMA_MAP_KEYWORDS = ['properties', '$defs', 'patternProperties'];
const SCHEMA_LIST_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const SCHEMA_VALUE_KEYWORDS = ['items', 'additionalProperties', 'not', 'propertyNames'];
const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const OPENAI_STRICT_UNSUPPORTED_KEYWORDS = ['allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else', 'oneOf', 'prefixItems', 'propertyNames', 'patternProperties'];
const GEMINI_UNSUPPORTED_KEYWORDS = ['const', 'oneOf', 'allOf', 'not', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'patternProperties', 'uniqueItems'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Calls visit(schema, path, depth) for every schema node below and including the given one. */
export function visitSchemaNodes(schema, path, visit, depth = 1) {
  if (!isPlainObject(schema)) return;
  visit(schema, path, depth);
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    if (!isPlainObject(schema[keyword])) continue;
    for (const [key, child] of Object.entries(schema[keyword])) {
      visitSchemaNodes(child, `${path}.${keyword}.${key}`, visit, depth + 1);
    }
  }
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    if (!Array.isArray(schema[keyword])) continue;
    schema[keyword].forEach((child, index) => visitSchemaNodes(child, `${path}.${keyword}[${index}]`, visit, depth + 1));
  }
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    visitSchemaNodes(schema[keyword], `${path}.${keyword}`, visit, depth + 1);
  }
}

/** An empty schema, or one with only annotations, accepts any JSON value. It is legal, but some clients want a type. */
export function isAnyValueSchema(node) {
  return Object.keys(node).every(keyword => ANNOTATION_KEYWORDS.has(keyword));
}

function finding(profile, rule, tool, path, detail) {
  return { profile, rule, tool, path, detail };
}

function resolveLocalReference(reference, root) {
  if (reference === '#') return root;
  const prefix = '#/$defs/';
  if (!reference.startsWith(prefix)) return undefined;
  return isPlainObject(root.$defs) ? root.$defs[reference.slice(prefix.length)] : undefined;
}

function checkToolDefinition(tool) {
  const findings = [];
  const root = tool.inputSchema;
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    findings.push(finding('portable', 'tool-name', tool.name, tool.name, `name must match ${TOOL_NAME_PATTERN}`));
  }
  if (typeof tool.description !== 'string' || tool.description.length === 0) {
    findings.push(finding('portable', 'description-missing', tool.name, 'description', 'a tool needs a description'));
  } else if (tool.description.length > MAX_DESCRIPTION_CHARACTERS) {
    findings.push(finding('portable', 'description-length', tool.name, 'description', `${tool.description.length} characters, over ${MAX_DESCRIPTION_CHARACTERS}`));
  }
  if (!isPlainObject(root) || root.type !== 'object' || !isPlainObject(root.properties)) {
    findings.push(finding('portable', 'root-object', tool.name, 'inputSchema', 'the input schema must be type object with a properties map'));
    return findings;
  }
  if (tool.outputSchema !== undefined && !isPlainObject(tool.outputSchema)) {
    findings.push(finding('portable', 'output-schema', tool.name, 'outputSchema', 'an output schema must be an object'));
  }
  visitSchemaNodes(root, `${tool.name}.inputSchema`, (node, path) => {
    findings.push(...checkPortableNode(tool.name, root, node, path));
  });
  return findings;
}

function checkPortableNode(toolName, root, node, path) {
  const findings = [];
  if (!isAnyValueSchema(node) && !TYPE_DETERMINING_KEYWORDS.some(keyword => keyword in node)) {
    findings.push(finding('portable', 'missing-type', toolName, path, 'no type, $ref, anyOf, const or enum'));
  }
  if ('type' in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.every(type => JSON_SCHEMA_TYPES.has(type))) {
      findings.push(finding('portable', 'unknown-type', toolName, path, `type ${JSON.stringify(node.type)}`));
    }
  }
  if ('$ref' in node && resolveLocalReference(node.$ref, root) === undefined) {
    findings.push(finding('portable', 'unresolved-ref', toolName, path, `${node.$ref} does not point into this tool's own schema`));
  }
  if (Array.isArray(node.enum) && node.enum.length === 0) {
    findings.push(finding('portable', 'empty-enum', toolName, path, 'enum has no values'));
  }
  if (Array.isArray(node.required) && isPlainObject(node.properties)) {
    for (const name of node.required.filter(name => !(name in node.properties))) {
      findings.push(finding('portable', 'required-not-declared', toolName, path, `required property ${name} is not in properties`));
    }
  }
  return findings;
}

function countEnumValues(root) {
  let total = 0;
  visitSchemaNodes(root, '', node => {
    if (Array.isArray(node.enum)) total += node.enum.length;
  });
  return total;
}

function countProperties(root) {
  let total = 0;
  visitSchemaNodes(root, '', node => {
    if (isPlainObject(node.properties)) total += Object.keys(node.properties).length;
  });
  return total;
}

function checkOpenAiStrict(tool) {
  const findings = [];
  const root = tool.inputSchema;
  if (!isPlainObject(root)) return findings;
  if ('anyOf' in root) {
    findings.push(finding('openai-strict', 'root-any-of', tool.name, `${tool.name}.inputSchema`, 'the root must not be anyOf'));
  }
  let deepest = 0;
  visitSchemaNodes(root, `${tool.name}.inputSchema`, (node, path, depth) => {
    deepest = Math.max(deepest, depth);
    if (isPlainObject(node.properties)) {
      if (node.additionalProperties !== false) {
        findings.push(finding('openai-strict', 'additional-properties-not-false', tool.name, path, 'every object needs additionalProperties: false'));
      }
      const required = new Set(node.required ?? []);
      const optional = Object.keys(node.properties).filter(name => !required.has(name));
      if (optional.length > 0) {
        findings.push(finding('openai-strict', 'optional-properties', tool.name, path, `${optional.length} properties are not required`));
      }
    }
    if (isAnyValueSchema(node)) {
      findings.push(finding('openai-strict', 'any-value-schema', tool.name, path, 'strict mode needs a type on every schema'));
    }
    for (const keyword of OPENAI_STRICT_UNSUPPORTED_KEYWORDS) {
      if (keyword in node) findings.push(finding('openai-strict', `keyword-${keyword}`, tool.name, path, `${keyword} is not in the documented supported subset`));
    }
  });
  if (deepest > OPENAI_STRICT_MAX_DEPTH) {
    findings.push(finding('openai-strict', 'nesting-depth', tool.name, `${tool.name}.inputSchema`, `${deepest} levels, over ${OPENAI_STRICT_MAX_DEPTH}`));
  }
  const propertyTotal = countProperties(root);
  if (propertyTotal > OPENAI_STRICT_MAX_PROPERTIES) {
    findings.push(finding('openai-strict', 'property-count', tool.name, `${tool.name}.inputSchema`, `${propertyTotal} properties, over ${OPENAI_STRICT_MAX_PROPERTIES}`));
  }
  const enumTotal = countEnumValues(root);
  if (enumTotal > OPENAI_STRICT_MAX_ENUM_VALUES) {
    findings.push(finding('openai-strict', 'enum-count', tool.name, `${tool.name}.inputSchema`, `${enumTotal} enum values, over ${OPENAI_STRICT_MAX_ENUM_VALUES}`));
  }
  return findings;
}

function checkGeminiSubset(tool) {
  const findings = [];
  if (!isPlainObject(tool.inputSchema)) return findings;
  visitSchemaNodes(tool.inputSchema, `${tool.name}.inputSchema`, (node, path) => {
    if (isAnyValueSchema(node)) {
      findings.push(finding('gemini-subset', 'any-value-schema', tool.name, path, 'Gemini function declarations need a type on every schema'));
    }
    for (const keyword of GEMINI_UNSUPPORTED_KEYWORDS) {
      if (keyword in node) findings.push(finding('gemini-subset', `keyword-${keyword}`, tool.name, path, `${keyword} is outside the documented subset`));
    }
    if ('$ref' in node) {
      findings.push(finding('gemini-subset', 'keyword-$ref', tool.name, path, '$ref needs a client that inlines references'));
    }
  });
  return findings;
}

export function checkToolSchemas(tools) {
  const findings = [];
  const seenNames = new Set();
  for (const tool of tools) {
    if (seenNames.has(tool.name)) {
      findings.push(finding('portable', 'duplicate-name', tool.name, tool.name, 'two tools share this name'));
    }
    seenNames.add(tool.name);
    findings.push(...checkToolDefinition(tool));
    findings.push(...checkOpenAiStrict(tool));
    findings.push(...checkGeminiSubset(tool));
  }
  return findings;
}

export function summarizeFindings(findings) {
  const summary = {};
  for (const { profile, rule } of findings) {
    summary[profile] ??= {};
    summary[profile][rule] = (summary[profile][rule] ?? 0) + 1;
  }
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tools = await listTools();
  const findings = checkToolSchemas(tools);
  console.log(JSON.stringify({ tools: tools.length, summary: summarizeFindings(findings) }, null, 2));
  for (const item of findings.filter(candidate => candidate.profile === 'portable')) {
    console.log(`${item.rule} ${item.path}: ${item.detail}`);
  }
}
