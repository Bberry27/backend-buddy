import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { scaleBand } from 'd3-scale';
import type { ViewProps } from './types';
import { buildDependencyModel, dependencyCellKey, dependencyDescription, dependencyName, orderDependencyTables,
  type DependencyCell, type DependencyOrder } from './dependency-logic';
import { HOST_COLORS, MATRIX_COLORS, type Theme } from './palettes';
import { useTheme } from './theme';
import './JoinMatrix.css';

interface JoinMatrixProps extends ViewProps { onSelectTables?: (ids: string[]) => void }
const CELL = 26, LEFT = 164, TOP = 132;
/** Cell colours per cardinality: the soft entry for one declared foreign key, the plain one for several. */
const cardinalityColors = (theme: Theme) => {
  const matrix = MATRIX_COLORS[theme];
  return {
    'one-to-one': [matrix.oneToOneSoft, matrix.oneToOne],
    'one-to-many': [matrix.oneToManySoft, matrix.oneToMany],
    unknown: [matrix.unknownSoft, matrix.unknown],
  };
};
const color = (cell: DependencyCell, colors: ReturnType<typeof cardinalityColors>) =>
  colors[cell.cardinality][cell.foreignKeys.length > 1 ? 1 : 0];
const trim = (name: string, length: number) => name.length <= length ? name : `${name.slice(0, length - 3)}...`;

