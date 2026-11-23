import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SchemaGraph, SchemaLink, SchemaTable } from './types';
import { ERD_TIER_EDGES, ERD_TIER_HYSTERESIS, HUB_GROUP, HUB_MIN_TABLES, UNCONNECTED_GROUP, attachedGroup, defaultGroupMode, domainAggregates, domainBounds, erdTier, hubTables, packGroups, parseGroupMode, tableGroups, junctions, knownRows, layoutTables, neighborhood, nodeSize, parsePositions, planErdEdges, relations, rowLabel, serializePositions, snapshotKey, visibleGraph } from './living-logic';

const table = (id: string, override: Partial<SchemaTable> = {}): SchemaTable => ({ id, className: id, domain: 'Operations', type: 'table', pk: 'id', primaryKey: ['id'], allColumns: [{ name: 'id', type: 'int', pk: true, fk: '', nullable: 'False', index: false, unique: false }], indexes: [], uniques: [], ...override });
const fk = (source: string, target: string, column: string, constraintId?: string): SchemaLink => ({ source, target, column, targetColumn: 'id', kind: 'declared FK', constraintId });
const graph = (): SchemaGraph => ({ project: { name: 'Example', key: 'example', dialect: 'postgres' }, tables: [table('a'), table('b'), table('a_b', { primaryKey: ['a_id', 'b_id'], allColumns: [] })], links: [fk('a_b', 'a', 'a_id'), fk('a_b', 'b', 'b_id')] });

