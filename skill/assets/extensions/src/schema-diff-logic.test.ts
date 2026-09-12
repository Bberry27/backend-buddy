import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SchemaColumn, SchemaGraph, SchemaLink, SchemaTable } from './types';
import { compareSchemas, foreignKeys, migrationDraft, parseSchemaSnapshot, qualifiedName, quoteIdentifier, tableDDL, unionEdges } from './schema-diff-logic';

const column = (name: string, overrides: Record<string, unknown> = {}): SchemaColumn => ({ name, type: 'integer', pk: false, fk: '', nullable: 'False', index: false, unique: false, default: null, ...overrides } as SchemaColumn);
const table = (id: string, overrides: Partial<SchemaTable> = {}): SchemaTable => ({ id, name: id, schema: 'public', className: id, domain: 'test', type: 'table', pk: '', allColumns: [column('id')], indexes: [], uniques: [], ...overrides });
const graph = (tables: SchemaTable[], links: SchemaLink[] = [], dialect = 'postgresql'): SchemaGraph => ({ tables, links, project: { name: 'Test', key: 'test', dialect } });
const link = (column: string, targetColumn: string): SchemaLink => ({ source: 'child', column, target: 'parent', targetColumn, kind: 'declared FK', constraintId: 'child_parent_fk' });
const activeSQL = (sql: string) => sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

test('comparison finds added, removed, changed and unchanged tables without using counts', () => {
  const a = graph([table('removed'), table('changed'), table('same', { rowCount: 100 })]);
  const b = graph([table('added'), table('changed', { allColumns: [column('id', { type: 'bigint' })] }), table('same')]);
  assert.deepEqual(compareSchemas(a, b).tables.map(diff => [diff.id, diff.status]), [['added', 'added'], ['changed', 'changed'], ['removed', 'removed'], ['same', 'unchanged']]);
  const union = unionEdges(a, b);
  assert.deepEqual(union, []);
});

test('typeDefinition detects SQLAlchemy string length and emits supported SQL lengths', () => {
  const a = graph([table('records', { allColumns: [column('label', { type: 'String', typeDefinition: 'String(100)' })] })]);
  const b = graph([table('records', { allColumns: [column('label', { type: 'String', typeDefinition: 'String(200)' })] })]);
  const comparison = compareSchemas(a, b);
  assert.deepEqual(comparison.tables[0].details[0].fields, ['type']);
  const draft = migrationDraft(comparison, 'postgresql');
  assert.match(draft.sql, /ALTER COLUMN "label" TYPE VARCHAR\(200\)/);
  assert.equal(draft.incomplete.length, 0);
  assert.equal(draft.destructive.length, 1);
});

test('default and serverDefault changes produce server SQL; applicationDefault never does', () => {
  for (const key of ['default', 'serverDefault', 'server_default']) {
    const a = graph([table('records', { allColumns: [column('id', { [key]: 5 })] })]);
    const b = graph([table('records', { allColumns: [column('id', { [key]: 10 })] })]);
    const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
    assert.match(draft.sql, /SET DEFAULT 10;/);
  }
  const a = graph([table('records', { allColumns: [column('id', { applicationDefault: 'datetime.utcnow' })] })]);
  const b = graph([table('records', { allColumns: [column('id', { applicationDefault: 'custom_callable()' })] })]);
  const comparison = compareSchemas(a, b);
  assert.equal(comparison.tables[0].status, 'changed');
  const draft = migrationDraft(comparison, 'postgresql');
  assert.equal(draft.statementCount, 0);
  assert.doesNotMatch(activeSQL(draft.sql), /DEFAULT|datetime|custom_callable/);
});

test('missing default and explicit no-default remain different', () => {
  const before = column('id', { serverDefault: 5 });
  const after = column('id', { serverDefault: null });
  const draft = migrationDraft(compareSchemas(graph([table('records', { allColumns: [before] })]), graph([table('records', { allColumns: [after] })])), 'postgresql');
  assert.match(draft.sql, /DROP DEFAULT;/);
  const missing = column('id');
  delete (missing as unknown as Record<string, unknown>).default;
  const unknown = migrationDraft(compareSchemas(graph([table('records', { allColumns: [before] })]), graph([table('records', { allColumns: [missing] })])), 'postgresql');
  assert.match(unknown.sql, /target server default is not recorded/);
  assert.equal(unknown.statementCount, 0);
});

