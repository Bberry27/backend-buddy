import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sankey } from 'd3-sankey';
import { ChevronDown, ChevronRight, LoaderCircle, Play, RotateCcw } from 'lucide-react';
import type { SchemaGraph, LiveConnection } from './types';
import { buildFanout, buildLiveFanout, defaultFanoutRoot, fanoutChildCounts, parsePrimaryKey, primaryKeyColumns } from './fanout-logic';
import type { FanoutModel, LiveFanoutResult } from './fanout-logic';
import './Fanout.css';

type Props = { graph: SchemaGraph; onSelectTable: (id: string) => void; live?: LiveConnection };
const ROW_HEIGHT = 92, NODE_WIDTH = 208, COLUMN_GAP = 190, MARGIN = 24;
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
const ratioLabel = (ratio: number | null) => ratio === null ? 'Unavailable' : `${ratio > 0 && ratio < 0.001 ? ratio.toExponential(2) : numberFormat.format(ratio)}x`;
const countLabel = (count: number | null) => count === null ? 'Rows unknown' : `${count.toLocaleString()} rows`;

function layout(model: FanoutModel) {
  if (!model.nodes.length) return { nodes: [], links: [], width: 1, height: 1 };
  const layerCounts = new Map<number, number>();
  model.nodes.forEach(node => layerCounts.set(node.depth, (layerCounts.get(node.depth) || 0) + 1));
  const sourceDepths = new Map(model.nodes.map(node => [node.id, node.depth]));
  const layerLinks = new Map<number, number>();
  model.links.forEach(link => { const depth = sourceDepths.get(link.source)!; layerLinks.set(depth, (layerLinks.get(depth) || 0) + 1); });
  const height = Math.max(240, Math.max(...layerCounts.values()) * ROW_HEIGHT + MARGIN * 2, Math.max(0, ...layerLinks.values()) * 22 + MARGIN * 2);
  const width = (Math.max(...model.nodes.map(node => node.depth)) + 1) * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP + MARGIN * 2;
  // Sankey determines ordering only. Its conserved node values are never presented as data.
  const arranged = sankey<{ id: string; hopDepth: number }, { id: string }>().nodeId(node => node.id).nodeWidth(NODE_WIDTH).nodePadding(28)
    .nodeAlign((node, count) => Math.min(count - 1, node.hopDepth)).extent([[MARGIN, MARGIN], [width - MARGIN, height - MARGIN]])({
      nodes: model.nodes.map(node => ({ id: node.id, hopDepth: node.depth })),
      links: model.links.map(link => ({ id: link.id, source: link.source, target: link.target, value: 1 })),
    });
  const positions = new Map<string, { x: number; y: number }>();
  for (const depth of layerCounts.keys()) {
    const layer = arranged.nodes.filter(node => node.hopDepth === depth).sort((a, b) => (a.y0! - b.y0!) || a.id.localeCompare(b.id));
    layer.forEach((node, index) => positions.set(node.id, {
      x: MARGIN + depth * (NODE_WIDTH + COLUMN_GAP), y: MARGIN + index * ROW_HEIGHT + (height - MARGIN * 2 - layer.length * ROW_HEIGHT) / 2,
    }));
  }
  const maximumRatio = Math.max(1, ...model.links.map(link => link.ratio || 0));
  const nodes = model.nodes.map(node => ({ ...node, ...positions.get(node.id)! }));
  const links = model.links.map(link => {
    const from = positions.get(link.source)!, to = positions.get(link.target)!;
    const x1 = from.x + NODE_WIDTH, x2 = to.x, y1 = from.y + 36, y2 = to.y + 36;
    return { ...link, path: `M${x1},${y1} C${x1 + COLUMN_GAP / 2},${y1} ${x2 - COLUMN_GAP / 2},${y2} ${x2},${y2}`,
      labelX: x1 + COLUMN_GAP / 2, labelY: (y1 + y2) / 2, curveY: (y1 + y2) / 2,
      stroke: link.ratio === null || link.ratio === 0 ? 1.5 : (link.ratio / maximumRatio) * 24 };
  });
  for (const depth of layerLinks.keys()) {
    const labels = links.filter(link => sourceDepths.get(link.source) === depth).sort((a, b) => a.labelY - b.labelY || a.id.localeCompare(b.id));
    labels.forEach((link, index) => { link.labelY = Math.max(link.labelY, index ? labels[index - 1].labelY + 22 : MARGIN); });
    for (let index = labels.length - 1; index >= 0; index--) labels[index].labelY = Math.min(labels[index].labelY, index === labels.length - 1 ? height - MARGIN : labels[index + 1].labelY - 22);
  }
  return { nodes, links, width, height };
}