test('counts preserve unknown and empty, log sizing is bounded', () => {
  for (const count of [undefined, null, -1, Infinity, NaN, '50']) assert.equal(knownRows(count), false);
  assert.equal(rowLabel(table('empty', { rowCount: 0 })), '0 rows');
  assert.equal(rowLabel(table('unknown')), 'Rows unknown');
  assert.ok(nodeSize(table('large', { rowCount: 1e15 })).width <= 330);
});
test('snapshot persistence isolates projects and sources, and reuses reordered tables', () => {
  const a = graph(), b = graph();
  b.tables.reverse(); assert.equal(snapshotKey(a), snapshotKey(b));
  b.project!.key = 'other'; assert.notEqual(snapshotKey(a), snapshotKey(b));
  b.project!.key = 'example'; b.source = { hash: 'new' }; assert.notEqual(snapshotKey(a), snapshotKey(b));
  a.source = { hash: 'new' }; assert.equal(snapshotKey(a), snapshotKey(b));
});
test('position serialization restores pins and filters unknown IDs and unsafe data', () => {
  const positions = { a: { x: -251.3, y: 38.5, pinned: true }, b: { x: 45, y: 1, pinned: false }, stale: { x: 0, y: 0, pinned: true } };
  const loaded = parsePositions(serializePositions(positions), ['a', 'b']);
  assert.deepEqual({ ...loaded }, { a: positions.a, b: positions.b });
  for (const raw of ['bad json', '{"version":2,"positions":{}}', '{"version":1,"positions":{"a":{"x":"0","y":1,"pinned":true}}}', '{"version":1,"positions":{"a":{"x":1e30,"y":1,"pinned":true}}}']) assert.equal(Object.keys(parsePositions(raw, ['a'])).length, 0);
});
test('true binary junction collapses, search can reveal it, and toggle restores it', () => {
  const value = graph();
  assert.equal(junctions(value).size, 1);
  const collapsed = visibleGraph(value, false);
  assert.equal(collapsed.tables.length, 2); assert.equal(collapsed.relations.length, 1);
  assert.equal(collapsed.relations[0].junction, 'a_b');
  assert.equal(visibleGraph(value, true).tables.length, 3);
  assert.equal(visibleGraph(value, false, 'a_b').tables.length, 3);
});
test('detail tables, partial uniqueness, one-to-one and inferred links never become N:M', () => {
  for (const change of ['surrogate', 'partial', 'one', 'inferred'] as const) {
    const value = graph();
    if (change === 'surrogate') value.tables[2].primaryKey = ['id'];
    if (change === 'partial') { value.tables[2].primaryKey = []; value.tables[2].uniques = [{ columns: ['a_id', 'b_id'], partial: true }]; }
    if (change === 'one') value.tables[2].uniques = [{ columns: ['a_id'] }];
    if (change === 'inferred') value.links[0].kind = 'inferred by naming';
    assert.equal(visibleGraph(value, false).hidden.size, 0, change);
  }
});
test('ternary and referenced junctions remain explicit to preserve their relationships', () => {
  const value = graph(); value.tables.push(table('c')); value.tables[2].primaryKey!.push('c_id'); value.links.push(fk('a_b', 'c', 'c_id'));
  assert.equal(junctions(value).size, 1); assert.equal(visibleGraph(value, false).hidden.size, 0);
  const referenced = graph(); referenced.tables.push(table('audit')); referenced.links.push(fk('audit', 'a_b', 'join_id'));
  assert.equal(visibleGraph(referenced, false).hidden.size, 0);
});
test('composite FK pairs group only by constraint, and target uniqueness is required', () => {
  const value = graph(); value.links = [fk('a_b', 'a', 'tenant', 'compound'), { ...fk('a_b', 'a', 'a_id', 'compound'), targetColumn: 'other' }];
  assert.equal(relations(value).length, 1); assert.equal(relations(value)[0].pairs.length, 2);
  value.links.forEach(link => { delete link.constraintId; }); assert.equal(relations(value).length, 2);
  value.tables[0].primaryKey = []; value.tables[0].allColumns = [];
  assert.equal(relations(value)[0].cardinality, 'unknown');
});
test('force layout is deterministic, finite, non-overlapping and restores saved positions', () => {
  const value: SchemaGraph = { tables: Array.from({length: 36}, (_,i) => table(`table_${i}`, { domain: ['Ops', 'Billing', 'Fleet'][i % 3], rowCount: i * 1000 })), links: [] };
  const first = layoutTables(value), second = layoutTables(value);
  assert.deepEqual(first, second);
  for (const [index, a] of value.tables.entries()) {
    const p = first[a.id], size = nodeSize(a); assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    for (const b of value.tables.slice(index + 1)) {
      const q = first[b.id], other = nodeSize(b);
      assert.ok(!(p.x < q.x + other.width && p.x + size.width > q.x && p.y < q.y + other.height && p.y + size.height > q.y));
    }
  }
  first.table_0 = {x: 0, y: 0, pinned: true};
  assert.deepEqual(layoutTables(value, first), first);
  assert.deepEqual(layoutTables(value, first, false).table_0, first.table_0);
  assert.deepEqual({ ...layoutTables({ tables: [], links: [] }) }, {});
});
test('C03 snapshotKey output is unchanged after the fingerprint moved to view-state.ts', () => {
  // Saved Living ERD layouts are keyed by this string. C03 moved the project scope and the
  // fingerprint into view-state.ts so the per-view state key shares them (C13); the two values
  // below are the bytes the key had before that move, so a change to either half fails here
  // rather than orphaning every stored layout.
  const pinned: SchemaGraph = {
    project: { name: 'Pinned Example', key: 'pinned-example', dialect: 'postgresql' },
    tables: [table('schema.alpha'), table('schema.beta')],
    links: [fk('schema.beta', 'schema.alpha', 'alpha_id', 'fk_beta_alpha')],
  };
  assert.equal(snapshotKey(pinned), 'backend-buddy-erd:v1:pinned-example:498f79cc');
  assert.equal(snapshotKey({ ...pinned, source: { hash: 'pinned/hash value' } }), 'backend-buddy-erd:v1:pinned-example:pinned%2Fhash%20value');
});

test('F05 every zoom lands in a tier, and the tiers stay in zoom order', () => {
  const seen = new Map<string, number[]>();
  for (const zoom of [0.001, 0.05, 0.15, 0.17, 0.3, 0.41, 0.45, 0.9, 1.14, 1.2, 2.6]) {
    // A fresh reading with no previous tier must be a pure function of the zoom.
    const tier = erdTier(zoom, 'tables');
    seen.set(tier, [...(seen.get(tier) || []), zoom]);
  }
  assert.equal(erdTier(0.001, 'tables'), 'overview');
  assert.equal(erdTier(2.6, 'tables'), 'detail');
  // Monotonic: zooming in never drops to a coarser tier.
  const order = ['overview', 'domains', 'tables', 'detail'];
  let previousIndex = -1;
  for (const zoom of [0.001, 0.1, 0.25, 0.6, 2.0]) {
    const index = order.indexOf(erdTier(zoom, 'tables'));
    assert.ok(index >= previousIndex, `zoom ${zoom} went backwards`);
    previousIndex = index;
  }
});

