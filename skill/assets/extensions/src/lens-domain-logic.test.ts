import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SchemaColumn, SchemaGraph, SchemaLink, SchemaTable } from './types';
import { analyzeNormalization, computeCommunities, declaredRelations, sampleDependencies } from './lens-domain-logic';

const column = (name: string, overrides: Partial<SchemaColumn> = {}): SchemaColumn => ({ name, type: 'text', pk: false, fk: '', nullable: '', index: false, unique: false, ...overrides });
const table = (id: string, columns: SchemaColumn[] = []): SchemaTable => ({ id, className: id, domain: 'Existing business domain', type: 'table', pk: '', allColumns: columns, indexes: [], uniques: [] });
const link = (source: string, target: string, extras: Partial<SchemaLink> = {}): SchemaLink => ({ source, target, column: 'parent_id', targetColumn: 'id', kind: 'declared FK', ...extras });
const fd = (determinant: string, dependent: string, distinctDeterminant = 4, sampleSize = 20) => ({ determinant, dependent, distinctDeterminant, distinctPair: distinctDeterminant, sampleSize });

test('communities separate dense neighborhoods joined by a bridge and ignore existing domain labels', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4', 'isolated'];
  const links: SchemaLink[] = [];
  for (const prefix of ['a', 'b']) for (let i = 1; i <= 4; i++) for (let j = i + 1; j <= 4; j++) links.push(link(`${prefix}${i}`, `${prefix}${j}`));
  links.push(link('a4', 'b1'));
  const graph: SchemaGraph = { tables: ids.map(id => table(id)), links };
  const before = JSON.stringify(graph), communities = computeCommunities(graph);
  for (const prefix of ['a', 'b']) for (let i = 1; i <= 4; i++) assert.equal(communities.get(`${prefix}${i}`), `${prefix}1`);
  assert.equal(communities.get('isolated'), 'isolated');
  assert.deepEqual(computeCommunities({ tables: [...graph.tables].reverse(), links: [...links].reverse() }), communities);
  assert.equal(JSON.stringify(graph), before);
});

test('composite FKs count once, independent constraints remain separate, and inferred/dangling edges do not cluster', () => {
  const graph: SchemaGraph = { tables: ['a', 'b', 'c'].map(id => table(id)), links: [
    link('a', 'b', { constraintId: 'ab', column: 'tenant', targetColumn: 'tenant' }),
    link('a', 'b', { constraintId: 'ab', column: 'key', targetColumn: 'key' }),
    link('a', 'b', { constraintId: 'ab', column: 'key', targetColumn: 'key' }),
    link('a', 'b', { constraintId: 'other', column: 'other' }),
    link('b', 'c', { kind: 'inferred by naming' }), link('c', 'missing'), link('a', 'a'),
  ] };
  const relations = declaredRelations(graph);
  assert.equal(relations.length, 3);
  assert.equal(relations.find(relation => relation.pairs[0].constraintId === 'ab')?.pairs.length, 2);
  assert.equal(computeCommunities(graph).get('c'), 'c');
  assert.equal(computeCommunities(graph).get('a'), computeCommunities(graph).get('b'));
  assert.deepEqual(computeCommunities({ tables: [], links: [] }), new Map());
});

test('shared-name candidates require three eligible tables and preserve type parameters', () => {
  const tables = ['orders', 'invoices', 'shipments'].map(id => table(id, [column('customer_name'), column('id'), column('createdAt'), column('customer_id'), column('amount', { type: 'numeric(8,2)' })]));
  tables.push(table('quotes', [column('customer_name', { type: 'varchar(80)' }), column('amount', { type: 'numeric(9,2)' })]));
  const result = analyzeNormalization({ tables, links: [] });
  assert.deepEqual(result.duplicates.map(field => field.name), ['amount', 'customer_name']);
  assert.ok(result.duplicates.every(field => field.tableIds.length === 3));
  const orders = result.reviews.find(review => review.table.id === 'orders')!;
  assert.equal(orders.score, 4); assert.equal(orders.profileKnown, false);
  assert.ok(orders.excluded.includes('createdAt: generic identifier or audit field'));
  assert.ok(orders.excluded.includes('customer_id: generic identifier or audit field'));
});

