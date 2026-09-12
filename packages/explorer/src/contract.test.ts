// Contract corpus tests on the TypeScript side (work package C01, CTQ-01 / CTQ-07 / CTQ-13).
//
// The Python side validates a document with packages/contract/schema-graph.v1.json and then runs
// normalize(). The TypeScript side never reimplements those rules: it consumes documents the API
// has already normalized, and its own structural parser is parseSchemaSnapshot(). This suite pins
// the two facts that keep the sides honest:
//
//   1. every document the Python side accepts also parses here and carries the contract v1 shapes;
//   2. the invalid corpus is partitioned - each case is either rejected by parseSchemaSnapshot, or
//      listed below with the reason only the Python oracle can catch it. A case that is accepted by
//      one side and rejected by the other with no recorded reason fails.
//
// Runs under `npm --prefix packages/explorer test` (tsx) and under a bare
// `node --test packages/explorer/src/contract.test.ts` (native type stripping), so the modules it
// exercises are loaded through a URL built at run time rather than a checked import specifier.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SchemaColumn, SchemaGraph, SchemaTable } from './types';

const ROOT = new URL('../../../', import.meta.url);
const FIXTURES = new URL('fixtures/', ROOT);
const SCHEMA = new URL('packages/contract/schema-graph.v1.json', ROOT);
const GENERATED = new URL('packages/explorer/src/contract.generated.ts', ROOT);
const CORPUS_ROOTS = ['contract', 'contract/v1'];

/** Invalid corpus cases parseSchemaSnapshot rejects on its own. */
const STRUCTURAL_HERE = new Set(['duplicate-table-id', 'duplicate-column-name', 'link-kind-fk']);
/** Invalid corpus cases only the Python side can reject, each with the rule that catches it. */
const PYTHON_ONLY = new Map([
  ['missing-project-key', 'semantic, Python-only: project.key is required by normalize() and by the JSON Schema; the snapshot parser never reads project.'],
  ['uppercase-project-key', 'semantic, Python-only: the project.key character set is a normalize() rule and a JSON Schema pattern.'],
  ['unresolved-declared-fk', 'semantic, Python-only: declared-target resolution is a normalize() rule over the whole document.'],
  ['contract-version-2-0', 'semantic, Python-only: the major-version check lives in normalize() and in the JSON Schema pattern.'],
  ['line-as-string', 'semantic, Python-only: the integer line rule lives in normalize() and in the JSON Schema.'],
  ['sample-values-four', 'semantic, Python-only: the three-item sampleValues cap is a JSON Schema rule.'],
  ['negative-row-count-lower-bound', 'semantic, Python-only: the non-negative rowCountLowerBound bound is a JSON Schema rule.'],
]);

const path = (url: URL) => fileURLToPath(url);
const read = (url: URL) => readFileSync(path(url), 'utf8');
const json = (url: URL): Record<string, unknown> => JSON.parse(read(url)) as Record<string, unknown>;
const listing = (relative: string) => readdirSync(path(new URL(`${relative}/`, FIXTURES))).filter(name => name.endsWith('.json')).sort();

/** Every corpus document of one outcome, from the Part A tree and the contract v1 tree. */
function corpus(outcome: 'valid' | 'invalid'): { name: string; url: URL }[] {
  return CORPUS_ROOTS.flatMap(root =>
    listing(`${root}/${outcome}`).map(name => ({ name: name.replace(/\.json$/, ''), url: new URL(`${root}/${outcome}/${name}`, FIXTURES) })),
  );
}

type TsImport = (specifier: string, parent: string) => Promise<unknown>;
let tsxLoader: Promise<TsImport | null> | undefined;

/** tsx's programmatic loader, for modules Node's strip-only mode cannot parse. */
function tsx(): Promise<TsImport | null> {
  tsxLoader ??= (async () => {
    try {
      const require = createRequire(new URL('../package.json', import.meta.url).href);
      const api = (await import(pathToFileURL(require.resolve('tsx/esm/api')).href)) as { tsImport: TsImport };
      return api.tsImport;
    } catch {
      return null;
    }
  })();
  return tsxLoader;
}

