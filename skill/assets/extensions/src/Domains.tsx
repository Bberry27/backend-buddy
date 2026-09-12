import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cluster, hierarchy } from 'd3-hierarchy';
import type { HierarchyPointNode } from 'd3-hierarchy';
import { arc, curveBundle, lineRadial } from 'd3-shape';
import { ChevronLeft, ChevronRight, Maximize, Minus, Plus, Search } from 'lucide-react';
import type { SchemaGraph, SchemaTable, ViewProps } from './types';
import { computeCommunities, declaredRelations, tableLabel } from './lens-domain-logic';
import { domainColor } from './palettes';
import { useTheme } from './theme';
import './Domains.css';

export { computeCommunities } from './lens-domain-logic';
interface BundleBranch { id: string; community?: string; table?: SchemaTable; children?: BundleBranch[] }
interface Community { id: string; label: string; tables: SchemaTable[]; color: string; cross: number; intra: number; rank: number }

export function buildDomainLayout(graph: SchemaGraph, communities: Map<string, string>, visibleIds: Set<string>, beta = 0.8) {
  const groups = new Map<string, SchemaTable[]>();
  for (const table of graph.tables) if (visibleIds.has(table.id)) {
    const id = communities.get(table.id) || table.id;
    const group = groups.get(id) || []; group.push(table); groups.set(id, group);
  }
  const data: BundleBranch = { id: 'root', children: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([id, tables]) => ({ id, community: id,
    children: tables.sort((a, b) => a.id.localeCompare(b.id)).map(table => ({ id: table.id, table, community: id })) })) };
  const radius = Math.max(220, visibleIds.size * 23 / (2 * Math.PI));
  const maxLabelLength = Math.max(0, ...graph.tables.filter(table => visibleIds.has(table.id)).map(table => Math.min(34, tableLabel(table).length)));
  const padding = Math.max(84, maxLabelLength * 7.2 + 28), size = (radius + padding) * 2;
  const root = cluster<BundleBranch>().size([Math.PI * 2, radius]).separation((a, b) => a.parent === b.parent ? 1 : 1.7)(hierarchy(data));
  const nodes = root.leaves().filter(node => node.data.table);
  const byId = new Map(nodes.map(node => [node.data.id, node]));
  const line = lineRadial<HierarchyPointNode<BundleBranch>>().angle(node => node.x).radius(node => node.y).curve(curveBundle.beta(Math.max(0, Math.min(1, beta))));
  const links = declaredRelations(graph).flatMap(relation => {
    const source = byId.get(relation.source), target = byId.get(relation.target);
    if (!source || !target) return [];
    const self = source === target;
    const x = Math.sin(source.x) * source.y, y = -Math.cos(source.x) * source.y;
    // A self-reference has a real loop; a single-point bundled path would be invisible.
    const path = self ? `M${x},${y} c-28,-32 28,-32 0,0` : line(source.path(target)) || '';
    return [{ ...relation, path, cross: communities.get(relation.source) !== communities.get(relation.target) }];
  });
  const bands = (root.children || []).flatMap(branch => {
    const leaves = branch.leaves(); if (!leaves.length) return [];
    const start = leaves[0].x - 0.02, end = leaves[leaves.length - 1].x + 0.02;
    return [{ id: branch.data.id, path: arc()({ innerRadius: radius - 8, outerRadius: radius - 4, startAngle: start, endAngle: end }) || '' }];
  });
  return { nodes, links, bands, radius, size };
}