test('index ordering is deterministic but indexed column ordering is structural', () => {
  const first = { name: 'ix_ab', columns: ['a', 'b'] }, second = { name: 'ix_c', columns: ['c'] };
  const base = table('records', { indexes: [first, second] });
  assert.equal(compareSchemas(graph([base]), graph([{ ...base, indexes: [second, first] }])).tables[0].status, 'unchanged');
  const changed = compareSchemas(graph([base]), graph([{ ...base, indexes: [{ ...first, columns: ['b', 'a'] }, second] }]));
  assert.equal(changed.tables[0].details[0].kind, 'index');
});

test('composite PK and FK group order is preserved and differences are detected', () => {
  const tables = [table('parent', { allColumns: [column('tenant_id'), column('id')], primaryKey: ['tenant_id', 'id'], primaryKeyName: 'parent_pkey' }), table('child', { allColumns: [column('tenant_id'), column('parent_id')] })];
  const links = [link('tenant_id', 'tenant_id'), link('parent_id', 'id')];
  const a = graph(tables, links);
  assert.deepEqual(foreignKeys(a)[0].columns, ['tenant_id', 'parent_id']);
  assert.deepEqual(foreignKeys(a)[0].targetColumns, ['tenant_id', 'id']);
  const b = graph([{ ...tables[0], primaryKey: ['id', 'tenant_id'] }, tables[1]], [...links].reverse());
  assert.equal(compareSchemas(a, b).tables.find(diff => diff.id === 'parent')!.details[0].kind, 'primary key');
  assert.equal(compareSchemas(a, b).tables.find(diff => diff.id === 'child')!.details[0].kind, 'foreign key');
  assert.equal(unionEdges(a, b)[0].status, 'changed');
});

test('migration drops FK first, edits keys and columns, then recreates ordered FK last', () => {
  const a = graph([
    table('parent', { allColumns: [column('tenant_id'), column('id')], primaryKey: ['tenant_id', 'id'], primaryKeyName: 'parent_pkey' }),
    table('child', { allColumns: [column('tenant_id'), column('parent_id')], indexes: [{ name: 'ix_child_parent', columns: ['tenant_id', 'parent_id'] }] }),
  ], [link('tenant_id', 'tenant_id'), link('parent_id', 'id')]);
  const b = structuredClone(a);
  b.tables[0].allColumns[1].type = 'bigint';
  b.tables[0].primaryKey = ['id', 'tenant_id'];
  b.tables[1].allColumns[1].type = 'bigint';
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.incomplete.length, 0, draft.sql);
  const sql = activeSQL(draft.sql);
  const dropFK = sql.indexOf('DROP CONSTRAINT "child_parent_fk"');
  const dropPK = sql.indexOf('DROP CONSTRAINT "parent_pkey"');
  const modify = sql.indexOf('TYPE BIGINT');
  const addPK = sql.indexOf('PRIMARY KEY ("id", "tenant_id")');
  const addFK = sql.indexOf('FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "public"."parent" ("tenant_id", "id")');
  assert(dropFK >= 0 && dropFK < dropPK && dropPK < modify && modify < addPK && addPK < addFK, draft.sql);
});

test('new tables are created before FKs, with ordered composite uniques', () => {
  const b = graph([table('parent', { allColumns: [column('tenant_id'), column('id')], primaryKey: ['tenant_id', 'id'] }), table('child', { allColumns: [column('tenant_id'), column('parent_id')], uniques: [{ name: 'uq_child', columns: ['parent_id', 'tenant_id'] }] })], [link('tenant_id', 'tenant_id'), link('parent_id', 'id')]);
  const draft = migrationDraft(compareSchemas(graph([]), b), 'postgresql');
  assert.equal(draft.incomplete.length, 0, draft.sql);
  assert.match(draft.sql, /UNIQUE \("parent_id", "tenant_id"\)/);
  assert(draft.sql.lastIndexOf('CREATE TABLE') < draft.sql.indexOf('FOREIGN KEY'));
});

test('MySQL uses MODIFY COLUMN, DROP FOREIGN KEY and named index syntax', () => {
  const a = graph([table('parent'), table('child', { allColumns: [column('parent_id', { default: 1 })], indexes: [{ name: 'old_ix', columns: ['parent_id'] }] })], [link('parent_id', 'id')], 'mysql');
  const b = structuredClone(a);
  b.tables[1].allColumns[0] = column('parent_id', { type: 'bigint', nullable: 'True', default: 2 });
  b.tables[1].indexes = [{ name: 'new_ix', columns: ['parent_id'] }];
  const draft = migrationDraft(compareSchemas(a, b), 'mysql');
  assert.equal(draft.incomplete.length, 0, draft.sql);
  assert.match(draft.sql, /DROP FOREIGN KEY `child_parent_fk`;/);
  assert.match(draft.sql, /DROP INDEX `old_ix` ON `public`\.`child`;/);
  assert.match(draft.sql, /MODIFY COLUMN `parent_id` BIGINT NULL DEFAULT 2;/);
  assert.match(draft.sql, /CREATE INDEX `new_ix` ON `public`\.`child`/);
  assert(draft.sql.indexOf('DROP FOREIGN KEY') < draft.sql.indexOf('MODIFY COLUMN'));
  assert(draft.sql.indexOf('MODIFY COLUMN') < draft.sql.lastIndexOf('ADD CONSTRAINT'));
});

