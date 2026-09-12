// Navigation registry tests (work package C03, feature F14, CTQ-06, CTQ-10).
//
// The registry is what W02's inspector menu, W04's context menus and the generated end-to-end
// matrix all read, so this suite pins the table itself:
//
//   a. exactly ten entries, P1-P10, with the from/to pairs of drill-through-contract.md section 6;
//   b. every v.* name a producer emits is allowlisted for the target it emits it for, and every
//      declared name is allowlisted for at least one of the entry's targets - a name the route
//      grammar would drop is a registry bug, not a runtime surprise;
//   c. resolve returns a target whose selection has been validated against the graph, and throws
//      rather than guessing when an id or a target is not in the registry;
//   d. P2 and P10 are marked prefill only (CTQ-06), and the entries that carry a caveat name an id
//      that resolves in caveat-strings.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CAVEAT_IDS, CAVEATS } from './caveat-strings';
import { VIEW_STATE_ALLOWLIST } from './route-state';
import { columnId, relationshipRef, type Selection } from './selection';
import { accepts, caveatFor, declaredViewStateKeys, entries, entry, resolve, targetsFor, type NavigationEntry } from './navigation';
import type { SchemaGraph } from './types';

const medium = JSON.parse(
  readFileSync(new URL('../../../fixtures/schemas/medium.json', import.meta.url), 'utf8'),
) as SchemaGraph;

/** The from/to pairs of section 6. `to` is the first target the contract lists for the entry. */
const CONTRACT: Record<string, { from: string; to: string; toAll: string[] }> = {
  P1: { from: 'inspector', to: 'fanout', toAll: ['fanout', 'living', 'city', 'columns', 'matrix', 'arcs', 'map', 'keys', 'review'] },
  P2: { from: 'matrix', to: 'fanout', toAll: ['fanout'] },
  P3: { from: 'city', to: 'living', toAll: ['living', 'fanout', 'columns'] },
  P4: { from: 'lens', to: 'columns', toAll: ['columns', 'review'] },
  P5: { from: 'arcs', to: 'living', toAll: ['living'] },
  P6: { from: 'domains', to: 'city', toAll: ['city', 'living'] },
  P7: { from: 'diff', to: 'columns', toAll: ['columns', 'diff'] },
  P8: { from: 'review', to: 'columns', toAll: ['columns', 'living', 'fanout'] },
  P9: { from: 'fanout', to: 'fanout', toAll: ['fanout', 'columns'] },
  P10: { from: 'columns', to: 'living', toAll: ['living', 'fanout'] },
};

const link = medium.links.find(candidate => candidate.constraintId)!;
const table = medium.tables.find(candidate => candidate.id === link.source)!;
const other = medium.tables.find(candidate => candidate.id !== table.id)!;

function silently<T>(body: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return body();
  } finally {
    console.warn = original;
  }
}

/**
 * A selection that satisfies one entry's `requires` and carries everything else it consumes, so no
 * entry is skipped for lack of input. `tableId` and `tableIds` are mutually exclusive, so the
 * shape the entry needs decides which one is set.
 */
function selectionFor(item: NavigationEntry): Selection {
  const value: Selection = item.requires.includes('tables')
    ? { tableIds: [link.source, link.target] }
    : { tableId: link.source };
  if (item.carries.includes('column')) value.columnId = columnId(table.id, table.allColumns[0].name);
  if (item.carries.includes('relationship')) value.relationshipRef = relationshipRef(link);
  if (item.carries.includes('finding')) value.findingId = 'opaque-finding-id';
  return value;
}

test('F14 the registry holds exactly P1-P10 with the contract from/to pairs', () => {
  const ids = entries.map(item => item.id);
  assert.deepEqual([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), Object.keys(CONTRACT));
  assert.equal(new Set(ids).size, ids.length);
  for (const item of entries) {
    const expected = CONTRACT[item.id];
    assert.equal(item.from, expected.from, `${item.id} from`);
    assert.equal(item.to, expected.to, `${item.id} to`);
    assert.deepEqual([...item.toAll], expected.toAll, `${item.id} toAll`);
    assert.equal(item.toAll[0], item.to, `${item.id} to should be the first of toAll`);
    assert.ok(item.label.length > 0, `${item.id} needs menu text`);
    assert.ok(item.requires.length > 0, `${item.id} needs a required selection shape`);
    for (const shape of item.requires) assert.ok(item.carries.includes(shape), `${item.id} must carry what it requires`);
  }
  assert.equal(entry('P11'), undefined);
});

