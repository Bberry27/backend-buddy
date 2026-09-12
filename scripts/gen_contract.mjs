#!/usr/bin/env node
// Generates the TypeScript view of the SchemaGraph contract and the Markdown field tables
// from the single source of truth, packages/contract/schema-graph.v1.json (work package C01,
// CTQ-13). Dependency-free on purpose: the offline artifact's source tree must build without
// anything this script needs, and the generated TypeScript is committed so the skill copy
// compiles without Node tooling of its own.
//
//   node scripts/gen_contract.mjs            write packages/explorer/src/contract.generated.ts,
//                                            the field tables in skill/references/schema-contract.md
//                                            and Part A of docs/architecture/schema-graph-contract.md
//   node scripts/gen_contract.mjs --check    regenerate in memory and exit 1 on drift
//   node scripts/gen_contract.mjs --docs     print the field-table block to stdout
//
// Part A of docs/architecture/schema-graph-contract.md reproduces skill/references/schema-contract.md
// verbatim, so the generator writes and checks that copy as well. Two prose copies of one contract
// drift apart silently otherwise, and a stale field table can reintroduce wording the reference no
// longer carries, including canonical caveat text that belongs only in docs/reference/caveats.md.
//
// The schema describes what an adapter may put on the wire, including the legacy boolean and
// nullable forms. The generated TypeScript describes the document after normalize() has run,
// because that is the only shape the views ever see (schema-graph-contract.md B4). Where the
// two differ, the schema carries the TypeScript form in `x-tsType`, and the property sets that
// normalize() guarantees are listed in each definition's `x-typescript.required`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_PATH = join(ROOT, 'packages/contract/schema-graph.v1.json');
export const TYPES_PATH = join(ROOT, 'packages/explorer/src/contract.generated.ts');
export const REFERENCE_PATH = join(ROOT, 'skill/references/schema-contract.md');
export const ARCHITECTURE_PATH = join(ROOT, 'docs/architecture/schema-graph-contract.md');
export const DOCS_START = '<!-- generated:fields:start -->';
export const DOCS_END = '<!-- generated:fields:end -->';
export const PART_A_HEADING = '## Part A. Canonical Schema Contract';
const ROOT_DEFINITION = 'SchemaGraph';
const GENERATOR = 'scripts/gen_contract.mjs';

