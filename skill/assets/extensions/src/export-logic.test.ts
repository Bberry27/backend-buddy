import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CAVEATS } from './caveat-strings';
import { COLUMN_ISSUES, caveatNote, columnReport, columnReportCsv, columnReportHtml, csvCell, describeColumnFilters, exportFileName, issueCounts, provenanceLines, provenanceOf, REPORT_CSP, toCsv } from './export-logic';
import type { ColumnFilters } from './column-logic';
import type { SchemaGraph } from './types';

// Synthetic, project-neutral fixture. Expected counts below are derived from this graph only.
const column = (name: string, more: Record<string, unknown> = {}) => ({ name, type: 'integer', pk: false, fk: '', nullable: 'False', index: false, unique: false, ...more });
const table = (id: string, allColumns: ReturnType<typeof column>[], more: Record<string, unknown> = {}) => ({ id, name: id.split('.')[1], schema: id.split('.')[0], className: id, domain: 'alpha', type: 'table', pk: '', allColumns, indexes: [], uniques: [], checks: [], ...more });
const graph = {
  project: { name: 'Synthetic Export Fixture', key: 'synthetic-export', dialect: 'postgresql' },
  source: { file: 'synthetic/export.json', commit: 'synthetic-commit', sha256: 'abc123', generated: '2026-01-02T03:04:05Z', basis: '=Synthetic basis, "quoted", for tests' },
  tables: [
    table('alpha.widgets', [
      column('id', { pk: true }),
      column('gadget_id', { nullable: 'True' }),
      column('bin_id'),
      column('note', { type: 'text', nullable: '' }),
      column('weight', { profiling: { nullFraction: 0, distinctCount: 0, sampled: false, min: 'SECRET_MIN_VALUE', max: 'SECRET_MAX_VALUE' } }),
    ], { primaryKey: ['id'], rowCount: 0 }),
    table('alpha.gadgets', [column('id', { pk: true })], { primaryKey: ['id'] }),
    table('alpha.parts', [column('id', { pk: true }), column('widget_id')], { primaryKey: ['id'], rowCount: 12, indexes: [{ name: 'ix_parts_widget', columns: ['widget_id'], unique: false }] }),
    table('alpha.logs', [column('message', { type: 'text' }), column('<b>odd</b>', { type: 'text' })], { rowCount: 3 }),
  ],
  links: [
    { source: 'alpha.widgets', column: 'gadget_id', target: 'alpha.gadgets', targetColumn: 'id', kind: 'declared FK' },
    { source: 'alpha.widgets', column: 'bin_id', target: 'alpha.bins', targetColumn: 'id', kind: 'inferred by naming' },
    { source: 'alpha.parts', column: 'widget_id', target: 'alpha.widgets', targetColumn: 'id', kind: 'declared FK' },
  ],
} as unknown as SchemaGraph;

const noFilters: ColumnFilters = { search: '', families: new Set(), nullableOnly: false, unindexedForeignOnly: false, idWithoutForeignOnly: false };
const exportedAt = '2026-11-22T00:00:00.000Z';
const rowsOf = (csv: string) => csv.replace(/^﻿/, '').split('\r\n');
const issuesFor = (tableId: string, columnName: string) => columnReport(graph).find(entry => entry.table.id === tableId)!.columns.find(item => item.column.name === columnName)!.issues;

/** The host artifact's own guard, extracted the way `test_renderer_security.py` extracts it. */
function hostCell(): ((value: unknown) => string) | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidate = [`${here}../../../skill/assets/explorer.html`, `${here}../../explorer.html`].find(existsSync);
  if (!candidate) return undefined;
  const template = readFileSync(candidate, 'utf8');
  const start = template.indexOf('cell=v=>');
  return new Function(`return ${template.slice(start + 'cell='.length, template.indexOf(';', start))}`)() as (value: unknown) => string;
}