test('qualified identifiers are separately escaped without splitting literal dots', () => {
  assert.equal(quoteIdentifier('a"b', 'postgresql'), '"a""b"');
  assert.equal(quoteIdentifier('a`b', 'mysql'), '`a``b`');
  const entity = table('stable', { schema: 's"chema', name: 'a.b' });
  assert.equal(qualifiedName(entity, 'postgresql'), '"s""chema"."a.b"');
  assert.throws(() => qualifiedName(table('public.foo', { name: undefined }), 'postgresql'), /separate name and schema/);
  const ddl = tableDDL(graph([entity]), entity, 'postgresql');
  assert.match(ddl.sql, /CREATE TABLE "s""chema"\."a.b"/);
});

test('server SQL literals are preserved but arbitrary defaults and hostile types stay comments', () => {
  const entity = table('records', { allColumns: [column('name', { type: 'text', default: "'O''Brien'" })] });
  assert.match(tableDDL(graph([entity]), entity, 'postgresql').sql, /DEFAULT 'O''Brien'/);
  for (const overrides of [{ default: 'datetime.utcnow()' }, { default: '1; DROP TABLE x;' }, { type: 'integer;\nDROP TABLE x;' }]) {
    const a = graph([table('records')]);
    const b = graph([table('records', { allColumns: [column('id', overrides)] })]);
    const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
    assert(draft.incomplete.length > 0);
    assert.equal(draft.statementCount, 0);
    assert.doesNotMatch(activeSQL(draft.sql), /DROP TABLE x|datetime/);
  }
});

test('unsupported views, partial indexes and dialects are explicit incomplete drafts', () => {
  const a = graph([table('view', { kind: 'view', definition: 'SELECT 1' })]);
  const b = graph([table('view', { kind: 'view', definition: 'SELECT 2;\nDROP TABLE secret;' })]);
  const comparison = compareSchemas(a, b);
  assert.equal(comparison.tables[0].details[0].fields[0], 'definition');
  const ddl = tableDDL(b, b.tables[0], 'postgresql');
  assert.match(ddl.sql, /-- DROP TABLE secret/);
  assert.equal(ddl.statementCount, 0);
  assert.equal(migrationDraft(comparison, 'postgresql').statementCount, 0);
  assert.match(migrationDraft(comparison, 'sqlite').sql, /INCOMPLETE: unsupported dialect/);
  const partial = graph([table('records', { indexes: [{ name: 'ix_partial', columns: ['id'], partial: true }] })]);
  assert.equal(migrationDraft(compareSchemas(graph([table('records')]), partial), 'postgresql').statementCount, 0);
});

test('unnamed affected FK or missing PG primary-key name withholds dependent edits', () => {
  const a = graph([table('parent'), table('child', { allColumns: [column('parent_id')] })], [{ ...link('parent_id', 'id'), constraintId: undefined }]);
  const b = structuredClone(a); b.tables[0].allColumns[0].type = 'bigint';
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.statementCount, 0);
  assert.match(draft.sql, /no constraintId/);
  const pkA = graph([table('records', { primaryKey: ['id'] })]);
  const pkB = graph([table('records', { primaryKey: [] })]);
  const pkDraft = migrationDraft(compareSchemas(pkA, pkB), 'postgresql');
  assert.equal(pkDraft.statementCount, 0);
  assert.match(pkDraft.sql, /primary-key constraint name is missing/);
});

test('incomplete related table suppresses its FK drops, while unrelated supported changes remain', () => {
  const a = graph([table('parent'), table('child', { allColumns: [column('parent_id')] }), table('unrelated')], [link('parent_id', 'id')]);
  const b = structuredClone(a);
  b.tables[0].allColumns[0].type = 'UnsupportedDomain';
  b.tables[2].allColumns[0].nullable = 'True';
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  const sql = activeSQL(draft.sql);
  assert.doesNotMatch(sql, /child_parent_fk|"parent"/);
  assert.match(sql, /"unrelated" ALTER COLUMN "id" DROP NOT NULL/);
});

