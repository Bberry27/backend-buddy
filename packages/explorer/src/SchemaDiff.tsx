import React, { useId, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpRight, FileUp, Minus, Plus, RotateCcw, Search } from 'lucide-react';
import type { SchemaGraph, ViewProps } from './types';
import { compareSchemas, diffTableLabel, migrationDraft, parseSchemaSnapshot, resolveDialect, stableValue, tableDDL, unionEdges } from './schema-diff-logic';
import type { DiffStatus, SchemaComparison, TableDiff } from './schema-diff-logic';
import './SchemaDiff.css';

interface Snapshot { graph: SchemaGraph; label: string }
const labels: Record<DiffStatus, string> = { added: 'B only', removed: 'A only', changed: 'Changed', unchanged: 'Unchanged' };
const formatCount = (count: number) => new Intl.NumberFormat().format(count);
const shortName = (name: string, limit = 31) => name.length > limit ? `${name.slice(0, limit - 3)}...` : name;
const displayValue = (value: unknown) => value === undefined ? 'Not recorded' : JSON.stringify(value, null, 2) ?? String(value);

function summary(diff: TableDiff): string {
  return [diffTableLabel(diff.after || diff.before!), labels[diff.status], ...diff.details.slice(0, 12).map(detail => `${detail.kind} ${detail.name}: ${detail.status}${detail.fields.length ? ` (${detail.fields.join(', ')})` : ''}`)].join('\n');
}

function UnionDiagram({ comparison, selected, onSelect, query, changedOnly, zoom }: {
  comparison: SchemaComparison; selected?: string; onSelect: (id: string) => void; query: string; changedOnly: boolean; zoom: number;
}) {
  const pattern = `sd-hatch-${useId().replaceAll(':', '')}`;
  const nodes = useMemo(() => comparison.tables.filter(diff => (!changedOnly || diff.status !== 'unchanged') && (!query || [diff.id, diffTableLabel(diff.after || diff.before!)].some(value => value.toLowerCase().includes(query.toLowerCase())))), [comparison, query, changedOnly]);
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
  const locations = useMemo(() => new Map(nodes.map((node, index) => [node.id, { x: 24 + index % columns * 260, y: 24 + Math.floor(index / columns) * 112 }])), [nodes, columns]);
  const edges = useMemo(() => unionEdges(comparison.before, comparison.after), [comparison]);
  const width = columns * 260 + 24, height = Math.max(136, Math.ceil(nodes.length / columns) * 112 + 24);
  const [hovered, setHovered] = useState<string>();
  if (!nodes.length) return <div className="sd-empty">No tables match this comparison filter.</div>;
  return <div className="sd-graph-scroll" aria-label="Union ERD">
    <svg className="sd-graph" role="group" aria-label={`Union ERD with ${nodes.length} tables`} width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`}>
      <defs><pattern id={pattern} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="var(--sd-removed-fill)" /><line x1="0" y1="0" x2="0" y2="7" stroke="var(--sd-removed)" strokeWidth="1" opacity=".45" /></pattern><clipPath id={`${pattern}-label`}><rect x="12" y="8" width="200" height="22" /></clipPath></defs>
      <g className="sd-edges">{edges.map(edge => {
        const source = locations.get(edge.source), target = locations.get(edge.target);
        if (!source || !target) return null;
        const self = edge.source === edge.target;
        const d = self ? `M ${source.x + 204} ${source.y + 20} C ${source.x + 256} ${source.y - 15}, ${source.x + 256} ${source.y + 100}, ${source.x + 204} ${source.y + 62}` : `M ${source.x + 112} ${source.y + 82} C ${source.x + 112} ${source.y + 104}, ${target.x + 112} ${target.y - 22}, ${target.x + 112} ${target.y}`;
        const active = selected === edge.source || selected === edge.target || hovered === edge.source || hovered === edge.target;
        return <path key={edge.key} d={d} className={`sd-edge sd-status-${edge.status}${active ? ' sd-edge-active' : ''}`} strokeDasharray={(edge.after || edge.before)![0].kind === 'inferred by naming' ? '3 4' : undefined}><title>{`${edge.source} -> ${edge.target}\n${labels[edge.status]}\nA: ${stableValue(edge.before)}\nB: ${stableValue(edge.after)}`}</title></path>;
      })}</g>
      {nodes.map(diff => {
        const { x, y } = locations.get(diff.id)!;
        const table = diff.after || diff.before!;
        return <g key={diff.id} role="button" tabIndex={0} aria-label={`${diffTableLabel(table)}, ${labels[diff.status]}`} aria-pressed={selected === diff.id} className={`sd-node sd-status-${diff.status}${selected === diff.id ? ' sd-selected' : ''}`} transform={`translate(${x} ${y})`} onClick={() => onSelect(diff.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(diff.id); } }} onMouseEnter={() => setHovered(diff.id)} onMouseLeave={() => setHovered(undefined)} onFocus={() => setHovered(diff.id)} onBlur={() => setHovered(undefined)}>
          <title>{`${summary(diff)}\nA: ${diff.before ? `${diff.before.allColumns.length} columns` : 'Absent'}\nB: ${diff.after ? `${diff.after.allColumns.length} columns` : 'Absent'}\n${diff.details.slice(0, 5).map(detail => `${detail.kind} ${detail.name}\nBefore: ${stableValue(detail.before).slice(0, 500)}\nAfter: ${stableValue(detail.after).slice(0, 500)}`).join('\n')}`}</title>
          <rect width="224" height="82" rx="4" style={diff.status === 'removed' ? { fill: `url(#${pattern})` } : undefined} />
          <text x="12" y="23" className="sd-node-name" clipPath={`url(#${pattern}-label)`}>{shortName(diffTableLabel(table))}</text>
          <text x="12" y="44" className="sd-node-meta">A: {diff.before ? `${diff.before.allColumns.length} columns` : 'absent'} / B: {diff.after ? `${diff.after.allColumns.length} columns` : 'absent'}</text>
          <text x="12" y="66" className="sd-node-status">{labels[diff.status]}{diff.details.length ? ` / ${diff.details.length} changes` : ''}</text>
        </g>;
      })}
    </svg>
  </div>;
}

