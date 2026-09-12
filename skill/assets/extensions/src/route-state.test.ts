// Route-state tests (work package C03, feature F14, CTQ-07, CTQ-10).
//
// The route grammar is the frozen contract of docs/architecture/drill-through-contract.md
// section 4, so these tests pin it rather than describe it:
//
//   a. the eight global keys and the per-view v.* allowlist are exactly the table in section 4;
//   b. parse and serialize round-trip the fixture ids, including dotted table ids, a composite
//      constraint id and the source.column>target.targetColumn fallback;
//   c. serialization is canonical: fixed key order, v.* sorted, byte-identical for equal states;
//   d. hostile input is dropped, not accepted or half-accepted: an undeclared v.* name, a value
//      over 200 characters, a key outside the grammar, a repeated key, an undecodable escape, and
//      an id the loaded graph does not resolve;
//   e. switching view keeps the global keys and drops the v.* names the new view does not declare.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { columnId, relationshipRef, type ViewId } from './selection';
import {
  MAX_VALUE_LENGTH,
  ROUTE_KEYS,
  VIEW_STATE_ALLOWLIST,
  filterViewState,
  fromHash,
  parseRouteState,
  patchViewState,
  serializeRouteState,
  toHash,
  type RouteState,
} from './route-state';
import type { SchemaGraph } from './types';

