// Tests for scripts/gen_contract.mjs (work package C01, CTQ-13). Two jobs: the pure rendering
// functions behave for the schema subset the contract uses, and the committed generated paths
// equal what the generator produces right now, so a hand edit or a schema change without a
// regeneration fails here as well as in CI. The generated paths include Part A of
// docs/architecture/schema-graph-contract.md, which reproduces skill/references/schema-contract.md
// verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHITECTURE_PATH,
  DOCS_END,
  DOCS_START,
  PART_A_HEADING,
  REFERENCE_PATH,
  SCHEMA_PATH,
  TYPES_PATH,
  assertRuleFree,
  definitionOrder,
  extractDocs,
  extractPartA,
  jsonLabel,
  loadSchema,
  renderDocs,
  renderTypes,
  resolveRef,
  spliceDocs,
  splicePartA,
  tsType,
} from './gen_contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = join(ROOT, 'scripts/gen_contract.mjs');
const schema = loadSchema();
const read = (path) => readFileSync(path, 'utf8');
const nodeRun = (...args) => spawnSync(process.execPath, [GENERATOR, ...args], { cwd: ROOT, encoding: 'utf8' });

/** A throwaway schema exercising every construct tsType() has to cover. */
const toySchema = {
  $defs: {
    scalar: { type: ['string', 'number', 'boolean', 'null'], maxLength: 256 },
    flag: { anyOf: [{ type: ['boolean', 'null'] }, { type: 'string', enum: ['', 'True'] }] },
    Leaf: {
      type: 'object',
      'x-typescript': { name: 'Leaf', required: ['id'] },
      properties: { id: { type: 'string' }, note: { type: 'string' } },
    },
    Root: {
      type: 'object',
      'x-typescript': { name: 'Root', required: ['leaves'], indexSignature: 'unknown' },
      required: ['leaves'],
      properties: {
        contractVersion: { type: 'string', pattern: '^1\\.[0-9]+$', default: '1.0' },
        leaves: { type: 'array', items: { $ref: '#/$defs/Leaf' } },
        flag: { $ref: '#/$defs/flag', 'x-tsType': 'boolean' },
        values: { type: 'array', items: { $ref: '#/$defs/scalar' } },
        kind: { type: 'string', enum: ['table', 'view'] },
        count: { type: ['integer', 'null'] },
        inline: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
        free: {},
      },
    },
  },
};

test('C01 tsType maps the schema subset the contract uses onto TypeScript', () => {
  const properties = toySchema.$defs.Root.properties;
  assert.equal(tsType(toySchema, properties.leaves), 'Leaf[]');
  assert.equal(tsType(toySchema, properties.flag), 'boolean', 'x-tsType wins over the wire form');
  assert.equal(tsType(toySchema, properties.values), '(string | number | boolean | null)[]');
  assert.equal(tsType(toySchema, properties.kind), "'table' | 'view'");
  assert.equal(tsType(toySchema, properties.count), 'number | null');
  assert.equal(tsType(toySchema, properties.inline), '{a: number}');
  assert.equal(tsType(toySchema, properties.free), 'unknown');
  assert.equal(tsType(toySchema, toySchema.$defs.flag), "boolean | null | '' | 'True'");
});

