import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SchemaColumn, SchemaGraph, SchemaTable } from './types';
import { columnFamily, columnProfile, knownCount, matchesColumn, nullableState, tableColumnFacts } from './column-logic';

const column = (name: string, overrides: Partial<SchemaColumn> = {}): SchemaColumn => ({ name, type: 'integer', pk: false, fk: '', nullable: '', index: false, unique: false, ...overrides });
const table = (overrides: Partial<SchemaTable> = {}): SchemaTable => ({ id: 'public.child', className: 'Child', domain: 'test', type: 'table', pk: '', allColumns: [column('tenant_id'), column('parent_id'), column('other')], indexes: [], uniques: [], ...overrides });
const fk = (name: string, constraintId?: string): SchemaGraph['links'][number] => ({ source: 'public.child', column: name, target: 'public.parent', targetColumn: name, kind: 'declared FK', constraintId });

test('ten SQL families remain distinct; arrays and unrecognized domains stay other', () => {
  for (const [sql, family] of [['BIGINT', 'integer'], ['int8', 'integer'], ['double precision', 'decimal'], ['NUMERIC(12,2)', 'decimal'], ['character varying(100)', 'text'], ['datetime2', 'datetime'], ['timestamp with time zone', 'datetime'], ['BOOLEAN', 'boolean'], ['jsonb', 'json'], ['bytea', 'binary'], ['uniqueidentifier', 'uuid'], ["enum('a','b')", 'enum'], ['integer[]', 'other'], ['customer_status', 'other']]) assert.equal(columnFamily(sql), family, sql);
});

test('missing row counts and nullability stay unknown, zero is a known empty table', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '20']) assert.equal(knownCount(value), false);
  assert.equal(knownCount(0), true);
  assert.equal(nullableState(''), 'unknown');
  assert.equal(nullableState('True'), 'nullable');
  assert.equal(nullableState('False'), 'required');
  assert.deepEqual(columnProfile(column('plain'), undefined), {});
});

test('SQLAlchemy integer, binary and unicode aliases map to their SQL families', () => {
  for (const alias of ['SmallInteger', 'BigInteger']) assert.equal(columnFamily(alias), 'integer');
  assert.equal(columnFamily('LargeBinary'), 'binary');
  for (const alias of ['Unicode(100)', 'UnicodeText']) assert.equal(columnFamily(alias), 'text');
});

test('index membership is different from leading FK coverage', () => {
  const facts = tableColumnFacts(table({ indexes: [{ columns: ['tenant_id', 'parent_id'] }] }), [fk('parent_id')]);
  assert.equal(facts.get('parent_id')?.indexed, true);
  assert.equal(facts.get('parent_id')?.unindexedDeclared, true);
  assert.match(facts.get('parent_id')!.indexDescription, /member 2, not leading/);
  assert.match(facts.get('tenant_id')!.indexDescription, /leading column/);
});

test('composite FK requires a complete leading prefix in recorded constraint order', () => {
  const links = [fk('tenant_id', 'fk_parent'), fk('parent_id', 'fk_parent')];
  for (const columns of [['tenant_id', 'parent_id'], ['tenant_id', 'parent_id', 'other']]) {
    const facts = tableColumnFacts(table({ indexes: [{ columns }] }), links);
    assert.equal(facts.get('tenant_id')?.unindexedDeclared, false);
    assert.equal(facts.get('parent_id')?.unindexedDeclared, false);
  }
  for (const columns of [['tenant_id'], ['parent_id', 'tenant_id', 'other'], ['other', 'tenant_id', 'parent_id'], ['tenant_id', 'other', 'parent_id']]) {
    const facts = tableColumnFacts(table({ indexes: [{ columns }] }), links);
    assert.equal(facts.get('tenant_id')?.unindexedDeclared, true);
    assert.equal(facts.get('parent_id')?.unindexedDeclared, true);
  }
});

test('unrelated FKs do not combine into an invented composite constraint', () => {
  const facts = tableColumnFacts(table({ indexes: [{ columns: ['tenant_id', 'parent_id'] }] }), [fk('tenant_id'), fk('parent_id')]);
  assert.equal(facts.get('tenant_id')?.unindexedDeclared, false);
  assert.equal(facts.get('parent_id')?.unindexedDeclared, true);
});

