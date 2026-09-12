// View-state tests (work package C03, feature F14, CTQ-07).
//
// Three jobs:
//
//   a. graphFingerprint is the fingerprint half of snapshotKey and produces the same string, so
//      the Living ERD layouts saved under the old key are not orphaned (frozen contract);
//   b. keys are isolated per project and per snapshot fingerprint, which is caveat C13 in code:
//      two projects with identical table names, and two snapshots of one project, never read or
//      overwrite each other's slice;
//   c. a stored value is validated before use and every failure mode degrades to no state - never
//      to a fabricated one: absent storage, a throwing accessor, invalid JSON, a wrong version, a
//      value the validator rejects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAVEATS } from './caveat-strings';
import { snapshotKey } from './living-logic';
import {
  VIEW_STATE_KEY_PREFIX,
  clearViewState,
  graphFingerprint,
  parseCityViewState,
  parseDiffViewState,
  parseFanoutViewState,
  parseMapViewState,
  projectScope,
  readViewState,
  viewStateKey,
  writeViewState,
} from './view-state';
import type { SchemaGraph, SchemaTable } from './types';

const table = (id: string): SchemaTable => ({
  id,
  className: id,
  domain: 'Operations',
  type: 'table',
  pk: 'id',
  primaryKey: ['id'],
  allColumns: [{ name: 'id', type: 'int', pk: true, fk: '', nullable: 'False', index: false, unique: false }],
  indexes: [],
  uniques: [],
});

const graph = (key: string, tables: string[] = ['a', 'b']): SchemaGraph => ({
  project: { name: key, key, dialect: 'postgresql' },
  tables: tables.map(table),
  links: [],
});

/** A localStorage stand-in: node has no web storage by default, and these tests need control. */
class Storage {
  readonly items = new Map<string, string>();
  failOn: 'none' | 'get' | 'set' | 'remove' = 'none';
  getItem(key: string): string | null {
    if (this.failOn === 'get') throw new Error('storage unavailable');
    return this.items.has(key) ? this.items.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.failOn === 'set') throw new Error('quota exceeded');
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failOn === 'remove') throw new Error('storage unavailable');
    this.items.delete(key);
  }
}

function withStorage<T>(body: (storage: Storage) => T): T {
  const storage = new Storage();
  const host = globalThis as { localStorage?: unknown };
  const had = Object.prototype.hasOwnProperty.call(host, 'localStorage');
  const previous = host.localStorage;
  host.localStorage = storage;
  try {
    return body(storage);
  } finally {
    if (had) host.localStorage = previous;
    else delete host.localStorage;
  }
}

const anything = (value: unknown): unknown => value;

test('F14 graphFingerprint is the fingerprint snapshotKey already published', () => {
  const cases: SchemaGraph[] = [
    graph('example'),
    { ...graph('example'), source: { hash: 'abc123' } },
    { ...graph('example'), source: { sourceHash: 'def456' } },
    { ...graph('example'), source: { sha256: '0'.repeat(64) } },
    { ...graph('example'), sourceHash: 'graph-level' },
    { project: { name: 'No Key', key: '', dialect: 'sqlite' }, tables: [], links: [] },
    { tables: [table('only')], links: [] },
  ];
  for (const value of cases) {
    assert.equal(snapshotKey(value), `backend-buddy-erd:v1:${projectScope(value)}:${graphFingerprint(value)}`);
    assert.ok(snapshotKey(value).endsWith(`:${graphFingerprint(value)}`));
  }
  // A recorded hash wins over the structural fallback, in the documented order.
  assert.equal(graphFingerprint({ ...graph('example'), source: { hash: 'a', sourceHash: 'b', sha256: 'c' } }), 'a');
  assert.equal(graphFingerprint({ ...graph('example'), source: { sourceHash: 'b', sha256: 'c' } }), 'b');
  // Reordering the same graph does not change the fingerprint.
  const ordered = graph('example', ['a', 'b', 'c']);
  const reversed = { ...ordered, tables: [...ordered.tables].reverse() };
  assert.equal(graphFingerprint(ordered), graphFingerprint(reversed));
  // A colon in a project name cannot break the key apart.
  assert.equal(projectScope({ project: { name: 'a:b', key: '', dialect: 'x' }, tables: [], links: [] }), 'a%3Ab');
});

test('CTQ-07 a view-state key is scoped by project, fingerprint and view (C13)', () => {
  const one = graph('project-one');
  const other = graph('project-two');
  assert.equal(viewStateKey(one, 'city'), `${VIEW_STATE_KEY_PREFIX}project-one:${graphFingerprint(one)}:city`);
  assert.notEqual(viewStateKey(one, 'city'), viewStateKey(other, 'city'));
  assert.notEqual(viewStateKey(one, 'city'), viewStateKey(one, 'living'));
  const later = { ...one, source: { hash: 'later-snapshot' } };
  assert.notEqual(viewStateKey(one, 'city'), viewStateKey(later, 'city'));
  // The three key families stay distinct, so nothing reads another family's value.
  assert.ok(viewStateKey(one, 'city').startsWith('backend-buddy:view-state:v1:'));
  assert.ok(!viewStateKey(one, 'city').startsWith('backend-buddy-erd:v1:'));
  assert.ok(CAVEATS.C13.text.includes('snapshot fingerprint'));
});

