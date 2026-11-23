import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { coversLookup, nullGuardColumns, partialCondition } from './index-coverage';

const columns = ['parent_id', 'tenant_id', 'deleted_at', 'Mixed Case', 'note'];

// [filter, columns it guards or null]. Shared by the unit test and the host-page parity test.
const CASES: Array<[string | undefined, string[] | null]> = [
  ['(parent_id IS NOT NULL)', ['parent_id']],
  ['parent_id is not null', ['parent_id']],
  ['((parent_id IS NOT NULL))', ['parent_id']],
  ['  (PARENT_ID   IS NOT NULL)  ', ['parent_id']],
  ['((parent_id IS NOT NULL) AND (tenant_id IS NOT NULL))', ['parent_id', 'tenant_id']],
  ['parent_id IS NOT NULL AND parent_id IS NOT NULL', ['parent_id']],
  ['("Mixed Case" IS NOT NULL)', ['Mixed Case']],
  ['[parent_id] IS NOT NULL', ['parent_id']],
  ['`parent_id` IS NOT NULL', ['parent_id']],
  // Quoted names match exactly; an unknown column never resolves.
  ['("PARENT_ID" IS NOT NULL)', null],
  ['(missing_id IS NOT NULL)', null],
  // Anything beyond a non-null requirement keeps the index partial.
  ['(deleted_at IS NULL)', null],
  ['((parent_id IS NOT NULL) OR (tenant_id IS NOT NULL))', null],
  ['((parent_id IS NOT NULL) AND (deleted_at IS NULL))', null],
  ["(note = 'a AND b IS NOT NULL')", null],
  ["((parent_id IS NOT NULL) AND (note <> ' AND '))", null],
  ['(NOT (parent_id IS NULL))', null],
  ['(parent_id IS NOT NULL', null],
  ['parent_id IS NOT NULL)', null],
  ['', null],
  [undefined, null],
];

test('F03 a partial index filter is a null guard only when it requires known columns to be non-null and nothing else', () => {
  for (const [predicate, expected] of CASES) assert.deepEqual(nullGuardColumns(predicate, columns), expected, String(predicate));
});

test('F03 a null-guarded partial index covers lookups by the guarded leading columns only', () => {
  const guarded = { columns: ['parent_id', 'tenant_id'], partial: true, predicate: '(parent_id IS NOT NULL)' };
  assert.equal(coversLookup(guarded, ['parent_id'], columns), true);
  assert.equal(coversLookup(guarded, ['parent_id', 'tenant_id'], columns), true);
  assert.equal(coversLookup(guarded, ['tenant_id'], columns), false, 'not leading');
  // A guard on a column the lookup does not constrain does not follow from the lookup.
  const other = { columns: ['parent_id'], partial: true, predicate: '(tenant_id IS NOT NULL)' };
  assert.equal(coversLookup(other, ['parent_id'], columns), false);
  assert.equal(coversLookup({ columns: ['parent_id'], partial: true, predicate: '(deleted_at IS NULL)' }, ['parent_id'], columns), false);
  assert.equal(coversLookup({ columns: ['parent_id'], partial: true }, ['parent_id'], columns), false, 'filter not recorded');
  // A predicate without the flag still counts as partial; expressions never cover.
  assert.equal(coversLookup({ columns: ['parent_id'], predicate: '(deleted_at IS NULL)' }, ['parent_id'], columns), false);
  assert.equal(coversLookup({ columns: ['parent_id'], expression: true }, ['parent_id'], columns), false);
  assert.equal(coversLookup({ columns: ['parent_id'] }, ['parent_id'], columns), true);
  assert.equal(partialCondition(guarded), 'WHERE (parent_id IS NOT NULL)');
  assert.equal(partialCondition({ columns: ['parent_id'], partial: true }), 'filter not recorded');
});

// packages/explorer/src or skill/assets/extensions/src: the host page sits under skill/assets.
const here = dirname(fileURLToPath(import.meta.url));
const host = [resolve(here, '../../../skill/assets/explorer.html'), resolve(here, '../../explorer.html')].find(path => existsSync(path));

test('F03 the host page null-guard parser agrees with index-coverage.ts', { skip: host ? false : 'host page not found' }, () => {
  // The helpers share one line of the host script; defining the others is harmless, only nullGuard runs.
  const line = readFileSync(join(host!), 'utf8').split(/\r?\n/).find(text => text.includes('const nullGuard='));
  assert.ok(line, 'explorer.html defines nullGuard');
  const hostGuard = new Function(`${line}\nreturn nullGuard;`)() as (predicate: unknown, names: string[]) => string[] | null;
  for (const [predicate, expected] of CASES) assert.deepEqual(hostGuard(predicate, columns), expected, String(predicate));
});