const fixture = (name: string): SchemaGraph =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/schemas/${name}.json`, import.meta.url), 'utf8')) as SchemaGraph;

const small = fixture('small');
const medium = fixture('medium');

function silently<T>(body: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return body();
  } finally {
    console.warn = original;
  }
}

function warningsOf(body: () => unknown): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    body();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('CTQ-07 the global keys and the per-view v.* allowlist are the frozen section 4 table', () => {
  assert.deepEqual([...ROUTE_KEYS], ['t', 'c', 'r', 'ts', 'f', 'q', 'd', 'k']);
  assert.deepEqual(Object.fromEntries(Object.entries(VIEW_STATE_ALLOWLIST).map(([view, names]) => [view, [...names]])), {
    map: ['zoom', 'focus', 'link'],
    entities: ['sort', 'compare'],
    keys: ['kind'],
    review: ['rule', 'category', 'status'],
    fanout: ['root', 'depth', 'pk'],
    columns: ['family', 'only', 'page'],
    city: ['mode', 'districts'],
    living: ['junctions', 'focus'],
    lens: ['flagged', 'page', 'size'],
    domains: ['community', 'page'],
    matrix: ['order', 'related'],
    arcs: ['cycle'],
    diff: ['dialect', 'side'],
    insights: ['kind'],
  });
  assert.equal(MAX_VALUE_LENGTH, 200);
  assert.throws(() => parseRouteState('t=a', 'nope' as ViewId), /unknown view id/);
});

test('CTQ-07 a state round-trips through the query string, including dotted and composite ids', () => {
  const table = medium.tables.find(candidate => candidate.allColumns.length > 0);
  assert.ok(table);
  const composite = medium.links.find(link => link.constraintId);
  const inferred = medium.links.find(link => !link.constraintId);
  assert.ok(composite);
  assert.ok(inferred);
  for (const link of [composite, inferred]) {
    const state: RouteState = {
      selection: {
        tableId: table.id,
        columnId: columnId(table.id, table.allColumns[0].name),
        relationshipRef: relationshipRef(link),
        findingId: `${table.id}|orphan-candidate|${table.allColumns[0].name}`,
      },
      query: 'order',
      domain: table.domain,
      entityType: table.type,
      viewState: { family: 'keys', page: '3' },
    };
    const serialized = serializeRouteState(state);
    const parsed = parseRouteState(serialized, 'columns', medium);
    assert.deepEqual(parsed, state);
    assert.equal(serializeRouteState(parsed), serialized);
  }
});

test('CTQ-07 a multi-selection round-trips as a comma-separated list, deduplicated', () => {
  const ids = medium.tables.slice(0, 4).map(table => table.id);
  const serialized = serializeRouteState({ selection: { tableIds: ids }, viewState: {} });
  assert.equal(serialized, `ts=${ids.map(encodeURIComponent).join(',')}`);
  assert.deepEqual(parseRouteState(serialized, 'matrix', medium).selection.tableIds, ids);
  // A comma inside a member is percent-encoded, so the split back is unambiguous.
  const comma = serializeRouteState({ selection: { tableIds: ['a,b', 'c'] }, viewState: {} });
  assert.equal(comma, 'ts=a%2Cb,c');
  assert.deepEqual(parseRouteState(comma, 'matrix').selection.tableIds, ['a,b', 'c']);
  assert.deepEqual(parseRouteState(`ts=${ids[0]},${ids[0]}`, 'matrix', medium).selection.tableIds, [ids[0]]);
});

test('CTQ-07 serialization is canonical: fixed key order, v.* sorted, byte-identical for equal states', () => {
  const state: RouteState = {
    selection: { tableId: 't1', columnId: 't1#c', relationshipRef: 'r1', tableIds: ['t1', 't2'], findingId: 'f1' },
    query: 'q1',
    domain: 'd1',
    entityType: 'k1',
    viewState: { page: '2', family: 'keys', only: 'pk' },
  };
  assert.equal(
    serializeRouteState(state),
    't=t1&c=t1%23c&r=r1&ts=t1,t2&f=f1&q=q1&d=d1&k=k1&v.family=keys&v.only=pk&v.page=2',
  );
  const reordered: RouteState = {
    viewState: { only: 'pk', family: 'keys', page: '2' },
    entityType: 'k1',
    domain: 'd1',
    query: 'q1',
    selection: { findingId: 'f1', tableIds: ['t1', 't2'], relationshipRef: 'r1', columnId: 't1#c', tableId: 't1' },
  };
  assert.equal(serializeRouteState(reordered), serializeRouteState(state));
  assert.equal(serializeRouteState({ selection: {}, viewState: {} }), '');
  assert.equal(serializeRouteState({ selection: { tableId: '' }, query: '', viewState: { page: '' } }), '');
  // Selection.origin belongs to the running session, not to a shared link.
  assert.equal(serializeRouteState({ selection: { tableId: 't1', origin: 'city' }, viewState: {} }), 't=t1');
});

test('CTQ-07 the artifact hash form uses the same grammar', () => {
  const state: RouteState = { selection: { tableId: small.tables[0].id }, viewState: { mode: 'flat' } };
  const hash = toHash(state);
  assert.equal(hash, `#t=${encodeURIComponent(small.tables[0].id)}&v.mode=flat`);
  assert.deepEqual(fromHash(hash, 'city', small), state);
  assert.deepEqual(fromHash('', 'city', small), { selection: {}, viewState: {} });
  assert.equal(toHash({ selection: {}, viewState: {} }), '');
  // A leading ? or # is optional on the way in.
  assert.deepEqual(parseRouteState('?t=' + small.tables[0].id, 'city', small).selection.tableId, small.tables[0].id);
});

