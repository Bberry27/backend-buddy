import assert from 'node:assert/strict';
import test from 'node:test';
import type { SchemaGraph, SchemaLink, SchemaTable } from './types';
import { buildFanout, buildLiveFanout, defaultFanoutRoot, fanoutChildCounts, knownCount, localRatio, parsePrimaryKey } from './fanout-logic';

function table(id: string, rowCount?: number): SchemaTable {
  return { id, rowCount, className: id, domain: 'Test', type: 'table', pk: 'id', primaryKey: ['id'],
    allColumns: [{ name: 'id', type: 'integer', pk: true, fk: '', nullable: 'False', index: true, unique: true },
      { name: 'parent_id', type: 'integer', pk: false, fk: '', nullable: 'False', index: true, unique: false }], indexes: [], uniques: [] };
}
function fk(child: string, parent: string, extra: Partial<SchemaLink> = {}): SchemaLink {
  return { source: child, target: parent, column: 'parent_id', targetColumn: 'id', kind: 'declared FK', ...extra };
}
const graph = (tables: SchemaTable[], links: SchemaLink[]): SchemaGraph => ({ tables, links });

test('ratios distinguish absent, zero parent, zero child, and positive counts', () => {
  assert.equal(knownCount(undefined), null);
  assert.equal(knownCount(null), null);
  assert.equal(knownCount(NaN), null);
  assert.equal(localRatio(0, 10).ratio, null);
  assert.equal(localRatio(10, undefined).ratio, null);
  assert.equal(localRatio(10, 0).ratio, 0);
  assert.equal(localRatio(10, 25).ratio, 2.5);
});

test('traversal reverses declared FK direction and does not aggregate independent factors', () => {
  const data = graph([table('p', 10), table('a', 20), table('b', 50)], [fk('a', 'p'), fk('b', 'p')]);
  const result = buildFanout(data, 'p', 2, new Set());
  assert.deepEqual(result.links.map(link => link.ratio), [2, 5]);
  assert.equal(result.nodes[0].rowCount, 10);
  assert.equal(buildFanout(data, 'a', 2, new Set()).links.length, 0);
});

test('inferred, one-to-one, and unique child FKs are excluded', () => {
  const unique = table('unique'); unique.uniques = [{ columns: ['parent_id'] }];
  const data = graph([table('p'), table('guess'), table('one'), unique], [fk('guess', 'p', { kind: 'inferred by naming' }), fk('one', 'p', { cardinality: 'one-to-one' }), fk('unique', 'p')]);
  assert.equal(buildFanout(data, 'p', 4, new Set()).links.length, 0);
});

test('partial unique index does not establish one-to-one', () => {
  const child = table('child'); child.indexes = [{ columns: ['parent_id'], unique: true, partial: true }];
  assert.equal(buildFanout(graph([table('p'), child], [fk('child', 'p')]), 'p', 1, new Set()).links.length, 1);
});

test('composite FK grouped once and composite uniqueness excludes it', () => {
  const child = table('child');
  const links = [fk('child', 'p', { column: 'a', constraintId: 'fk_pair' }), fk('child', 'p', { column: 'b', constraintId: 'fk_pair' })];
  const data = graph([table('p'), child], links);
  assert.equal(buildFanout(data, 'p', 2, new Set()).links.length, 1);
  child.uniques = [{ columns: ['a', 'b'] }];
  assert.equal(buildFanout(data, 'p', 2, new Set()).links.length, 0);
});

test('cycles are pruned with notice and depth remains bounded', () => {
  const result = buildFanout(graph([table('p'), table('a'), table('b')], [fk('a', 'p'), fk('b', 'a'), fk('p', 'b')]), 'p', 4, new Set());
  assert.equal(result.nodes.length, 3);
  assert.match(result.notices.join(' '), /cyclic/);
  assert.ok(result.links.every(link => result.nodes.find(node => node.id === link.target)!.depth > result.nodes.find(node => node.id === link.source)!.depth));
});

test('diamond shares child once at the same depth; alternate path survives collapse', () => {
  const data = graph([table('p'), table('a'), table('b'), table('shared', 30)], [fk('a', 'p'), fk('b', 'p'), fk('shared', 'a'), fk('shared', 'b')]);
  const result = buildFanout(data, 'p', 2, new Set());
  assert.equal(result.nodes.filter(node => node.tableId === 'shared').length, 1);
  assert.equal(result.links.length, 4);
  const collapsed = buildFanout(data, 'p', 2, new Set([JSON.stringify([1, 'a'])]));
  assert.equal(collapsed.nodes.filter(node => node.tableId === 'shared').length, 1);
  assert.equal(collapsed.links.length, 3);
});

