/**
 * Pure export logic for user-initiated reports (feature F19).
 *
 * Nothing here touches the DOM, the network or storage: it turns a SchemaGraph and a view's
 * current scope into text (CSV, a self-contained HTML report, provenance lines). The download
 * itself happens in `svg-export.ts` and only on an explicit click.
 *
 * Rules this module keeps:
 *  - Every CSV cell passes the S01 spreadsheet-formula guard, byte-compatible with the host's
 *    `cell=v=>` in `skill/assets/explorer.html`.
 *  - Unknown stays unknown (C01): a missing row count or statistic is written as `unknown`,
 *    never as 0 or a blank that a spreadsheet would sum as 0.
 *  - Declared and inferred evidence stay distinguishable (C07) in separate columns.
 *  - Column issues are derived only from facts `column-logic.ts` already computes for the Column
 *    Table view; the one combination it does not name itself (a nullable declared FK) is the
 *    conjunction of two of those facts, not a new threshold or heuristic.
 *  - Minimum and maximum values are not exported: they can be sensitive.
 */
import { CAVEATS, type CaveatId } from './caveat-strings';
import { columnFamily, columnProfile, knownCount, matchesColumn, nullableState, tableColumnFacts, type ColumnFacts, type ColumnFilters } from './column-logic';
import { HOST_COLORS } from './palettes';
import type { SchemaGraph } from './types';

type Table = SchemaGraph['tables'][number];
type Column = Table['allColumns'][number];

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * One CSV cell. A value that a spreadsheet would read as a formula (`= + - @`, tab or carriage
 * return after optional leading whitespace) is prefixed with an apostrophe, exactly as the host
 * artifact's guard does, then the value is quoted.
 */
export function csvCell(value: unknown): string {
  return '"' + String(value ?? '').replace(/^[\s]*[=+\-@\t\r]/, "'$&").replaceAll('"', '""') + '"';
}

/**
 * A CSV document: UTF-8 byte-order mark, optional `# ` provenance preamble lines (each one cell),
 * a header row, then the rows, joined with CRLF.
 */
export function toCsv(rows: readonly Record<string, unknown>[], columns: readonly string[], preamble: readonly string[] = []): string {
  const lines = [
    ...preamble.map(line => csvCell('# ' + line)),
    columns.map(csvCell).join(','),
    ...rows.map(row => columns.map(column => csvCell(row[column])).join(',')),
  ];
  return '﻿' + lines.join('\r\n');
}

// ---------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------

export interface ExportProvenance {
  project: string;
  key: string;
  dialect: string;
  generated: string;
  basis: string;
  sha256: string;
  commit: string;
  file: string;
}

const NOT_RECORDED = 'not recorded';
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : NOT_RECORDED;

export function provenanceOf(graph: SchemaGraph): ExportProvenance {
  const source = graph.source ?? {};
  return {
    project: text(graph.project?.name),
    key: text(graph.project?.key),
    dialect: text(graph.project?.dialect),
    generated: text(source.generated),
    basis: text(source.basis),
    sha256: text(source.sha256),
    commit: text(source.commit),
    file: text(source.file),
  };
}

/** The provenance every export carries, one fact per line. */
export function provenanceLines(provenance: ExportProvenance, view: string, exportedAt: string): string[] {
  return [
    `Backend Buddy export: ${view}`,
    `Project: ${provenance.project} (${provenance.key})`,
    `Snapshot generated: ${provenance.generated}`,
    `Basis: ${provenance.basis}`,
    `Source: ${provenance.file} | commit ${provenance.commit} | SHA-256 ${provenance.sha256}`,
    `Exported: ${exportedAt}`,
  ];
}