/** Reads and parses the committed JSON Schema. */
export function loadSchema(path = SCHEMA_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Resolves a local `#/$defs/Name` pointer against the schema document. */
export function resolveRef(schema, ref) {
  const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(String(ref));
  if (!match || !isObject(schema.$defs?.[match[1]])) throw new Error(`Unsupported $ref: ${ref}`);
  return { name: match[1], node: schema.$defs[match[1]] };
}

/** The exported interface name of a definition, or null when it is a helper definition. */
const interfaceName = (node) => (isObject(node) && isObject(node['x-typescript']) ? node['x-typescript'].name : null);

const quote = (value) => (typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(value));
const union = (parts) => [...new Set(parts)].join(' | ');
const wrap = (type) => (type.includes(' ') ? `(${type})` : type);

const PRIMITIVES = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' };

/**
 * The TypeScript type for one schema node, describing the document after normalize().
 * `x-tsType` wins so the schema can accept a legacy wire form without widening the view types.
 */
export function tsType(schema, node) {
  if (!isObject(node)) return 'unknown';
  if (typeof node['x-tsType'] === 'string') return node['x-tsType'];
  if (node.$ref) {
    const { node: target } = resolveRef(schema, node.$ref);
    return interfaceName(target) ?? tsType(schema, target);
  }
  if (Array.isArray(node.enum)) return union(node.enum.map(quote));
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) return union(node[key].map((member) => tsType(schema, member)));
  }
  if (Array.isArray(node.type)) return union(node.type.map((name) => PRIMITIVES[name] ?? 'unknown'));
  if (node.type === 'array') return `${wrap(tsType(schema, node.items))}[]`;
  if (node.type === 'object') {
    const properties = Object.entries(node.properties ?? {});
    if (!properties.length) return 'Record<string, unknown>';
    const required = new Set(node.required ?? []);
    const fields = properties.map(([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${tsType(schema, value)}`);
    return `{${fields.join('; ')}}`;
  }
  return PRIMITIVES[node.type] ?? 'unknown';
}

/**
 * Definition names reachable from the root definition, breadth first, so the emitted order is
 * deterministic and a reader meets a type before the types it contains.
 */
export function definitionOrder(schema, start = ROOT_DEFINITION) {
  const order = [];
  const queue = [start];
  const seen = new Set(queue);
  while (queue.length) {
    const name = queue.shift();
    const node = schema.$defs[name];
    if (!interfaceName(node)) continue;
    order.push(name);
    for (const ref of refsOf(node)) {
      const { name: target } = resolveRef(schema, ref);
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return order;
}

/** Every `$ref` string inside a node, in document order. */
function refsOf(node, out = []) {
  if (Array.isArray(node)) for (const item of node) refsOf(item, out);
  else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else refsOf(value, out);
    }
  }
  return out;
}

const sentence = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Wraps a description into `//` comment lines that stay inside a reasonable line length. */
function comment(text, indent) {
  const words = sentence(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > 108 - indent.length) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((value) => `${indent}// ${value}`);
}

/** Renders one exported interface. */
function renderInterface(schema, name) {
  const node = schema.$defs[name];
  const annotation = node['x-typescript'];
  const required = new Set(annotation.required ?? node.required ?? []);
  const lines = [...comment(node.description, ''), `export interface ${annotation.name} {`];
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    lines.push(...comment(value.description, '  '));
    lines.push(`  ${key}${required.has(key) ? '' : '?'}: ${tsType(schema, value)};`);
  }
  if (annotation.indexSignature) lines.push(`  [key: string]: ${annotation.indexSignature};`);
  lines.push('}');
  return lines.join('\n');
}

/** The full contents of packages/explorer/src/contract.generated.ts. */
export function renderTypes(schema) {
  const version = schema.$defs[ROOT_DEFINITION].properties.contractVersion.default;
  const blocks = [
    [
      `// Generated by ${GENERATOR} from packages/contract/schema-graph.v1.json. Do not edit by hand.`,
      `// Run \`npm run contract\` after changing the schema; \`npm run contract:check\` fails on drift.`,
      '//',
      '// These interfaces describe a SchemaGraph after normalize() has run: the schema accepts the',
      '// legacy boolean and nullable wire forms, normalize() coerces them, and only the coerced',
      '// document reaches a view. Unknown fields are kept as data, which is why SchemaGraph,',
      '// SchemaTable, SchemaSource and the profiling types carry an index signature.',
    ].join('\n'),
    `export const CONTRACT_VERSION = ${quote(version)};`,
    ...definitionOrder(schema).map((name) => renderInterface(schema, name)),
  ];
  return `${blocks.join('\n\n')}\n`;
}

const CONSTRAINT_LABELS = [
  ['minLength', (value, node) => (node.maxLength === undefined ? `at least ${value} characters` : null)],
  ['maxLength', (value, node) => (node.minLength ? `${node.minLength}-${value} characters` : `up to ${value} characters`)],
  ['minimum', (value) => `at least ${value}`],
  ['maximum', (value) => `at most ${value}`],
  ['maxItems', (value) => `at most ${value} items`],
  ['pattern', (value) => `pattern \`${value}\``],
];

/** A reader-facing label for the JSON form a node accepts. */
export function jsonLabel(schema, node) {
  if (!isObject(node)) return 'any JSON value';
  if (node.$ref) {
    const { node: target } = resolveRef(schema, node.$ref);
    return interfaceName(target) ? `\`${interfaceName(target)}\`` : jsonLabel(schema, target);
  }
  if (Array.isArray(node.enum)) return node.enum.map((value) => `\`${JSON.stringify(value)}\``).join(' or ');
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) return node[key].map((member) => jsonLabel(schema, member)).join(', or ');
  }
  if (node.type === 'array') return `array of ${jsonLabel(schema, node.items)}${constraints(node)}`;
  if (node.type === undefined) return 'any JSON value';
  const base = (Array.isArray(node.type) ? node.type : [node.type]).map((name) => `\`${name}\``).join(' or ');
  return `${base}${constraints(node)}`;
}

function constraints(node) {
  const parts = [];
  for (const [key, format] of CONSTRAINT_LABELS) {
    if (node[key] === undefined) continue;
    const label = format(node[key], node);
    if (label) parts.push(label);
  }
  return parts.length ? ` (${parts.join(', ')})` : '';
}

const cell = (text) => sentence(text).replace(/\|/g, '\\|');

/** The Markdown block between the generated-field markers in skill/references/schema-contract.md. */
export function renderDocs(schema) {
  const lines = [
    DOCS_START,
    `<!-- Generated by \`${GENERATOR} --docs\` from packages/contract/schema-graph.v1.json. Do not edit by hand. -->`,
  ];
  for (const name of definitionOrder(schema)) {
    const node = schema.$defs[name];
    const required = new Set(node.required ?? []);
    lines.push('', `### ${node['x-typescript'].name}`, '', cell(node.description), '');
    lines.push('| Field | JSON form | Required | Notes |', '|---|---|---|---|');
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      lines.push(`| \`${key}\` | ${jsonLabel(schema, value)} | ${required.has(key) ? 'yes' : 'no'} | ${cell(value.description)} |`);
    }
    if (node.additionalProperties !== false) {
      lines.push('| other fields | any JSON value | no | Kept as data and passed through unchanged. |');
    }
  }
  lines.push('', DOCS_END);
  return `${lines.join('\n')}\n`;
}

