/**
 * Tests for scripts/generate-fixtures.mjs and the committed fixtures (work package R01).
 *
 * Run with plain Node (as CI's script job does, after `npm run restore`):
 *   npm run test:scripts                      # every *.test.mjs under scripts/
 *   node --test scripts/generate-fixtures.test.mjs
 * or through tsx from the explorer package:
 *   npx --prefix packages/explorer tsx --test scripts/generate-fixtures.test.mjs
 *
 * The TypeScript validators (parseSchemaSnapshot, junctions, computeCommunities) are loaded
 * from packages/explorer/src through Node's native type stripping, falling back to tsx from
 * packages/explorer/node_modules. Locally, when neither is available, those subtests are
 * skipped with a message; under CI (the `CI` environment variable, set by GitHub Actions) they
 * fail instead, so a workflow that forgot `npm run restore` cannot stay green by skipping.
 *
 * Local-only environment: BB_FORBIDDEN_COUNTS, comma-separated integers naming the table and
 * column counts of real schemas that no fixture may reproduce. Like the name denylist
 * (BB_DENYLIST_FILE) the values live outside the repository so that it stays count-neutral
 * (AGENTS.md section 3); the check is skipped when the variable is unset.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildFixtureSet, mulberry32, pluralize, seedRowCount } from './generate-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'fixtures');
const generator = join(root, 'scripts/generate-fixtures.mjs');
const CAP = 2 * 1024 * 1024;
const KEY = /^[a-z0-9][a-z0-9_-]*$/;
const FORBIDDEN_COUNTS_VARIABLE = 'BB_FORBIDDEN_COUNTS';

/**
 * Parses BB_FORBIDDEN_COUNTS: comma- or whitespace-separated non-negative integers. Returns
 * an empty set when the variable is unset or blank and throws on anything that is not an
 * integer, so a typo cannot silently disable the check.
 */
export function parseForbiddenCounts(value) {
  const counts = new Set();
  for (const token of String(value ?? '').split(/[\s,;]+/).filter(Boolean)) {
    if (!/^\d+$/.test(token)) throw new Error(`${FORBIDDEN_COUNTS_VARIABLE}: "${token}" is not a non-negative integer`);
    counts.add(Number(token));
  }
  return counts;
}

/**
 * How a test behaves when the TypeScript validators cannot be loaded: 'fail' under CI (GitHub
 * Actions exports CI=true; the workflow restores packages/explorer first), 'skip' elsewhere.
 */
export function typeScriptValidatorPolicy(env = process.env) {
  const ci = String(env.CI ?? '').trim().toLowerCase();
  return ci && ci !== 'false' && ci !== '0' ? 'fail' : 'skip';
}

const read = rel => readFileSync(join(fixtures, rel), 'utf8');
const graph = name => JSON.parse(read(`schemas/${name}.json`));
const columnCount = g => g.tables.reduce((n, t) => n + t.allColumns.length, 0);
const declared = g => g.links.filter(l => l.kind === 'declared FK');
const inferred = g => g.links.filter(l => l.kind === 'inferred by naming');
const baseTables = g => g.tables.filter(t => t.kind !== 'view');
const domains = g => new Set(g.tables.map(t => t.domain));
const IGNORED_DIRS = new Set(['__pycache__', 'node_modules']);
const listFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) listFiles(path, out); } else out.push(path);
  }
  return out;
};
const committedSet = () => Object.fromEntries(
  listFiles(fixtures).filter(p => /\.(json|sql)$/.test(p) && !p.endsWith('large.json')).map(p => [p.slice(fixtures.length + 1).replaceAll('\\', '/'), readFileSync(p, 'utf8')]));
const allSchemaNames = () => readdirSync(join(fixtures, 'schemas')).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));

/** Deep scan for a key; returns the number of occurrences. */
function countKey(value, key) {
  if (Array.isArray(value)) return value.reduce((n, item) => n + countKey(item, key), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [k, v]) => n + (k === key ? 1 : 0) + countKey(v, key), 0);
  return 0;
}