test('C01 renderTypes emits one interface per annotated definition, with the index signature', () => {
  const output = renderTypes({ ...toySchema, $defs: { ...toySchema.$defs, SchemaGraph: toySchema.$defs.Root } });
  assert.match(output, /^export const CONTRACT_VERSION = '1\.0';$/m);
  assert.match(output, /^export interface Root \{$/m, 'the interface takes its name from x-typescript');
  assert.match(output, /^ {2}contractVersion\?: string;$/m);
  assert.match(output, /^ {2}leaves: Leaf\[\];$/m);
  assert.match(output, /^ {2}flag\?: boolean;$/m);
  assert.match(output, /^ {2}\[key: string\]: unknown;$/m);
  assert.match(output, /^export interface Leaf \{$/m);
  assert.match(output, /^ {2}id: string;$/m);
  assert.match(output, /^ {2}note\?: string;$/m);
  assert.ok(output.endsWith('\n'));
});

test('C01 definitionOrder is breadth first from the root and skips helper definitions', () => {
  const order = definitionOrder(schema);
  assert.equal(order[0], 'SchemaGraph');
  assert.deepEqual(order, ['SchemaGraph', 'SchemaProject', 'SchemaSource', 'SchemaTable', 'SchemaLink', 'SchemaColumn', 'SchemaIndex', 'SchemaCheck', 'TableProfiling', 'ColumnProfiling']);
  for (const name of ['scalar', 'legacyBoolean', 'identifier', 'displayText', 'longText', 'nonNegativeInteger']) {
    assert.ok(!order.includes(name), `${name} is a helper definition and gets no interface`);
  }
});

test('C01 resolveRef refuses a pointer the generator cannot follow', () => {
  assert.equal(resolveRef(schema, '#/$defs/SchemaTable').name, 'SchemaTable');
  for (const ref of ['#/definitions/SchemaTable', 'https://example.test/other.json#/$defs/A', '#/$defs/Absent']) {
    assert.throws(() => resolveRef(schema, ref), /Unsupported \$ref|Unsupported/);
  }
});

test('C01 jsonLabel describes the wire form, caps included', () => {
  const table = schema.$defs.SchemaTable.properties;
  assert.equal(jsonLabel(schema, table.id), '`string` (1-256 characters)');
  assert.equal(jsonLabel(schema, table.line), '`integer` (at least 0)');
  assert.equal(jsonLabel(schema, table.kind), '`"table"` or `"view"`');
  assert.equal(jsonLabel(schema, table.allColumns), 'array of `SchemaColumn`');
  assert.equal(jsonLabel(schema, table.rowCount), '`integer` or `null` (at least 0)');
  assert.equal(jsonLabel(schema, schema.$defs.SchemaColumn.properties.default), 'any JSON value');
});

test('C01 the docs block is delimited by the markers and lists every definition', () => {
  const block = renderDocs(schema);
  assert.ok(block.startsWith(`${DOCS_START}\n`));
  assert.ok(block.endsWith(`${DOCS_END}\n`));
  for (const name of definitionOrder(schema)) assert.ok(block.includes(`### ${name}`), name);
  assert.match(block, /^\| Field \| JSON form \| Required \| Notes \|$/m);
  assert.match(block, /^\| `contractVersion` \| `string`[^|]*\| no \| /m);
  assert.match(block, /^\| `id` \| `string` \(1-256 characters\) \| yes \| /m);
});

test('C01 spliceDocs replaces the block in place and extractDocs reads it back', () => {
  const block = `${DOCS_START}\nbody\n${DOCS_END}\n`;
  const document = `# Title\n\nprose\n\n${DOCS_START}\nstale\n${DOCS_END}\n\ntrailing prose\n`;
  const spliced = spliceDocs(document, block);
  assert.equal(spliced, `# Title\n\nprose\n\n${DOCS_START}\nbody\n${DOCS_END}\n\ntrailing prose\n`);
  assert.equal(extractDocs(spliced), block);
  assert.equal(extractDocs('# Title\n\nno markers\n'), null);
  assert.equal(spliceDocs('# Title\n\nno markers\n', block), `# Title\n\nno markers\n\n${block}`);
});

test('C01 splicePartA replaces the section and extractPartA reads it back', () => {
  const document = `# Title\n\nintro\n\n---\n\n${PART_A_HEADING} (verbatim)\n\nstale body\n\n---\n\n## Part B\n\nprose\n`;
  assert.equal(extractPartA(document), 'stale body\n');
  const spliced = splicePartA(document, 'fresh body\n');
  assert.equal(spliced, `# Title\n\nintro\n\n---\n\n${PART_A_HEADING} (verbatim)\n\nfresh body\n\n---\n\n## Part B\n\nprose\n`);
  assert.equal(extractPartA(spliced), 'fresh body\n');
  // Padding around the section is normalised away, so only the contract text is compared.
  assert.equal(extractPartA(splicePartA(document, '\n\nfresh body\n\n\n')), 'fresh body\n');
  assert.equal(extractPartA('# Title\n\nno Part A\n'), null);
  assert.throws(() => splicePartA('# Title\n\nno Part A\n', 'body\n'), /Part A/);
  // A rule inside the reference would close Part A early, so the generator refuses one outright.
  assert.equal(assertRuleFree(read(REFERENCE_PATH)), read(REFERENCE_PATH));
  assert.throws(() => assertRuleFree('# Title\n\nprose\n\n---\n\nmore prose\n'), /--- rule/);
});

test('C01 the committed generated paths equal the generator output', () => {
  assert.equal(read(TYPES_PATH), renderTypes(schema), 'run `npm run contract` and commit contract.generated.ts');
  assert.equal(extractDocs(read(REFERENCE_PATH)), renderDocs(schema), 'run `npm run contract` and commit the field tables');
  // Part A of the architecture document reproduces the reference verbatim, field tables included.
  // A stale copy would restate the contract in wording the reference has dropped, which is how
  // canonical caveat text leaks back into a document that must only cite caveats by id.
  assert.equal(extractPartA(read(ARCHITECTURE_PATH)), read(REFERENCE_PATH), 'run `npm run contract` and commit Part A');
});

test('C01 --check succeeds on the committed tree and --docs prints the block', () => {
  const check = nodeRun('--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /^contract\.generated\.ts up to date$/m);
  assert.match(check.stdout, /^schema-contract\.md field tables up to date$/m);
  assert.match(check.stdout, /^schema-graph-contract\.md Part A up to date$/m);
  const docs = nodeRun('--docs');
  assert.equal(docs.status, 0, docs.stderr);
  assert.equal(docs.stdout.replace(/\r\n/g, '\n'), renderDocs(schema));
});

test('C01 --check fails on drift and the generator refuses unknown arguments', () => {
  const bogus = nodeRun('--bogus');
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /Usage/);
  // Drift is proven against a copy of the schema, so the committed tree is never written to.
  const drifted = JSON.parse(read(SCHEMA_PATH));
  drifted.$defs.SchemaTable.properties.addedByDrift = { type: 'string', description: 'Drift probe.' };
  assert.notEqual(renderTypes(drifted), read(TYPES_PATH));
  assert.notEqual(renderDocs(drifted), extractDocs(read(REFERENCE_PATH)));
  // A hand edit inside Part A drifts from the reference even when the reference itself is current.
  const editedPartA = splicePartA(read(ARCHITECTURE_PATH), read(REFERENCE_PATH).replace('Evidence class,', 'Evidence class.'));
  assert.notEqual(extractPartA(editedPartA), read(REFERENCE_PATH));
});