/** A download file name without extension: the project key and view slug, in a portable character set. */
export function exportFileStem(graph: SchemaGraph, view: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe(graph.project?.key || 'schema')}-${safe(view)}`;
}

export function exportFileName(graph: SchemaGraph, view: string, extension: string): string {
  return `${exportFileStem(graph, view)}.${extension}`;
}

/** A caveat as an export footer line, its wording verbatim from `caveat-strings.ts`. */
export function caveatNote(id: CaveatId): string {
  return `${id} ${CAVEATS[id].title}: ${CAVEATS[id].text}`;
}

// ---------------------------------------------------------------------------------------------
// Column Table issues
// ---------------------------------------------------------------------------------------------

export type ColumnIssueId = 'no-primary-key' | 'row-count-unknown' | 'unindexed-declared-fk' | 'nullable-declared-fk' | 'inferred-only' | 'id-without-declared-fk' | 'nullability-unknown';

export interface ColumnIssueDefinition {
  id: ColumnIssueId;
  /** Short name, written into every flagged row: the issue is named in text, never colour alone. */
  label: string;
  scope: 'table' | 'column';
  /** `review` is a structural candidate (C08); `unknown` is missing evidence (C01). */
  kind: 'review' | 'unknown';
  /** Where the rule comes from and what it does and does not establish. */
  description: string;
}

export const COLUMN_ISSUES: readonly ColumnIssueDefinition[] = Object.freeze([
  { id: 'no-primary-key', label: 'No primary key recorded', scope: 'table', kind: 'review',
    description: 'No column is marked primary and the table records no primary key (Column Table PK badge). Check table-level, inherited and migration declarations before choosing a key.' },
  { id: 'row-count-unknown', label: 'Row count unknown', scope: 'table', kind: 'unknown',
    description: 'The snapshot holds no measured row count for this table. Unknown is not zero.' },
  { id: 'unindexed-declared-fk', label: 'Unindexed declared FK', scope: 'column', kind: 'review',
    description: 'Declared FK without a verified leading index prefix covering every column of the constraint (Column Table filter "Unindexed declared FKs"). An access-path review, not a normalization violation.' },
  { id: 'nullable-declared-fk', label: 'Nullable declared FK', scope: 'column', kind: 'review',
    description: 'A declared FK column that allows NULL (Column Table FK and NULLABLE badges together). An optional relationship may be intentional.' },
  { id: 'inferred-only', label: 'Inferred relationship only', scope: 'column', kind: 'review',
    description: 'Mapped to a target by naming only; no declared constraint exists (Column Table INFERRED badge). Inferred references are not constraints.' },
  { id: 'id-without-declared-fk', label: '_id without declared FK', scope: 'column', kind: 'review',
    description: 'Name ends in _id but no declared FK covers it (Column Table filter "_id without FK"). A naming suffix is not proof of a reference.' },
  { id: 'nullability-unknown', label: 'Nullability not recorded', scope: 'column', kind: 'unknown',
    description: 'The snapshot does not record whether the column allows NULL (Column Table NULLABILITY UNKNOWN badge).' },
] satisfies ColumnIssueDefinition[]);

const ISSUE_BY_ID = new Map(COLUMN_ISSUES.map(issue => [issue.id, issue]));
export const issueLabel = (id: ColumnIssueId) => ISSUE_BY_ID.get(id)!.label;

export function tableIssues(table: Table, facts: Map<string, ColumnFacts>): ColumnIssueId[] {
  const issues: ColumnIssueId[] = [];
  if (![...facts.values()].some(fact => fact.primary)) issues.push('no-primary-key');
  if (!knownCount(table.rowCount)) issues.push('row-count-unknown');
  return issues;
}

export function columnIssues(column: Column, fact: ColumnFacts): ColumnIssueId[] {
  const issues: ColumnIssueId[] = [];
  const nullable = nullableState(column.nullable);
  if (fact.unindexedDeclared) issues.push('unindexed-declared-fk');
  if (fact.foreign && nullable === 'nullable') issues.push('nullable-declared-fk');
  if (fact.inferred && !fact.foreign) issues.push('inferred-only');
  if (/_id$/i.test(column.name) && !fact.foreign) issues.push('id-without-declared-fk');
  if (nullable === 'unknown') issues.push('nullability-unknown');
  return issues;
}

export interface ColumnReportRow {
  table: string;
  column: string;
  type: string;
  type_family: string;
  primary_key: 'yes' | 'no';
  declared_fk_target: string;
  inferred_target: string;
  relationship_evidence: string;
  nullable: 'nullable' | 'required' | 'unknown';
  indexed: 'yes' | 'no';
  index_coverage: string;
  unique: 'yes' | 'no';
  table_row_count: string;
  null_fraction: string;
  distinct_count: string;
  statistics_scope: string;
  column_issues: string;
  table_issues: string;
}

/** Column order of the CSV and of the HTML report's data columns. */
export const COLUMN_REPORT_FIELDS: readonly (keyof ColumnReportRow)[] = Object.freeze([
  'table', 'column', 'type', 'type_family', 'primary_key', 'declared_fk_target', 'inferred_target', 'relationship_evidence',
  'nullable', 'indexed', 'index_coverage', 'unique', 'table_row_count', 'null_fraction', 'distinct_count', 'statistics_scope',
  'column_issues', 'table_issues',
] as const);

export interface ColumnReportEntry {
  table: Table;
  tableIssues: ColumnIssueId[];
  columns: { column: Column; issues: ColumnIssueId[]; row: ColumnReportRow }[];
}

const numberText = (value: number) => String(value);

/**
 * The Column Table's current scope as report entries. With `filters` the same predicate the view
 * uses (`matchesColumn`) selects the columns, so an export matches what the filters show; tables
 * left with no matching column are dropped, exactly as the view drops them.
 */
export function columnReport(graph: SchemaGraph, filters?: ColumnFilters): ColumnReportEntry[] {
  const linksByTable = new Map<string, SchemaGraph['links']>();
  graph.links.forEach(link => { const list = linksByTable.get(link.source) ?? []; list.push(link); linksByTable.set(link.source, list); });
  return graph.tables.flatMap(table => {
    const links = linksByTable.get(table.id) ?? [];
    const facts = tableColumnFacts(table, links);
    const tIssues = tableIssues(table, facts);
    const columns = table.allColumns.filter(column => !filters || matchesColumn(table, column, facts.get(column.name)!, filters)).map(column => {
      const fact = facts.get(column.name)!;
      const issues = columnIssues(column, fact);
      const declared = links.filter(link => link.kind === 'declared FK' && link.column === column.name).map(link => `${link.target}.${link.targetColumn}`);
      if (!declared.length && column.fk) declared.push(column.fk);
      const inferred = links.filter(link => link.kind === 'inferred by naming' && link.column === column.name).map(link => `${link.target}.${link.targetColumn}`);
      const evidence = [declared.length ? 'declared FK' : '', inferred.length ? 'inferred by naming' : ''].filter(Boolean).join(' + ') || 'none';
      const profile = columnProfile(column, table.rowCount, table.profiling);
      const row: ColumnReportRow = {
        table: table.id,
        column: column.name,
        type: column.type || 'unknown',
        type_family: columnFamily(column.type || ''),
        primary_key: fact.primary ? 'yes' : 'no',
        declared_fk_target: declared.join('; '),
        inferred_target: inferred.join('; '),
        relationship_evidence: evidence,
        nullable: nullableState(column.nullable),
        indexed: fact.indexed ? 'yes' : 'no',
        index_coverage: fact.indexDescription.replaceAll('\n', '; '),
        unique: fact.unique ? 'yes' : 'no',
        table_row_count: knownCount(table.rowCount) ? numberText(table.rowCount) : 'unknown',
        null_fraction: profile.nullFraction !== undefined ? numberText(profile.nullFraction) : 'unknown',
        distinct_count: profile.distinctCount !== undefined ? numberText(profile.distinctCount) : 'unknown',
        statistics_scope: profile.scope ?? 'none',
        column_issues: issues.map(issueLabel).join('; '),
        table_issues: tIssues.map(issueLabel).join('; '),
      };
      return { column, issues, row };
    });
    return columns.length ? [{ table, tableIssues: tIssues, columns }] : [];
  });
}

export interface IssueCount { issue: ColumnIssueDefinition; count: number }

/** How many tables (table scope) or columns (column scope) carry each issue. */
export function issueCounts(entries: readonly ColumnReportEntry[]): IssueCount[] {
  return COLUMN_ISSUES.map(issue => ({
    issue,
    count: issue.scope === 'table'
      ? entries.filter(entry => entry.tableIssues.includes(issue.id)).length
      : entries.reduce((sum, entry) => sum + entry.columns.filter(item => item.issues.includes(issue.id)).length, 0),
  }));
}

/** A plain-text description of the active Column Table filters, for the report header. */
export function describeColumnFilters(filters?: ColumnFilters): string {
  if (!filters) return 'none (all columns)';
  const parts = [
    filters.search.trim() ? `search "${filters.search.trim()}"` : '',
    filters.families.size ? `type families: ${[...filters.families].join(', ')}` : '',
    filters.nullableOnly ? 'nullable only' : '',
    filters.unindexedForeignOnly ? 'unindexed declared FKs' : '',
    filters.idWithoutForeignOnly ? '_id without FK' : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : 'none (all columns)';
}

export interface ColumnReportOptions {
  filters?: ColumnFilters;
  exportedAt: string;
  /** Host-supplied scope note, for example the shell's search and domain filters. */
  scopeNote?: string;
}

export function columnReportCsv(graph: SchemaGraph, options: ColumnReportOptions): string {
  const entries = columnReport(graph, options.filters);
  const preamble = [
    ...provenanceLines(provenanceOf(graph), 'Column Table', options.exportedAt),
    `Filters: ${describeColumnFilters(options.filters)}`,
    ...(options.scopeNote ? [`Scope: ${options.scopeNote}`] : []),
    'Unknown values are written as "unknown", never 0. Minimum and maximum values are not exported.',
  ];
  return toCsv(entries.flatMap(entry => entry.columns.map(item => item.row as unknown as Record<string, unknown>)), COLUMN_REPORT_FIELDS, preamble);
}

// ---------------------------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------------------------

export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

/**
 * The report's own policy: no script, no network, inline styles only. It is a document to hand
 * to someone else, so it carries everything it needs and asks for nothing.
 */
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const REPORT_CAVEATS: readonly CaveatId[] = ['C01', 'C06', 'C07', 'C08', 'C09'];

/**
 * This module is inlined into the artifact's own <style> and <script> elements, and the S01
 * renderer checks forbid bundle text that could close either early. The report's closing style
 * tag is therefore assembled at run time rather than written as a literal.
 */
const STYLE_END = ['<', '/', 'style>'].join('');

export function columnReportHtml(graph: SchemaGraph, options: ColumnReportOptions): string {
  const provenance = provenanceOf(graph);
  const entries = columnReport(graph, options.filters);
  const counts = issueCounts(entries);
  const columnTotal = entries.reduce((sum, entry) => sum + entry.columns.length, 0);
  const flaggedColumns = entries.reduce((sum, entry) => sum + entry.columns.filter(item => item.issues.length).length, 0);
  const sampled = entries.some(entry => entry.columns.some(item => item.row.statistics_scope === 'sample'));
  const caveats = [...REPORT_CAVEATS, ...(sampled ? ['C05' as CaveatId] : [])];
  const c = HOST_COLORS.light;
  const e = escapeHtml;
  const headers = ['Column', 'Type', 'Key / relationship', 'Nullable', 'Index coverage', 'Statistics', 'Issues'];
  const columnRow = ({ row, issues }: ColumnReportEntry['columns'][number]) => {
    const relationship = [
      row.primary_key === 'yes' ? 'PK' : '',
      row.declared_fk_target ? `Declared FK → ${row.declared_fk_target}` : '',
      row.inferred_target ? `Inferred by naming (not a constraint) → ${row.inferred_target}` : '',
      row.unique === 'yes' ? 'Unique membership' : '',
    ].filter(Boolean);
    const statistics = row.statistics_scope === 'none' ? 'No statistics' : `Nulls ${row.null_fraction}; distinct ${row.distinct_count} (${row.statistics_scope} scope)`;
    return `<tr class="${issues.length ? 'issue' : ''}" data-issues="${e(issues.join(' '))}">`
      + `<td><strong>${e(row.column)}</strong></td><td>${e(row.type)}${row.type_family !== row.type.toLowerCase() ? `<br><span class="muted">${e(row.type_family)}</span>` : ''}</td>`
      + `<td>${relationship.map(e).join('<br>') || '<span class="muted">None</span>'}</td>`
      + `<td${row.nullable === 'unknown' ? ' class="unknown"' : ''}>${e(row.nullable)}</td>`
      + `<td>${e(row.index_coverage)}</td><td>${e(statistics)}</td>`
      + `<td>${issues.length ? issues.map(id => `<span class="flag flag-${e(ISSUE_BY_ID.get(id)!.kind)}">⚠ Issue: ${e(issueLabel(id))}</span>`).join('') : '<span class="muted">None detected</span>'}</td></tr>`;
  };
  const body = entries.map(entry => {
    const label = entry.table.name ? `${entry.table.schema ? `${entry.table.schema}.` : ''}${entry.table.name}` : entry.table.id;
    const rows = knownCount(entry.table.rowCount) ? `${entry.table.rowCount.toLocaleString('en-US')} rows` : 'Row count unknown';
    return `<tbody><tr class="table-head${entry.tableIssues.length ? ' issue' : ''}" data-issues="${e(entry.tableIssues.join(' '))}"><th colspan="${headers.length}" scope="rowgroup">`
      + `${e(label)} <span class="muted">· ${e(rows)} · ${entry.columns.length} of ${entry.table.allColumns.length} columns</span>`
      + `${entry.tableIssues.map(id => ` <span class="flag flag-${e(ISSUE_BY_ID.get(id)!.kind)}">⚠ Table issue: ${e(issueLabel(id))}</span>`).join('')}</th></tr>`
      + entry.columns.map(columnRow).join('') + '</tbody>';
  }).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(provenance.project)} | Column Table report</title>
<style>
body{margin:0;padding:24px;background:${c.bg};color:${c.ink};font:13px/1.45 'Segoe UI',Arial,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px}.muted{color:${c.muted}}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:12px 0}dt{color:${c.muted}}dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;background:${c.panel}}th,td{border:1px solid ${c.line};padding:5px 7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
thead th{background:${c.raised};position:sticky;top:0}
tr.table-head th{background:${c.raised};font-size:14px}
tr.issue td,tr.issue th{background:color-mix(in srgb,${c.orange} 12%,${c.panel})}
tr.issue td:first-child{border-left:4px solid ${c.orange}}tr.table-head.issue th{border-left:4px solid ${c.orange}}
.flag{display:inline-block;margin:1px 4px 1px 0;padding:1px 6px;border-radius:3px;border:1px solid ${c.orange};font-weight:600}
.flag-unknown{border-style:dashed;border-color:${c.purple}}td.unknown{font-style:italic}
.summary td:last-child,.summary th:last-child{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
blockquote{margin:6px 0;padding:6px 10px;border-left:3px solid ${c.line};color:${c.muted}}
@media print{body{padding:0;background:${c.panel}}thead th{position:static}}
${STYLE_END}</head><body>
<h1>${e(provenance.project)}: Column Table report</h1>
<p class="muted">Highlighted rows carry at least one issue, named in the Issues column. Issues are review candidates or missing evidence, not verdicts.</p>
<dl>
<dt>Project</dt><dd>${e(provenance.project)} (${e(provenance.key)}, ${e(provenance.dialect)})</dd>
<dt>Snapshot generated</dt><dd>${e(provenance.generated)}</dd>
<dt>Basis</dt><dd>${e(provenance.basis)}</dd>
<dt>Source</dt><dd>${e(provenance.file)} · commit ${e(provenance.commit)} · SHA-256 ${e(provenance.sha256)}</dd>
<dt>Exported</dt><dd>${e(options.exportedAt)}</dd>
<dt>Filters</dt><dd>${e(describeColumnFilters(options.filters))}</dd>
${options.scopeNote ? `<dt>Scope</dt><dd>${e(options.scopeNote)}</dd>\n` : ''}<dt>Coverage</dt><dd>${columnTotal} columns in ${entries.length} tables; ${flaggedColumns} columns carry a column issue</dd>
</dl>
<h2>Issue summary</h2>
<table class="summary"><thead><tr><th scope="col">Issue</th><th scope="col">Applies to</th><th scope="col">Kind</th><th scope="col">What it means</th><th scope="col">Count</th></tr></thead><tbody>
${counts.map(({ issue, count }) => `<tr${count ? ' class="issue"' : ''}><td>${e(issue.label)}</td><td>${issue.scope === 'table' ? 'tables' : 'columns'}</td><td>${issue.kind === 'review' ? 'Review candidate' : 'Unknown evidence'}</td><td>${e(issue.description)}</td><td>${count}</td></tr>`).join('\n')}
</tbody></table>
<h2>Columns</h2>
<table class="columns"><thead><tr>${headers.map(header => `<th scope="col">${e(header)}</th>`).join('')}</tr></thead>${body || `<tbody><tr><td colspan="${headers.length}" class="muted">No columns in this scope.</td></tr></tbody>`}</table>
<h2>Caveats</h2>
${caveats.map(id => `<p><strong>${id} ${e(CAVEATS[id].title)}</strong></p><blockquote>${e(CAVEATS[id].text)}</blockquote>`).join('\n')}
<p class="muted">Minimum and maximum values are not included in this report. Generated by Backend Buddy from the snapshot above; no database was contacted to produce it.</p>
</body></html>
`;
}