/** Strongly connected components of the declared-FK graph (Tarjan). */
function stronglyConnected(g) {
  const adjacent = new Map(g.tables.map(t => [t.id, []]));
  for (const l of declared(g)) if (adjacent.has(l.source) && adjacent.has(l.target)) adjacent.get(l.source).push(l.target);
  let index = 0;
  const indices = new Map(), low = new Map(), onStack = new Set(), stack = [], components = [];
  const connect = v => {
    indices.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
    for (const w of adjacent.get(v)) {
      if (!indices.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), indices.get(w)));
    }
    if (low.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); component.push(w); } while (w !== v);
      components.push(component);
    }
  };
  for (const id of adjacent.keys()) if (!indices.has(id)) connect(id);
  return components;
}

let tsxLoader;
/** Loads a module from packages/explorer/src natively (type stripping) or through tsx; null when neither works. */
async function loadExplorer(name) {
  const url = pathToFileURL(join(root, 'packages/explorer/src', name)).href;
  try { return await import(url); } catch { /* not erasable-only TypeScript, or no native type stripping */ }
  if (tsxLoader === undefined) {
    tsxLoader = (async () => {
      try {
        const require = createRequire(pathToFileURL(join(root, 'packages/explorer/package.json')).href);
        return (await import(pathToFileURL(require.resolve('tsx/esm/api')).href)).tsImport;
      } catch { return null; }
    })();
  }
  const tsImport = await tsxLoader;
  return tsImport ? tsImport(url, import.meta.url) : null;
}
const SKIP_TS = 'TypeScript validators unavailable: run `npm run restore` (tsx) or use a Node build with type stripping.';
/** Skips locally, fails under CI (see typeScriptValidatorPolicy). */
function validatorsUnavailable(t) {
  if (typeScriptValidatorPolicy() === 'fail') assert.fail(`${SKIP_TS} CI must execute this test: make sure the workflow runs npm run restore before node --test.`);
  return t.skip(SKIP_TS);
}

// ---------------------------------------------------------------------------------------

test('R01 mulberry32 is deterministic and well distributed in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  const values = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(values, Array.from({ length: 1000 }, () => b()));
  assert.ok(values.every(v => v >= 0 && v < 1));
  assert.ok(new Set(values).size > 990);
});

test('R01 pluralize covers the vocabulary shapes', () => {
  assert.equal(pluralize('category'), 'categories');
  assert.equal(pluralize('address'), 'addresses');
  assert.equal(pluralize('day'), 'days');
  assert.equal(pluralize('order'), 'orders');
});