test('CTQ-07 two projects and two snapshots never read each other s slice', () => {
  withStorage(storage => {
    const one = graph('project-one');
    const other = graph('project-two');
    const later = { ...one, source: { hash: 'later-snapshot' } };
    assert.equal(writeViewState(one, 'city', { mode: 'flat', districts: 'business' }), true);
    assert.equal(writeViewState(other, 'city', { mode: '3d', districts: 'discovered' }), true);
    assert.equal(storage.items.size, 2);
    assert.deepEqual(readViewState(one, 'city', parseCityViewState), { mode: 'flat', districts: 'business' });
    assert.deepEqual(readViewState(other, 'city', parseCityViewState), { mode: '3d', districts: 'discovered' });
    assert.equal(readViewState(later, 'city', parseCityViewState), null);
    assert.equal(readViewState(one, 'living', anything), null);
    assert.equal(clearViewState(one, 'city'), true);
    assert.equal(readViewState(one, 'city', parseCityViewState), null);
    assert.deepEqual(readViewState(other, 'city', parseCityViewState), { mode: '3d', districts: 'discovered' });
  });
});

test('CTQ-07 an unreadable, unparseable or rejected slice is ignored, never defaulted', () => {
  withStorage(storage => {
    const value = graph('project-one');
    const key = viewStateKey(value, 'city');
    storage.items.set(key, 'not json at all');
    assert.equal(readViewState(value, 'city', parseCityViewState), null);
    storage.items.set(key, JSON.stringify({ version: 2, value: { mode: 'flat', districts: 'business' } }));
    assert.equal(readViewState(value, 'city', parseCityViewState), null);
    storage.items.set(key, JSON.stringify({ version: 1, value: { mode: 'hologram', districts: 'business' } }));
    assert.equal(readViewState(value, 'city', parseCityViewState), null);
    storage.items.set(key, JSON.stringify({ version: 1, value: null }));
    assert.equal(readViewState(value, 'city', parseCityViewState), null);
    storage.failOn = 'get';
    assert.equal(readViewState(value, 'city', parseCityViewState), null);
    storage.failOn = 'set';
    assert.equal(writeViewState(value, 'city', { mode: 'flat', districts: 'business' }), false);
    storage.failOn = 'remove';
    assert.equal(clearViewState(value, 'city'), false);
  });
  // No storage object at all: the read is still a null, not a throw.
  const host = globalThis as { localStorage?: unknown };
  const had = Object.prototype.hasOwnProperty.call(host, 'localStorage');
  if (!had) assert.equal(readViewState(graph('project-one'), 'city', anything), null);
});

test('CTQ-07 the MVP slices validate their bounds before a view can use them', () => {
  assert.deepEqual(parseCityViewState({ mode: 'flat', districts: 'discovered' }), { mode: 'flat', districts: 'discovered' });
  assert.deepEqual(
    parseCityViewState({ mode: '3d', districts: 'business', camera: { position: [1, 2, 3], target: [0, 0, 0] } }),
    { mode: '3d', districts: 'business', camera: { position: [1, 2, 3], target: [0, 0, 0] } },
  );
  // A camera that fails validation is dropped; the mode it came with is still usable.
  assert.deepEqual(
    parseCityViewState({ mode: '3d', districts: 'business', camera: { position: [1, 2, Infinity], target: [0, 0, 0] } }),
    { mode: '3d', districts: 'business' },
  );
  assert.equal(parseCityViewState({ mode: '3d' }), null);
  assert.equal(parseCityViewState([]), null);
  assert.equal(parseCityViewState('flat'), null);

  assert.deepEqual(parseMapViewState({ pan: { x: -12.5, y: 3 }, zoom: 1.4 }), { pan: { x: -12.5, y: 3 }, zoom: 1.4 });
  assert.equal(parseMapViewState({ pan: { x: 1e9, y: 0 }, zoom: 1 }), null);
  assert.equal(parseMapViewState({ pan: { x: 0, y: 0 }, zoom: 0 }), null);
  assert.equal(parseMapViewState({ pan: { x: 0, y: Number.NaN }, zoom: 1 }), null);

  assert.deepEqual(parseDiffViewState({ a: 'abc123', b: 'def456' }), { a: 'abc123', b: 'def456' });
  assert.deepEqual(parseDiffViewState({ a: 'abc123' }), { a: 'abc123' });
  assert.equal(parseDiffViewState({ a: 'x'.repeat(257) }), null);
  assert.equal(parseDiffViewState({ a: { tables: [] } }), null);

  assert.deepEqual(parseFanoutViewState({ collapsed: ['a.b', 'c.d'] }), { collapsed: ['a.b', 'c.d'] });
  assert.deepEqual(parseFanoutViewState({ collapsed: ['a.b', 7, '', null] }), { collapsed: ['a.b'] });
  assert.equal(parseFanoutViewState({ collapsed: 'a.b' }), null);
});