test('F05 the tier holds across a boundary until the zoom clears the hysteresis margin', () => {
  for (const edge of ERD_TIER_EDGES) {
    const below = erdTier(edge * 0.5, 'tables');
    const above = erdTier(edge * 2, 'tables');
    assert.notEqual(below, above, `edge ${edge} separates nothing`);
    // Sitting a hair above the raw edge must not flip a diagram that came from below it.
    assert.equal(erdTier(edge * 1.01, below), below, `edge ${edge} flipped up too early`);
    assert.equal(erdTier(edge * 0.99, above), above, `edge ${edge} flipped down too early`);
    // Clearing the margin does change it, in both directions.
    assert.equal(erdTier(edge * ERD_TIER_HYSTERESIS * 1.01, below), above);
    assert.equal(erdTier(edge / ERD_TIER_HYSTERESIS * 0.99, above), below);
  }
});

test('F05 domain aggregates count cross-domain relationships once per pair and keep evidence apart', () => {
  const tables = [table('a1', { domain: 'Billing' }), table('a2', { domain: 'Billing' }),
    table('b1', { domain: 'Ops' }), table('c1', { domain: 'Lonely' })];
  const links: SchemaLink[] = [
    fk('a1', 'b1', 'ops_id', 'c1'), fk('b1', 'a2', 'billing_id', 'c2'),
    { source: 'a2', target: 'b1', column: 'ops_id', targetColumn: 'id', kind: 'inferred by naming' },
    fk('a1', 'a2', 'sibling_id', 'c3'),
  ];
  const { domains, ribbons } = domainAggregates(tables, relations({ tables, links }));
  assert.deepEqual(domains.map(d => `${d.id}:${d.tables.length}`), ['Billing:2', 'Lonely:1', 'Ops:1']);
  // One ribbon for the Billing<->Ops pair whichever way each relationship points; none for the
  // same-domain link, and none at all for the unconnected domain.
  assert.equal(ribbons.length, 1);
  assert.deepEqual([ribbons[0].source, ribbons[0].target], ['Billing', 'Ops']);
  assert.equal(ribbons[0].count, 3);
  assert.equal(ribbons[0].declared, 2);
  assert.equal(ribbons[0].inferred, 1);
});

test('F05 a neighborhood grows by hops and never leaves the connected component', () => {
  const tables = ['a', 'b', 'c', 'd', 'island'].map(id => table(id));
  const links = [fk('a', 'b', 'b_id', 'k1'), fk('b', 'c', 'c_id', 'k2'), fk('c', 'd', 'd_id', 'k3')];
  const rels = relations({ tables, links });
  assert.deepEqual([...neighborhood(rels, 'a', 0)], ['a']);
  assert.deepEqual([...neighborhood(rels, 'a', 1)].sort(), ['a', 'b']);
  assert.deepEqual([...neighborhood(rels, 'a', 2)].sort(), ['a', 'b', 'c']);
  // Saturates at the component rather than growing forever, and an isolated table stays alone.
  assert.deepEqual([...neighborhood(rels, 'a', 99)].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...neighborhood(rels, 'island', 99)], ['island']);
});