test('F19 csvCell neutralises every formula vector exactly as the host S01 guard does', () => {
  const vectors = ['=1+1', ' =1', '\t=1', '\r=1', '+SUM(1)', '-2', '@A1', 'plain', 'say "hi"', '', null, undefined, 0];
  for (const vector of vectors.slice(0, 7)) assert.ok(csvCell(vector).startsWith('"\''), `not neutralised: ${String(vector)}`);
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(0), '"0"');
  const host = hostCell();
  assert.ok(host, 'host artifact template not found');
  for (const vector of vectors) assert.equal(csvCell(vector), host!(vector), `differs from host guard for ${JSON.stringify(vector)}`);
});

test('F19 toCsv writes a BOM, a guarded provenance preamble, a header and CRLF rows', () => {
  const csv = toCsv([{ a: '=cmd', b: 1 }], ['a', 'b'], ['=preamble']);
  assert.ok(csv.startsWith('﻿'));
  assert.deepEqual(rowsOf(csv), ['"# =preamble"', '"a","b"', '"\'=cmd","1"']);
});

test('F19 provenance carries project, generated time and basis, with absent fields named not recorded', () => {
  const lines = provenanceLines(provenanceOf(graph), 'Arc Diagram', exportedAt);
  assert.ok(lines.includes('Project: Synthetic Export Fixture (synthetic-export)'));
  assert.ok(lines.includes('Snapshot generated: 2026-01-02T03:04:05Z'));
  assert.ok(lines.includes('Basis: =Synthetic basis, "quoted", for tests'));
  assert.equal(provenanceOf({ ...graph, source: {} } as SchemaGraph).generated, 'not recorded');
  assert.equal(exportFileName({ ...graph, project: { ...graph.project, key: 'a/b c' } } as SchemaGraph, 'column-table', 'csv'), 'a_b_c-column-table.csv');
});

test('F19 column issues come from the Column Table facts and are named per row', () => {
  assert.deepEqual(issuesFor('alpha.widgets', 'gadget_id'), ['unindexed-declared-fk', 'nullable-declared-fk']);
  assert.deepEqual(issuesFor('alpha.widgets', 'bin_id'), ['inferred-only', 'id-without-declared-fk']);
  assert.deepEqual(issuesFor('alpha.widgets', 'note'), ['nullability-unknown']);
  assert.deepEqual(issuesFor('alpha.widgets', 'id'), []);
  assert.deepEqual(issuesFor('alpha.parts', 'widget_id'), [], 'an indexed, required declared FK carries no issue');
  const byTable = new Map(columnReport(graph).map(entry => [entry.table.id, entry.tableIssues]));
  assert.deepEqual(byTable.get('alpha.logs'), ['no-primary-key']);
  assert.deepEqual(byTable.get('alpha.gadgets'), ['row-count-unknown']);
  assert.deepEqual(byTable.get('alpha.widgets'), [], 'a measured zero row count is not unknown');
  const counts = new Map(issueCounts(columnReport(graph)).map(item => [item.issue.id, item.count]));
  for (const issue of COLUMN_ISSUES) {
    const expected = issue.scope === 'table'
      ? columnReport(graph).filter(entry => entry.tableIssues.includes(issue.id)).length
      : columnReport(graph).flatMap(entry => entry.columns).filter(item => item.issues.includes(issue.id)).length;
    assert.equal(counts.get(issue.id), expected);
  }
});