/** Replaces the generated block in `markdown`, or appends it when the markers are absent. */
export function spliceDocs(markdown, block) {
  const start = markdown.indexOf(DOCS_START);
  const end = markdown.indexOf(DOCS_END);
  if (start === -1 || end === -1 || end < start) {
    return `${markdown.replace(/\n+$/, '')}\n\n${block}`;
  }
  return `${markdown.slice(0, start)}${block}${markdown.slice(end + DOCS_END.length).replace(/^\n/, '')}`;
}

/** Extracts the generated block from `markdown`, or null when the markers are absent. */
export function extractDocs(markdown) {
  const start = markdown.indexOf(DOCS_START);
  const end = markdown.indexOf(DOCS_END);
  if (start === -1 || end === -1 || end < start) return null;
  return `${markdown.slice(start, end + DOCS_END.length)}\n`;
}

/** Start and end offsets of Part A's body: from the heading line to the next horizontal rule. */
function partABounds(markdown) {
  const heading = markdown.indexOf(PART_A_HEADING);
  if (heading === -1) return null;
  const afterHeading = markdown.indexOf('\n', heading);
  if (afterHeading === -1) return null;
  const terminator = markdown.indexOf('\n---\n', afterHeading + 1);
  if (terminator === -1) return null;
  return { start: afterHeading + 1, end: terminator + 1 };
}

/** No leading blank line and exactly one trailing newline: the form the two copies are compared in. */
const partABody = (text) => `${text.replace(/^\n+/, '').replace(/\n+$/, '')}\n`;

/** Part A of the architecture document, in comparable form, or null when the section is absent. */
export function extractPartA(markdown) {
  const bounds = partABounds(markdown);
  return bounds ? partABody(markdown.slice(bounds.start, bounds.end)) : null;
}

/** Replaces Part A of the architecture document with `reference`, keeping the heading and the rule. */
export function splicePartA(markdown, reference) {
  const bounds = partABounds(markdown);
  if (!bounds) throw new Error(`No "${PART_A_HEADING}" section closed by a --- rule in the architecture document`);
  return `${markdown.slice(0, bounds.start)}\n${partABody(reference)}\n${markdown.slice(bounds.end)}`;
}

/**
 * A horizontal rule closes Part A, so the reference may not contain one: a rule inside it would be
 * copied in and truncate the section, leaving `--check` failing with nothing to regenerate.
 */
export function assertRuleFree(reference) {
  if (/^---$/m.test(reference)) {
    throw new Error(
      'skill/references/schema-contract.md contains a --- rule, which would close Part A of the architecture document early. Use a heading instead.',
    );
  }
  return reference;
}

function main(argv) {
  const flags = new Set(argv);
  for (const argument of argv) {
    if (!['--check', '--docs'].includes(argument)) {
      console.error(`Unknown argument ${argument}. Usage: node ${GENERATOR} [--check | --docs]`);
      return 2;
    }
  }
  const schema = loadSchema();
  const types = renderTypes(schema);
  const docs = renderDocs(schema);
  if (flags.has('--docs')) {
    process.stdout.write(docs);
    return 0;
  }
  const reference = readFileSync(REFERENCE_PATH, 'utf8');
  const architecture = readFileSync(ARCHITECTURE_PATH, 'utf8');
  const written = assertRuleFree(spliceDocs(reference, docs));
  if (flags.has('--check')) {
    const drift = [];
    if (readFileSync(TYPES_PATH, 'utf8') !== types) drift.push('packages/explorer/src/contract.generated.ts');
    else console.log('contract.generated.ts up to date');
    if (extractDocs(reference) !== docs) drift.push('skill/references/schema-contract.md field tables');
    else console.log('schema-contract.md field tables up to date');
    if (extractPartA(architecture) !== partABody(written)) drift.push('docs/architecture/schema-graph-contract.md Part A');
    else console.log('schema-graph-contract.md Part A up to date');
    if (!drift.length) return 0;
    console.error(`Contract drift in ${drift.join(' and ')}. Run \`npm run contract\` and commit the result.`);
    return 1;
  }
  writeFileSync(TYPES_PATH, types, 'utf8');
  writeFileSync(REFERENCE_PATH, written, 'utf8');
  writeFileSync(ARCHITECTURE_PATH, splicePartA(architecture, written), 'utf8');
  console.log('Wrote packages/explorer/src/contract.generated.ts, the field tables in skill/references/schema-contract.md and Part A of docs/architecture/schema-graph-contract.md');
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