export default function JoinMatrix({ graph, onSelectTable, onSelectTables }: JoinMatrixProps) {
  // The canvas and the SVG both need resolved colour strings, so the theme is read as state
  // rather than derived from the DOM per paint: a theme change re-renders and repaints.
  const theme = useTheme();
  const colors = useMemo(() => cardinalityColors(theme), [theme]);
  const surface = HOST_COLORS[theme];
  const model = useMemo(() => buildDependencyModel(graph), [graph]);
  const [order, setOrder] = useState<DependencyOrder>('alpha');
  const [relatedOnly, setRelatedOnly] = useState(false);
  const tables = useMemo(() => orderDependencyTables(model, order, relatedOnly), [model, order, relatedOnly]);
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 640, height: 420 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, ''), cellId = `matrix-cell-${rawId}`;
  const scale = useMemo(() => scaleBand<string>().domain(tables.map(table => table.id)).range([0, tables.length * CELL]), [tables]);
  const useCanvas = tables.length > 100;
  const firstRow = Math.max(0, Math.floor(scroll.y / CELL)), lastRow = Math.min(tables.length, Math.ceil((scroll.y + size.height - TOP) / CELL));
  const firstCol = Math.max(0, Math.floor(scroll.x / CELL)), lastCol = Math.min(tables.length, Math.ceil((scroll.x + size.width - LEFT) / CELL));
  const rows = tables.slice(firstRow, Math.max(firstRow, lastRow)), cols = tables.slice(firstCol, Math.max(firstCol, lastCol));
  const activeSource = active ? tables[active.row] : undefined, activeTarget = active ? tables[active.col] : undefined;
  const activeCell = activeSource && activeTarget ? model.cells.get(dependencyCellKey(activeSource.id, activeTarget.id)) : undefined;
  const description = activeSource && activeTarget ? activeCell ? dependencyDescription(activeCell) :
    `${activeSource.id} -> ${activeTarget.id}; no declared foreign key` : '';

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight
      ? previous : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setActive(null); setScroll({ x: 0, y: 0 });
    if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
  }, [tables]);

  useLayoutEffect(() => {
    if (!useCanvas || !canvas.current) return;
    const context = canvas.current.getContext('2d');
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.current.width = Math.max(1, Math.ceil(size.width * ratio));
    canvas.current.height = Math.max(1, Math.ceil(size.height * ratio));
    context.scale(ratio, ratio);
    // The host page may override a variable, so the computed value wins; the palette is the
    // fallback for a view mounted where tokens.css has not been applied to this element.
    const style = getComputedStyle(viewport.current!);
    const bg = style.getPropertyValue('--bg').trim() || surface.bg;
    const panel = style.getPropertyValue('--panel').trim() || surface.panel;
    const line = style.getPropertyValue('--line').trim() || surface.line;
    const ink = style.getPropertyValue('--ink').trim() || surface.ink;
    const accent = style.getPropertyValue('--accent').trim() || surface.accent;
    context.fillStyle = bg; context.fillRect(0, 0, size.width, size.height);
    context.save(); context.beginPath(); context.rect(LEFT, TOP, Math.max(0, size.width - LEFT), Math.max(0, size.height - TOP)); context.clip();
    for (let row = firstRow; row < lastRow; row++) for (let col = firstCol; col < lastCol; col++) {
      const x = LEFT + scale(tables[col].id)! - scroll.x, y = TOP + scale(tables[row].id)! - scroll.y;
      const cell = model.cells.get(dependencyCellKey(tables[row].id, tables[col].id));
      if (cell) {
        context.fillStyle = color(cell, colors); context.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
        if (cell.foreignKeys.length > 1) {
          context.fillStyle = MATRIX_COLORS[theme].countInk; context.font = '10px sans-serif'; context.textAlign = 'center';
          context.fillText(String(cell.foreignKeys.length), x + CELL / 2, y + 17);
        }
      }
      context.strokeStyle = active?.row === row && active?.col === col ? accent : line;
      context.lineWidth = active?.row === row && active?.col === col ? 2 : 0.5;
      context.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
    }
    context.restore();
    context.fillStyle = panel; context.fillRect(0, 0, size.width, TOP); context.fillRect(0, TOP, LEFT, size.height - TOP);
    context.font = '11px sans-serif';
    context.save(); context.beginPath(); context.rect(0, TOP, LEFT, Math.max(0, size.height - TOP)); context.clip();
    for (let row = firstRow; row < lastRow; row++) {
      const y = TOP + scale(tables[row].id)! - scroll.y;
      if (active?.row === row) { context.fillStyle = line; context.fillRect(0, y, LEFT, CELL); }
      context.fillStyle = active?.row === row ? accent : ink; context.textAlign = 'right';
      context.fillText(trim(dependencyName(tables[row]), 23), LEFT - 9, y + 17);
    }
    context.restore();
    context.save(); context.beginPath(); context.rect(LEFT, 0, Math.max(0, size.width - LEFT), TOP); context.clip();
    for (let col = firstCol; col < lastCol; col++) {
      const x = LEFT + scale(tables[col].id)! - scroll.x;
      if (active?.col === col) { context.fillStyle = line; context.fillRect(x, 0, CELL, TOP); }
      context.save(); context.translate(x + 17, TOP - 9); context.rotate(-Math.PI / 2);
      context.fillStyle = active?.col === col ? accent : ink; context.textAlign = 'left';
      context.fillText(trim(dependencyName(tables[col]), 18), 0, 0); context.restore();
    }
    context.restore();
    context.fillStyle = ink; context.textAlign = 'left'; context.font = '11px sans-serif';
    context.fillText('Parent columns', 12, TOP - 35); context.fillText('Child rows', 12, TOP - 16);
  }, [useCanvas, size, scroll, tables, model, active, scale, firstRow, lastRow, firstCol, lastCol, colors, surface, theme]);

  const select = (row: number, col: number) => {
    if (!tables[row] || !tables[col]) return;
    const ids = [...new Set([tables[row].id, tables[col].id])];
    if (onSelectTables) onSelectTables(ids); else onSelectTable(tables[row].id);
  };
  const position = (event: React.PointerEvent | React.MouseEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    return { x, y, row: Math.floor((y - TOP + scroll.y) / CELL), col: Math.floor((x - LEFT + scroll.x) / CELL) };
  };
  const hover = (event: React.PointerEvent) => {
    const { x, y, row, col } = position(event);
    if (x >= LEFT && y >= TOP && tables[row] && tables[col])
      setActive(previous => previous?.row === row && previous.col === col ? previous : { row, col });
  };
  const click = (event: React.MouseEvent) => {
    const { x, y, row, col } = position(event);
    if (x < LEFT && y >= TOP && tables[row]) onSelectTable(tables[row].id);
    else if (y < TOP && x >= LEFT && tables[col]) onSelectTable(tables[col].id);
    else if (x >= LEFT && y >= TOP) { select(row, col); viewport.current?.focus({ preventScroll: true }); }
  };
  const navigate = (event: React.KeyboardEvent) => {
    if (!tables.length) return;
    let row = active?.row || 0, col = active?.col || 0;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row, col); return; }
    if (event.key === 'ArrowUp') row--; else if (event.key === 'ArrowDown') row++;
    else if (event.key === 'ArrowLeft') col--; else if (event.key === 'ArrowRight') col++;
    else if (event.key === 'Home') { col = 0; if (event.ctrlKey) row = 0; }
    else if (event.key === 'End') { col = tables.length - 1; if (event.ctrlKey) row = tables.length - 1; }
    else return;
    event.preventDefault(); row = Math.max(0, Math.min(tables.length - 1, row)); col = Math.max(0, Math.min(tables.length - 1, col));
    setActive({ row, col });
    const element = viewport.current!;
    const x = col * CELL, y = row * CELL;
    if (x < element.scrollLeft) element.scrollLeft = x;
    else if (x + CELL > element.scrollLeft + size.width - LEFT) element.scrollLeft = x + CELL - size.width + LEFT;
    if (y < element.scrollTop) element.scrollTop = y;
    else if (y + CELL > element.scrollTop + size.height - TOP) element.scrollTop = y + CELL - size.height + TOP;
  };
  return <section className="schema-matrix" aria-label="Join Matrix">
    <div className="schema-matrix-toolbar">
      <strong>Join Matrix</strong><span>{tables.length} tables · {model.foreignKeys.length} declared FKs</span>
      <label>Order <select aria-label="Table order" value={order} onChange={event => setOrder(event.target.value as DependencyOrder)}>
        <option value="alpha">Alphabetical</option><option value="rowcount">Row count</option>
        <option value="schema">Schema</option><option value="rcm">Reverse Cuthill-McKee</option>
      </select></label>
      <label><input type="checkbox" checked={relatedOnly} onChange={event => setRelatedOnly(event.target.checked)} />Related only</label>
    </div>
    <div className="schema-matrix-viewport" ref={viewport} role="grid" aria-label="Declared foreign keys: child rows, parent columns"
      aria-rowcount={tables.length} aria-colcount={tables.length} tabIndex={0} aria-activedescendant={active ? cellId : undefined}
      onFocus={() => { if (!active && tables.length) setActive({ row: 0, col: 0 }); }} onKeyDown={navigate}
      onScroll={event => setScroll({ x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })}>
      {!tables.length ? <div className="schema-matrix-empty">{relatedOnly ? 'No tables with declared foreign keys.' : 'No tables in this schema.'}</div> :
        <div className="schema-matrix-space" style={{ width: Math.max(size.width, LEFT + tables.length * CELL), height: Math.max(size.height, TOP + tables.length * CELL) }}>
          <div className="schema-matrix-surface" style={{ left: scroll.x, top: scroll.y, width: size.width, height: size.height }}>
            {useCanvas ? <canvas ref={canvas} style={{ width: size.width, height: size.height }} onPointerMove={hover} onClick={click} aria-hidden="true" /> :
              <svg width={size.width} height={size.height} onPointerMove={hover} onClick={click} aria-hidden="true">
                <defs>
                  <clipPath id={`${rawId}-body`}><rect x={LEFT} y={TOP} width={Math.max(0, size.width - LEFT)} height={Math.max(0, size.height - TOP)} /></clipPath>
                  <clipPath id={`${rawId}-rows`}><rect y={TOP} width={LEFT} height={Math.max(0, size.height - TOP)} /></clipPath>
                  <clipPath id={`${rawId}-cols`}><rect x={LEFT} width={Math.max(0, size.width - LEFT)} height={TOP} /></clipPath>
                </defs>
                <g clipPath={`url(#${rawId}-body)`}>{rows.flatMap((source, ri) => cols.map((target, ci) => {
                  const x = LEFT + scale(target.id)! - scroll.x, y = TOP + scale(source.id)! - scroll.y;
                  const cell = model.cells.get(dependencyCellKey(source.id, target.id));
                  return <g key={dependencyCellKey(source.id, target.id)}>
                    <rect x={x + 0.5} y={y + 0.5} width={CELL - 1} height={CELL - 1} fill="none"
                      stroke={active?.row === ri + firstRow && active.col === ci + firstCol ? 'var(--accent)' : 'var(--line)'}
                      strokeWidth={active?.row === ri + firstRow && active.col === ci + firstCol ? 2 : 0.5} />
                    {cell && <rect x={x + 2} y={y + 2} width={CELL - 4} height={CELL - 4} fill={color(cell, colors)} />}
                    {cell && cell.foreignKeys.length > 1 && <text x={x + CELL / 2} y={y + 17} textAnchor="middle" fill="var(--matrix-count-ink)" fontSize="10">{cell.foreignKeys.length}</text>}
                  </g>;
                }))}</g>
                <rect width={size.width} height={TOP} fill="var(--panel)" /><rect y={TOP} width={LEFT} height={Math.max(0, size.height - TOP)} fill="var(--panel)" />
                <g clipPath={`url(#${rawId}-rows)`}>{rows.map((table, i) => {
                  const y = TOP + scale(table.id)! - scroll.y, selected = active?.row === firstRow + i;
                  return <g key={table.id}>{selected && <rect y={y} width={LEFT} height={CELL} fill="var(--line)" />}
                    <text x={LEFT - 9} y={y + 17} textAnchor="end" fill={selected ? 'var(--accent)' : 'var(--ink)'} fontSize="11">{trim(dependencyName(table), 23)}</text></g>;
                })}</g>
                <g clipPath={`url(#${rawId}-cols)`}>{cols.map((table, i) => {
                  const x = LEFT + scale(table.id)! - scroll.x, selected = active?.col === firstCol + i;
                  return <g key={table.id}>{selected && <rect x={x} width={CELL} height={TOP} fill="var(--line)" />}
                    <text transform={`translate(${x + 17},${TOP - 9}) rotate(-90)`} fill={selected ? 'var(--accent)' : 'var(--ink)'} fontSize="11">{trim(dependencyName(table), 18)}</text></g>;
                })}</g>
                <g fill="var(--ink)" fontSize="11"><text x="12" y={TOP - 35}>Parent columns</text><text x="12" y={TOP - 16}>Child rows</text></g>
              </svg>}
          </div>
        </div>}
      {active && <div className="schema-matrix-sr" role="row" aria-rowindex={active.row + 1}>
        <span id={cellId} role="gridcell" aria-colindex={active.col + 1}>{description}</span>
      </div>}
    </div>
    <div className="schema-matrix-detail" role={activeSource && activeTarget ? 'tooltip' : undefined} aria-live="polite">
      {activeSource && activeTarget && <>
      <strong>{activeSource.id} → {activeTarget.id}</strong>
      {activeCell ? activeCell.foreignKeys.map(fk => <span key={fk.id}>{fk.name} · {fk.columns.map(column => `${column.source} → ${column.target}`).join(', ')} · ON DELETE {fk.onDelete}</span>) : <span>No declared foreign key</span>}
      </>}
    </div>
    <div className="schema-matrix-legend">
      <span><i style={{ background: colors['one-to-one'][0] }} />1:1</span>
      <span><i style={{ background: colors['one-to-many'][0] }} />1:N</span>
      <span><i style={{ background: colors.unknown[0] }} />Unknown cardinality</span>
      <span><i style={{ background: colors['one-to-many'][1] }} />Multiple FKs</span>
      {model.ignoredLinks > 0 && <span>{model.ignoredLinks} inferred or unresolved links excluded</span>}
    </div>
  </section>;
}