test('F05 a domain bubble encloses its own tables and nothing else', () => {
  const tables = [table('a1', { domain: 'Billing' }), table('a2', { domain: 'Billing' }), table('b1', { domain: 'Ops' })];
  const positions = { a1: { x: 100, y: 100, pinned: false }, a2: { x: 500, y: 300, pinned: false }, b1: { x: 4000, y: 50, pinned: false } };
  const { domains } = domainAggregates(tables, []);
  const boxes = domainBounds(domains, positions, 10);
  const billing = boxes.find(b => b.id === 'Billing')!, ops = boxes.find(b => b.id === 'Ops')!;
  assert.equal(billing.x, 90);
  assert.equal(billing.y, 90);
  // Wide enough to reach the far corner of a2 plus the padding on both sides.
  assert.equal(billing.width, 500 - 100 + nodeSize(table('a2')).width + 20);
  // The distant Ops table cannot stretch the Billing box, and every box is usable.
  assert.ok(ops.x > billing.x + billing.width);
  for (const box of boxes) assert.ok(box.width > 0 && box.height > 0);
  // A domain with no placed positions still gets a box rather than NaN geometry.
  const orphan = domainBounds(domains, {}, 10);
  for (const box of orphan) assert.ok(Number.isFinite(box.x) && box.width > 0);
});

test('F05 edges resolve to whatever stands in for each endpoint, and never inside one bubble', () => {
  const tables = [table('a1', { domain: 'Billing' }), table('a2', { domain: 'Billing' }),
    table('b1', { domain: 'Ops' }), table('b2', { domain: 'Ops' })];
  const links = [fk('a1', 'a2', 'sibling_id', 'k1'), fk('a1', 'b1', 'ops_id', 'k2'), fk('a2', 'b2', 'ops_id', 'k3')];
  const rels = relations({ tables, links });
  const domainOf = new Map(tables.map(entry => [entry.id, `__bubble_${entry.domain}`]));

  // Everything collapsed: the Billing-internal link disappears, the two crossing links become one ribbon.
  const collapsed = planErdEdges(rels, id => domainOf.get(id)!);
  assert.deepEqual(collapsed.direct, []);
  assert.equal(collapsed.ribbons.length, 1);
  assert.equal(collapsed.ribbons[0].count, 2);

  // Billing expanded, Ops collapsed: its internal link is drawn, and both crossings become one
  // ribbon per visible endpoint rather than being dropped.
  const half = planErdEdges(rels, id => id.startsWith('a') ? id : domainOf.get(id)!);
  assert.deepEqual(half.direct.map(r => `${r.source}->${r.target}`), ['a1->a2']);
  assert.deepEqual(half.ribbons.map(r => r.count), [1, 1]);
  assert.deepEqual(half.ribbons.map(r => [r.source, r.target].sort()[0]), ['__bubble_Ops', '__bubble_Ops']);

  // Everything expanded: every relationship is drawn directly and no ribbon is invented.
  const expanded = planErdEdges(rels, id => id);
  assert.equal(expanded.direct.length, rels.length);
  assert.deepEqual(expanded.ribbons, []);
});

test('F05 laid-out domains produce bubbles that do not overlap each other', () => {
  // The clustered tiers draw one bubble around each domain's tables. Overlapping bubbles were the
  // symptom of a layout that never grouped the domains, so the invariant is asserted here.
  const tables: SchemaTable[] = [];
  const sizes = { Billing: 26, Ops: 14, Identity: 6, Catalog: 21, Other: 42 };
  for (const [domain, count] of Object.entries(sizes)) {
    for (let index = 0; index < count; index++) {
      tables.push(table(`${domain.toLowerCase()}_${index}`, { domain,
        allColumns: Array.from({ length: 1 + index % 9 }, (_, c) => ({ name: `c${c}`, type: 'int',
          pk: c === 0, fk: '', nullable: 'False', index: false, unique: false })) }));
    }
  }
  // Chain each domain internally and across, so the link force has something to pull against.
  const links = tables.slice(1).map((entry, index) => fk(entry.id, tables[index].id, 'parent_id', `k${index}`));
  const graph: SchemaGraph = { tables, links };
  const positions = layoutTables(graph, {}, false);
  const { domains } = domainAggregates(tables, relations(graph));
  const boxes = domainBounds(domains, positions);
  assert.equal(boxes.length, Object.keys(sizes).length);
  for (const [index, a] of boxes.entries()) {
    for (const b of boxes.slice(index + 1)) {
      assert.ok(!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y),
        `domain bubbles ${a.id} and ${b.id} overlap`);
    }
  }
});

