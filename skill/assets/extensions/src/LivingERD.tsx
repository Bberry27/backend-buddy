import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, EdgeLabelRenderer, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { Download, Expand, Image, LocateFixed, Maximize2, Minimize2, Pin, PinOff, RotateCcw, Search, ZoomIn, ZoomOut } from 'lucide-react';
import { toPng, toSvg } from 'html-to-image';
import type { SchemaTable, ViewProps } from './types';
import { ERD_TIER_EDGES, ERD_TIER_HYSTERESIS, domainAggregates, domainBounds, erdTier, layoutTables, neighborhood, nodeSize, planErdEdges, readPositions, rowLabel, savePositions, snapshotKey, visibleGraph, type DomainRibbon, type ErdTier, type Positions, type Relation } from './living-logic';
import { useTheme } from './theme';
import '@xyflow/react/dist/style.css';
import './LivingERD.css';

type TableData = { table: SchemaTable; detailed: boolean; pinned: boolean; dimmed: boolean; togglePin: (id: string) => void; foreign: Set<string> };
type TableNode = Node<TableData, 'table'>;
type DomainData = { name: string; count: number; zoom: number; expanded: boolean; preview: string[]; box: { width: number; height: number }; toggle: () => void };
type DomainNode = Node<DomainData, 'domain'>;
type DiagramNode = TableNode | DomainNode;
type RelationshipEdgeData = { relation: Relation; markerPrefix: string; dimmed: boolean };
type RelationshipEdgeT = Edge<RelationshipEdgeData, 'relationship'>;
type RibbonEdgeT = Edge<{ ribbon: DomainRibbon; zoom: number }, 'ribbon'>;
type DiagramEdge = RelationshipEdgeT | RibbonEdgeT;

// What each tier is called in the toolbar, so the current level of detail is stated rather than
// inferred from how big the boxes happen to look.
const TIER_LABELS: Record<ErdTier, string> = {
  overview: 'Domains', domains: 'Domains + names', tables: 'Tables', detail: 'Columns',
};
function sampleText(value: unknown): string {
  try { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); return text.length > 65 ? text.slice(0, 62) + '...' : text; } catch { return '[value]'; }
}
function TableCard({ data }: NodeProps<TableNode>) {
  const { table, detailed, pinned, togglePin, dimmed, foreign } = data;
  return <div className={`lerd-table${dimmed ? ' lerd-dimmed' : ''}${pinned ? ' lerd-pinned' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <header className="lerd-table-heading">
      <div className="lerd-table-title"><strong title={table.id}>{table.name || table.id}</strong><span>{rowLabel(table)}</span></div>
      <button className="lerd-icon nodrag" title={`${pinned ? 'Unpin' : 'Pin'} ${table.id}`} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${table.id}`} aria-pressed={pinned} onClick={e => { e.stopPropagation(); togglePin(table.id); }}>{pinned ? <Pin size={15} /> : <PinOff size={15} />}</button>
    </header>
    {detailed && <div className="lerd-columns nodrag nowheel">
      {table.allColumns.length === 0 && <div className="lerd-no-columns">No column metadata</div>}
      {table.allColumns.map(column => {
        const topLevelSamples = (column as typeof column & { sampleValues?: unknown[] }).sampleValues;
        const samples = Array.isArray(topLevelSamples) ? topLevelSamples : (column.profiling as (typeof column.profiling & { sampleValues?: unknown[] }))?.sampleValues;
        const pk = column.pk || table.primaryKey?.includes(column.name);
        return <div className="lerd-column" key={column.name}>
          <div className="lerd-column-main"><span title={column.name}>{column.name}</span><span className="lerd-badges">{pk && <b title="Primary key">PK</b>}{(foreign.has(column.name) || !!column.fk) && <b title="Declared foreign key">FK</b>}<i title={column.nullable === 'False' ? 'Not nullable' : column.nullable === 'True' ? 'Nullable' : 'Nullability unknown'}>{column.nullable === 'False' ? 'NOT NULL' : column.nullable === 'True' ? 'NULL' : 'NULL ?'}</i></span></div>
          <div className="lerd-column-type" title={column.type}>{column.type || 'Type unknown'}</div>
          {Array.isArray(samples) && samples.length > 0 && <div className="lerd-samples" title={samples.slice(0, 3).map(sampleText).join(' | ')}>{samples.slice(0, 3).map((value, index) => <code key={index}>{sampleText(value)}</code>)}</div>}
        </div>;
      })}
    </div>}
    <Handle type="source" position={Position.Right} />
  </div>;
}
function DomainCard({ data }: NodeProps<DomainNode>) {
  // Labels are drawn in diagram units, so dividing out the zoom holds them at a constant size on
  // screen however far out the diagram is. The cap is the bubble itself: a small domain shrinks its
  // own label rather than overflowing. The previous factor scaled labels *down* below zoom 0.2,
  // which made the furthest tier -- the one that exists to be read at a glance -- illegible.
  const size = (base: number) => Math.min(base / data.zoom, data.box.height * (base / 110));
  return <div className="lerd-domain">
    {/* React Flow positions an edge from its endpoints' handles and silently drops an edge whose
        endpoint has none, so the ribbons between two collapsed domains need these to exist. */}
    <Handle type="target" position={Position.Left} className="lerd-domain-handle" isConnectable={false} />
    <Handle type="source" position={Position.Right} className="lerd-domain-handle" isConnectable={false} />
    <button className="lerd-domain-head nodrag" onClick={data.toggle} aria-expanded={data.expanded}
      title={`Show the ${data.count} ${data.count === 1 ? 'table' : 'tables'} in ${data.name}`}>
      <strong style={{ fontSize: size(15) }}>{data.name}</strong>
      <span style={{ fontSize: size(11) }}>{data.count} {data.count === 1 ? 'table' : 'tables'}</span>
    </button>
    {data.preview.length > 0 && <ul className="lerd-domain-preview" style={{ fontSize: size(11), gap: size(2) }}>
      {data.preview.map(name => <li key={name}>{name}</li>)}
      {data.count > data.preview.length &&
        <li className="lerd-domain-more">+{data.count - data.preview.length} more</li>}
    </ul>}
  </div>;
}