test('R01 generator output is byte-identical across two CLI runs, including --large', () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'backend-buddy-fixtures-a-')), mkdtempSync(join(tmpdir(), 'backend-buddy-fixtures-b-'))];
  try {
    for (const dir of dirs) {
      const run = spawnSync(process.execPath, [generator, '--out', dir, '--large'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /schemas\/large\.json/);
    }
    const files = listFiles(dirs[0]).map(p => p.slice(dirs[0].length));
    assert.equal(files.length, Object.keys(buildFixtureSet({ large: true })).length);
    for (const rel of files) assert.ok(readFileSync(dirs[0] + rel).equals(readFileSync(dirs[1] + rel)), `differs: ${rel}`);
    const large = JSON.parse(readFileSync(join(dirs[0], 'schemas/large.json'), 'utf8'));
    assert.equal(large.tables.length, 1200);
    assert.ok(columnCount(large) >= 14000 && columnCount(large) <= 16500, `large columns ${columnCount(large)}`);
    assert.equal(domains(large).size, 14);
    assert.ok(statSync(join(dirs[0], 'schemas/large.json')).size > CAP, 'large.json is expected above the cap, hence git-ignored');
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('R01 committed fixtures match the generator output (no drift)', () => {
  const generated = buildFixtureSet();
  const committed = committedSet();
  assert.deepEqual(Object.keys(committed).sort(), Object.keys(generated).sort());
  for (const [rel, text] of Object.entries(generated)) assert.equal(committed[rel], text, `stale fixture ${rel}: run npm run fixtures`);
});

test('R01 committed fixtures stay under the 2 MB cap, use LF, and large.json is git-ignored', () => {
  for (const path of listFiles(fixtures)) {
    if (path.endsWith('large.json')) continue;
    assert.ok(statSync(path).size < CAP, `${path} exceeds 2 MB`);
    if (/\.(json|sql|md|py|gitignore)$/.test(path)) assert.ok(!readFileSync(path, 'utf8').includes('\r'), `${path} contains CR`);
  }
  assert.match(read('.gitignore'), /^schemas\/large\.json$/m);
});

test('R01 every schema fixture carries a valid project key, dialect, and source block', () => {
  for (const name of allSchemaNames()) {
    const g = graph(name);
    assert.match(g.project.key, KEY, `${name} key`);
    assert.equal(g.project.dialect, name === 'small' ? 'sqlite' : 'postgresql', `${name} dialect`);
    for (const field of ['file', 'commit', 'sha256', 'generated', 'basis']) assert.equal(typeof g.source[field], 'string', `${name} source.${field}`);
    assert.ok(g.source.basis.length > 20);
    assert.ok(Array.isArray(g.tables) && Array.isArray(g.links));
    const ids = new Set(g.tables.map(t => t.id));
    assert.equal(ids.size, g.tables.length, `${name} duplicate ids`);
    for (const t of g.tables) {
      assert.equal(new Set(t.allColumns.map(c => c.name)).size, t.allColumns.length, `${t.id} duplicate columns`);
      for (const c of t.allColumns) assert.ok(['', 'True', 'False', null].includes(c.nullable), `${t.id}.${c.name} nullable`);
    }
    for (const l of g.links) {
      assert.ok(ids.has(l.source), `${name}: link source ${l.source}`);
      if (l.kind === 'declared FK') assert.ok(ids.has(l.target), `${name}: declared target ${l.target}`);
    }
  }
});

test('R01 parseForbiddenCounts accepts integer lists, rejects anything else, and treats unset as empty', () => {
  assert.deepEqual([...parseForbiddenCounts(undefined)], []);
  assert.deepEqual([...parseForbiddenCounts('  ')], []);
  assert.deepEqual([...parseForbiddenCounts('12, 345;6 7')].sort((a, b) => a - b), [6, 7, 12, 345]);
  assert.throws(() => parseForbiddenCounts('12,abc'), /is not a non-negative integer/);
  assert.throws(() => parseForbiddenCounts('-1'), /is not a non-negative integer/);
});

test('R01 typeScriptValidatorPolicy fails under CI and skips elsewhere', () => {
  assert.equal(typeScriptValidatorPolicy({}), 'skip');
  assert.equal(typeScriptValidatorPolicy({ CI: '' }), 'skip');
  assert.equal(typeScriptValidatorPolicy({ CI: 'false' }), 'skip');
  assert.equal(typeScriptValidatorPolicy({ CI: '0' }), 'skip');
  assert.equal(typeScriptValidatorPolicy({ CI: 'true' }), 'fail');
  assert.equal(typeScriptValidatorPolicy({ CI: '1' }), 'fail');
});

test('R01 no fixture reproduces a locally forbidden table or column count (BB_FORBIDDEN_COUNTS)', t => {
  const forbidden = parseForbiddenCounts(process.env[FORBIDDEN_COUNTS_VARIABLE]);
  if (forbidden.size === 0) return t.skip(`${FORBIDDEN_COUNTS_VARIABLE} is unset; the count denylist is local-only and never committed`);
  const digits = [...forbidden].map(String);
  for (const rel of Object.keys(committedSet())) {
    for (const value of digits) assert.ok(!rel.includes(value), `fixture path ${rel} carries a forbidden count`);
  }
  for (const name of allSchemaNames()) {
    const g = graph(name);
    assert.ok(!forbidden.has(g.tables.length), `${name} table count is forbidden`);
    assert.ok(!forbidden.has(columnCount(g)), `${name} column count is forbidden`);
    for (const table of g.tables) assert.ok(!forbidden.has(table.allColumns.length), `${name}.${table.id} column count is forbidden`);
  }
});

test('R01 every schema and valid contract fixture parses with parseSchemaSnapshot', async t => {
  const logic = await loadExplorer('schema-diff-logic.ts');
  if (!logic) return validatorsUnavailable(t);
  for (const name of allSchemaNames()) {
    const parsed = logic.parseSchemaSnapshot(read(`schemas/${name}.json`));
    assert.equal(parsed.tables.length, graph(name).tables.length, name);
  }
  for (const file of readdirSync(join(fixtures, 'contract/valid'))) assert.ok(logic.parseSchemaSnapshot(read(`contract/valid/${file}`)).tables.length > 0, file);
  const invalidByParser = ['duplicate-table-id', 'duplicate-column-name', 'link-kind-fk'];
  for (const name of invalidByParser) assert.throws(() => logic.parseSchemaSnapshot(read(`contract/invalid/${name}.json`)), name);
});

test('R01 small: three domains, a dozen tables, one composite FK, one cycle, sqlite dialect', () => {
  const g = graph('small');
  assert.equal(domains(g).size, 3);
  assert.ok(g.tables.length >= 10 && g.tables.length <= 14, `tables ${g.tables.length}`);
  const groups = new Map();
  for (const l of declared(g)) if (l.constraintId) groups.set(`${l.source}|${l.constraintId}`, (groups.get(`${l.source}|${l.constraintId}`) || 0) + 1);
  assert.equal([...groups.values()].filter(n => n > 1).length, 1, 'exactly one composite FK group');
  const cycles = stronglyConnected(g).filter(c => c.length > 1);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].sort(), ['accounts.contacts', 'accounts.organizations']);
  assert.equal(inferred(g).length, 1);
  assert.ok(g.tables.some(t => t.primaryKey.length === 2 && t.primaryKey.every(c => t.allColumns.find(x => x.name === c).fk)), 'junction table with an FK-only composite key');
});