test('F19 Column Table CSV keeps unknown distinct from zero and declared distinct from inferred', () => {
  const csv = columnReportCsv(graph, { filters: noFilters, exportedAt });
  const lines = rowsOf(csv);
  const preamble = lines.filter(line => line.startsWith('"# '));
  assert.ok(preamble.some(line => line.includes('Snapshot generated: 2026-01-02T03:04:05Z')));
  assert.ok(preamble.some(line => line.includes('Basis: =Synthetic basis, ""quoted"", for tests')));
  const header = lines[preamble.length].split(',').map(cell => cell.slice(1, -1));
  const records = lines.slice(preamble.length + 1).map(line => Object.fromEntries(line.match(/"(?:[^"]|"")*"/g)!.map((cell, i) => [header[i], cell.slice(1, -1).replaceAll('""', '"')])));
  const find = (t: string, c: string) => records.find(record => record.table === t && record.column === c)!;
  assert.equal(records.length, graph.tables.reduce((sum, t) => sum + t.allColumns.length, 0));
  assert.equal(find('alpha.widgets', 'weight').table_row_count, '0');
  assert.equal(find('alpha.widgets', 'weight').null_fraction, '0');
  assert.equal(find('alpha.widgets', 'weight').distinct_count, '0');
  assert.equal(find('alpha.gadgets', 'id').table_row_count, 'unknown');
  assert.equal(find('alpha.widgets', 'id').null_fraction, 'unknown');
  assert.equal(find('alpha.widgets', 'gadget_id').declared_fk_target, 'alpha.gadgets.id');
  assert.equal(find('alpha.widgets', 'gadget_id').relationship_evidence, 'declared FK');
  assert.equal(find('alpha.widgets', 'bin_id').inferred_target, 'alpha.bins.id');
  assert.equal(find('alpha.widgets', 'bin_id').declared_fk_target, '');
  assert.equal(find('alpha.widgets', 'bin_id').relationship_evidence, 'inferred by naming');
  assert.equal(find('alpha.widgets', 'gadget_id').column_issues, 'Unindexed declared FK; Nullable declared FK');
  assert.equal(find('alpha.logs', 'message').table_issues, 'No primary key recorded');
  assert.ok(!csv.includes('SECRET_MIN_VALUE') && !csv.includes('SECRET_MAX_VALUE'), 'min/max are never exported');
});

test('F19 Column Table export follows the view filters', () => {
  const filters = { ...noFilters, unindexedForeignOnly: true };
  const entries = columnReport(graph, filters);
  assert.deepEqual(entries.flatMap(entry => entry.columns.map(item => `${entry.table.id}.${item.column.name}`)), ['alpha.widgets.gadget_id']);
  assert.equal(describeColumnFilters(filters), 'unindexed declared FKs');
  assert.ok(columnReportCsv(graph, { filters, exportedAt }).includes('# Filters: unindexed declared FKs'));
});

test('F19 Column Table HTML report highlights issue rows and names each issue in text', () => {
  const html = columnReportHtml(graph, { filters: noFilters, exportedAt });
  assert.ok(html.includes(`content="${REPORT_CSP}"`));
  assert.ok(!/<script/i.test(html), 'the report carries no script');
  assert.ok(html.includes('</style></head>'), 'the stylesheet is closed in the downloaded document');
  assert.ok(!/https?:\/\//.test(html), 'the report references no network resource');
  assert.ok(html.includes('&lt;b&gt;odd&lt;/b&gt;') && !html.includes('<b>odd</b>'), 'identifiers are escaped');
  assert.match(html, /<tr class="issue" data-issues="unindexed-declared-fk nullable-declared-fk">[\s\S]*?gadget_id[\s\S]*?⚠ Issue: Unindexed declared FK[\s\S]*?⚠ Issue: Nullable declared FK/);
  assert.match(html, /<tr class="table-head issue" data-issues="no-primary-key">[\s\S]*?⚠ Table issue: No primary key recorded/);
  assert.match(html, /<tr class="table-head issue" data-issues="row-count-unknown">[\s\S]*?Row count unknown/);
  assert.match(html, /<tr class="" data-issues="">[\s\S]*?<strong>id<\/strong>/, 'clean rows are not highlighted');
  assert.ok(html.includes('2026-01-02T03:04:05Z') && html.includes('=Synthetic basis, &quot;quoted&quot;, for tests'));
  assert.ok(html.includes(CAVEATS.C01.text.replaceAll('"', '&quot;')) && html.includes(CAVEATS.C07.text));
  assert.ok(!html.includes('SECRET_MIN_VALUE'));
  for (const { issue, count } of issueCounts(columnReport(graph))) assert.ok(html.includes(`<td>${issue.label.replaceAll('<', '&lt;')}</td>`) && html.includes(`<td>${count}</td>`));
});

test('F19 caveat notes quote caveat-strings verbatim', () => {
  assert.equal(caveatNote('C03'), `C03 ${CAVEATS.C03.title}: ${CAVEATS.C03.text}`);
});
