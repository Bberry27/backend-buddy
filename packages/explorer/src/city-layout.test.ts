import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SchemaGraph, SchemaTable } from './types';
import { CITY_HEIGHT_BASES, CITY_PROMINENT_LABELS, cityHeightAdvice, cityHeightValue, cityLabelled, cityRowCount, cityTableLabel, layoutCity } from './city-layout';

function table(id: string, columnCount: number, domain = 'Core', rowCount?: number): SchemaTable {
  return { id, className: id, domain, type: 'table', pk: 'id', rowCount, indexes: [], uniques: [],
    allColumns: Array.from({ length: columnCount }, (_, i) => ({ name: `col_${i}`, type: 'integer',
      pk: i === 0, fk: '', nullable: 'False', index: false, unique: false })) };
}

function fixture(count: number): SchemaGraph {
  const tables = Array.from({ length: count }, (_, i) => table(`table_${i}`, 1 + (i * 17) % 71,
    `Domain ${i % 11}`, i % 3 ? i ** 4 : undefined));
  return { tables, links: tables.slice(1).map((t, i) => ({ source: t.id, target: tables[i].id,
    column: 'parent_id', targetColumn: 'id', kind: i % 2 ? 'declared FK' : 'inferred by naming' })) };
}

test('all buildings stay inside districts, remain disjoint, and preserve column area ratios', () => {
  for (const count of [1, 2, 12, 120, 600]) {
    const graph = fixture(count), layout = layoutCity(graph);
    assert.equal(layout.buildings.length, count);
    const ratio = layout.buildings[0].width ** 2 / layout.buildings[0].table.allColumns.length;
    for (const b of layout.buildings) {
      const d = layout.districts.find(d => d.id === b.domain)!;
      assert.ok(b.x - b.width / 2 > d.x && b.x + b.width / 2 < d.x + d.width);
      assert.ok(b.z - b.depth / 2 > d.z && b.z + b.depth / 2 < d.z + d.depth);
      assert.ok(b.width > 0 && Number.isFinite(b.height));
      assert.ok(Math.abs(b.width ** 2 / b.table.allColumns.length - ratio) < 1e-8);
      for (const other of layout.buildings) {
        if (b.id >= other.id) continue;
        assert.ok(Math.abs(b.x - other.x) >= (b.width + other.width) / 2 ||
          Math.abs(b.z - other.z) >= (b.depth + other.depth) / 2, `${b.id} overlaps ${other.id}`);
      }
    }
  }
});

test('roads use orthogonal aisles and do not cross unrelated building footprints', () => {
  const graph = fixture(120), layout = layoutCity(graph);
  assert.equal(layout.roads.length, graph.links.length);
  assert.ok(layout.roads.some(road => road.crossDistrict));
  for (const road of layout.roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i];
    assert.ok(a[0] === b[0] || a[1] === b[1], `Diagonal route ${road.id}`);
    for (const building of layout.buildings) {
      if (building.id === road.source || building.id === road.target) continue;
      const half = road.width / 2;
      const x0 = building.x - building.width / 2 - half, x1 = building.x + building.width / 2 + half;
      const z0 = building.z - building.depth / 2 - half, z1 = building.z + building.depth / 2 + half;
      const intersects = a[0] === b[0]
        ? a[0] > x0 && a[0] < x1 && Math.max(a[1], b[1]) > z0 && Math.min(a[1], b[1]) < z1
        : a[1] > z0 && a[1] < z1 && Math.max(a[0], b[0]) > x0 && Math.min(a[0], b[0]) < x1;
      assert.ok(!intersects, `${road.id} crosses ${building.id}`);
    }
  }
});

test('layout is deterministic without mutating input ordering', () => {
  const graph = fixture(40), snapshot = JSON.stringify(graph);
  assert.deepEqual(layoutCity(graph), layoutCity({ ...graph, tables: [...graph.tables].reverse() }));
  assert.equal(JSON.stringify(graph), snapshot);
});

test('missing and invalid counts stay unknown; zero stays known; road volume is not invented', () => {
  const unknown = table('unknown', 2), zero = table('zero', 2, 'Core', 0);
  assert.equal(cityRowCount(unknown), null);
  assert.equal(cityRowCount({ ...unknown, rowCount: null }), null);
  assert.equal(cityRowCount({ ...unknown, rowCount: Number.NaN }), null);
  assert.equal(cityRowCount({ ...unknown, rowCount: -1 }), null);
  assert.equal(cityRowCount(zero), 0);
  assert.match(cityTableLabel(unknown), /Unprofiled/);
  assert.match(cityTableLabel(zero), /0 rows/);
  const layout = layoutCity({ tables: [unknown, zero], links: [{ source: 'unknown', target: 'zero',
    column: 'zero_id', targetColumn: 'id', kind: 'declared FK' }] });
  assert.equal(layout.roads[0].ratio, null);
  assert.equal(layout.buildings.find(b => b.id === 'unknown')!.rowCount, null);
});

test('known heights follow log1p counts above the minimum; empty and dangling graphs are valid', () => {
  const layout = layoutCity({ tables: [table('a', 12, 'Core', 100), table('b', 12, 'Core', 1000000)], links: [] });
  const [a, b] = layout.buildings;
  assert.ok(Math.abs(a.height / b.height - Math.log1p(100) / Math.log1p(1000000)) < 1e-8);
  assert.equal(layoutCity({ tables: [], links: [] }).buildings.length, 0);
  assert.equal(layoutCity({ tables: [table('empty', 0)], links: [{ source: 'empty', target: 'missing',
    column: 'x', targetColumn: 'id', kind: 'declared FK' }] }).roads.length, 0);
});