test('R01 medium: layout counts and structures', () => {
  const g = graph('medium');
  assert.equal(domains(g).size, 8);
  assert.ok(g.tables.length >= 150 && g.tables.length <= 170, `tables ${g.tables.length}`);
  assert.ok(columnCount(g) >= 2100 && columnCount(g) <= 2500, `columns ${columnCount(g)}`);
  assert.ok(declared(g).length >= 85 && declared(g).length <= 125, `declared pairs ${declared(g).length}`);
  assert.ok(inferred(g).length >= 14 && inferred(g).length <= 30, `inferred pairs ${inferred(g).length}`);
  assert.ok(g.links.length >= 105 && g.links.length <= 140, `total pairs ${g.links.length}`);
  const views = g.tables.filter(t => t.kind === 'view');
  assert.equal(views.length, 5);
  for (const v of views) { assert.equal(typeof v.definition, 'string'); assert.match(v.definition, /^SELECT /); assert.equal(v.primaryKey.length, 0); }
  assert.equal(baseTables(g).filter(t => t.primaryKey.length === 0).length, 4, 'four base tables without a primary key');
  const components = stronglyConnected(g).filter(c => c.length > 1);
  assert.equal(components.length, 1, 'exactly one multi-table strongly connected component');
  assert.equal(components[0].length, 3);
  assert.equal(declared(g).filter(l => l.source === l.target).length, 1, 'one self-referencing table');
  assert.ok(g.tables.filter(t => t.primaryKey.length > 1).length >= 6, 'several composite primary keys');
  const groups = new Map();
  for (const l of declared(g)) groups.set(`${l.source}|${l.constraintId}`, [...(groups.get(`${l.source}|${l.constraintId}`) || []), l]);
  const composite = [...groups.values()].filter(pairs => pairs.length > 1);
  assert.ok(composite.length >= 4, `composite FK groups ${composite.length}`);
  for (const pairs of composite) assert.equal(new Set(pairs.map(p => p.target)).size, 1, 'composite group shares one target');
  assert.ok(g.tables.filter(t => t.indexes.length).length > 60);
  assert.ok(g.tables.filter(t => t.uniques.length).length > 20);
  assert.ok(g.tables.filter(t => t.checks.length).length > 5);
  assert.ok(g.tables.some(t => t.indexes.some(i => i.partial)), 'a partial index');
  assert.ok(g.tables.some(t => t.uniques.some(u => u.columns.length > 1)), 'a composite unique');
  assert.ok(g.tables.some(t => t.allColumns.some(c => c.type === 'UUID' && c.pk)), 'a UUID primary key');
  assert.equal(countKey(g, 'rowCount'), 0, 'medium must not carry rowCount anywhere');
  assert.equal(countKey(g, 'rowCountLowerBound'), 0);
  assert.equal(countKey(g, 'profiling'), 0);
  const names = baseTables(g).map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'table names are globally unique so the SQLite seed can drop schemas');
});