function RibbonEdge(props: EdgeProps<RibbonEdgeT>) {
  const ribbon = props.data!.ribbon;
  const [path, labelX, labelY] = getBezierPath(props);
  // Thickness stands for how many relationships the thread carries. Evidence stays separable: a
  // ribbon made only of naming guesses is dashed and muted, exactly as a single inferred edge is.
  const onlyInferred = ribbon.declared === 0;
  return <g className="lerd-ribbon">
    <BaseEdge id={props.id} path={path} style={{ stroke: onlyInferred ? 'var(--muted)' : 'var(--accent)',
      strokeWidth: Math.min(9, 1.6 + Math.log1p(ribbon.count) * 2.2), strokeOpacity: 0.45,
      strokeDasharray: onlyInferred ? '10 7' : undefined }} />
    {/* The label renderer is inside the viewport transform, so the count is scaled back up to a
        constant screen size the same way the domain labels are. */}
    <EdgeLabelRenderer><div className="lerd-ribbon-label"
      style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px) scale(${1 / props.data!.zoom})` }}
      title={`${ribbon.count} ${ribbon.count === 1 ? 'relationship' : 'relationships'}: ${ribbon.declared} declared, ${ribbon.inferred} inferred by naming`}>
      {ribbon.count}</div></EdgeLabelRenderer>
  </g>;
}
function RelationshipEdge(props: EdgeProps<RelationshipEdgeT>) {
  const r = props.data!.relation;
  const self = props.source === props.target;
  const [normalPath, labelX, labelY] = getBezierPath(props);
  const loopY = Math.min(props.sourceY, props.targetY) - 85;
  const path = self ? `M${props.sourceX},${props.sourceY} C${props.sourceX + 100},${loopY} ${props.targetX - 100},${loopY} ${props.targetX},${props.targetY}` : normalPath;
  const marker = (name: string) => `url(#${props.data!.markerPrefix}-${name})`;
  const known = r.cardinality !== 'unknown';
  const many = r.junction || r.cardinality === 'one-to-many';
  return <g className={props.data!.dimmed ? 'lerd-edge lerd-dimmed' : 'lerd-edge'}>
    <BaseEdge id={props.id} path={path} markerStart={known ? marker(many ? 'many' : 'one') : undefined} markerEnd={known ? marker(r.junction ? 'many' : 'one') : undefined} style={{ stroke: r.kind === 'inferred by naming' ? 'var(--muted)' : 'var(--accent)', strokeWidth: r.junction ? 2.6 : r.cardinality === 'one-to-one' ? 2 : 1.4, strokeDasharray: r.junction ? '9 5' : r.kind === 'inferred by naming' ? '3 5' : undefined }} />
    <EdgeLabelRenderer><div className={`lerd-edge-label${props.data!.dimmed ? ' lerd-dimmed' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${self ? (props.sourceX + props.targetX) / 2 : labelX}px,${self ? loopY : labelY}px)` }} title={r.junction ? `N:M via ${r.junction}` : `${r.kind}; ${r.pairs.map(p => `${p.column} -> ${p.targetColumn}`).join(', ')}`}>
      {r.junction ? `N:M · ${r.junction}` : r.kind === 'inferred by naming' ? 'Inferred · ?' : r.cardinality === 'unknown' ? 'FK · ?' : r.cardinality === 'one-to-one' ? '1:1' : 'N:1'}
      {r.pairs.length > 1 && !r.junction ? ` (${r.pairs.length})` : ''}
    </div></EdgeLabelRenderer>
  </g>;
}
// One id per domain, shared by the bubble node and by the edge planner that routes a relationship
// to whatever is standing in for a collapsed table.
const bubbleId = (domain: string) => `__lerd_domain_${domain}`;
const nodeTypes = { table: TableCard, domain: DomainCard };
const edgeTypes = { relationship: RelationshipEdge, ribbon: RibbonEdge };