test('F08 a declared height basis is always known, so no building falls back to the baseline', () => {
  // Every table here is unprofiled: this is the shape the city has before any row count is measured.
  const graph: SchemaGraph = { tables: [table('a', 4, 'Core'), table('b', 40, 'Core'), table('c', 12, 'Edge')], links: [] };
  const rows = layoutCity(graph, 'rows');
  assert.equal(rows.basis, 'rows');
  // Guardrail: an unmeasured row count keeps the minimum height and is never given a stand-in.
  assert.deepEqual([...new Set(rows.buildings.map(b => b.height))], [0.6]);

  const columns = layoutCity(graph, 'columns');
  assert.equal(columns.basis, 'columns');
  assert.ok(new Set(columns.buildings.map(b => b.height)).size > 1, 'columns must separate the tables');
  const [a, b] = ['a', 'b'].map(id => columns.buildings.find(building => building.id === id)!);
  assert.ok(Math.abs(a.height / b.height - Math.log1p(4) / Math.log1p(40)) < 1e-8);
});

test('F08 the height basis never rewrites the measured row count it is not derived from', () => {
  const graph: SchemaGraph = { tables: [table('measured', 3, 'Core', 500), table('unknown', 9, 'Core')], links: [] };
  for (const basis of CITY_HEIGHT_BASES.map(option => option.id)) {
    const layout = layoutCity(graph, basis);
    assert.equal(layout.buildings.find(b => b.id === 'measured')!.rowCount, 500);
    assert.equal(layout.buildings.find(b => b.id === 'unknown')!.rowCount, null, `${basis} invented a row count`);
  }
});

test('F08 cityHeightValue reports null only for an unmeasured row count', () => {
  const unprofiled = table('u', 7, 'Core');
  assert.equal(cityHeightValue(unprofiled, 'rows'), null);
  assert.equal(cityHeightValue(unprofiled, 'columns'), 7);
  // No index is a known zero, not an unknown, so it stays a number.
  assert.equal(cityHeightValue(unprofiled, 'indexes'), 0);
  assert.equal(cityHeightValue(table('m', 7, 'Core', 0), 'rows'), 0);
});

test('F08 the city says why it is flat, and stops saying it once it is not', () => {
  const unmeasured: SchemaGraph = { tables: [table('a', 4), table('b', 9)], links: [] };
  const advice = cityHeightAdvice(layoutCity(unmeasured, 'rows'));
  assert.match(advice, /No row counts in this snapshot/);
  // Both ways out are named, and the reader is not sent to an admin area the artifact cannot reach.
  assert.match(advice, /set Height to a declared basis/);
  assert.ok(!/admin/i.test(advice));

  // A declared basis cannot be unknown, so there is nothing to explain.
  for (const basis of ['columns', 'indexes'] as const) {
    assert.equal(cityHeightAdvice(layoutCity(unmeasured, basis)), '');
  }

  // Fully measured: silent. Partly measured: a count of what is missing.
  const measured: SchemaGraph = { tables: [table('a', 4, 'Core', 10), table('b', 9, 'Core', 20)], links: [] };
  assert.equal(cityHeightAdvice(layoutCity(measured, 'rows')), '');
  const partial: SchemaGraph = { tables: [table('a', 4, 'Core', 10), table('b', 9, 'Core')], links: [] };
  assert.match(cityHeightAdvice(layoutCity(partial, 'rows')), /1 of 2 tables have a measured row count/);
  // An empty graph has no heights to describe.
  assert.equal(cityHeightAdvice(layoutCity({ tables: [], links: [] }, 'rows')), '');
});

test('F08 label density keeps what is pointed at, whatever else it hides', () => {
  // Heights differ, so "prominent" has something to rank by.
  const graph: SchemaGraph = { tables: Array.from({ length: 40 }, (_, i) =>
    table(`t${String(i).padStart(2, '0')}`, 3, 'Core', i * 100)), links: [] };
  const buildings = layoutCity(graph, 'rows').buildings;
  const tallest = [...buildings].sort((a, b) => b.height - a.height)[0].id;
  const smallest = [...buildings].sort((a, b) => a.height - b.height)[0].id;

  assert.equal(cityLabelled(buildings, 'all', new Set()).size, buildings.length);
  // Selected only means exactly that, and an empty selection means an unlabelled city.
  assert.deepEqual([...cityLabelled(buildings, 'selected', new Set())], []);
  assert.deepEqual([...cityLabelled(buildings, 'selected', new Set([smallest]))], [smallest]);

  const prominent = cityLabelled(buildings, 'prominent', new Set());
  assert.equal(prominent.size, CITY_PROMINENT_LABELS);
  assert.ok(prominent.has(tallest), 'the tallest building must be named');
  assert.ok(!prominent.has(smallest), 'the shortest should have been dropped at this size');

  // Whatever is hovered or selected is named at every density, which is what makes the rest safe
  // to hide: the answer is a hover away.
  for (const density of ['prominent', 'selected'] as const) {
    assert.ok(cityLabelled(buildings, density, new Set([smallest])).has(smallest),
      `${density} dropped the thing being pointed at`);
  }
});

test('F08 a city smaller than the label budget loses no names', () => {
  const graph: SchemaGraph = { tables: Array.from({ length: 6 }, (_, i) =>
    table(`t${i}`, 3, 'Core', i * 10)), links: [] };
  const buildings = layoutCity(graph, 'rows').buildings;
  // The default must not hide anything on a schema small enough to show in full.
  assert.equal(cityLabelled(buildings, 'prominent', new Set()).size, buildings.length);
  assert.equal(cityLabelled(buildings, 'prominent', new Set(), 0).size, 0);
});