/**
 * Loads a module beside this test by URL, so tsc never sees a `.ts` import specifier. Node's
 * native type stripping handles erasable-only modules; the rest go through tsx, which
 * `npm run restore` installs and the CI jobs restore before running the suites.
 */
async function load(name: string): Promise<Record<string, unknown>> {
  const url = new URL(name, import.meta.url).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch {
    // Not erasable-only TypeScript, or this build has no native type stripping.
  }
  const tsImport = await tsx();
  assert.ok(tsImport, `cannot load ${name}: run \`npm run restore\` so tsx is available`);
  return (await tsImport(url, import.meta.url)) as Record<string, unknown>;
}

type Parse = (text: string) => SchemaGraph;
const parser = async (): Promise<Parse> => (await load('schema-diff-logic.ts')).parseSchemaSnapshot as Parse;

// A document written against the generated types, checked at compile time by `satisfies`. It uses
// every promoted field of Part B2, so a generator change that drops or renames one fails the build.
const sample = {
  contractVersion: '1.0',
  project: { name: 'Contract sample', key: 'contract-sample', dialect: 'postgresql' },
  source: { file: 'db/schema.sql', commit: 'synthetic', sha256: 'not-recorded', generated: '2026-01-01T00:00:00Z', basis: 'Synthetic document used by the contract test; not verified against a live database.' },
  tables: [
    {
      id: 'w.items', schema: 'w', name: 'items', className: 'Item', domain: 'Contract', type: 'Core master entity',
      kind: 'table', file: 'db/schema.sql', line: 12, pk: 'id', primaryKey: ['id'],
      allColumns: [
        { name: 'id', type: 'Integer', pk: true, fk: '', nullable: 'False', index: false, unique: false, line: 13 },
        {
          name: 'label', type: 'Text', pk: false, fk: '', nullable: '', index: false, unique: true, line: 14,
          typeBasis: 'Catalog read', applicationDefault: 'unnamed', serverDefault: null, sampleValues: ['alpha'],
          profiling: { nullFraction: 0.5, distinctCount: 1, min: 'alpha', max: 'alpha', sampleSize: 2, sampled: true, scope: 'sampled', sampleValues: ['alpha'] },
        },
      ],
      indexes: [{ name: 'ix_items_label', columns: ['label'], unique: false, partial: false, expression: false }],
      uniques: [{ name: 'uq_items_label', columns: ['label'] }],
      checks: [{ name: 'ck_items_label', definition: "label <> ''" }],
      rowCount: null, rowCountLowerBound: 2, rowCountExact: false, sampleSize: 2, sampled: true,
      profiling: { status: 'incomplete', reason: 'The per-table time budget was reached.', sampleSize: 2, sampled: true, scope: 'sampled' },
    },
    {
      id: 'w.v_items', className: 'ItemView', domain: 'Contract', type: 'Configuration / reference', pk: '',
      kind: 'view', definition: 'SELECT id, label FROM w.items', allColumns: [{ name: 'id', type: 'Integer', pk: false, fk: '', nullable: '', index: false, unique: false }],
      indexes: [], uniques: [],
    },
  ],
  links: [{ source: 'w.items', column: 'id', target: 'w.items', targetColumn: 'id', kind: 'inferred by naming', constraintId: 'inferred_items_self', cardinality: 'one-to-one' }],
} satisfies SchemaGraph;

// @ts-expect-error the generated table kind is an enumeration, not a free string.
const rejectedKind = { ...sample.tables[0], kind: 'materialised view' } satisfies SchemaTable;
// @ts-expect-error nullable is the normalized tri-state, so a boolean is not assignable.
const rejectedNullable = { ...sample.tables[0].allColumns[0], nullable: true } satisfies SchemaColumn;
// @ts-expect-error a lower bound is a number; the wire form is validated by the JSON Schema.
const rejectedLowerBound = { ...sample.tables[0], rowCountLowerBound: '2' } satisfies SchemaTable;
void [rejectedKind, rejectedNullable, rejectedLowerBound];

test('C01 the fixture corpus is present and complete', () => {
  assert.ok(existsSync(path(FIXTURES)), `run from the repository checkout: ${path(FIXTURES)} is missing`);
  assert.equal(corpus('valid').length, 8);
  assert.equal(corpus('invalid').length, 10);
  assert.ok(listing('schemas').length >= 7);
});