test('referenced small lookup with a declared unique natural key is exempt, naming alone is not', () => {
  const lookup = table('countries', [column('code', { unique: true }), column('country_label')]);
  const two = ['orders', 'invoices'].map(id => table(id, [column('country_label')]));
  const graph = { tables: [lookup, ...two], links: [link('orders', 'countries', { column: 'code', targetColumn: 'code' })] };
  const result = analyzeNormalization(graph);
  assert.equal(result.duplicates.length, 0);
  assert.match(result.reviews.find(review => review.table.id === 'countries')!.lookupReason!, /unique natural-key candidate code/);
  assert.equal(analyzeNormalization({ ...graph, links: [] }).duplicates.length, 1);
  lookup.allColumns[0].unique = false;
  lookup.indexes = [{ columns: ['code'], unique: true, partial: true }];
  assert.equal(analyzeNormalization(graph).duplicates.length, 1, 'partial unique does not prove a natural key');
});

test('sample FDs reject tautologies, constants, invalid counts and mismatches; unique determinants carry caution', () => {
  const value = table('orders', [column('id', { pk: true }), column('customer'), column('label'), column('unique_sample'), column('other')]);
  value.profiling = { functionalDependencies: [fd('customer', 'label'), fd('customer', 'label'), fd('id', 'label'), fd('unique_sample', 'label', 20),
    fd('label', 'label'), fd('customer', 'other', 1), fd('missing', 'label'), { ...fd('customer', 'other'), distinctPair: 5 }, fd('other', 'label', 21), fd('other', 'label', 2.5), fd('other', 'label', 4, Number.NaN)] };
  assert.equal(sampleDependencies(value).length, 1, 'unique determinants are ignored by default');
  const dependencies = sampleDependencies(value, { includeVacuous: true });
  assert.equal(dependencies.length, 3);
  assert.equal(dependencies.find(item => item.determinant === 'customer')!.caution, null);
  assert.match(dependencies.find(item => item.determinant === 'id')!.caution!, /Declared unique/);
  assert.match(dependencies.find(item => item.determinant === 'unique_sample')!.caution!, /equality is automatic/);
  const review = analyzeNormalization({ tables: [value], links: [] }).reviews[0];
  assert.equal(review.score, 3);
  assert.equal(review.profileKnown, true);
  assert.equal(review.dependencies.length, 1);
  assert.ok(review.excluded.some(reason => reason.includes('equality is automatic')));
});

test('a composite PK member is not individually treated as unique', () => {
  const value = table('lines', [column('order_id', { pk: true }), column('line_no', { pk: true }), column('customer_name')]);
  value.primaryKey = ['order_id', 'line_no'];
  value.profiling = { functionalDependencies: [fd('order_id', 'customer_name')] };
  assert.equal(sampleDependencies(value)[0].caution, null);
});

test('unknown profiling never becomes a clean score, while a reported empty sample review stays sample-only', () => {
  const missing = table('missing'), zero = table('zero'), profiled = table('profiled');
  zero.rowCount = 0;
  profiled.profiling = { functionalDependencies: [], sampleSize: 20 };
  const result = analyzeNormalization({ tables: [missing, zero, profiled], links: [] });
  assert.equal(result.reviews.find(review => review.table.id === 'missing')!.score, null);
  assert.equal(result.reviews.find(review => review.table.id === 'zero')!.score, null);
  assert.equal(result.reviews.find(review => review.table.id === 'profiled')!.score, 0);
  assert.deepEqual(analyzeNormalization({ tables: [], links: [] }), { reviews: [], duplicates: [] });
});
