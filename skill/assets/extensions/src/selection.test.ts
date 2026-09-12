// Selection model tests (work package C03, feature F14, CTQ-07).
//
// Two jobs:
//
//   a. the id forms of docs/architecture/schema-graph-contract.md B3 are built and parsed exactly
//      as that table writes them, and they survive identifiers that contain the separators - the
//      hostile fixture ships a table id containing `>`;
//   b. validateSelection is the gate an untrusted deep link passes through: an id the loaded graph
//      does not resolve is dropped with a warning that names the field and not the value, and the
//      "exactly one of tableId/tableIds" rule is enforced rather than assumed.
//
// Ids come from the synthetic fixtures only, never from a real schema (RK-01).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  VIEW_IDS,
  columnId,
  decodeIdComponent,
  encodeIdComponent,
  isEmptySelection,
  isViewId,
  parseColumnId,
  relationshipRef,
  relationshipTables,
  resolveRelationshipRef,
  selectionShapes,
  validateSelection,
} from './selection';
import type { SchemaGraph, SchemaLink } from './types';

const fixture = (name: string): SchemaGraph =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/schemas/${name}.json`, import.meta.url), 'utf8')) as SchemaGraph;

const small = fixture('small');
const medium = fixture('medium');
const hostile = fixture('hostile');

/** Runs `body` with console.warn captured, and returns everything it wrote. */
function withWarnings<T>(body: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { result: body(), warnings };
  } finally {
    console.warn = original;
  }
}

test('F14 the view-id union covers the nine bundle views, the four host views and insights', () => {
  assert.equal(VIEW_IDS.length, 14);
  assert.equal(new Set(VIEW_IDS).size, 14);
  for (const id of ['map', 'entities', 'keys', 'review', 'fanout', 'columns', 'city', 'living', 'lens', 'domains', 'matrix', 'arcs', 'diff', 'insights']) {
    assert.ok(isViewId(id), `${id} should be a view id`);
  }
  assert.equal(isViewId('inspector'), false);
  assert.equal(isViewId(undefined), false);
});

test('F14 a column id is table.id#column and round-trips a dotted id', () => {
  const table = small.tables[0];
  const column = table.allColumns[0].name;
  assert.equal(columnId(table.id, column), `${table.id}#${column}`);
  assert.deepEqual(parseColumnId(columnId(table.id, column)), { tableId: table.id, column });
  assert.equal(parseColumnId(`${table.id}#missing#extra`), null);
  assert.equal(parseColumnId(table.id), null);
  assert.equal(parseColumnId(`#${column}`), null);
});

test('CTQ-07 separator characters inside an identifier survive the composite id forms', () => {
  for (const raw of ['plain', 'a.b', 'has>angle', 'has#hash', 'has,comma', 'has%percent', 'all%23of>them,#now']) {
    assert.equal(decodeIdComponent(encodeIdComponent(raw)), raw);
  }
  // hostile.json ships a table id containing `>`; a column id built from it must still split.
  const angled = hostile.tables.find(table => table.id.includes('>'));
  assert.ok(angled, 'hostile fixture should carry a table id containing an angle bracket');
  const parsed = parseColumnId(columnId(angled.id, 'id'));
  assert.deepEqual(parsed, { tableId: angled.id, column: 'id' });
  // A component that escapes to a separator is not read as one.
  assert.deepEqual(parseColumnId(columnId('a#b', 'c#d')), { tableId: 'a#b', column: 'c#d' });
});

test('F14 a relationship ref is the constraint id, else source.column>target.targetColumn', () => {
  const declared = medium.links.find(link => link.constraintId);
  assert.ok(declared);
  assert.equal(relationshipRef(declared), declared.constraintId);
  const inferred = medium.links.find(link => !link.constraintId);
  assert.ok(inferred);
  assert.equal(relationshipRef(inferred), `${inferred.source}.${inferred.column}>${inferred.target}.${inferred.targetColumn}`);
});

test('C11 a composite foreign key shares one ref and resolves to every column pair', () => {
  const counts = new Map<string, SchemaLink[]>();
  for (const link of medium.links) {
    const ref = relationshipRef(link);
    counts.set(ref, [...(counts.get(ref) || []), link]);
  }
  const composite = [...counts.entries()].find(([, links]) => links.length > 1);
  assert.ok(composite, 'the medium fixture should carry a composite foreign key');
  const [ref, links] = composite;
  assert.deepEqual(resolveRelationshipRef(ref, medium), links);
  assert.deepEqual(relationshipTables(ref, medium), [links[0].source, links[0].target]);
  assert.deepEqual(resolveRelationshipRef('no-such-constraint', medium), []);
  assert.deepEqual(resolveRelationshipRef('', medium), []);
});

test('CTQ-07 validateSelection drops ids the loaded graph does not resolve', () => {
  const table = small.tables.find(candidate => candidate.allColumns.length > 0);
  assert.ok(table);
  const column = table.allColumns[0].name;
  const known = { tableId: table.id, columnId: columnId(table.id, column), origin: 'matrix' as const };
  assert.deepEqual(validateSelection(known, small), known);

  const { result, warnings } = withWarnings(() => validateSelection({
    tableId: 'nope.absent',
    columnId: columnId(table.id, 'not_a_column'),
    relationshipRef: 'fk_does_not_exist',
    findingId: 'opaque|finding|id',
  }, small));
  assert.deepEqual(result, { findingId: 'opaque|finding|id' });
  assert.equal(warnings.length, 3);
  for (const key of ['t', 'c', 'r']) {
    assert.ok(warnings.some(line => line.includes(`dropped ${key} `)), `expected a warning for ${key}`);
  }
  // The warning names the field, never the value that arrived (security checklist).
  for (const line of warnings) assert.ok(!line.includes('nope.absent') && !line.includes('fk_does_not_exist'));
});

test('CTQ-07 exactly one of tableId and tableIds survives, and a column implies its table', () => {
  const [first, second] = small.tables;
  const both = withWarnings(() => validateSelection({ tableId: first.id, tableIds: [second.id] }, small));
  assert.deepEqual(both.result, { tableIds: [second.id] });
  assert.equal(both.warnings.length, 1);
  assert.ok(both.warnings[0].includes('dropped t '));

  const implied = validateSelection({ columnId: columnId(first.id, first.allColumns[0].name) }, small);
  assert.equal(implied.tableId, first.id);

  const partial = withWarnings(() => validateSelection({ tableIds: [first.id, 'absent.table'] }, small));
  assert.deepEqual(partial.result, { tableIds: [first.id] });
  assert.equal(partial.warnings.length, 1);

  const badOrigin = withWarnings(() => validateSelection({ tableId: first.id, origin: 'inspector' as never }, small));
  assert.deepEqual(badOrigin.result, { tableId: first.id });
  assert.ok(badOrigin.warnings[0].includes('dropped origin '));

  assert.deepEqual(validateSelection(undefined, small), {});
  assert.equal(isEmptySelection(validateSelection(undefined, small)), true);
  assert.equal(isEmptySelection({ findingId: 'f' }), false);
});

test('F14 selectionShapes reports what a selection carries, for the registry requires check', () => {
  assert.deepEqual(selectionShapes({}), []);
  assert.deepEqual(selectionShapes({ tableIds: [] }), []);
  assert.deepEqual(
    selectionShapes({ tableId: 'a', tableIds: ['b'], columnId: 'a#c', relationshipRef: 'r', findingId: 'f' }),
    ['table', 'tables', 'column', 'relationship', 'finding'],
  );
});