test('C01 every schema fixture and valid corpus document parses with parseSchemaSnapshot', async () => {
  const parseSchemaSnapshot = await parser();
  const documents = [
    ...listing('schemas').map(name => ({ name, url: new URL(`schemas/${name}`, FIXTURES) })),
    ...corpus('valid'),
  ];
  for (const { name, url } of documents) {
    const parsed = parseSchemaSnapshot(read(url));
    assert.equal(parsed.tables.length, (json(url).tables as unknown[]).length, name);
    assert.ok(Array.isArray(parsed.links), name);
  }
});

test('C01 valid corpus documents carry the contract v1 shapes the generated types declare', async () => {
  const parseSchemaSnapshot = await parser();
  for (const { name, url } of corpus('valid')) {
    const graph = parseSchemaSnapshot(read(url));
    const version = graph.contractVersion;
    if (version !== undefined) assert.match(String(version), /^1\.[0-9]+$/, name);
    for (const table of graph.tables) {
      if (table.kind !== undefined) assert.ok(['table', 'view'].includes(String(table.kind)), `${name}: ${table.id} kind`);
      if (table.profiling?.status !== undefined) assert.ok(['complete', 'incomplete'].includes(String(table.profiling.status)), `${name}: ${table.id} status`);
      if (table.rowCountLowerBound !== undefined) {
        assert.ok(table.rowCount === null || table.rowCount === undefined, `${name}: ${table.id} keeps unknown distinct from a lower bound`);
      }
      for (const column of table.allColumns) {
        assert.ok(['', 'True', 'False'].includes(String(column.nullable ?? '')), `${name}: ${table.id}.${column.name} nullable`);
        for (const values of [column.sampleValues, column.profiling?.sampleValues]) {
          if (values !== undefined) assert.ok(Array.isArray(values) && values.length <= 3, `${name}: ${table.id}.${column.name} sampleValues`);
        }
      }
    }
    for (const link of graph.links) assert.ok(['declared FK', 'inferred by naming'].includes(link.kind), `${name}: link kind`);
  }
});

test('C01 the invalid corpus is partitioned between the snapshot parser and the Python oracle', async () => {
  const parseSchemaSnapshot = await parser();
  const cases = corpus('invalid');
  const names = cases.map(entry => entry.name).sort();
  assert.deepEqual([...new Set([...STRUCTURAL_HERE, ...PYTHON_ONLY.keys()])].sort(), names, 'every invalid case is classified exactly once');
  assert.equal(STRUCTURAL_HERE.size + PYTHON_ONLY.size, names.length, 'the two sets are disjoint');
  for (const { name, url } of cases) {
    if (STRUCTURAL_HERE.has(name)) assert.throws(() => parseSchemaSnapshot(read(url)), name);
    else {
      const reason = PYTHON_ONLY.get(name);
      assert.match(String(reason), /^semantic, Python-only: /, name);
      assert.ok(parseSchemaSnapshot(read(url)).tables.length >= 0, `${name} parses here: ${reason}`);
    }
  }
});

test('C01 the generated module declares every definition and property of the committed schema', async () => {
  const generated = await load('contract.generated.ts');
  const schema = JSON.parse(read(SCHEMA)) as { $defs: Record<string, Record<string, unknown>> };
  const text = read(GENERATED);
  assert.equal(generated.CONTRACT_VERSION, (schema.$defs.SchemaGraph.properties as Record<string, { default: string }>).contractVersion.default);
  assert.match(text, /^\/\/ Generated by scripts\/gen_contract\.mjs /, 'the committed file states that it is generated');
  let declared = 0;
  for (const definition of Object.values(schema.$defs)) {
    const annotation = definition['x-typescript'] as { name: string } | undefined;
    if (!annotation) continue;
    declared += 1;
    assert.match(text, new RegExp(`^export interface ${annotation.name} \\{$`, 'm'), annotation.name);
    for (const property of Object.keys((definition.properties ?? {}) as Record<string, unknown>)) {
      assert.match(text, new RegExp(`^  ${property}\\??: `, 'm'), `${annotation.name}.${property}`);
    }
  }
  assert.ok(declared >= 9, `expected the contract's interfaces, saw ${declared}`);
});