// --- Grouping and hubs (F05) -------------------------------------------------------------------
// A synthetic schema shaped like the ones that broke the old layout: two tables nearly everything
// refers to, a few real clusters behind them, and names whose prefixes say nothing useful.
const hubSchema = (): SchemaGraph => {
  const tables: SchemaTable[] = [table('owners', { domain: 'Other' }), table('accounts', { domain: 'Other' })];
  const links: SchemaLink[] = [fk('accounts', 'owners', 'owner_id', 'acc_owner')];
  const clusters = { alpha: 6, beta: 5, gamma: 4 };
  for (const [name, size] of Object.entries(clusters)) {
    for (let index = 0; index < size; index++) {
      const id = `${name}_${index}`;
      tables.push(table(id, { domain: index % 2 ? 'Other' : name }));
      links.push(fk(id, 'owners', 'owner_id', `${id}_owner`), fk(id, 'accounts', 'account_id', `${id}_account`));
      if (index) links.push(fk(id, `${name}_0`, 'parent_id', `${id}_parent`));
    }
  }
  // Tables that only hang off a hub, one with two keys into it, and one with no keys at all.
  for (let index = 0; index < 8; index++) links.push(fk(`satellite_${index}`, index < 5 ? 'owners' : 'accounts', 'owner_id', `sat_${index}`));
  for (let index = 0; index < 8; index++) tables.push(table(`satellite_${index}`, { domain: 'Other' }));
  links.push(fk('satellite_0', 'owners', 'approver_id', 'sat_0_approver'));
  tables.push(table('loner', { domain: 'Other' }));
  // A naming guess between two clusters must not merge them.
  links.push({ source: 'beta_1', target: 'gamma_0', column: 'gamma_id', targetColumn: 'id', kind: 'inferred by naming' });
  return { tables, links };
};
const overlapping = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('F05 hubs are the tables a tenth of the schema refers to, counted once per referring table', () => {
  const value = hubSchema();
  assert.ok(value.tables.length >= HUB_MIN_TABLES);
  assert.deepEqual([...hubTables(value.tables, relations(value))], ['accounts', 'owners']);
  // A second key from the same table does not make it count twice, and a self-reference never counts.
  const doubled = { ...value, links: [...value.links, fk('gamma_0', 'gamma_0', 'self_id', 'self'), fk('beta_0', 'gamma_0', 'other_id', 'x1'), fk('beta_0', 'gamma_0', 'third_id', 'x2')] };
  assert.equal(hubTables(doubled.tables, relations(doubled)).has('gamma_0'), false);
  // A small schema has no hubs: every line in it is readable.
  const small = { tables: value.tables.slice(0, HUB_MIN_TABLES - 1), links: value.links };
  assert.equal(hubTables(small.tables, relations(small)).size, 0);
});

test('F05 the default grouping follows the prefixes only while they actually group the schema', () => {
  assert.equal(defaultGroupMode(hubSchema().tables), 'relationships');
  assert.equal(defaultGroupMode(['a', 'b', 'c', 'd'].map(id => table(id, { domain: 'Billing' }))), 'prefix');
  assert.equal(defaultGroupMode([...['a', 'b', 'c'].map(id => table(id, { domain: 'Billing' })), table('d', { domain: '' })]), 'relationships');
  assert.equal(defaultGroupMode([]), 'prefix');
});

test('F05 relationship groups come from declared keys with the hubs set aside', () => {
  const value = hubSchema();
  const hubs = hubTables(value.tables, relations(value));
  const groups = tableGroups(value, 'relationships', hubs);
  assert.equal(groups.size, value.tables.length);
  for (const hub of hubs) assert.equal(groups.get(hub), HUB_GROUP);
  // Each real cluster is one group, named after its most connected member, and the naming guess
  // between beta and gamma did not merge them.
  for (const [name, size] of [['alpha', 6], ['beta', 5], ['gamma', 4]] as const) {
    const ids = Array.from({ length: size }, (_, index) => `${name}_${index}`);
    assert.deepEqual(new Set(ids.map(id => groups.get(id))), new Set([`${name}_0`]), name);
  }
  // Tables whose only keys point at a hub sit with that hub; the one with no keys is unconnected.
  assert.equal(groups.get('satellite_0'), attachedGroup('owners'));
  assert.equal(groups.get('satellite_6'), attachedGroup('accounts'));
  assert.equal(groups.get('loner'), UNCONNECTED_GROUP);
  // The prefix grouping keeps the snapshot's domains, apart from the hubs.
  const prefix = tableGroups(value, 'prefix', hubs);
  assert.equal(prefix.get('owners'), HUB_GROUP);
  assert.equal(prefix.get('alpha_0'), 'alpha');
  assert.equal(prefix.get('alpha_1'), 'Other');
});

