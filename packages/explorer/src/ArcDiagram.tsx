import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { scalePoint } from 'd3-scale';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { ViewProps } from './types';
import { buildDependencyModel, dependencyName, dependencyTopology, type DependencyArc } from './dependency-logic';
import { ARC_COLORS } from './palettes';
import { useTheme } from './theme';
import './ArcDiagram.css';

interface ArcDiagramProps extends ViewProps { onSelectTables?: (ids: string[]) => void }
const STEP = 38;
const shorten = (name: string) => name.length > 20 ? `${name.slice(0, 17)}...` : name;

export default function ArcDiagram({ graph, onSelectTable, onSelectTables }: ArcDiagramProps) {
  // SVG marker fills and stroke attributes need resolved colours, not custom properties.
  const arcColors = ARC_COLORS[useTheme()];
  const model = useMemo(() => buildDependencyModel(graph), [graph]);
  const topology = useMemo(() => dependencyTopology(model), [model]);
  const [showCycles, setShowCycles] = useState(true);
  const [hover, setHover] = useState<{ tableId?: string; fkId?: string } | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(420);
  const [chartHeight, setChartHeight] = useState(0);
  useLayoutEffect(() => {
    const element = chart.current!;
    const measure = () => { setChartWidth(element.clientWidth); setChartHeight(element.clientHeight); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const width = Math.max(420, chartWidth, (topology.tables.length - 1) * STEP + 100);
  const x = useMemo(() => scalePoint<string>().domain(topology.tables.map(table => table.id))
    .range([50, width - 50]), [topology.tables, width]);
  const byId = useMemo(() => new Map(topology.tables.map(table => [table.id, table])), [topology.tables]);
  const cycleIds = useMemo(() => new Set(topology.cycles.flatMap(component => component.members)), [topology]);
  const maxDistance = Math.max(1, ...topology.arcs.filter(arc => !arc.backward).map(arc => Math.abs(arc.sourceIndex - arc.targetIndex)));
  const maxBackDistance = Math.max(1, ...topology.arcs.filter(arc => arc.backward).map(arc => Math.abs(arc.sourceIndex - arc.targetIndex)));
  const spacing = (width - 100) / Math.max(1, topology.tables.length - 1);
  const forwardHeight = topology.arcs.some(arc => !arc.backward) ? Math.min(206, maxDistance * spacing * 0.55) : 0;
  const backwardHeight = topology.arcs.some(arc => arc.backward) ? Math.max(52, Math.min(96, maxBackDistance * spacing * 0.55)) : 0;
  const baseline = forwardHeight + 28, labelY = baseline + backwardHeight + 30, height = Math.max(260, labelY + 132);
  useLayoutEffect(() => {
    if (!chart.current || !chartHeight) return;
    // Frame labels in short viewports while retaining the axis and scroll access
    // to the full arcs. User scrolling does not trigger another framing pass.
    chart.current.scrollTop = Math.max(0, Math.min(baseline - 16, labelY + 120 - chartHeight));
  }, [graph, chartWidth, chartHeight, baseline, labelY]);
  const hoveredArc = hover?.fkId ? topology.arcs.find(arc => arc.foreignKey.id === hover.fkId) : undefined;
  const hoveredTable = hover?.tableId ? byId.get(hover.tableId) : undefined;
  const associated = (arc: DependencyArc) => hover?.fkId === arc.foreignKey.id || hover?.tableId === arc.foreignKey.source || hover?.tableId === arc.foreignKey.target;
  const arcPath = (arc: DependencyArc) => {
    const source = x(arc.foreignKey.source)!, target = x(arc.foreignKey.target)!;
    if (source === target) return `M${source},${baseline} C${source + 24},${baseline + 68} ${source - 24},${baseline + 68} ${source},${baseline}`;
    const distance = Math.abs(arc.sourceIndex - arc.targetIndex);
    const rise = arc.backward ? distance / maxBackDistance * backwardHeight : distance / maxDistance * forwardHeight;
    return `M${source},${baseline} Q${(source + target) / 2},${baseline + (arc.backward ? 2 : -2) * rise} ${target},${baseline}`;
  };
  const selectArc = (arc: DependencyArc) => {
    if (onSelectTables) onSelectTables([...new Set([arc.foreignKey.source, arc.foreignKey.target])]);
    else onSelectTable(arc.foreignKey.source);
  };
  const activate = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
  };
  return <section className="schema-arc" aria-label="Arc Diagram">
    <div className="schema-arc-toolbar">
      <strong>Arc Diagram</strong><span>{topology.tables.length} tables · {model.foreignKeys.length} declared FKs</span>
      <span className="schema-arc-cycle-count">{topology.cycles.length} cyclic {topology.cycles.length === 1 ? 'group' : 'groups'}</span>
      <button type="button" title={showCycles ? 'Hide cycle groups' : 'Show cycle groups'} aria-label={showCycles ? 'Hide cycle groups' : 'Show cycle groups'}
        aria-expanded={showCycles} aria-controls={`${rawId}-cycles`} onClick={() => setShowCycles(value => !value)}>
        {showCycles ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
      </button>
    </div>
    <div className={`schema-arc-body${showCycles ? ' schema-arc-with-panel' : ''}`}>
      <div className="schema-arc-chart" ref={chart} tabIndex={0} aria-label="Parent-first table dependencies">
        {!topology.tables.length ? <div className="schema-arc-empty">No tables in this schema.</div> :
          <svg width={width} height={height} role="group" aria-label="Foreign keys point from child tables to parent tables">
            <defs>
              <marker id={`${rawId}-normal`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 Z" fill={arcColors.normal} />
              </marker>
              <marker id={`${rawId}-warning`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 Z" fill={arcColors.cycle} />
              </marker>
            </defs>
            <line x1="28" y1={baseline} x2={width - 28} y2={baseline} stroke="var(--line)" />
            {[...topology.arcs].sort((a, b) => Math.abs(b.sourceIndex - b.targetIndex) - Math.abs(a.sourceIndex - a.targetIndex)).map(arc => {
              const selected = associated(arc), warning = arc.cyclic;
              const fk = arc.foreignKey;
              const label = `${fk.name}: ${fk.source} to ${fk.target}${arc.cyclic ? '; cycle' : ''}; ${fk.columns.map(column => `${column.source} to ${column.target}`).join(', ')}; ON DELETE ${fk.onDelete}`;
              return <g key={fk.id} role="button" tabIndex={0} className="schema-arc-edge" aria-label={label}
                onFocus={() => setHover({ fkId: fk.id })} onBlur={() => setHover(null)}
                onPointerEnter={() => setHover({ fkId: fk.id })} onPointerLeave={() => setHover(null)}
                onClick={() => selectArc(arc)} onKeyDown={event => activate(event, () => selectArc(arc))}>
                <title>{label}</title>
                <path d={arcPath(arc)} fill="none" stroke={warning ? arcColors.cycle : arcColors.normal}
                  strokeWidth={selected ? 3 : 1.5} opacity={hover && !selected ? 0.22 : 0.82}
                  strokeDasharray={warning ? '5 3' : undefined} markerEnd={`url(#${rawId}-${warning ? 'warning' : 'normal'})`} />
                <path d={arcPath(arc)} fill="none" stroke="transparent" strokeWidth="12" />
              </g>;
            })}
            {topology.tables.map(table => {
              const position = x(table.id)!, isolated = topology.isolated.has(table.id);
              const selected = hover?.tableId === table.id || hoveredArc?.foreignKey.source === table.id || hoveredArc?.foreignKey.target === table.id;
              const fill = isolated ? arcColors.isolated : cycleIds.has(table.id) ? arcColors.cycle : arcColors.normal;
              return <g key={table.id} className="schema-arc-node" role="button" tabIndex={0}
                aria-label={`${dependencyName(table)}${isolated ? '; isolated table' : cycleIds.has(table.id) ? '; cycle member' : ''}`}
                onFocus={() => setHover({ tableId: table.id })} onBlur={() => setHover(null)}
                onPointerEnter={() => setHover({ tableId: table.id })} onPointerLeave={() => setHover(null)}
                onClick={() => onSelectTable(table.id)} onKeyDown={event => activate(event, () => onSelectTable(table.id))}>
                <title>{table.id}</title>
                <rect x={position - 11} y={baseline - 14} width="22" height="28" fill="transparent" />
                <rect x={position - 11} y={labelY - 8} width="22" height={height - labelY} fill="transparent" />
                {isolated ? <line x1={position} x2={position} y1={baseline - 6} y2={baseline + 6} stroke={fill} strokeWidth="3" /> :
                  <circle cx={position} cy={baseline} r={selected ? 6 : 4} fill={fill} stroke="var(--bg)" strokeWidth="1.5" />}
                <line x1={position} x2={position} y1={baseline + 9} y2={labelY - 10} stroke="var(--line)" strokeDasharray="1 5" pointerEvents="none" />
                <text transform={`translate(${position + 4},${labelY}) rotate(90)`} fontSize="11"
                  fill={selected ? 'var(--accent)' : isolated ? 'var(--muted)' : 'var(--ink)'}>{shorten(dependencyName(table))}</text>
              </g>;
            })}
          </svg>}
      </div>
      {showCycles && <aside className="schema-arc-cycles" id={`${rawId}-cycles`} aria-label="Strongly connected cycle groups">
        <h3>Cycle Groups</h3>
        {!topology.cycles.length ? <p>No declared FK cycles.</p> : topology.cycles.map((component, index) =>
          <div key={component.id} className="schema-arc-cycle-group">
            <strong>Group {index + 1} · {component.members.length} {component.members.length === 1 ? 'table' : 'tables'}</strong>
            {component.selfLoop && <span className="schema-arc-self">Contains self-reference</span>}
            <ul>{component.members.map(id => <li key={id}><button type="button" title={id} onClick={() => onSelectTable(id)}
              onPointerEnter={() => setHover({ tableId: id })} onPointerLeave={() => setHover(null)}
              onFocus={() => setHover({ tableId: id })} onBlur={() => setHover(null)}>{dependencyName(byId.get(id)!)}</button></li>)}</ul>
          </div>)}
      </aside>}
    </div>
    <div className="schema-arc-detail" role={hoveredTable || hoveredArc ? 'tooltip' : undefined} aria-live="polite">
      {hoveredTable ? <><strong>{hoveredTable.id}</strong><span>{hoveredTable.domain || 'Unassigned'}{topology.isolated.has(hoveredTable.id) ? ' · Isolated' : cycleIds.has(hoveredTable.id) ? ' · Cycle member' : ''}</span></> : hoveredArc && <>
        <strong>{hoveredArc.foreignKey.name} · {hoveredArc.foreignKey.source} → {hoveredArc.foreignKey.target}</strong>
        <span>{hoveredArc.foreignKey.columns.map(column => `${column.source} → ${column.target}`).join(', ')} · ON DELETE {hoveredArc.foreignKey.onDelete}</span>
      </>}
    </div>
    <div className="schema-arc-legend">
      <span><i />Child → parent</span><span><i className="schema-arc-warning" />Cyclic FK</span>
      <span><i className="schema-arc-isolated" />Isolated</span><span>Parents first · Backward cycle edges below</span>
      {model.ignoredLinks > 0 && <span>{model.ignoredLinks} inferred or unresolved links excluded</span>}
    </div>
  </section>;
}