export default function SchemaDiff({ graph, onSelectTable }: ViewProps) {
  const [a, setA] = useState<Snapshot>();
  const [importedB, setB] = useState<Snapshot>();
  const b: Snapshot = importedB || { graph, label: 'Current graph' };
  const [loading, setLoading] = useState({ A: false, B: false });
  const [errors, setErrors] = useState({ A: '', B: '' });
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [zoom, setZoom] = useState(.8);
  const [dialectOverride, setDialect] = useState('');
  const [tab, setTab] = useState<'ddl' | 'changes' | 'migration'>('ddl');
  const inputs = { A: useRef<HTMLInputElement>(null), B: useRef<HTMLInputElement>(null) };
  const readVersion = useRef({ A: 0, B: 0 });
  const comparison = useMemo(() => a ? compareSchemas(a.graph, b.graph) : undefined, [a, b.graph]);
  const dialect = dialectOverride || resolveDialect(b.graph.project?.dialect) || resolveDialect(a?.graph.project?.dialect) || '';
  const active = comparison?.tables.find(table => table.id === selected) || comparison?.tables.find(table => table.status !== 'unchanged') || comparison?.tables[0];
  const ddlA = useMemo(() => tableDDL(a?.graph || graph, active?.before, dialect), [a, graph, active, dialect]);
  const ddlB = useMemo(() => tableDDL(b.graph, active?.after, dialect), [b.graph, active, dialect]);
  const migration = useMemo(() => comparison ? migrationDraft(comparison, dialect) : undefined, [comparison, dialect]);
  const counts = useMemo(() => comparison?.tables.reduce((result, table) => ({ ...result, [table.status]: result[table.status] + 1 }), { added: 0, removed: 0, changed: 0, unchanged: 0 }), [comparison]);
  const tabId = useId();

  async function loadFile(side: 'A' | 'B', file?: File) {
    if (!file) return;
    const token = ++readVersion.current[side];
    setLoading(previous => ({ ...previous, [side]: true }));
    setErrors(previous => ({ ...previous, [side]: '' }));
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Snapshot exceeds the 20 MB limit.');
      const snapshot = { graph: parseSchemaSnapshot(await file.text()), label: file.name };
      if (readVersion.current[side] === token) { if (side === 'A') setA(snapshot); else setB(snapshot); setSelected(undefined); }
    } catch (cause) {
      if (readVersion.current[side] === token) setErrors(previous => ({ ...previous, [side]: cause instanceof Error ? cause.message : 'Snapshot could not be read.' }));
    } finally {
      if (readVersion.current[side] === token) setLoading(previous => ({ ...previous, [side]: false }));
      if (inputs[side].current) inputs[side].current.value = '';
    }
  }

  function useCurrent(side: 'A' | 'B') {
    readVersion.current[side]++;
    setLoading(previous => ({ ...previous, [side]: false }));
    setErrors(previous => ({ ...previous, [side]: '' }));
    if (side === 'A') setA({ graph, label: 'Current graph' }); else setB(undefined);
    setSelected(undefined);
  }
  function exportMigration() {
    if (!migration) return;
    const url = URL.createObjectURL(new Blob([migration.sql], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `schema-diff-A-to-B-${dialect || 'unknown'}-DRAFT.sql`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="sd-root">
    <div className="sd-snapshots">
      {(['A', 'B'] as const).map(side => <div className="sd-snapshot" key={side}>
        <strong className="sd-side-label">{side}</strong>
        <span className="sd-snapshot-name" title={side === 'A' ? a?.label : b.label}>{loading[side] ? 'Reading...' : side === 'A' ? a?.label || 'No snapshot' : b.label}</span>
        <input className="sd-file-input" type="file" accept=".json,application/json" ref={inputs[side]} aria-label={`Choose snapshot ${side}`} onChange={event => loadFile(side, event.target.files?.[0])} />
        <button type="button" className="sd-icon-button" aria-label={`Choose snapshot ${side}`} title={`Choose snapshot ${side}`} onClick={() => inputs[side].current?.click()}><FileUp size={16} aria-hidden="true" /></button>
        <button type="button" className="sd-icon-button" aria-label={`Use current graph as ${side}`} title={`Use current graph as ${side}`} onClick={() => useCurrent(side)}><RotateCcw size={15} aria-hidden="true" /></button>
      </div>)}
      <button type="button" className="sd-icon-button" disabled={!a || loading.A || loading.B} aria-label="Swap snapshots A and B" title="Swap snapshots A and B" onClick={() => { if (a) { setA(b); setB(a); setSelected(undefined); } }}><ArrowLeftRight size={16} aria-hidden="true" /></button>
      <label className="sd-dialect"><span>Dialect</span><select aria-label="Migration dialect" value={dialect} onChange={event => setDialect(event.target.value)}><option value="">Unknown</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option></select></label>
      <button type="button" className="sd-command" disabled={!comparison} title="Export draft migration SQL; no execution" onClick={exportMigration}><ArrowDownToLine size={16} aria-hidden="true" /><span>Export draft</span></button>
    </div>
    {(errors.A || errors.B) && <div className="sd-error" role="alert">{errors.A && <div>A: {errors.A}</div>}{errors.B && <div>B: {errors.B}</div>}</div>}
    <div className="sd-comparison-toolbar">
      <label className="sd-search"><Search size={15} aria-hidden="true" /><input aria-label="Search comparison tables" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tables" /></label>
      <label className="sd-checkbox"><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.target.checked)} />Changes only</label>
      <div className="sd-legend" aria-label="Diff legend">{(['removed', 'added', 'changed', 'unchanged'] as const).map(status => <span className={`sd-legend-item sd-status-${status}`} key={status}><i aria-hidden="true" />{labels[status]}{counts ? ` ${formatCount(counts[status])}` : ''}</span>)}</div>
      <div className="sd-zoom"><button type="button" className="sd-icon-button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= .4} onClick={() => setZoom(value => Math.max(.4, value - .1))}><Minus size={15} aria-hidden="true" /></button><output>{Math.round(zoom * 100)}%</output><button type="button" className="sd-icon-button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 1.6} onClick={() => setZoom(value => Math.min(1.6, value + .1))}><Plus size={15} aria-hidden="true" /></button></div>
    </div>
    {!comparison ? <div className="sd-empty sd-awaiting">Snapshot A is not selected.</div> : <div className="sd-main">
      <UnionDiagram comparison={comparison} selected={active?.id} onSelect={setSelected} query={query} changedOnly={changedOnly} zoom={zoom} />
      <section className="sd-inspector" aria-label="Schema diff inspector">
        <div className="sd-selection">
          <select aria-label="Inspect comparison table" value={active?.id || ''} onChange={event => setSelected(event.target.value)}>{comparison.tables.map(table => <option key={table.id} value={table.id}>{diffTableLabel(table.after || table.before!)} / {labels[table.status]}</option>)}</select>
          <button type="button" className="sd-icon-button" aria-label="Inspect table in schema explorer" title="Inspect table in schema explorer" disabled={!active || !graph.tables.some(table => table.id === active.id)} onClick={() => { if (active) onSelectTable(active.id); }}><ArrowUpRight size={16} aria-hidden="true" /></button>
        </div>
        <div role="tablist" aria-label="Comparison detail" className="sd-tabs">{(['ddl', 'changes', 'migration'] as const).map(value => <button type="button" key={value} role="tab" id={`${tabId}-${value}`} aria-controls={`${tabId}-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => { const tabs = ['ddl', 'changes', 'migration'] as const; const index = tabs.indexOf(value); if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; setTab(next); document.getElementById(`${tabId}-${next}`)?.focus(); } }}>{value === 'ddl' ? 'DDL A / B' : value === 'changes' ? `Changes${active ? ` (${active.details.length})` : ''}` : 'Migration draft'}</button>)}</div>
        <div className="sd-detail-body" role="tabpanel" id={`${tabId}-panel-${tab}`} aria-labelledby={`${tabId}-${tab}`}>
          {tab === 'ddl' && <div className="sd-ddl-pair"><div><h3>A / Before</h3><pre aria-label="Snapshot A DDL">{ddlA.sql}</pre></div><div><h3>B / After</h3><pre aria-label="Snapshot B DDL">{ddlB.sql}</pre></div></div>}
          {tab === 'changes' && <div className="sd-changes">{active?.details.length ? active.details.map((detail, index) => <details key={`${detail.kind}-${detail.name}-${index}`} className={`sd-change sd-status-${detail.status}`}><summary><span>{detail.kind}: {detail.name}</span><span>{detail.fields.join(', ') || labels[detail.status]}</span>{detail.destructive && <strong className="sd-risk">Data review</strong>}</summary><div className="sd-change-values"><div><h3>A / Before</h3><pre>{displayValue(detail.before)}</pre></div><div><h3>B / After</h3><pre>{displayValue(detail.after)}</pre></div></div></details>) : <p className="sd-empty">No structural changes for this table.</p>}</div>}
          {tab === 'migration' && <div className="sd-migration"><div className="sd-migration-status" role="status">{migration?.incomplete.length ? `Incomplete / ${migration.incomplete.length} unresolved items` : 'Draft ready for review'} / {migration?.destructive.length || 0} data-review flags / {migration?.statementCount || 0} statements</div><pre aria-label="Migration SQL draft">{migration?.sql}</pre></div>}
        </div>
      </section>
    </div>}
  </div>;
}