export default function Domains({ graph, onSelectTable }: ViewProps) {
  // Community swatches, bands, nodes and links are SVG fills and strokes, so they need a
  // resolved colour rather than a custom property.
  const theme = useTheme();
  const communities = useMemo(() => computeCommunities(graph), [graph]);
  const relations = useMemo(() => declaredRelations(graph), [graph]);
  const [query, setQuery] = useState(''), [community, setCommunity] = useState('');
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'cross' | 'intra'>('all');
  const [page, setPage] = useState(0), [pageSize, setPageSize] = useState(60), [beta, setBeta] = useState(0.8), [manualZoom, setManualZoom] = useState(1);
  const [autoFit, setAutoFit] = useState(true), [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [focused, setFocused] = useState<string | null>(null), [hoverLink, setHoverLink] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const collection = new Map<string, Community>();
    for (const table of graph.tables) {
      const id = communities.get(table.id)!;
      const value = collection.get(id) || { id, label: '', tables: [], color: '', cross: 0, intra: 0, rank: 0 };
      value.tables.push(table); collection.set(id, value);
    }
    const result = [...collection.values()].sort((a, b) => b.tables.length - a.tables.length || a.id.localeCompare(b.id));
    // Colour by the community's own id, not by its rank, so a community keeps its colour when
    // another one gains or loses tables.
    const ids = result.map(group => group.id);
    result.forEach((group, index) => {
      group.tables.sort((a, b) => a.id.localeCompare(b.id));
      group.label = `D${String(index + 1).padStart(2, '0')}`; group.color = domainColor(group.id, ids, theme).color; group.rank = index;
    });
    for (const link of relations) {
      const a = collection.get(communities.get(link.source)!)!, b = collection.get(communities.get(link.target)!)!;
      if (a === b) a.intra++; else { a.cross++; b.cross++; }
    }
    return result;
  }, [graph, communities, relations, theme]);
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  const filtered = useMemo(() => [...graph.tables].filter(table => (!community || communities.get(table.id) === community) &&
    tableLabel(table).toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) =>
    (groupById.get(communities.get(a.id)!)?.rank || 0) - (groupById.get(communities.get(b.id)!)?.rank || 0) || a.id.localeCompare(b.id)), [graph, communities, groupById, community, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, pages - 1);
  const visible = useMemo(() => filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize), [filtered, currentPage, pageSize]);
  const visibleIds = useMemo(() => new Set(visible.map(table => table.id)), [visible]);
  const layout = useMemo(() => buildDomainLayout(graph, communities, visibleIds, beta), [graph, communities, visibleIds, beta]);
  const fitZoom = Math.max(0.01, Math.min(1, (Math.min(viewportSize.width, viewportSize.height) - 24) / layout.size));
  const zoom = autoFit ? fitZoom : manualZoom;
  const drawnLinks = useMemo(() => layout.links.filter(link => edgeFilter === 'all' || (edgeFilter === 'cross' ? link.cross : !link.cross)), [layout, edgeFilter]);
  const crossCount = relations.filter(link => communities.get(link.source) !== communities.get(link.target)).length;
  const omittedCount = relations.filter(link => !visibleIds.has(link.source) || !visibleIds.has(link.target)).length;
  const tableIds = useMemo(() => new Set(graph.tables.map(table => table.id)), [graph]);
  const invalidCount = graph.links.filter(link => link.kind === 'declared FK' && (!tableIds.has(link.source) || !tableIds.has(link.target))).length;
  const focusedTable = graph.tables.find(table => table.id === focused);
  const selectedLink = drawnLinks.find(link => link.id === hoverLink);
  useEffect(() => { setPage(0); setFocused(null); setHoverLink(null); }, [query, community, pageSize, graph]);
  useEffect(() => { setCommunity(''); }, [graph]);
  useEffect(() => { setHoverLink(null); setFocused(null); }, [edgeFilter, currentPage]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setViewportSize(previous => {
      const width = element.clientWidth, height = element.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (element) { element.scrollLeft = Math.max(0, (layout.size * zoom - element.clientWidth) / 2); element.scrollTop = Math.max(0, (layout.size * zoom - element.clientHeight) / 2); }
  }, [zoom, layout.size, visible, viewportSize]);
  function changeZoom(delta: number) { setManualZoom(Math.max(0.01, Math.min(2, zoom + delta))); setAutoFit(false); }
  return <section className="dm-root" aria-label="Auto-clustered domains">
    <div className="dm-toolbar">
      <label className="dm-search"><Search size={15}/><input aria-label="Search domain tables" placeholder="Search tables" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <select aria-label="Detected community" value={community} onChange={event => setCommunity(event.target.value)}><option value="">All communities ({groups.length})</option>{groups.map(group => <option key={group.id} value={group.id}>{group.label}: {group.id} ({group.tables.length})</option>)}</select>
      <select aria-label="Domain relationship scope" value={edgeFilter} onChange={event => setEdgeFilter(event.target.value as typeof edgeFilter)}><option value="all">All relationships</option><option value="cross">Cross-domain only</option><option value="intra">Within-domain only</option></select>
      <label className="dm-bundle">Bundle<input aria-label="Edge bundling strength" type="range" min="0" max="1" step="0.05" value={beta} onChange={event => setBeta(Number(event.target.value))}/></label>
      <div className="dm-zoom"><button aria-label="Zoom out domains" title="Zoom out" disabled={zoom <= 0.01} onClick={() => changeZoom(-0.15)}><Minus size={15}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in domains" title="Zoom in" disabled={zoom >= 2} onClick={() => changeZoom(0.15)}><Plus size={15}/></button><button aria-label="Fit domain diagram" title="Fit diagram" aria-pressed={autoFit} onClick={() => setAutoFit(true)}><Maximize size={15}/></button></div>
    </div>
    <div className="dm-summary"><span>{groups.length} detected communities</span><span>{relations.length} declared FK constraints</span><span>{crossCount} cross-domain</span><span>{graph.links.filter(link => link.kind === 'inferred by naming').length} inferred pairs excluded</span>{invalidCount > 0 && <span>{invalidCount} unresolved FK pairs omitted</span>}</div>
    <div className="dm-workspace">
      <aside className="dm-legend" aria-label="Detected domain legend"><div className="dm-legend-title">Detected Domains</div>
        {groups.map(group => <button key={group.id} className={`dm-domain ${community === group.id ? 'dm-selected' : ''}`} aria-pressed={community === group.id} onClick={() => setCommunity(community === group.id ? '' : group.id)} title={`${group.label}: ${group.tables.map(tableLabel).join(', ')}`}>
          <span className="dm-swatch" style={{ background: group.color }}/><span><strong>{group.label} <span>{group.id}</span></strong><small>{group.tables.length} tables · {group.intra} within · {group.cross} cross</small></span>
        </button>)}
        <details className="dm-method"><summary>Community evidence</summary><p>Deterministic local modularity optimization on the undirected declared-FK graph. A composite FK counts once; separate constraints retain their weight. Communities are structural candidates, not confirmed business domains. Isolated tables remain separate.</p><p>Cross-domain lines use the child community color. Within-domain lines are dashed. FK direction remains child to referenced parent in relationship details. Search, community selection and paging hide out-of-scope links without recomputing communities.</p>{invalidCount > 0 && <p>Some declared links have unresolved endpoints and were omitted.</p>}</details>
      </aside>
      <div className="dm-diagram-shell">
        <div className="dm-viewport" ref={viewport}>
          {visible.length ? <div className="dm-canvas" style={{ width: layout.size * zoom, height: layout.size * zoom }}><svg className="dm-svg" width={layout.size * zoom} height={layout.size * zoom} viewBox={`${-layout.size / 2} ${-layout.size / 2} ${layout.size} ${layout.size}`} aria-label={`Hierarchical edge bundle, ${visible.length} tables, ${drawnLinks.length} visible FK constraints`}>
            <g className="dm-bands">{layout.bands.map(band => <path key={band.id} d={band.path} fill={groupById.get(band.id)?.color}/>)}</g>
            <g className="dm-edges">{drawnLinks.map(link => {
              const highlighted = hoverLink === link.id || focused === link.source || focused === link.target;
              const label = `${link.source} -> ${link.target}; ${link.pairs.map(pair => `${pair.column} -> ${pair.targetColumn}`).join(', ')}; ${link.cross ? 'cross-domain' : 'within-domain'} declared FK`;
              return <path key={link.id} d={link.path} fill="none" stroke={groupById.get(communities.get(link.source)!)?.color} className={`${link.cross ? 'dm-cross' : 'dm-intra'} ${highlighted ? 'dm-highlight' : focused || hoverLink ? 'dm-dim' : ''}`} tabIndex={0} role="button" aria-label={`Inspect ${label}`} onClick={() => onSelectTable(link.source)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectTable(link.source); } }} onMouseEnter={() => setHoverLink(link.id)} onMouseLeave={() => setHoverLink(null)} onFocus={() => setHoverLink(link.id)} onBlur={() => setHoverLink(null)}><title>{label}</title></path>;
            })}</g>
            <g>{layout.nodes.map(node => {
              const left = node.x >= Math.PI, table = node.data.table!, group = groupById.get(node.data.community!)!;
              const label = tableLabel(table), shortened = label.length > 34 ? `${label.slice(0, 31)}...` : label;
              return <g key={table.id} className={`dm-node ${focused === table.id ? 'dm-node-active' : ''}`} transform={`rotate(${node.x * 180 / Math.PI - 90}) translate(${node.y},0)`} tabIndex={0} role="button" aria-label={`Inspect ${label}, ${group.label}`} onClick={() => onSelectTable(table.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectTable(table.id); } }} onMouseEnter={() => setFocused(table.id)} onMouseLeave={() => setFocused(null)} onFocus={() => setFocused(table.id)} onBlur={() => setFocused(null)}>
                <title>{`${label}\n${group.label}: ${group.id}\n${typeof table.rowCount === 'number' && table.rowCount >= 0 && Number.isFinite(table.rowCount) ? `${table.rowCount.toLocaleString()} rows` : 'Rows unknown'}`}</title>
                <rect x={left ? -(shortened.length * 7.2 + 16) : -8} y="-11" width={shortened.length * 7.2 + 24} height="22" transform={left ? 'rotate(180)' : undefined} fill="transparent" pointerEvents="all"/>
                <circle r="4" fill={group.color}/><text dy="0.32em" x={left ? -12 : 12} textAnchor={left ? 'end' : 'start'} transform={left ? 'rotate(180)' : undefined}>{shortened}</text>
              </g>;
            })}</g>
          </svg></div> : <div className="dm-empty">{graph.tables.length ? 'No tables match these filters.' : 'No tables in this schema.'}</div>}
        </div>
        <div className="dm-table-list" aria-label="Visible domain tables">
          {visible.map(table => <button key={table.id} title={`Inspect ${tableLabel(table)}`} onClick={() => onSelectTable(table.id)} onMouseEnter={() => setFocused(table.id)} onMouseLeave={() => setFocused(null)} onFocus={() => setFocused(table.id)} onBlur={() => setFocused(null)}>
            <span className="dm-swatch" style={{ background: groupById.get(communities.get(table.id)!)?.color }}/><span>{tableLabel(table)}</span>
          </button>)}
        </div>
        {(focusedTable || selectedLink) && <div className="dm-tooltip" role="status">{selectedLink ? <><strong>{selectedLink.source} <span>to</span> {selectedLink.target}</strong><span>{selectedLink.cross ? 'Cross-domain' : 'Within-domain'} declared FK · {selectedLink.pairs.length} column {selectedLink.pairs.length === 1 ? 'pair' : 'pairs'}</span>{selectedLink.pairs.map(pair => <span key={`${pair.column}:${pair.targetColumn}`}>{pair.column} → {pair.targetColumn}</span>)}</> : focusedTable ? <><strong>{tableLabel(focusedTable)}</strong><span>{groupById.get(communities.get(focusedTable.id)!)?.label} · {focusedTable.allColumns.length} columns</span><span>{typeof focusedTable.rowCount === 'number' && focusedTable.rowCount >= 0 && Number.isFinite(focusedTable.rowCount) ? `${focusedTable.rowCount.toLocaleString()} rows` : 'Rows unknown'}</span></> : null}</div>}
        <div className="dm-visible-note">{drawnLinks.length} relationships drawn · {omittedCount} outside page/filter</div>
      </div>
    </div>
    <footer className="dm-footer"><span>{filtered.length ? currentPage * pageSize + 1 : 0}-{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length} tables</span><label>Per page <select aria-label="Domain tables per page" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[30, 60, 100].map(value => <option key={value}>{value}</option>)}</select></label><div><button title="Previous domain page" aria-label="Previous domain page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16}/></button><span>{currentPage + 1} / {pages}</span><button title="Next domain page" aria-label="Next domain page" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16}/></button></div></footer>
  </section>;
}