test('R01 medium: junction detection and community detection see the intended structures', async t => {
  const living = await loadExplorer('living-logic.ts');
  const lens = await loadExplorer('lens-domain-logic.ts');
  if (!living || !lens) return validatorsUnavailable(t);
  const g = graph('medium');
  const found = living.junctions(g);
  assert.ok(found.size >= 4, `junctions ${found.size}`);
  for (const [id, outgoing] of found) { assert.equal(outgoing.length, 2, id); assert.ok(outgoing.every(r => r.cardinality === 'one-to-many')); }
  assert.ok(living.relations(g).some(r => r.cardinality === 'one-to-one'), 'a one-to-one relation');
  const communities = new Set(lens.computeCommunities(g).values());
  assert.ok(communities.size > 1 && communities.size < g.tables.length, `communities ${communities.size}`);
  const { duplicates } = lens.analyzeNormalization(g);
  assert.ok(duplicates.length > 0, 'repeated attribute fields for the Normalization Lens');
});

test('R01 medium-measured: same schema as medium plus the stated measurement mix', () => {
  const measured = graph('medium-measured'), medium = graph('medium');
  const strip = g => ({ tables: g.tables.map(({ rowCount, rowCountLowerBound, profiling, ...t }) => ({ ...t, allColumns: t.allColumns.map(({ profiling: p, ...c }) => c) })), links: g.links });
  assert.deepEqual(strip(measured), strip(medium));
  assert.notEqual(measured.project.key, medium.project.key);
  const n = measured.tables.length;
  const withRows = measured.tables.filter(t => typeof t.rowCount === 'number');
  assert.ok(withRows.length >= Math.floor(n * 0.75) && withRows.length <= Math.ceil(n * 0.85), `rowCount on ${withRows.length}/${n}`);
  assert.ok(measured.tables.filter(t => t.rowCount === 0).length >= 5, 'at least five tables with rowCount 0');
  assert.ok(measured.tables.every(t => t.rowCount === undefined || Number.isSafeInteger(t.rowCount) && t.rowCount >= 0));
  const bounds = measured.tables.filter(t => typeof t.rowCountLowerBound === 'number');
  assert.ok(bounds.length >= 8 && bounds.length <= 12, `lower bounds ${bounds.length}`);
  assert.ok(bounds.every(t => t.rowCount === undefined), 'a lower bound is never paired with a total');
  assert.ok(measured.tables.filter(t => t.kind === 'view').every(t => t.rowCount === undefined && t.rowCountLowerBound === undefined), 'views stay unknown');
  const columns = measured.tables.flatMap(t => t.allColumns);
  const profiled = columns.filter(c => c.profiling);
  const share = profiled.length / columns.length;
  assert.ok(share >= 0.33 && share <= 0.47, `profiled share ${share.toFixed(2)}`);
  for (const c of profiled) {
    const p = c.profiling;
    assert.ok(p.nullFraction >= 0 && p.nullFraction <= 1);
    assert.ok(Number.isSafeInteger(p.distinctCount) && p.distinctCount >= 1 && p.distinctCount <= p.sampleSize);
    assert.ok(Number.isSafeInteger(p.sampleSize) && p.sampleSize >= 1 && p.sampleSize <= 10000);
    assert.equal(p.sampled, true); assert.equal(p.scope, 'sampled');
    assert.ok('min' in p && 'max' in p);
    if (c.nullable === 'False') assert.equal(p.nullFraction, 0);
  }
  const sampled = measured.tables.flatMap(t => t.allColumns.filter(c => c.profiling?.sampleValues));
  assert.equal(sampled.length, 3, 'sampleValues on exactly three columns');
  assert.ok(sampled.every(c => c.pk));
  for (const t of measured.tables) {
    if (typeof t.rowCount === 'number' && t.rowCount > 0) for (const c of t.allColumns) if (c.profiling) assert.ok(c.profiling.sampleSize <= t.rowCount, `${t.id}.${c.name} sample exceeds rowCount`);
    if (t.rowCount === 0 || t.rowCount === undefined && t.rowCountLowerBound === undefined) assert.ok(t.allColumns.every(c => !c.profiling), `${t.id}: unknown or empty tables carry no column statistics`);
  }
  assert.equal(measured.tables.filter(t => Array.isArray(t.profiling?.functionalDependencies)).length, 3);
});