test('F14 every v.* name the registry writes is allowlisted for the view it is written to', () => {
  for (const item of entries) {
    for (const name of item.viewStateKeys) {
      assert.ok(
        item.toAll.some(view => VIEW_STATE_ALLOWLIST[view].includes(name)),
        `${item.id} declares v.${name}, which no target of ${item.toAll.join('/')} allowlists`,
      );
    }
    for (const view of item.toAll) {
      const produced = item.viewState(selectionFor(item), view);
      for (const name of Object.keys(produced)) {
        assert.ok(item.viewStateKeys.includes(name), `${item.id} produced an undeclared v.${name}`);
        assert.ok(VIEW_STATE_ALLOWLIST[view].includes(name), `${item.id} produced v.${name} for ${view}`);
        assert.ok(produced[name].length > 0, `${item.id} produced an empty v.${name}`);
      }
    }
  }
  // The cross-check helper reports the same set, per view.
  assert.deepEqual(declaredViewStateKeys('fanout'), ['pk', 'root']);
  assert.deepEqual(declaredViewStateKeys('city'), ['districts']);
  assert.deepEqual(declaredViewStateKeys('insights'), []);
});

test('F14 targetsFor offers only the entries a surface owns and the selection satisfies', () => {
  assert.deepEqual(targetsFor({ tableId: table.id }, 'inspector').map(item => item.id), ['P1']);
  assert.deepEqual(targetsFor({ tableId: table.id }, 'matrix'), []);
  assert.deepEqual(targetsFor({ tableIds: [table.id, other.id] }, 'matrix').map(item => item.id), ['P2']);
  assert.deepEqual(targetsFor({}, 'city'), []);
  assert.deepEqual(targetsFor({ tableId: table.id }, 'city').map(item => item.id), ['P3']);
  assert.deepEqual(targetsFor({ tableId: table.id, tableIds: [other.id] }, 'insights'), []);
  for (const item of entries) {
    assert.equal(accepts(item, selectionFor(item)), true, `${item.id} should accept the selection it asks for`);
    assert.equal(accepts(item, {}), false, `${item.id} should reject an empty selection`);
  }
});

test('F14 resolve validates the selection against the graph and names the entry as its reason', () => {
  const target = resolve('P3', { tableId: table.id }, medium);
  assert.deepEqual(target, {
    view: 'living',
    reason: 'P3',
    selection: { tableId: table.id, origin: 'city' },
    viewState: { focus: table.id },
  });
  // An explicit target must be one the entry offers.
  assert.deepEqual(resolve('P3', { tableId: table.id }, medium, 'fanout').viewState, { root: table.id });
  assert.equal(resolve('P3', { tableId: table.id }, medium, 'columns').viewState, undefined);
  // The inspector is not a view, so it leaves origin alone; an existing origin is kept.
  assert.equal(resolve('P1', { tableId: table.id }, medium).selection?.origin, undefined);
  assert.equal(resolve('P3', { tableId: table.id, origin: 'matrix' }, medium).selection?.origin, 'matrix');
  // Ids the graph does not resolve never reach a target.
  const dropped = silently(() => resolve('P3', { tableId: 'absent.table' }, medium));
  assert.deepEqual(dropped, { view: 'living', reason: 'P3' });
  assert.throws(() => resolve('P11', { tableId: table.id }, medium), /unknown entry P11/);
  assert.throws(() => resolve('P3', { tableId: table.id }, medium, 'diff'), /does not open diff/);
  for (const item of entries) {
    const selection = selectionFor(item);
    for (const view of item.toAll) {
      const resolved = resolve(item.id, selection, medium, view);
      assert.equal(resolved.view, view);
      assert.equal(resolved.reason, item.id);
      assert.equal(resolved.selection?.tableId, selection.tableId);
      assert.deepEqual(resolved.selection?.tableIds, selection.tableIds);
      for (const name of Object.keys(resolved.viewState || {})) {
        assert.ok(item.viewStateKeys.includes(name), `${item.id} resolved an undeclared v.${name}`);
      }
    }
  }
});

test('CTQ-06 P2 and P10 are prefill only and no entry performs a live action', () => {
  const prefill = entries.filter(item => item.prefillOnly).map(item => item.id);
  assert.deepEqual(prefill, ['P2', 'P10']);
  assert.ok(entries.find(item => item.id === 'P2')!.viewStateKeys.includes('root'));
  assert.ok(entries.find(item => item.id === 'P10')!.viewStateKeys.includes('pk'));
  // No module of the navigation contract reaches for a live connection.
  for (const module of ['selection', 'route-state', 'view-state', 'navigation', 'mount-policy']) {
    const source = readFileSync(new URL(`./${module}.ts`, import.meta.url), 'utf8');
    assert.equal(source.includes('live.'), false, `${module}.ts must not call a live connection`);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${module}.ts must not fetch`);
  }
});

test('CTQ-13 an entry that carries a caveat takes the wording from caveat-strings.ts', () => {
  for (const item of entries) {
    if (!item.caveat) {
      assert.equal(caveatFor(item.id), undefined);
      continue;
    }
    assert.ok(CAVEAT_IDS.includes(item.caveat), `${item.id} names an unknown caveat`);
    assert.equal(caveatFor(item.id), CAVEATS[item.caveat].text);
    // The menu text is not a restatement of the caveat.
    assert.notEqual(item.label, CAVEATS[item.caveat].text);
  }
  assert.equal(entries.find(item => item.id === 'P6')!.caveat, 'C03');
  assert.equal(caveatFor('P11'), undefined);
});