test('F05 packed groups never overlap, and the first group named leads', () => {
  const sizes = [{ id: 'wide', width: 5000, height: 300 }, { id: 'a', width: 900, height: 700 },
    { id: 'b', width: 400, height: 1600 }, { id: 'hubs', width: 600, height: 300 }, { id: 'c', width: 300, height: 300 }];
  const boxes = packGroups(sizes, (x, y) => (x === 'a' && y === 'c') || (x === 'c' && y === 'a') ? 5 : 0, 'hubs');
  assert.equal(boxes[0].id, 'hubs');
  assert.deepEqual(boxes.map(box => box.id).sort(), sizes.map(size => size.id).sort());
  for (const [index, a] of boxes.entries()) {
    assert.deepEqual([a.width, a.height], [sizes.find(size => size.id === a.id)!.width, sizes.find(size => size.id === a.id)!.height]);
    for (const b of boxes.slice(index + 1)) assert.ok(!overlapping(a, b), `${a.id} and ${b.id} overlap`);
  }
});

test('F05 group bubbles do not overlap on a hub-heavy schema, in either grouping', () => {
  // The regression: one simulation over every table let the hubs pull their referrers across the
  // canvas, so a fifth of the domain bubbles overlapped on a real schema.
  const value = hubSchema();
  const hubs = hubTables(value.tables, relations(value));
  for (const mode of ['prefix', 'relationships'] as const) {
    const groups = tableGroups(value, mode, hubs);
    const groupOf = (entry: SchemaTable) => groups.get(entry.id)!;
    const positions = layoutTables(value, {}, false, groupOf, HUB_GROUP);
    assert.deepEqual(layoutTables(value, {}, false, groupOf, HUB_GROUP), positions, 'layout is deterministic');
    const boxes = domainBounds(domainAggregates(value.tables, relations(value), groupOf).domains, positions);
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) assert.ok(!overlapping(a, b), `${mode}: ${a.id} and ${b.id} overlap`);
    }
    for (const [index, a] of value.tables.entries()) for (const b of value.tables.slice(index + 1)) {
      assert.ok(!overlapping({ ...positions[a.id], ...nodeSize(a) }, { ...positions[b.id], ...nodeSize(b) }), `${mode}: ${a.id} and ${b.id} overlap`);
    }
  }
});

test('F05 pinned tables keep their place and newly laid-out groups are packed clear of them', () => {
  const value = hubSchema();
  const pinned = { alpha_3: { x: 40, y: 9000, pinned: true } };
  const positions = layoutTables(value, pinned, false);
  assert.deepEqual(positions.alpha_3, pinned.alpha_3);
  const size = nodeSize(value.tables.find(entry => entry.id === 'alpha_3')!);
  for (const entry of value.tables) if (entry.id !== 'alpha_3') {
    assert.ok(!overlapping({ ...positions[entry.id], ...nodeSize(entry) }, { ...pinned.alpha_3, ...size }), entry.id);
  }
});

test('F05 the grouping is saved with the layout and an older layout reads as having none', () => {
  const positions = { a: { x: 1, y: 2, pinned: true } };
  assert.equal(parseGroupMode(serializePositions(positions, 'relationships')), 'relationships');
  assert.deepEqual({ ...parsePositions(serializePositions(positions, 'relationships'), ['a']) }, positions);
  assert.equal(serializePositions(positions), JSON.stringify({ version: 1, positions }));
  assert.equal(parseGroupMode(serializePositions(positions)), undefined);
  assert.equal(parseGroupMode(JSON.stringify({ version: 1, positions, groupBy: 'anything' })), undefined);
  assert.equal(parseGroupMode('not json'), undefined);
});