test('R01 SQL seeds: dependency-ordered DDL and rowCount-consistent inserts for both dialects', () => {
  const measured = graph('medium-measured');
  const base = baseTables(measured);
  for (const [dialect, qualifiedName] of [['pg', t => `"${t.schema}"."${t.name}"`], ['sqlite', t => `"${t.name}"`]]) {
    const sql = read(`sql/${dialect}/seed.sql`);
    assert.match(sql, /^BEGIN;$/m); assert.match(sql, /^COMMIT;\n$/m);
    if (dialect === 'sqlite') assert.match(sql, /^PRAGMA foreign_keys = ON;$/m);
    const created = [...sql.matchAll(/^CREATE TABLE (.+) \($/gm)].map(m => m[1]);
    assert.equal(created.length, base.length, `${dialect}: one CREATE TABLE per base table`);
    assert.deepEqual([...created].sort(), base.map(qualifiedName).sort());
    // Every inline REFERENCES points at an already-created table (or itself); PostgreSQL defers cycle edges through ALTER TABLE.
    const seen = new Set();
    let current = null;
    for (const line of sql.split('\n')) {
      const create = /^CREATE TABLE (.+) \($/.exec(line);
      if (create) { current = create[1]; continue; }
      if (line === ');' && current) { seen.add(current); current = null; continue; }
      const ref = current && /REFERENCES (.+?) \(/.exec(line);
      if (ref && dialect === 'pg') assert.ok(seen.has(ref[1]) || ref[1] === current, `${dialect}: ${current} references ${ref[1]} before it exists`);
    }
    const alters = sql.match(/^ALTER TABLE .+ ADD CONSTRAINT .+ FOREIGN KEY/gm) || [];
    if (dialect === 'pg') assert.ok(alters.length >= 1, 'cycle edges are added after all tables exist'); else assert.equal(alters.length, 0);
    assert.ok((sql.match(/^UPDATE /gm) || []).length >= 1, `${dialect}: deferred cycle edges are back-filled`);
    // Insert counts follow the rule: rowCount up to 200, exactly 200 above, 10 when unknown, none when 0.
    const rows = new Map();
    let target = null;
    for (const line of sql.split('\n')) {
      const insert = /^INSERT INTO (.+?) \(/.exec(line);
      if (insert) { target = insert[1]; rows.set(target, rows.get(target) || 0); continue; }
      if (target && line.startsWith('(')) rows.set(target, rows.get(target) + 1);
      if (line.endsWith(';')) target = null;
    }
    let zero = 0, capped = 0;
    for (const t of base) {
      const expected = seedRowCount(t);
      assert.equal(rows.get(qualifiedName(t)) || 0, expected, `${dialect}: ${t.id} rows`);
      if (typeof t.rowCount === 'number' && t.rowCount <= 200) assert.equal(expected, t.rowCount);
      if (t.rowCount > 200 || t.rowCountLowerBound) { assert.equal(expected, 200); capped++; }
      if (expected === 0) zero++;
    }
    assert.ok(zero >= 1, `${dialect}: at least one table seeded with zero rows`);
    assert.ok(capped >= 1);
    assert.match(sql, /declared in the\n-- JSON snapshot, not measured from this seed/);
  }
});

test('R01 edge-cases: singleton domain, key-only table, long and unicode identifiers, duplicate names, unknown nullability, unresolved inferred target', () => {
  const g = graph('edge-cases');
  const byDomain = new Map();
  for (const t of g.tables) byDomain.set(t.domain, (byDomain.get(t.domain) || 0) + 1);
  assert.ok([...byDomain.values()].includes(1), 'a domain with exactly one table');
  assert.ok(g.tables.some(t => t.allColumns.length === 1 && t.allColumns[0].pk), 'a table with zero non-PK columns');
  assert.ok(g.tables.some(t => t.name.length === 60), 'a 60-character table name');
  assert.ok(g.tables.some(t => t.allColumns.some(c => c.name.length === 60)), 'a 60-character column name');
  assert.ok(g.tables.some(t => /[^ -~]/.test(t.name) && t.allColumns.some(c => /[^ -~]/.test(c.name))), 'unicode identifiers');
  const names = g.tables.map(t => t.name);
  assert.ok(names.length > new Set(names).size, 'the same table name appears in two schemas');
  assert.equal(new Set(g.tables.map(t => t.id)).size, g.tables.length);
  assert.ok(g.tables.some(t => t.allColumns.some(c => c.nullable === '')), "nullable '' (unknown)");
  assert.ok(g.tables.some(t => t.allColumns.some(c => c.nullable === null)), 'legacy null nullability');
  assert.ok(g.tables.some(t => t.primaryKey.length === 0 && t.kind !== 'view'), 'a table without a primary key');
  const ids = new Set(g.tables.map(t => t.id));
  assert.ok(inferred(g).some(l => !ids.has(l.target)), 'an inferred link whose target is out of scope');
  assert.ok(declared(g).every(l => ids.has(l.target)));
});

test('R01 many-domains: fourteen domains and about sixty tables for palette tests', () => {
  const g = graph('many-domains');
  assert.equal(domains(g).size, 14);
  assert.ok(g.tables.length >= 55 && g.tables.length <= 65, `tables ${g.tables.length}`);
  assert.ok(declared(g).length >= 30);
});

test('R01 hostile: payloads are present in identifiers and free text while the graph stays structurally valid', () => {
  const g = graph('hostile');
  const text = JSON.stringify(g);
  for (const payload of ['<img src=x onerror=alert(1)>', 'javascript:alert(document.domain)', "=cmd|' /C calc'!A0", '+SUM(1)', '</script><script>alert(1)</script>', '__proto__', 'constructor', '\\\\backslash', '\\"quoted\\"']) {
    assert.ok(text.includes(payload), `missing payload ${payload}`);
  }
  assert.ok(g.tables.some(t => t.type === 'constructor'), 'constructor as a table type');
  assert.ok(g.tables.some(t => t.allColumns.some(c => c.name === '__proto__')), '__proto__ as a column name');
  assert.ok(g.tables.some(t => t.name.length === 120), 'a 120-character table name');
  assert.ok(g.tables.some(t => t.allColumns.some(c => c.name.length === 120)), 'a 120-character column name');
  assert.ok(g.tables.some(t => t.kind === 'view' && /<img /.test(t.definition)));
  assert.match(g.project.key, KEY);
  for (const t of g.tables) {
    assert.ok(t.id.length > 0);
    for (const c of t.allColumns) assert.ok(!/[\u0000-\u001f\u007f]/.test(c.name), 'identifiers carry no control characters');
  }
});

test('R01 empty: project, source, and empty arrays', () => {
  const g = graph('empty');
  assert.deepEqual(g.tables, []); assert.deepEqual(g.links, []);
  assert.equal(g.project.key, 'empty');
  assert.equal(typeof g.source.basis, 'string');
});

test('R01 contract cases: five valid graphs and six invalid graphs carrying $expectedError', () => {
  const valid = readdirSync(join(fixtures, 'contract/valid')).sort();
  const invalid = readdirSync(join(fixtures, 'contract/invalid')).sort();
  assert.deepEqual(valid, ['composite-fk-group.json', 'composite-primary-key.json', 'external-stub.json', 'legacy-flags.json', 'view-with-definition.json']);
  assert.deepEqual(invalid, ['duplicate-column-name.json', 'duplicate-table-id.json', 'link-kind-fk.json', 'missing-project-key.json', 'unresolved-declared-fk.json', 'uppercase-project-key.json']);
  for (const file of valid) assert.equal(JSON.parse(read(`contract/valid/${file}`)).$expectedError, undefined);
  for (const file of invalid) {
    const g = JSON.parse(read(`contract/invalid/${file}`));
    assert.equal(typeof g.$expectedError, 'string'); assert.ok(g.$expectedError.length > 10, file);
  }
  // C01: the three cases the JSON Schema also rejects record the instance path it reports, so a
  // validator that runs the schema before normalize() has a stable fragment to assert.
  const structural = Object.fromEntries(invalid.map(file => [file.slice(0, -5), JSON.parse(read(`contract/invalid/${file}`)).$structuralError]));
  assert.deepEqual(structural, {
    'duplicate-column-name': undefined,
    'duplicate-table-id': undefined,
    'link-kind-fk': 'links/0/kind',
    'missing-project-key': 'project',
    'unresolved-declared-fk': undefined,
    'uppercase-project-key': 'project/key',
  });
  const legacy = JSON.parse(read('contract/valid/legacy-flags.json'));
  assert.equal(legacy.tables[0].allColumns[0].pk, 'True');
  assert.equal(legacy.tables[0].allColumns[1].nullable, null);
  const stub = JSON.parse(read('contract/valid/external-stub.json'));
  assert.ok(stub.tables.some(t => t.stub === true));
});

test('C01 contract v1 cases: three valid graphs and four invalid ones naming their rejecting stage', () => {
  const valid = readdirSync(join(fixtures, 'contract/v1/valid')).sort();
  const invalid = readdirSync(join(fixtures, 'contract/v1/invalid')).sort();
  assert.deepEqual(valid, ['contract-version-1-1.json', 'profiling-status-incomplete.json', 'sample-values-three.json']);
  assert.deepEqual(invalid, ['contract-version-2-0.json', 'line-as-string.json', 'negative-row-count-lower-bound.json', 'sample-values-four.json']);
  for (const file of valid) {
    const g = JSON.parse(read(`contract/v1/valid/${file}`));
    assert.equal(g.$expectedError, undefined, file);
    assert.equal(g.$structuralError, undefined, file);
    assert.match(g.project.key, KEY);
  }
  assert.deepEqual(
    Object.fromEntries(invalid.map(file => [file.slice(0, -5), JSON.parse(read(`contract/v1/invalid/${file}`)).$structuralError])),
    {
      'contract-version-2-0': 'contractVersion',
      'line-as-string': 'tables/0/line',
      'negative-row-count-lower-bound': 'tables/0/rowCountLowerBound',
      'sample-values-four': 'tables/0/allColumns/0/profiling/sampleValues',
    },
  );
  // The field values these cases exist to pin (schema-graph-contract.md B2).
  const minor = JSON.parse(read('contract/v1/valid/contract-version-1-1.json'));
  assert.equal(minor.contractVersion, '1.1');
  assert.equal(typeof minor.futureGraphField.note, 'string', 'an unknown field a v1.0 reader ignores');
  const incomplete = JSON.parse(read('contract/v1/valid/profiling-status-incomplete.json'));
  const bounded = incomplete.tables.find(t => t.profiling.status === 'incomplete');
  assert.equal(bounded.rowCount, null, 'a lower bound only ever sits beside an unknown count');
  assert.equal(typeof bounded.rowCountLowerBound, 'number');
  assert.equal(incomplete.tables.find(t => t.profiling.status === 'complete').rowCount, 0, 'zero is measured, not unknown');
  const samples = JSON.parse(read('contract/v1/valid/sample-values-three.json'));
  assert.equal(samples.tables[0].allColumns[1].profiling.sampleValues.length, 3);
  assert.equal(samples.tables[0].allColumns[2].sampleValues.length, 3);
  assert.equal(JSON.parse(read('contract/v1/invalid/sample-values-four.json')).tables[0].allColumns[0].profiling.sampleValues.length, 4);
  assert.equal(JSON.parse(read('contract/v1/invalid/negative-row-count-lower-bound.json')).tables[0].rowCountLowerBound, -1);
  assert.equal(JSON.parse(read('contract/v1/invalid/line-as-string.json')).tables[0].line, '12');
  assert.equal(JSON.parse(read('contract/v1/invalid/contract-version-2-0.json')).contractVersion, '2.0');
});

test('R01 generator refuses unknown arguments', () => {
  const run = spawnSync(process.execPath, [generator, '--bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage/);
  assert.ok(existsSync(generator));
});
