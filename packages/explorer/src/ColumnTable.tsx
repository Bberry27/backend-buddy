import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, Download, FlaskConical, LoaderCircle, Search, X } from 'lucide-react';
import type { LiveConnection, SchemaGraph } from './types';
import { COLUMN_FAMILIES, columnFamily, columnProfile, formatProfileValue, knownCount, matchesColumn, nullableState, tableColumnFacts } from './column-logic';
import type { ColumnFacts, ColumnFamily, ColumnTableColumn, ColumnTableEntity } from './column-logic';
import './ColumnTable.css';

export interface ColumnTableProps {
  graph: SchemaGraph;
  onSelectTable: (id: string) => void;
  live?: LiveConnection;
}

const PAGE_SIZE = 120;
const number = new Intl.NumberFormat();
const percent = (value: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
const tableLabel = (table: ColumnTableEntity) => table.name ? `${table.schema ? `${table.schema}.` : ''}${table.name}` : table.id;

function ProfileReadout({ column, table }: { column: ColumnTableColumn; table: ColumnTableEntity }) {
  const rowCount = table.rowCount;
  const profile = columnProfile(column, rowCount, table.profiling);
  const hasAny = Object.entries(profile).some(([key, value]) => key !== 'scope' && value !== undefined);
  if (!hasAny) return <span className="ct-profile-empty">No statistics</span>;
  return <span className="ct-profile">
    {profile.nullFraction !== undefined && <span className="ct-null-stat">
      <span>Nulls {percent(profile.nullFraction)}{profile.scope === 'sample' ? ' in sample' : profile.scope === 'unknown' ? ' (scope unknown)' : ''}</span>
      <span className="ct-null-track" aria-hidden="true"><span style={{ width: `${profile.nullFraction * 100}%` }} /></span>
    </span>}
    {profile.distinctCount !== undefined && <span>{number.format(profile.distinctCount)} distinct{profile.scope === 'sample' ? ' in sample' : profile.scope === 'table' ? ' in table' : ' (scope unknown)'}</span>}
    {profile.sampleSize !== undefined && <span>{profile.scope === 'table' ? 'Profile' : 'Sample'} {number.format(profile.sampleSize)} rows{profile.coverage !== undefined ? ` / ${percent(profile.coverage)} coverage` : ' / coverage unknown'}</span>}
    {profile.scope === 'sample' && profile.sampleSize === undefined && <span>Sample size / coverage unknown</span>}
    {profile.sampleRatio !== undefined && <span>Distinct / {profile.scope === 'table' ? 'profile rows' : 'sample'}: {percent(profile.sampleRatio)}</span>}
    {profile.rowRatio !== undefined && <span>{profile.scope === 'sample' ? 'Sample distinct' : 'Distinct'} / total rows: {percent(profile.rowRatio)}</span>}
    {profile.distinctCount !== undefined && profile.rowRatio === undefined && <span>Distinct / total rows: {rowCount === 0 ? 'N/A (empty table)' : 'unknown'}</span>}
    {profile.min !== undefined || profile.max !== undefined ? <span className="ct-range-hint">Range available</span> : null}
  </span>;
}

function badges(column: ColumnTableColumn, facts: ColumnFacts) {
  const nullable = nullableState(column.nullable);
  return <span className="ct-badges">
    {facts.primary && <span title="Primary-key membership">PK</span>}
    {facts.foreign && <span title={facts.foreignDescription}>FK</span>}
    {facts.inferred && !facts.foreign && <span title={facts.foreignDescription}>INFERRED</span>}
    {facts.unique && <span title={facts.uniqueDescription}>UNIQUE</span>}
    {facts.indexed && <span title={facts.indexDescription}>INDEXED</span>}
    {nullable === 'nullable' && <span title="Column allows NULL">NULLABLE</span>}
    {nullable === 'unknown' && <span title="Nullability is not recorded">NULLABILITY UNKNOWN</span>}
  </span>;
}

function ColumnGroup({ table, columns, facts, open, setOpen, onSelect, onInspect, selected }: {
  table: ColumnTableEntity;
  columns: ColumnTableColumn[];
  facts: Map<string, ColumnFacts>;
  open: boolean;
  setOpen: (open: boolean) => void;
  onSelect: (column: string) => void;
  onInspect: () => void;
  selected?: string;
}) {
  const groupId = useId();
  const [visible, setVisible] = useState(PAGE_SIZE);
  useEffect(() => { setVisible(PAGE_SIZE); }, [columns, open]);
  return <section className="ct-group" aria-label={tableLabel(table)}>
    <div className="ct-group-header">
      <button className="ct-group-toggle" type="button" aria-expanded={open} aria-controls={groupId} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className="ct-table-name">{tableLabel(table)}</span>
        <span className="ct-group-count">{number.format(columns.length)}{columns.length !== table.allColumns.length ? ` / ${number.format(table.allColumns.length)}` : ''} columns</span>
      </button>
      <span className="ct-row-count">{knownCount(table.rowCount) ? `${number.format(table.rowCount)} rows` : 'Rows unknown'}</span>
      <button className="ct-icon-button" type="button" aria-label={`Inspect table ${tableLabel(table)}`} title={`Inspect table ${tableLabel(table)}`} onClick={onInspect}><ArrowUpRight size={17} aria-hidden="true" /></button>
    </div>
    <div id={groupId} hidden={!open}>
      {open && <>
        <div className="ct-tiles">
          {columns.slice(0, visible).map(column => {
            const fact = facts.get(column.name)!;
            const profile = columnProfile(column, table.rowCount, table.profiling);
            const tooltip = [column.name, column.type, fact.indexDescription, fact.foreignDescription,
              `Minimum: ${formatProfileValue(profile.min)}`, `Maximum: ${formatProfileValue(profile.max)}`].filter(Boolean).join('\n');
            return <button type="button" key={column.name} className={`ct-tile ct-family-${columnFamily(column.type)}`} aria-pressed={selected === column.name} title={tooltip} onClick={() => onSelect(column.name)}>
              <span className="ct-tile-family"><span className="ct-swatch" aria-hidden="true" />{columnFamily(column.type)}</span>
              <strong className="ct-column-name">{column.name}</strong>
              <span className="ct-column-type">{column.type || 'Type unknown'}</span>
              {badges(column, fact)}
              <ProfileReadout column={column} table={table} />
            </button>;
          })}
        </div>
        {columns.length > visible && <button type="button" className="ct-more" onClick={() => setVisible(value => value + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, columns.length - visible)} more ({number.format(columns.length - visible)} remaining)</button>}
      </>}
    </div>
  </section>;
}

export default function ColumnTable({ graph, onSelectTable, live }: ColumnTableProps) {
  const [profiled, setProfiled] = useState<{ base: SchemaGraph; result: SchemaGraph; sampled: boolean; limit: number }>();
  const currentGraph = profiled?.base === graph ? profiled.result : graph;
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search);
  const [families, setFamilies] = useState<Set<ColumnFamily>>(new Set());
  const [nullableOnly, setNullableOnly] = useState(false);
  const [unindexedForeignOnly, setUnindexedForeignOnly] = useState(false);
  const [idWithoutForeignOnly, setIdWithoutForeignOnly] = useState(false);
  const [expansion, setExpansion] = useState<{ defaultOpen: boolean; exceptions: Map<string, boolean> }>({ defaultOpen: false, exceptions: new Map() });
  const [selected, setSelected] = useState<{ table: string; column: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const request = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { request.current++; }, []);
  const filterId = useId();

  const factsByTable = useMemo(() => {
    const linksByTable = new Map<string, SchemaGraph['links']>();
    currentGraph.links.forEach(link => {
      const list = linksByTable.get(link.source) ?? [];
      list.push(link);
      linksByTable.set(link.source, list);
    });
    return new Map(currentGraph.tables.map(table => [table.id, tableColumnFacts(table, linksByTable.get(table.id) ?? [])]));
  }, [currentGraph]);
  const counts = useMemo(() => {
    const result = Object.fromEntries(COLUMN_FAMILIES.map(family => [family, 0])) as Record<ColumnFamily, number>;
    currentGraph.tables.forEach(table => table.allColumns.forEach(column => result[columnFamily(column.type)]++));
    return result;
  }, [currentGraph]);
  const groups = useMemo(() => currentGraph.tables.map(table => ({ table, columns: table.allColumns.filter(column => matchesColumn(table, column, factsByTable.get(table.id)!.get(column.name)!, { search: query, families, nullableOnly, unindexedForeignOnly, idWithoutForeignOnly })) })).filter(group => group.columns.length > 0), [currentGraph, factsByTable, query, families, nullableOnly, unindexedForeignOnly, idWithoutForeignOnly]);
  const totalColumns = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const visibleColumns = groups.reduce((sum, group) => sum + group.columns.length, 0);
  const selectedTable = currentGraph.tables.find(table => table.id === selected?.table);
  const selectedColumn = selectedTable?.allColumns.find(column => column.name === selected?.column);
  const selectedFacts = selectedTable && selectedColumn ? factsByTable.get(selectedTable.id)!.get(selectedColumn.name)! : undefined;
  const selectedProfile = selectedColumn ? columnProfile(selectedColumn, selectedTable?.rowCount, selectedTable?.profiling) : undefined;
  const hasFilter = Boolean(search || families.size || nullableOnly || unindexedForeignOnly || idWithoutForeignOnly);

  async function runProfile() {
    if (!live?.profile || inFlight.current || !currentGraph.tables.length) return;
    const base = graphRef.current;
    const token = ++request.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await live.profile({ tables: currentGraph.tables.map(table => table.id), maxRowsPerTable: 10000 });
      // A host may install the returned graph before this promise resolves.
      // Never replace a different graph selected while the request was running.
      if (request.current === token && (graphRef.current === base || graphRef.current === result.graph)) {
        setProfiled({ base: graphRef.current, result: result.graph, sampled: result.sampled, limit: result.limit });
      }
    } catch (cause) {
      if (request.current === token && graphRef.current === base) setError(cause instanceof Error ? cause.message : 'Profiling failed.');
    } finally {
      inFlight.current = false;
      if (request.current === token) setBusy(false);
    }
  }

  function exportSnapshot() {
    let url: string | undefined;
    try {
      const blob = new Blob([JSON.stringify(currentGraph, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(currentGraph.project?.key || 'schema').replace(/[^a-zA-Z0-9_-]/g, '_')}-column-snapshot.json`;
      anchor.click();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Snapshot export failed.');
    } finally {
      if (url) { const downloadUrl = url; window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000); }
    }
  }

  return <div className="ct-root">
    <div className="ct-toolbar">
      <label className="ct-search"><Search size={17} aria-hidden="true" /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search columns or tables" aria-label="Search columns or tables" /></label>
      <div className="ct-actions">
        <button type="button" className="ct-command" disabled={!live?.profile || busy || !currentGraph.tables.length} title={live?.profile ? 'Profile all tables, up to 10,000 rows per table' : 'Profiling requires a live connection with a profiler'} onClick={runProfile}>{busy ? <LoaderCircle size={16} className="ct-spin" aria-hidden="true" /> : <FlaskConical size={16} aria-hidden="true" />}<span>{busy ? 'Profiling...' : 'Profile'}</span></button>
        <button type="button" className="ct-icon-button" title="Export current schema snapshot (JSON)" aria-label="Export current schema snapshot (JSON)" onClick={exportSnapshot}><Download size={17} aria-hidden="true" /></button>
      </div>
    </div>
    <fieldset className="ct-families"><legend>Type families</legend>{COLUMN_FAMILIES.map(family => <label key={family} className={`ct-family-filter ct-family-${family}`}><input type="checkbox" checked={families.has(family)} onChange={() => setFamilies(previous => { const next = new Set(previous); if (next.has(family)) next.delete(family); else next.add(family); return next; })} /><span className="ct-swatch" aria-hidden="true" /><span>{family}</span><span className="ct-family-count">{number.format(counts[family])}</span></label>)}</fieldset>
    <div className="ct-filters">
      <label><input type="checkbox" checked={nullableOnly} onChange={event => setNullableOnly(event.target.checked)} />Nullable only</label>
      <label title="Declared FKs without a verified leading index prefix covering every column in the constraint. Column-only index flags do not establish order."><input type="checkbox" checked={unindexedForeignOnly} onChange={event => setUnindexedForeignOnly(event.target.checked)} />Unindexed declared FKs</label>
      <label title="Names ending in _id without a declared FK; naming-inferred links are not constraints."><input type="checkbox" checked={idWithoutForeignOnly} onChange={event => setIdWithoutForeignOnly(event.target.checked)} />_id without FK</label>
      {hasFilter && <button type="button" className="ct-clear" onClick={() => { setSearch(''); setFamilies(new Set()); setNullableOnly(false); setUnindexedForeignOnly(false); setIdWithoutForeignOnly(false); }}>Clear filters</button>}
    </div>
    <div className="ct-results-bar">
      <span role="status" id={filterId}>{number.format(visibleColumns)} / {number.format(totalColumns)} columns in {number.format(groups.length)} tables</span>
      <div className="ct-expand-actions"><button type="button" onClick={() => setExpansion({ defaultOpen: true, exceptions: new Map() })}>Expand all</button><button type="button" onClick={() => setExpansion({ defaultOpen: false, exceptions: new Map(currentGraph.tables.map(table => [table.id, false])) })}>Collapse all</button></div>
    </div>
    {profiled?.base === graph && <div className="ct-profile-status" role="status">{profiled.sampled ? `Sampled profile; limit ${number.format(profiled.limit)} rows per table. Sample distinct counts are not total distinct estimates.` : 'Profile completed.'}</div>}
    {error && <div className="ct-error" role="alert">{error}</div>}
    <div className={`ct-body${selectedColumn ? ' ct-has-inspector' : ''}`}>
      <div className="ct-table-scroll" aria-describedby={filterId}>
        {groups.length ? groups.map(({ table, columns }, index) => <ColumnGroup key={table.id} table={table} columns={columns} facts={factsByTable.get(table.id)!} open={expansion.exceptions.get(table.id) ?? (expansion.defaultOpen || index < 2)} setOpen={open => setExpansion(previous => ({ ...previous, exceptions: new Map(previous.exceptions).set(table.id, open) }))} onSelect={column => setSelected({ table: table.id, column })} onInspect={() => onSelectTable(table.id)} selected={selected?.table === table.id ? selected.column : undefined} />) : <div className="ct-empty">{totalColumns ? 'No columns match these filters.' : 'No columns in this schema.'}</div>}
      </div>
      {selectedColumn && selectedTable && selectedFacts && selectedProfile && <aside className="ct-inspector" aria-label="Column inspector">
        <div className="ct-inspector-top"><strong>Column detail</strong><button type="button" className="ct-icon-button" onClick={() => setSelected(undefined)} aria-label="Close column detail" title="Close column detail"><X size={16} aria-hidden="true" /></button></div>
        <p className="ct-inspector-table">{tableLabel(selectedTable)}</p>
        <h3>{selectedColumn.name}</h3><p className="ct-inspector-type">{selectedColumn.type || 'Type unknown'}</p>
        {badges(selectedColumn, selectedFacts)}
        <dl><dt>Nullability</dt><dd>{nullableState(selectedColumn.nullable)}</dd><dt>Index coverage</dt><dd>{selectedFacts.indexDescription}</dd>{selectedFacts.unique && <><dt>Uniqueness</dt><dd>{selectedFacts.uniqueDescription}</dd></>}{selectedFacts.foreignDescription && <><dt>References</dt><dd>{selectedFacts.foreignDescription}</dd></>}<dt>Total rows</dt><dd>{knownCount(selectedTable.rowCount) ? number.format(selectedTable.rowCount) : 'Unknown'}</dd><dt>Minimum</dt><dd title={formatProfileValue(selectedProfile.min)}>{formatProfileValue(selectedProfile.min)}</dd><dt>Maximum</dt><dd title={formatProfileValue(selectedProfile.max)}>{formatProfileValue(selectedProfile.max)}</dd></dl>
        <ProfileReadout column={selectedColumn} table={selectedTable} />
        <button type="button" className="ct-command ct-inspect-command" onClick={() => onSelectTable(selectedTable.id)}><ArrowUpRight size={16} aria-hidden="true" />Inspect table</button>
      </aside>}
    </div>
  </div>;
}