export default function Fanout({ graph, onSelectTable, live }: Props) {
  const tables = useMemo(() => [...graph.tables].sort((a, b) => a.id.localeCompare(b.id)), [graph]);
  // How far each table actually fans out, so the view can open somewhere with something to show
  // and can say so when the chosen root has nothing.
  const childCounts = useMemo(() => fanoutChildCounts(graph), [graph]);
  const [rootId, setRootId] = useState(() => defaultFanoutRoot(graph));
  const [depth, setDepth] = useState(2);
  const [mode, setMode] = useState<'schema' | 'row'>('schema');
  const [pkValue, setPkValue] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [liveResult, setLiveResult] = useState<LiveFanoutResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const root = tables.find(table => table.id === rootId) || tables[0];
  const selectedRoot = root?.id || '';
  const tableById = useMemo(() => new Map(tables.map(table => [table.id, table])), [tables]);
  const available = typeof live?.subtree === 'function';
  const primaryKeys = root ? primaryKeyColumns(root) : [];
  useEffect(() => {
    request.current += 1;
    setLiveResult(null); setError(''); setPending(false); setCollapsed(new Set());
    return () => { request.current += 1; controller.current?.abort(); };
  }, [graph, selectedRoot, depth, mode, live, pkValue]);
  const model = useMemo(() => mode === 'row'
    ? liveResult ? buildLiveFanout(liveResult, selectedRoot, collapsed, graph) : { nodes: [], links: [], notices: [] }
    : buildFanout(graph, selectedRoot, depth, collapsed), [graph, selectedRoot, depth, collapsed, mode, liveResult]);
  const drawing = useMemo(() => layout(model), [model]);

  function toggleNode(id: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  async function runSubtree(event: React.FormEvent) {
    event.preventDefault();
    if (!root || !available || !live?.subtree) return;
    let parsed: unknown;
    try { parsed = parsePrimaryKey(root, pkValue); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid primary key.'); return; }
    const token = ++request.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setPending(true); setError(''); setLiveResult(null); setCollapsed(new Set());
    try {
      const result = await live.subtree({ rootTable: selectedRoot, pkValue: parsed, depth, maxRowsPerHop: 10000 }, controller.current.signal);
      if (token === request.current) setLiveResult(result);
    } catch (cause) {
      if (token === request.current) setError(cause instanceof Error ? cause.message : 'The live subtree request failed.');
    } finally { if (token === request.current) setPending(false); }
  }

  return <section className="fanout-view" aria-label="Row fan-out">
    <div className="fanout-toolbar">
      <label className="fanout-root-label">Root table<select aria-label="Root table" value={selectedRoot} onChange={event => { setRootId(event.target.value); setPkValue(''); }} disabled={!tables.length}>
        {!tables.length && <option value="">No tables</option>}
        {tables.map(table => {
          // The child count sits on the option: most tables in a real schema fan out to nothing,
          // and picking one of those blind is what makes the view look broken.
          const children = childCounts.get(table.id) || 0;
          return <option key={table.id} value={table.id}>{table.id}{children ? ` (${children})` : ' (no fan-out)'}</option>;
        })}
      </select></label>
      <label>Depth<select aria-label="Traversal depth" value={depth} onChange={event => setDepth(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value}>{value}</option>)}</select></label>
      <div className="fanout-modes" role="group" aria-label="Fan-out source">
        <button type="button" aria-pressed={mode === 'schema'} onClick={() => setMode('schema')}>Table counts</button>
        <button type="button" aria-pressed={mode === 'row'} disabled={!available} title={!available ? 'A live subtree connection is required' : 'Start from one row'} onClick={() => setMode('row')}>Start from one row</button>
      </div>
      <button type="button" className="fanout-icon-button" onClick={() => setCollapsed(new Set())} disabled={!collapsed.size} aria-label="Expand all branches" title="Expand all branches"><RotateCcw size={16} /></button>
    </div>
    {mode === 'schema' && selectedRoot && !(childCounts.get(selectedRoot) || 0) &&
      <p className="fanout-availability" role="status">
        Nothing fans out from {selectedRoot}: no declared non-unique foreign key points at it. Pick a
        root whose name carries a child count, or use the PK / FK index to see what does reference it.
      </p>}
    {!available && <p className="fanout-availability" role="status">Start from one row unavailable: no live subtree connection.</p>}
    {mode === 'row' && <form className="fanout-live-form" onSubmit={runSubtree}>
      <label><span>{primaryKeys.length > 1 ? `Composite primary key (${primaryKeys.join(', ')})` : `Primary key${primaryKeys.length ? ` (${primaryKeys[0]})` : ''}`}</span>
        <input value={pkValue} onChange={event => setPkValue(event.target.value)} placeholder={primaryKeys.length > 1 ? JSON.stringify(Object.fromEntries(primaryKeys.map(key => [key, '']))) : 'Primary key value'} aria-label="Root primary key value" disabled={!primaryKeys.length} />
      </label>
      <button type="submit" disabled={pending || !available || !primaryKeys.length || !pkValue.trim()}>{pending ? <LoaderCircle className="fanout-spin" size={16} /> : <Play size={16} />} {pending ? 'Loading' : 'Load subtree'}</button>
      <span className="fanout-live-limit">10,000 rows per hop</span>
      {!primaryKeys.length && <span role="status">No known primary key for this table.</span>}
    </form>}
    {error && <p className="fanout-error" role="alert">{error}</p>}
    <div className="fanout-legend">
      <span><i className="fanout-sample" /> Local ratio: child rows / parent rows</span>
      <span><i className="fanout-sample fanout-sample-unknown" /> Unavailable or zero: structural guide</span>
      <span>Independent factors, not conserved flow. Counts are not additive.</span>
      {mode === 'schema' && <span>Declared non-unique FKs only. Table-wide ratios are estimates, not per-row matches.</span>}
    </div>
    {model.notices.length > 0 && <div className="fanout-notices" role="status">{model.notices.map(notice => <p key={notice}>{notice}</p>)}</div>}
    <div className="fanout-scroll" tabIndex={0} aria-label="Fan-out diagram and relationship ratios" aria-busy={pending}>
      {!drawing.nodes.length ? <div className="fanout-empty">{pending ? 'Loading the selected row and its descendants...' : mode === 'row' ? 'No row subtree loaded.' : 'No tables available.'}</div>
        : <>
          <div className="fanout-canvas" style={{ width: drawing.width, height: drawing.height }}>
            <svg width={drawing.width} height={drawing.height} className="fanout-ribbons" aria-hidden="true">
              {drawing.links.map(link => <path key={link.id} d={link.path} fill="none" className={link.ratio === null || link.ratio === 0 ? 'fanout-structural' : 'fanout-quantitative'} strokeWidth={link.stroke}><title>{ratioLabel(link.ratio)}{link.reason ? `: ${link.reason}` : ''}</title></path>)}
              {drawing.links.map(link => <g key={`label-${link.id}`}>
                {Math.abs(link.labelY - link.curveY) > 6 && <line x1={link.labelX} x2={link.labelX} y1={link.curveY} y2={link.labelY} className="fanout-label-guide" />}
                <text x={link.labelX} y={link.labelY} textAnchor="middle" dominantBaseline="middle" className="fanout-ratio-label">{ratioLabel(link.ratio)}{link.truncated ? '*' : ''}</text>
              </g>)}
            </svg>
            {drawing.nodes.map(node => {
              const table = tableById.get(node.tableId);
              return <div key={node.id} className={`fanout-node${node.truncated ? ' fanout-node-partial' : ''}`} style={{ left: node.x, top: node.y, width: NODE_WIDTH }}>
                <button type="button" className="fanout-table-button" onClick={() => onSelectTable(node.tableId)} title={node.tableId} aria-label={`Inspect ${node.tableId}, ${countLabel(node.rowCount)}`}>
                  <span className="fanout-table-name">{table?.name || node.tableId}</span>
                  <span className="fanout-node-meta">{table?.schema || table?.domain || 'Table'} | depth {node.depth}</span>
                  <span className="fanout-count">{countLabel(node.rowCount)}{node.truncated ? ' (partial)' : ''}</span>
                </button>
                <button type="button" className="fanout-node-toggle" disabled={!node.expandable} onClick={() => toggleNode(node.id)} aria-label={`${collapsed.has(node.id) ? 'Expand' : 'Collapse'} ${node.tableId} at depth ${node.depth}`} aria-expanded={node.expandable ? !collapsed.has(node.id) : undefined} title={node.expandable ? `${collapsed.has(node.id) ? 'Expand' : 'Collapse'} branch` : 'No further branches at this depth'}>{collapsed.has(node.id) ? <ChevronRight size={17} /> : <ChevronDown size={17} />}</button>
              </div>;
            })}
          </div>
          {!drawing.links.length && <p className="fanout-no-links">No visible child relationships at this depth.</p>}
          {!!drawing.links.length && <table className="fanout-ratio-table">
            <caption>Local relationship ratios</caption><thead><tr><th scope="col">Parent</th><th scope="col">Child</th><th scope="col">Local ratio</th><th scope="col">Evidence</th></tr></thead>
            <tbody>{drawing.links.map(link => {
              const parent = model.nodes.find(node => node.id === link.source)!, child = model.nodes.find(node => node.id === link.target)!;
              return <tr key={link.id}><td><button type="button" onClick={() => onSelectTable(parent.tableId)}>{parent.tableId}</button><small>Depth {parent.depth}</small></td>
                <td><button type="button" onClick={() => onSelectTable(child.tableId)}>{child.tableId}</button><small>Depth {child.depth}{link.columns ? ` | ${link.columns}` : ''}</small></td>
                <td>{ratioLabel(link.ratio)}</td><td>{link.reason || (mode === 'row' ? 'Live subtree' : 'Table-wide counts')}{link.truncated ? ' (partial)' : ''}{link.count !== undefined ? ` | ${link.count.toLocaleString()} matching rows` : ''}</td></tr>;
            })}</tbody>
          </table>}
        </>}
    </div>
  </section>;
}