test('partial, expression, and column-only index metadata do not prove FK coverage', () => {
  for (const index of [{ columns: ['parent_id'], partial: true }, { columns: ['parent_id'], expression: true }]) {
    const facts = tableColumnFacts(table({ indexes: [index] }), [fk('parent_id')]);
    assert.equal(facts.get('parent_id')?.indexed, true);
    assert.equal(facts.get('parent_id')?.unindexedDeclared, true);
    assert.match(facts.get('parent_id')!.indexDescription, /coverage unverified/);
  }
  const facts = tableColumnFacts(table({ allColumns: [column('parent_id', { index: true })] }), [fk('parent_id')]);
  assert.equal(facts.get('parent_id')?.unindexedDeclared, true);
  assert.match(facts.get('parent_id')!.indexDescription, /order is unknown/);
});

test('primary and composite unique keys carry explicit membership semantics', () => {
  const facts = tableColumnFacts(table({ primaryKey: ['tenant_id', 'parent_id'], uniques: [{ columns: ['parent_id', 'other'] }] }), [fk('tenant_id', 'parent'), fk('parent_id', 'parent')]);
  assert.equal(facts.get('parent_id')?.primary, true);
  assert.equal(facts.get('parent_id')?.unique, true);
  assert.equal(facts.get('parent_id')?.unindexedDeclared, false);
  assert.match(facts.get('parent_id')!.uniqueDescription, /alone is not necessarily unique/);
});

test('unique membership flags do not invent single-column indexes for composite unique keys', () => {
  const entity = table({ allColumns: [column('tenant_id', { unique: true }), column('parent_id', { unique: true })], uniques: [{ columns: ['tenant_id', 'parent_id'] }] });
  const facts = tableColumnFacts(entity, [fk('parent_id')]);
  assert.equal(facts.get('parent_id')?.unindexedDeclared, true);
  assert.doesNotMatch(facts.get('parent_id')!.uniqueDescription, /Individually unique/);
});

test('sample distinct ratios keep sample and total denominators separate', () => {
  const sampled = column('status', { profiling: { nullFraction: .2, distinctCount: 80, sampleSize: 100, min: 0, max: 99 } });
  const profile = columnProfile(sampled, 10000);
  assert.equal(profile.scope, 'sample');
  assert.equal(profile.sampleRatio, .8);
  assert.equal(profile.rowRatio, .008);
  assert.equal(profile.coverage, .01);
  assert.equal(profile.min, 0);
  assert.equal(columnProfile(sampled, undefined).rowRatio, undefined);
  assert.equal(columnProfile(sampled, 0).rowRatio, undefined);
  assert.equal(columnProfile(column('empty', { profiling: { distinctCount: 0, sampleSize: 0 } }), 0).sampleRatio, undefined);
});

test('table-level sample metadata supplies coverage without inventing statistics', () => {
  const profile = columnProfile(column('value', { profiling: { distinctCount: 25 } }), 1000, { sampleSize: 100, sampled: true });
  assert.equal(profile.sampleSize, 100);
  assert.equal(profile.sampleRatio, .25);
  assert.equal(profile.coverage, .1);
  assert.equal(profile.scope, 'sample');
  assert.deepEqual(columnProfile(column('none'), 1000, { sampleSize: 100 }), {});
  assert.equal(columnProfile(column('value', { profiling: { distinctCount: 25, sampled: false } }), 1000).scope, 'table');
});

test('invalid fractions are unavailable and counts are never clamped into invented values', () => {
  for (const nullFraction of [-.1, 1.1, NaN, Infinity]) assert.equal(columnProfile(column('bad', { profiling: { nullFraction } }), 50).nullFraction, undefined);
  const profile = columnProfile(column('zero', { profiling: { nullFraction: 0, distinctCount: 0 } }), 50);
  assert.equal(profile.nullFraction, 0);
  assert.equal(profile.rowRatio, 0);
});

test('filters combine, search includes schema/table, naming inference is not a declaration', () => {
  const entity = table({ name: 'Child', schema: 'public', allColumns: [column('parent_id', { nullable: 'True' }), column('tenant_id', { fk: 'parent.id' })] });
  const facts = tableColumnFacts(entity, [{ ...fk('parent_id'), kind: 'inferred by naming' }]);
  const filters = { search: 'PUBLIC', families: new Set(['integer'] as const), nullableOnly: true, unindexedForeignOnly: false, idWithoutForeignOnly: true };
  assert.equal(matchesColumn(entity, entity.allColumns[0], facts.get('parent_id')!, filters), true);
  assert.equal(matchesColumn(entity, entity.allColumns[1], facts.get('tenant_id')!, filters), false);
  assert.equal(matchesColumn(entity, entity.allColumns[0], facts.get('parent_id')!, { ...filters, unindexedForeignOnly: true }), false);
});