test('destructive table and column removals are flagged without CASCADE', () => {
  const a = graph([table('removed'), table('changed', { allColumns: [column('id'), column('extra')] })]);
  const b = graph([table('changed')]);
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.destructive.length, 2);
  assert.match(draft.sql, /DROP TABLE "public"\."removed"/);
  assert.match(draft.sql, /DROP COLUMN "extra"/);
  assert.doesNotMatch(draft.sql, /CASCADE/);
});

test('parser accepts graph wrappers and inert extra metadata, rejects malformed/deep snapshots', () => {
  const snapshot = graph([table('records')]);
  assert.equal(parseSchemaSnapshot(JSON.stringify({ graph: snapshot })).tables[0].id, 'records');
  assert.equal(parseSchemaSnapshot(JSON.stringify({ ...snapshot, instructions: 'ignored as data' })).tables.length, 1);
  assert.throws(() => parseSchemaSnapshot('{'), /JSON/);
  assert.throws(() => parseSchemaSnapshot(JSON.stringify(graph([table('same'), table('same')]))), /unique/);
  assert.throws(() => parseSchemaSnapshot(JSON.stringify({ tables: [], links: [{}] })), /relationship/);
  let nested: unknown = 0; for (let i = 0; i < 34; i++) nested = { nested };
  assert.throws(() => parseSchemaSnapshot(JSON.stringify({ ...snapshot, nested })), /nesting/);
});

test('cross-dialect snapshots never silently become a translated migration', () => {
  const a = graph([table('records')], [], 'mysql');
  const b = graph([table('records', { allColumns: [column('id', { type: 'bigint' })] })]);
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.statementCount, 0);
  assert.match(draft.sql, /cross-dialect translation is unsupported/);
  const ddl = tableDDL(a, a.tables[0], 'postgresql');
  assert.equal(ddl.statementCount, 0);
  assert.match(ddl.sql, /DDL translation is unsupported/);
});

test('catalog FK name and lowercase ondelete metadata survive recreation', () => {
  const a = graph([table('parent'), table('child', { allColumns: [column('parent_id', { ondelete: 'CASCADE' })] })], [{ ...link('parent_id', 'id'), constraintId: 'group-id', name: 'actual_fk_name' }]);
  const b = structuredClone(a); b.tables[1].allColumns[0].nullable = 'True';
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.incomplete.length, 0, draft.sql);
  assert.match(draft.sql, /DROP CONSTRAINT "actual_fk_name"/);
  assert.match(draft.sql, /REFERENCES "public"\."parent" \("id"\) ON DELETE CASCADE;/);
  assert.doesNotMatch(activeSQL(draft.sql), /group-id/);
});

test('application-only defaults do not unnecessarily drop and rebuild existing FKs', () => {
  const a = graph([table('parent'), table('child', { allColumns: [column('parent_id')] })], [link('parent_id', 'id')]);
  const b = structuredClone(a); b.tables[1].allColumns[0] = column('parent_id', { applicationDefault: 'python_callable' });
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.statementCount, 0);
  assert.doesNotMatch(activeSQL(draft.sql), /DROP|ADD|python_callable/);
});

test('PostgreSQL type changes drop the old default before conversion and restore after', () => {
  const a = graph([table('records', { allColumns: [column('value', { type: 'integer', default: 1 })] })]);
  const b = graph([table('records', { allColumns: [column('value', { type: 'text', default: "'one'" })] })]);
  const draft = migrationDraft(compareSchemas(a, b), 'postgresql');
  assert.equal(draft.incomplete.length, 0, draft.sql);
  assert(draft.sql.indexOf('DROP DEFAULT') < draft.sql.indexOf('TYPE TEXT'));
  assert(draft.sql.indexOf('TYPE TEXT') < draft.sql.indexOf("SET DEFAULT 'one'"));
});

test('index exports remain deterministic when snapshot catalog order changes', () => {
  const base = table('records', { allColumns: [column('a'), column('b')] });
  const first = { name: 'ix_a', columns: ['a'] }, second = { name: 'ix_b', columns: ['b'] };
  const a = graph([base]);
  const b1 = graph([{ ...base, indexes: [first, second] }]);
  const b2 = graph([{ ...base, indexes: [second, first] }]);
  assert.equal(migrationDraft(compareSchemas(a, b1), 'postgresql').sql, migrationDraft(compareSchemas(a, b2), 'postgresql').sql);
});
