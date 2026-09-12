import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SchemaGraph, SchemaLink, SchemaTable } from './types';
import { buildDependencyModel, dependencyCellKey, dependencyDescription, dependencyTopology, orderDependencyTables } from './dependency-logic';

const table = (id: string, options: Partial<SchemaTable> = {}): SchemaTable => ({
  id, name: id, className: id, domain: 'Core', type: 'table', pk: 'id', allColumns: [], indexes: [], uniques: [], ...options,
});
const fk = (source: string, target: string, options: Partial<SchemaLink> = {}): SchemaLink => ({
  source, target, column: `${target}_id`, targetColumn: 'id', kind: 'declared FK', ...options,
});
const graph = (ids: string[], links: SchemaLink[]): SchemaGraph => ({ tables: ids.map(id => table(id)), links });

test('composite columns count once per constraint, with separate constraints retained', () => {
  const source = graph(['child', 'parent', 'other'], [
    fk('child', 'parent', { constraintId: 'fk_owner', column: 'tenant', targetColumn: 'tenant' }),
    fk('child', 'parent', { constraintId: 'fk_owner', column: 'owner', targetColumn: 'id' }),
    fk('child', 'parent', { constraintId: 'fk_owner', column: 'owner', targetColumn: 'id' }),
    fk('child', 'parent', { constraintId: 'fk_approver', column: 'approver', targetColumn: 'id' }),
    fk('other', 'parent', { constraintId: 'fk_owner' }),
  ]);
  const model = buildDependencyModel(source), cell = model.cells.get(dependencyCellKey('child', 'parent'))!;
  assert.equal(model.foreignKeys.length, 3);
  assert.equal(cell.foreignKeys.length, 2);
  assert.equal(cell.foreignKeys.find(key => key.name === 'fk_owner')!.columns.length, 2);
  assert.equal(model.cells.has(dependencyCellKey('parent', 'child')), false);
});

test('declared-only model excludes inferred and unresolved edges and preserves optional metadata', () => {
  const link = { ...fk('child', 'parent', { constraintId: 'fk_child', cardinality: 'one-to-many' }), ondelete: 'CASCADE' };
  const model = buildDependencyModel(graph(['child', 'parent', 'isolated'], [link,
    fk('parent', 'isolated', { kind: 'inferred by naming' }), fk('child', 'missing')]));
  assert.equal(model.ignoredLinks, 2);
  assert.equal(model.foreignKeys.length, 1);
  assert.equal(model.foreignKeys[0].onDelete, 'CASCADE');
  assert.equal(model.foreignKeys[0].cardinality, 'one-to-many');
  assert.match(dependencyDescription([...model.cells.values()][0]), /ON DELETE CASCADE/);
  assert.deepEqual(orderDependencyTables(model, 'alpha', true).map(table => table.id), ['child', 'parent']);
});

test('missing cardinality and delete rules stay unknown; anonymous pairs never invent composite membership', () => {
  const model = buildDependencyModel(graph(['a', 'b'], [fk('a', 'b', { column: 'x' }), fk('a', 'b', { column: 'y' })]));
  assert.equal(model.foreignKeys.length, 2);
  assert.ok(model.foreignKeys.every(fk => fk.onDelete === 'Unknown' && fk.cardinality === 'unknown'));
});

test('column-level delete rules are used when the link omits the rule', () => {
  const source = table('child', { allColumns: [{ name: 'parent_id', type: 'integer', pk: false, fk: 'parent.id',
    nullable: 'False', index: false, unique: false, ondelete: 'RESTRICT' }] });
  const model = buildDependencyModel({ tables: [source, table('parent')], links: [fk('child', 'parent')] });
  assert.equal(model.foreignKeys[0].onDelete, 'RESTRICT');
});

test('row count order keeps unknown after zero and schema/alpha ordering is deterministic', () => {
  const source: SchemaGraph = { tables: [table('z', { rowCount: undefined, schema: 'b' }), table('a', { rowCount: 0, schema: 'b' }),
    table('c', { rowCount: 100, schema: 'a' }), table('b', { rowCount: null, schema: 'a' })], links: [] };
  const snapshot = JSON.stringify(source), model = buildDependencyModel(source);
  assert.deepEqual(orderDependencyTables(model, 'rowcount').map(t => t.id), ['c', 'a', 'b', 'z']);
  assert.deepEqual(orderDependencyTables(model, 'schema').map(t => t.id), ['b', 'c', 'a', 'z']);
  assert.deepEqual(orderDependencyTables(model, 'alpha').map(t => t.id), ['a', 'b', 'c', 'z']);
  assert.equal(JSON.stringify(source), snapshot);
});

test('reverse Cuthill-McKee makes scrambled paths banded and is stable across input permutations', () => {
  const path = ['a', 'e', 'b', 'f', 'c', 'd'];
  const source = graph([...path, 'isolated'], path.slice(1).map((id, index) => fk(id, path[index])));
  const ordered = orderDependencyTables(buildDependencyModel(source), 'rcm').map(t => t.id);
  for (let i = 1; i < path.length; i++) assert.equal(Math.abs(ordered.indexOf(path[i]) - ordered.indexOf(path[i - 1])), 1);
  assert.deepEqual(ordered, orderDependencyTables(buildDependencyModel({ tables: [...source.tables].reverse(), links: [...source.links].reverse() }), 'rcm').map(t => t.id));
});

test('SCC condensation is parent-first, cyclic arcs are classified, and isolated tables go right', () => {
  const source = graph(['grandchild', 'child', 'parent', 'isolated', 'cycle_a', 'cycle_b', 'self'], [
    fk('child', 'parent'), fk('grandchild', 'child'), fk('cycle_a', 'cycle_b'), fk('cycle_b', 'cycle_a'),
    fk('self', 'self'), fk('child', 'cycle_a'),
  ]);
  const topology = dependencyTopology(buildDependencyModel(source));
  const ids = topology.tables.map(table => table.id);
  assert.ok(ids.indexOf('parent') < ids.indexOf('child'));
  assert.ok(ids.indexOf('child') < ids.indexOf('grandchild'));
  assert.ok(ids.indexOf('cycle_a') < ids.indexOf('child') && ids.indexOf('cycle_b') < ids.indexOf('child'));
  assert.equal(ids.at(-1), 'isolated');
  assert.deepEqual(topology.cycles.map(component => component.members), [['cycle_a', 'cycle_b'], ['self']]);
  assert.ok(topology.cycles.find(component => component.id === 'self')!.selfLoop);
  assert.equal(topology.arcs.filter(arc => arc.backward).length, 2);
  assert.ok(topology.arcs.filter(arc => !arc.cyclic).every(arc => arc.targetIndex < arc.sourceIndex));
});

test('large dependency chains avoid recursion limits and include every node exactly once', () => {
  const ids = Array.from({ length: 12000 }, (_, index) => `t${String(index).padStart(5, '0')}`);
  const topology = dependencyTopology(buildDependencyModel(graph(ids, ids.slice(1).map((id, index) => fk(id, ids[index])))));
  assert.equal(topology.tables.length, ids.length);
  assert.deepEqual(topology.tables.map(table => table.id), ids);
  assert.equal(topology.cycles.length, 0);
});

test('empty graphs and all-isolated schemas remain valid', () => {
  assert.deepEqual(dependencyTopology(buildDependencyModel(graph([], []))).tables, []);
  const topology = dependencyTopology(buildDependencyModel(graph(['b', 'a'], [])));
  assert.deepEqual(topology.tables.map(table => table.id), ['a', 'b']);
  assert.equal(topology.isolated.size, 2);
});