test('repeated table at different depths is explicit, never summed', () => {
  const data = graph([table('p'), table('a'), table('b', 40)], [fk('a', 'p'), fk('b', 'p'), fk('b', 'a')]);
  const result = buildFanout(data, 'p', 2, new Set());
  assert.deepEqual(result.nodes.filter(node => node.tableId === 'b').map(node => node.rowCount), [40, 40]);
  assert.match(result.notices.join(' '), /never added/);
});

test('depth and collapse limit traversal', () => {
  const data = graph([table('p'), table('a'), table('b')], [fk('a', 'p'), fk('b', 'a')]);
  assert.equal(buildFanout(data, 'p', 1, new Set()).nodes.length, 2);
  assert.equal(buildFanout(data, 'p', 4, new Set([JSON.stringify([0, 'p'])])).nodes.length, 1);
});

test('composite keys require precisely the PK fields and scalar values', () => {
  const root = table('root'); root.primaryKey = ['tenant', 'id'];
  assert.deepEqual(parsePrimaryKey(root, '{"tenant":"acme","id":7}'), { tenant: 'acme', id: 7 });
  for (const invalid of ['7', '{"id":7}', '{"tenant":null,"id":7}', '{"tenant":"acme","id":7,"other":1}']) assert.throws(() => parsePrimaryKey(root, invalid));
  assert.equal(parsePrimaryKey(table('single'), 'abc-123'), 'abc-123');
  assert.equal(parsePrimaryKey(table('single'), '42'), 42);
  assert.equal(parsePrimaryKey(table('single'), '9223372036854775807'), '9223372036854775807');
  assert.throws(() => parsePrimaryKey(root, '{"tenant":"acme","id":9223372036854775807}'), /Quote large numeric/);
});

test('live graph uses local supplied ratios, hides descendants, and announces truncation', () => {
  const result = { nodes: [{ id: 'root', tableId: 'p', depth: 0, rowCount: 1 }, { id: 'child', tableId: 'c', depth: 1, rowCount: 10000, truncated: true }],
    links: [{ source: 'root', target: 'child', ratio: 10000 }, { source: 'child', target: 'root', ratio: null }], truncated: true, limit: 10000 };
  const model = buildLiveFanout(result, 'p', new Set());
  assert.equal(model.links.length, 1);
  assert.equal(model.links[0].ratio, 10000);
  assert.match(model.notices.join(' '), /truncated/);
  assert.match(model.notices.join(' '), /acyclic/);
  assert.equal(buildLiveFanout(result, 'p', new Set(['root'])).nodes.length, 1);
  const excluded = buildLiveFanout(result, 'p', new Set(), graph([table('p'), table('c')], [fk('c', 'p', { cardinality: 'one-to-one' })]));
  assert.equal(excluded.links.length, 0);
  assert.match(excluded.notices.join(' '), /non-unique FK/);
});

test('F06 child counts count eligible relationships, not raw links', () => {
  const tables = ['hub', 'a', 'b', 'lonely'].map(id => table(id));
  const links = [
    fk('a', 'hub'), fk('b', 'hub'),
    // Two links of one composite constraint are one relationship, not two.
    fk('a', 'lonely', { constraintId: 'multi', column: 'parent_id' }),
    fk('a', 'lonely', { constraintId: 'multi', column: 'id' }),
  ];
  const counts = fanoutChildCounts(graph(tables, links));
  assert.equal(counts.get('hub'), 2);
  // 'lonely' is referenced through the child's own unique id column, so that relationship is not
  // eligible and it fans out to nothing.
  assert.equal(counts.get('lonely'), undefined);
  assert.equal(counts.get('a'), undefined);
});

test('F06 the default root is one that actually fans out, not the alphabetical first', () => {
  // 'aaa' sorts first and has no children; the old default picked it and the view looked dead.
  const tables = ['aaa', 'zzz', 'child_one', 'child_two'].map(id => table(id));
  const links = [fk('child_one', 'zzz'), fk('child_two', 'zzz')];
  const g = graph(tables, links);
  assert.equal(defaultFanoutRoot(g), 'zzz');
  assert.ok(buildFanout(g, defaultFanoutRoot(g), 2, new Set()).links.length > 0,
    'the default root must produce at least one link');

  // Stable for a given graph, and independent of the order the tables arrive in.
  assert.equal(defaultFanoutRoot({ ...g, tables: [...tables].reverse() }), 'zzz');
});

test('F06 a graph with no eligible relationship still yields a usable root', () => {
  const tables = ['solo', 'other'].map(id => table(id));
  const g = graph(tables, []);
  // No fan-out anywhere: fall back to the alphabetically first id rather than an empty string, so
  // the select holds a valid value and the view can explain that this root has no children.
  assert.equal(defaultFanoutRoot(g), 'other');
  assert.equal(fanoutChildCounts(g).size, 0);
  assert.equal(defaultFanoutRoot(graph([], [])), '');
});