test('CTQ-07 an undeclared v.* name is dropped with a warning that names the key only', () => {
  const warnings = warningsOf(() => {
    const parsed = parseRouteState('v.mode=flat&v.root=secret.table&v.districts=discovered', 'city', small);
    assert.deepEqual(parsed.viewState, { mode: 'flat', districts: 'discovered' });
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('v.root'));
  assert.ok(!warnings[0].includes('secret.table'));
  assert.deepEqual(silently(() => filterViewState('city', { mode: 'flat', junctions: 'show' })), { mode: 'flat' });
});

test('CTQ-07 a value over the 200-character cap is dropped, on the way in and on the way out', () => {
  const long = 'x'.repeat(MAX_VALUE_LENGTH + 1);
  const atCap = 'y'.repeat(MAX_VALUE_LENGTH);
  const parsed = silently(() => parseRouteState(`q=${long}&d=${atCap}&v.page=${long}`, 'columns'));
  assert.equal(parsed.query, undefined);
  assert.equal(parsed.domain, atCap);
  assert.deepEqual(parsed.viewState, {});
  const members = silently(() => parseRouteState(`ts=${long},ok.table`, 'matrix'));
  assert.deepEqual(members.selection.tableIds, ['ok.table']);
  // Serialization refuses to emit half an id.
  assert.equal(silently(() => serializeRouteState({ selection: { tableId: long }, viewState: {} })), '');
  assert.equal(
    silently(() => serializeRouteState({ selection: { tableIds: [long, 'ok.table'] }, viewState: {} })),
    'ts=ok.table',
  );
  const capWarnings = warningsOf(() => parseRouteState(`q=${long}`, 'columns'));
  assert.equal(capWarnings.length, 1);
  assert.ok(capWarnings[0].includes('q') && !capWarnings[0].includes(long));
});

test('CTQ-07 keys outside the grammar, repeats and undecodable escapes are dropped', () => {
  const warnings = warningsOf(() => {
    const parsed = parseRouteState('t=a.b&t=c.d&zz=1&f=%E0%A4%A&q=ok&=&x', 'columns');
    assert.equal(parsed.selection.tableId, 'a.b');
    assert.equal(parsed.selection.findingId, undefined);
    assert.equal(parsed.query, 'ok');
  });
  assert.equal(warnings.filter(line => line.includes('repeated key')).length, 1);
  // `zz`, the empty key from `=`, and the bare `x`.
  assert.equal(warnings.filter(line => line.includes('not part of the route grammar')).length, 3);
  assert.equal(warnings.filter(line => line.includes('not decodable')).length, 1);
});

test('CTQ-07 ids are validated against the loaded graph and dropped when unknown', () => {
  const table = small.tables[0];
  const link = small.links[0];
  const good = `t=${encodeURIComponent(table.id)}&r=${encodeURIComponent(relationshipRef(link))}`;
  assert.deepEqual(parseRouteState(good, 'map', small).selection, { tableId: table.id, relationshipRef: relationshipRef(link) });
  const dropped = silently(() => parseRouteState('t=absent.table&c=absent.table%23id&r=fk_absent', 'map', small));
  assert.deepEqual(dropped.selection, {});
  // Without a graph the ids pass through, so a shell can parse before its snapshot has loaded.
  assert.deepEqual(parseRouteState('t=absent.table', 'map').selection, { tableId: 'absent.table' });
});

test('CTQ-10 the global keys survive a view change and the v.* slice does not', () => {
  const search = 't=a.b&q=order&v.mode=flat&v.districts=discovered';
  const city = silently(() => parseRouteState(search, 'city'));
  assert.deepEqual(city.viewState, { mode: 'flat', districts: 'discovered' });
  const living = silently(() => parseRouteState(search, 'living'));
  assert.equal(living.selection.tableId, 'a.b');
  assert.equal(living.query, 'order');
  assert.deepEqual(living.viewState, {});
  assert.deepEqual(silently(() => filterViewState('living', city.viewState)), {});
});

test('CTQ-10 a view-state patch adds, replaces and removes names within the allowlist', () => {
  assert.deepEqual(patchViewState('city', { mode: '3d' }, { districts: 'discovered' }), { mode: '3d', districts: 'discovered' });
  assert.deepEqual(patchViewState('city', { mode: '3d' }, { mode: 'flat' }), { mode: 'flat' });
  assert.deepEqual(patchViewState('city', { mode: '3d', districts: 'business' }, { mode: undefined }), { districts: 'business' });
  assert.deepEqual(patchViewState('city', { mode: '3d' }, { mode: '' }), {});
  assert.deepEqual(silently(() => patchViewState('city', {}, { root: 'a.b' })), {});
});