function Diagram({ graph, onSelectTable }: ViewProps) {
  // React Flow paints its own controls, minimap and selection box; colorMode tells it which of
  // its two built-in themes to use, and LivingERD.css maps its variables onto the tokens.
  const colorMode = useTheme();
  const rf = useReactFlow<DiagramNode, DiagramEdge>();
  const [positions, setPositions] = useState<Positions>(() => layoutTables(graph, readPositions(graph)));
  const positionsRef = useRef(positions);
  const domainOfRef = useRef<Map<string, string>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [tier, setTier] = useState<ErdTier>('tables');
  // Domains opened in place. Zooming out collapses back to bubbles without discarding the choice,
  // so a user who opened two domains keeps them open on the way back in.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const [showJunctions, setShowJunctions] = useState(false);
  const [reveal, setReveal] = useState<string>();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const markerPrefix = `lerd-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const fitDiagram = useCallback((duration = 0) => {
    // Fitting must not change what the diagram is showing, so the ceiling stays inside the band the
    // current tier already occupies.
    const clustered = rf.getViewport().zoom < ERD_TIER_EDGES[1];
    const maxZoom = clustered ? ERD_TIER_EDGES[1] / ERD_TIER_HYSTERESIS - 0.001 : 1;
    void rf.fitView({ padding: 0.12, maxZoom, minZoom: 0.001, duration });
  }, [rf]);
  /** Frame a specific set of tables, so arriving somewhere shows its surroundings too. */
  const fitIds = useCallback((ids: string[], duration = 400) => {
    if (!ids.length) return;
    void rf.fitView({ nodes: ids.map(id => ({ id })), padding: 0.28, maxZoom: 1.2, minZoom: 0.001, duration });
  }, [rf]);
  // Fitting has to wait for the render that makes the nodes visible: React Flow measures only what
  // is on the canvas, so a fit issued in the same handler that expands a domain finds nothing to
  // frame and silently leaves the viewport where it was.
  const [pendingFit, setPendingFit] = useState<string[] | null>(null);
  useEffect(() => {
    if (!pendingFit) return;
    const frame = requestAnimationFrame(() => { fitIds(pendingFit); setPendingFit(null); });
    return () => cancelAnimationFrame(frame);
  }, [pendingFit, fitIds]);
  /**
   * Open the domains `reveal` spans, then frame `fit` once those nodes are on the canvas. The two
   * lists differ on a focus: everything the neighbourhood touches is opened, but only what sits
   * near the target is framed.
   */
  const revealAndFit = useCallback((fit: string[], reveal: string[] = fit) => {
    if (!fit.length) return;
    setExpanded(current => new Set([...current, ...reveal.map(id => domainOfRef.current.get(id) || 'Other')]));
    setPendingFit(fit);
  }, []);
  useEffect(() => {
    if (!canvas.current) return;
    let previous: {width: number; height: number} | undefined;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const {width, height} = entry.contentRect;
      if (previous && width > 0 && height > 0 && (Math.abs(width - previous.width) > 1 || Math.abs(height - previous.height) > 1)) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fitDiagram());
      }
      previous = {width, height};
    });
    observer.observe(canvas.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fitDiagram]);
  const key = useMemo(() => snapshotKey(graph), [graph]);
  const shown = useMemo(() => visibleGraph(graph, showJunctions, reveal), [graph, showJunctions, reveal]);
  const detail = tier === 'detail';
  const clustered = tier === 'overview' || tier === 'domains';
  const aggregate = useMemo(() => domainAggregates(shown.tables, shown.relations), [shown]);
  const boxes = useMemo(() => domainBounds(aggregate.domains, positions), [aggregate, positions]);
  const domainOf = useMemo(() => new Map(shown.tables.map(entry => [entry.id, entry.domain || 'Other'])), [shown]);
  domainOfRef.current = domainOf;
  // A table is on the canvas whenever the diagram is past the clustered tiers, or while its own
  // domain is expanded. Bubbles and tables share one coordinate space, so nothing has to move.
  const tableShown = useCallback((id: string) =>
    !clustered || expanded.has(domainOf.get(id) || 'Other'), [clustered, expanded, domainOf]);
  const toggleDomain = useCallback((domain: string) => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(domain)) next.add(domain);
    return next;
  }), []);
  useEffect(() => { setExpanded(new Set()); }, [key]);
  const updatePositions = useCallback((next: Positions, persist = false) => {
    positionsRef.current = next; setPositions(next);
    if (persist && !savePositions(key, next)) setStatus('Layout storage unavailable; positions remain in this session.');
  }, [key]);
  const togglePin = useCallback((id: string) => {
    const current = positionsRef.current;
    updatePositions({ ...current, [id]: { ...current[id], pinned: !current[id].pinned } }, true);
  }, [updatePositions]);
  const neighbors = useMemo(() => {
    const ids = new Set(hovered ? [hovered] : []);
    if (hovered) for (const r of shown.relations) { if (r.source === hovered) ids.add(r.target); if (r.target === hovered) ids.add(r.source); }
    return ids;
  }, [hovered, shown]);
  const foreign = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const link of graph.links) if (link.kind === 'declared FK') { if (!result.has(link.source)) result.set(link.source, new Set()); result.get(link.source)!.add(link.column); }
    return result;
  }, [graph]);
  const focus = useCallback((id: string) => {
    const table = graph.tables.find(entry => entry.id === id);
    if (!table || !positionsRef.current[id]) return;
    setReveal(id); setHovered(null); setSearchOpen(false);
    // Arriving at a table shows what it is attached to, and opens the domains that neighbourhood
    // spans so the fit frames real tables instead of the bubbles standing in for them.
    const around = [...neighborhood(shown.relations, id, 1)].filter(member => positionsRef.current[member]);
    // A cross-domain neighbour is on the far side of the diagram by construction, so framing the
    // whole neighbourhood would zoom back out to the overview and undo the arrival. Frame the
    // table with the neighbours laid out beside it, and open the rest so panning out shows them.
    const home = domainOf.get(id) || 'Other';
    const nearby = around.filter(member => member === id || (domainOf.get(member) || 'Other') === home);
    revealAndFit(nearby.length ? nearby : [id], around);
    onSelectTable(id);
  }, [graph, shown, domainOf, revealAndFit, onSelectTable]);
  const nodes: DiagramNode[] = useMemo(() => {
    const tables: TableNode[] = shown.tables.map(table => {
      const size = nodeSize(table), height = detail ? size.height : 76;
      return { id: table.id, type: 'table', position: positions[table.id] || { x: 0, y: 0 },
        hidden: !tableShown(table.id), width: size.width, height, style: { width: size.width, height },
        data: { table, detailed: detail, pinned: positions[table.id]?.pinned || false,
          dimmed: !!hovered && !neighbors.has(table.id), togglePin, foreign: foreign.get(table.id) || new Set() } };
    });
    if (!clustered) return tables;
    const domainNodes: DomainNode[] = aggregate.domains.map((domain, index) => {
      const box = boxes[index], open = expanded.has(domain.id);
      return { id: bubbleId(domain.id), type: 'domain', position: { x: box.x, y: box.y },
        width: box.width, height: box.height, style: { width: box.width, height: box.height },
        draggable: false, selectable: false, hidden: open, zIndex: 0,
        data: { name: domain.id, count: domain.tables.length, zoom, expanded: open,
          box: { width: box.width, height: box.height },
          // Member names only once they are large enough to read; at the furthest tier they would
          // be an unreadable smear that hides the shape the tier exists to show.
          preview: tier === 'domains' ? domain.tables.slice(0, 10).map(entry => entry.name || entry.id) : [],
          toggle: () => toggleDomain(domain.id) } };
    });
    // Bubbles first so an expanded domain's tables paint over a neighbour's outline.
    return [...domainNodes, ...tables];
  }, [shown, positions, clustered, detail, hovered, neighbors, togglePin, foreign, zoom, tier,
    aggregate, boxes, expanded, tableShown, toggleDomain]);
  const edges: DiagramEdge[] = useMemo(() => {
    const plan = planErdEdges(shown.relations, id => tableShown(id) ? id : bubbleId(domainOf.get(id) || 'Other'));
    const direct = plan.direct.map((relation): DiagramEdge => ({ id: relation.id, source: relation.source,
      target: relation.target, type: 'relationship',
      data: { relation, markerPrefix, dimmed: !!hovered && relation.source !== hovered && relation.target !== hovered } }));
    const ribbons = plan.ribbons.map((ribbon): DiagramEdge => ({ id: ribbon.id, source: ribbon.source,
      target: ribbon.target, type: 'ribbon', data: { ribbon, zoom } }));
    return [...ribbons, ...direct];
  }, [shown, tableShown, domainOf, markerPrefix, hovered, zoom]);
  const matches = useMemo(() => query.trim() ? graph.tables.filter(t => `${t.id} ${t.name || ''} ${t.domain}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 25) : [], [graph, query]);
  const onNodesChange = useCallback((changes: NodeChange<DiagramNode>[]) => {
    const next = { ...positionsRef.current }; let changed = false;
    for (const change of changes) if (change.type === 'position' && change.position && next[change.id]) {
      next[change.id] = { ...next[change.id], ...change.position }; changed = true;
    }
    if (changed) updatePositions(next);
  }, [updatePositions]);
  const relayout = () => {
    const next = layoutTables(graph, positionsRef.current, false);
    updatePositions(next, true); setStatus('Layout refreshed; pinned positions retained.');
    requestAnimationFrame(() => fitDiagram(350));
  };
  const download = async (format: 'svg' | 'png') => {
    if (!canvas.current || exporting) return;
    setExporting(true); setStatus('');
    try {
      const options = { backgroundColor: getComputedStyle(canvas.current).backgroundColor, pixelRatio: 2, skipFonts: true, filter: (node: HTMLElement) => !node.classList?.contains('lerd-export-exclude') };
      const url = await (format === 'svg' ? toSvg(canvas.current, options) : toPng(canvas.current, options));
      const link = document.createElement('a'); link.download = `living-erd.${format}`; link.href = url; link.click();
      setStatus(`${format.toUpperCase()} exported.`);
    } catch (error) { setStatus(`Export failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    finally { setExporting(false); }
  };
  return <section className="lerd-root" aria-label="Living ERD">
    <div className="lerd-toolbar">
      <form className="lerd-search" onSubmit={e => { e.preventDefault(); if (matches[0]) focus(matches[0].id); }}>
        <Search size={16} aria-hidden="true" /><input aria-label="Search tables" placeholder="Search tables" value={query} onFocus={() => setSearchOpen(true)} onChange={e => { setQuery(e.target.value); setSearchOpen(true); }} onKeyDown={e => { if (e.key === 'Escape') setSearchOpen(false); }} />
        {searchOpen && query.trim() && <div className="lerd-search-results">{matches.length ? matches.map(table => <button key={table.id} type="button" onClick={() => focus(table.id)}><span>{table.id}</span><small>{table.domain}</small></button>) : <span>No matching tables</span>}</div>}
      </form>
      <label className="lerd-toggle"><input type="checkbox" checked={showJunctions} onChange={e => { setShowJunctions(e.target.checked); setReveal(undefined); }} />Show junctions</label>
      <div className="lerd-actions">
        <output className="lerd-tier" title="The level of detail the current zoom is showing. Zooming past a boundary changes it; the boundaries have a margin so a diagram parked on one does not flicker.">{TIER_LABELS[tier]}</output>
        {clustered && <button className="lerd-icon" title="Open every domain" aria-label="Open every domain"
          disabled={expanded.size === aggregate.domains.length}
          onClick={() => setExpanded(new Set(aggregate.domains.map(domain => domain.id)))}><Maximize2 size={17} /></button>}
        {clustered && <button className="lerd-icon" title="Close every domain" aria-label="Close every domain"
          disabled={!expanded.size} onClick={() => setExpanded(new Set())}><Minimize2 size={17} /></button>}
        <button className="lerd-icon" title="Zoom out" aria-label="Zoom out" onClick={() => { void rf.zoomOut({ duration: 200 }); }}><ZoomOut size={17} /></button>
        <output className="lerd-zoom">{Math.round(zoom * 100)}%</output>
        <button className="lerd-icon" title="Zoom in" aria-label="Zoom in" onClick={() => { void rf.zoomIn({ duration: 200 }); }}><ZoomIn size={17} /></button>
        <button className="lerd-icon" title="Fit diagram" aria-label="Fit diagram" onClick={() => fitDiagram(300)}><Expand size={17} /></button>
        <button className="lerd-icon" title="Refresh force layout (keep pins)" aria-label="Refresh force layout" onClick={relayout}><RotateCcw size={17} /></button>
        <button className="lerd-icon" title="Unpin all tables" aria-label="Unpin all tables" onClick={() => updatePositions(Object.fromEntries(Object.entries(positionsRef.current).map(([id, p]) => [id, { ...p, pinned: false }])), true)}><LocateFixed size={17} /></button>
        <button className="lerd-icon" title="Export visible diagram as SVG" aria-label="Export SVG" disabled={exporting} onClick={() => { void download('svg'); }}><Download size={17} /></button>
        <button className="lerd-icon" title="Export visible diagram as PNG" aria-label="Export PNG" disabled={exporting} onClick={() => { void download('png'); }}><Image size={17} /></button>
      </div>
    </div>
    <div className="lerd-canvas" ref={canvas}>
      <ReactFlow<DiagramNode, DiagramEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onNodeDragStop={(_, node) => { if (positionsRef.current[node.id]) updatePositions({ ...positionsRef.current, [node.id]: { ...node.position, pinned: true } }, true); }} onNodeClick={(_, node) => { if (node.type === 'table') onSelectTable(node.id); }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'table') focus(node.id);
          else revealAndFit((aggregate.domains.find(domain => bubbleId(domain.id) === node.id)?.tables || []).map(entry => entry.id));
        }} onNodeMouseEnter={(_, node) => { if (node.type === 'table') setHovered(node.id); }} onNodeMouseLeave={() => setHovered(null)} onPaneClick={() => { setHovered(null); setSearchOpen(false); }} onMove={(_, viewport) => { setZoom(viewport.zoom); setTier(current => erdTier(viewport.zoom, current)); }} onInit={() => { requestAnimationFrame(() => fitDiagram()); }} fitView fitViewOptions={{ padding: 0.12, maxZoom: 1, minZoom: 0.001 }} minZoom={0.001} maxZoom={2.6} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} colorMode={colorMode} proOptions={{ hideAttribution: true }}>
        <Background color="var(--line)" gap={28} size={1} />
        <MiniMap className="lerd-minimap lerd-export-exclude" pannable zoomable ariaLabel="Diagram minimap"
          nodeClassName={node => node.type === 'domain' ? 'lerd-minimap-domain' : 'lerd-minimap-table'} />
      </ReactFlow>
      <svg className="lerd-markers" aria-hidden="true"><defs>
        <marker id={`${markerPrefix}-many`} markerWidth="14" markerHeight="14" refX="11" refY="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1 L11 7 L1 13 M1 7 H11" fill="none" stroke="var(--accent)" strokeWidth="1.4" /></marker>
        <marker id={`${markerPrefix}-one`} markerWidth="14" markerHeight="14" refX="10" refY="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M7 1 V13 M1 7 H11" fill="none" stroke="var(--accent)" strokeWidth="1.4" /></marker>
      </defs></svg>
      {!graph.tables.length && <div className="lerd-empty">No tables available.</div>}
    </div>
    <footer className="lerd-footer"><span>{graph.tables.length} tables · {shown.hidden.size} junctions collapsed{clustered ? ` · ${expanded.size} of ${aggregate.domains.length} domains open` : ''}</span><span className="lerd-legend"><i /> Declared FK <i className="lerd-inferred" /> Inferred <i className="lerd-junction" /> N:M <span>? Unknown</span></span><span role="status">{status}</span></footer>
  </section>;
}
export default function LivingERD(props: ViewProps) {
  const key = useMemo(() => snapshotKey(props.graph), [props.graph]);
  return <ReactFlowProvider key={key}><Diagram {...props} /></ReactFlowProvider>;
}
