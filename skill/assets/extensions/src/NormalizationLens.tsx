import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, FlaskConical, LoaderCircle, Search } from 'lucide-react';
import type { SchemaGraph, ViewProps } from './types';
import { analyzeNormalization, tableLabel } from './lens-domain-logic';
import type { NormalizationReview } from './lens-domain-logic';
import './NormalizationLens.css';

interface FieldLink { id: string; group: string; path: string; label: string }
const columnToken = (table: string, column: string) => JSON.stringify([table, column]);
const nameKey = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function ReviewCard({ review, onSelect, active, setActive, register }: {
  review: NormalizationReview; onSelect: () => void; active: string | null; setActive: (value: string | null) => void;
  register: (column: string, element: HTMLDivElement | null) => void;
}) {
  const marker = `nl-arrow-${useId().replace(/:/g, '')}`;
  const { table, dependencies, duplicates } = review;
  const rowY = (name: string) => table.allColumns.findIndex(column => column.name === name) * 30 + 15;
  const shownDependencies = dependencies.slice(0, 8);
  return <article className="nl-card" data-table={table.id}>
    <header className="nl-card-header"><button className="nl-table-name" onClick={onSelect} title={`Inspect ${tableLabel(table)}`}>{tableLabel(table)}<ArrowRight size={14}/></button>
      <div className="nl-card-meta"><span>{table.domain || 'Unassigned'}</span><span>{typeof table.rowCount === 'number' && Number.isFinite(table.rowCount) && table.rowCount >= 0 ? `${table.rowCount.toLocaleString()} rows` : 'Rows unknown'}</span></div>
      <div className="nl-score"><strong>{review.score === null ? 'Unassessed' : `${review.score} review points`}</strong><span>{review.profileKnown ? 'Sample evidence only' : 'Partial: profile unknown'}</span></div>
    </header>
    <div className={`nl-columns ${shownDependencies.length ? 'nl-has-fd' : ''}`}>
      {shownDependencies.length > 0 && <svg className="nl-fd-arrows" width="48" height={table.allColumns.length * 30} aria-label="Sample-only functional dependency arrows">
        <defs><marker id={marker} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L6,3 L0,6" fill="context-stroke"/></marker></defs>
        {shownDependencies.map((fd, i) => <path key={`${fd.determinant}:${fd.dependent}`} d={`M46,${rowY(fd.determinant)} H${5 + i * 4} V${rowY(fd.dependent)} H44`}
          className={fd.caution ? 'nl-fd-caution' : 'nl-fd-path'} fill="none" markerEnd={`url(#${marker})`}>
          <title>{`${fd.determinant} -> ${fd.dependent}: sample only, ${fd.sampleSize} rows. ${fd.caution || 'Validate with full data and business meaning.'}`}</title></path>)}
      </svg>}
      {table.allColumns.map(column => {
        const duplicate = duplicates.find(field => field.name === nameKey(column.name) && field.type === column.type.trim().replace(/\s+/g, ' ').toLowerCase());
        return <div className={`nl-column ${duplicate ? 'nl-duplicate' : ''} ${duplicate?.id === active ? 'nl-active' : ''}`} key={column.name} ref={element => register(column.name, element)}>
          <span className="nl-column-key" title={column.pk ? 'Primary-key member' : column.fk ? 'Reference field' : ''}>{column.pk ? 'PK' : column.fk ? 'FK' : ''}</span>
          {duplicate ? <button className="nl-column-name" onMouseEnter={() => setActive(duplicate.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(duplicate.id)} onBlur={() => setActive(null)} onClick={() => setActive(active === duplicate.id ? null : duplicate.id)} title={`Same name and type in ${duplicate.tableIds.length} eligible tables`}>{column.name}</button> : <span className="nl-column-name" title={column.name}>{column.name}</span>}
          <span className="nl-column-type" title={column.type}>{column.type || 'Unknown'}</span>
        </div>;
      })}
      {!table.allColumns.length && <div className="nl-no-columns">No column metadata</div>}
    </div>
    {(duplicates.length > 0 || dependencies.length > 0) && <div className="nl-flags">
      {duplicates.map(field => <div key={field.id}><strong>{field.name}</strong>: same type in {field.tableIds.length} eligible tables (+2). Confirm shared meaning and whether values must change together.</div>)}
      {dependencies.map(fd => <div key={`${fd.determinant}:${fd.dependent}`}><strong>{fd.determinant} <ArrowRight size={12}/> {fd.dependent}</strong>: sample only, {fd.distinctDeterminant} determinant values = {fd.distinctPair} pairs / {fd.sampleSize.toLocaleString()} rows. {fd.caution || 'Repeated determinant with one dependent value (+3). Check full-data exceptions, null handling, and whether history is intentional.'}</div>)}
      {dependencies.length > shownDependencies.length && <div>First {shownDependencies.length} sample dependencies drawn; all {dependencies.length} listed.</div>}
    </div>}
    <details className="nl-exclusions"><summary>Evidence and exclusions ({review.excluded.length})</summary>
      {review.lookupReason && <p>{review.lookupReason}</p>}
      <p>{review.profileKnown ? 'No sampled violation is not proof of a normal form.' : 'Functional-dependency coverage is unknown; absent statistics do not earn a clean score.'} Self-dependencies, constant or unique determinants, invalid counts, and unequal distinct counts do not produce arrows.</p>
      {review.excluded.length > 0 && <ul>{review.excluded.map(value => <li key={value}>{value}</li>)}</ul>}
    </details>
  </article>;
}

export default function NormalizationLens({ graph, onSelectTable, live }: ViewProps) {
  const [query, setQuery] = useState(''), [domain, setDomain] = useState(''), [onlyFlagged, setOnlyFlagged] = useState(false);
  const [page, setPage] = useState(0), [pageSize, setPageSize] = useState(8), [active, setActive] = useState<string | null>(null);
  const [profiled, setProfiled] = useState<{ base: SchemaGraph; value: SchemaGraph } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const request = useRef(0), controller = useRef<AbortController | null>(null);
  const board = useRef<HTMLDivElement>(null), fields = useRef(new Map<string, HTMLDivElement>());
  const [links, setLinks] = useState<FieldLink[]>([]), [size, setSize] = useState({ width: 1, height: 1 });
  const model = profiled?.base === graph ? profiled.value : graph;
  const analysis = useMemo(() => analyzeNormalization(model), [model]);
  const domains = useMemo(() => [...new Set(model.tables.map(table => table.domain || 'Unassigned'))].sort(), [model]);
  const filtered = useMemo(() => analysis.reviews.filter(review => (!domain || (review.table.domain || 'Unassigned') === domain) &&
    (!onlyFlagged || (review.score || 0) > 0) && `${tableLabel(review.table)} ${review.table.allColumns.map(column => column.name).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())), [analysis, domain, onlyFlagged, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, pages - 1);
  const visible = useMemo(() => filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize), [filtered, currentPage, pageSize]);
  useEffect(() => { setPage(0); }, [query, domain, onlyFlagged, pageSize, graph]);
  useEffect(() => {
    request.current++; setPending(false); setError(''); setProfiled(null);
    return () => { request.current++; controller.current?.abort(); };
  }, [graph, live]);
  useLayoutEffect(() => {
    const container = board.current;
    if (!container) { setLinks([]); return; }
    const measure = () => {
      const box = container.getBoundingClientRect(), next: FieldLink[] = [];
      for (const duplicate of analysis.duplicates) {
        const endpoints = visible.flatMap(review => {
          if (!duplicate.tableIds.includes(review.table.id)) return [];
          const column = review.table.allColumns.find(value => nameKey(value.name) === duplicate.name && value.type.trim().replace(/\s+/g, ' ').toLowerCase() === duplicate.type);
          const element = column && fields.current.get(columnToken(review.table.id, column.name));
          if (!element) return [];
          return [{ id: review.table.id, rect: element.getBoundingClientRect() }];
        });
        if (endpoints.length < 2) continue;
        const first = endpoints[0];
        for (const second of endpoints.slice(1)) {
          if (next.length >= 48) break;
          const sameColumn = Math.abs(first.rect.left - second.rect.left) < 5;
          const firstOnLeft = first.rect.left < second.rect.left;
          const x1 = (sameColumn || firstOnLeft ? first.rect.right : first.rect.left) - box.left;
          const x2 = (sameColumn || !firstOnLeft ? second.rect.right : second.rect.left) - box.left;
          const y1 = first.rect.top + first.rect.height / 2 - box.top, y2 = second.rect.top + second.rect.height / 2 - box.top;
          const lane = sameColumn ? Math.max(x1, x2) + 12 + next.length % 4 * 5 : (x1 + x2) / 2 + (next.length % 3 - 1) * 5;
          next.push({ id: `${duplicate.id}:${first.id}:${second.id}`, group: duplicate.id,
            path: `M${x1},${y1} C${lane},${y1} ${lane},${y1} ${lane},${(y1 + y2) / 2} S${lane},${y2} ${x2},${y2}`,
            label: `${duplicate.name}: ${first.id} and ${second.id}; repeated-name candidate, not a foreign key` });
        }
      }
      setSize({ width: container.offsetWidth, height: container.offsetHeight }); setLinks(next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(container);
    container.querySelectorAll('.nl-card').forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [visible, analysis]);
  async function profile() {
    if (!live?.profile || !visible.length) return;
    const token = ++request.current; controller.current?.abort(); controller.current = new AbortController();
    setPending(true); setError('');
    try {
      const result = await live.profile({ tables: visible.map(review => review.table.id), maxRowsPerTable: 1000 }, controller.current.signal);
      if (token !== request.current) return;
      const updates = new Map(result.graph.tables.map(table => [table.id, table]));
      setProfiled({ base: graph, value: { ...model, tables: model.tables.map(table => updates.has(table.id) ? { ...table, ...updates.get(table.id)! } : table) } });
    } catch (cause) { if (token === request.current) setError(cause instanceof Error ? cause.message : 'Profiling failed.'); }
    finally { if (token === request.current) setPending(false); }
  }
  return <section className="nl-root" aria-label="Normalization lens">
    <div className="nl-toolbar">
      <label className="nl-search"><Search size={15}/><input aria-label="Search normalization tables or columns" placeholder="Search tables or columns" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <select aria-label="Normalization domain" value={domain} onChange={event => setDomain(event.target.value)}><option value="">All domains</option>{domains.map(value => <option key={value}>{value}</option>)}</select>
      <label className="nl-check"><input type="checkbox" checked={onlyFlagged} onChange={event => setOnlyFlagged(event.target.checked)}/>Only flagged</label>
      <button className="nl-profile" onClick={profile} disabled={!live?.profile || pending || !visible.length} title={live?.profile ? 'Request up to 1,000 rows per visible table from the connected profiler' : 'Live profiler unavailable in this offline graph'}>{pending ? <LoaderCircle className="nl-spin" size={15}/> : <FlaskConical size={15}/>} {pending ? 'Profiling...' : 'Profile visible tables'}</button>
    </div>
    <div className="nl-overview"><span>{analysis.reviews.filter(review => (review.score || 0) > 0).length} tables flagged</span><span>{analysis.duplicates.length} repeated field groups</span><span>{analysis.reviews.filter(review => !review.profileKnown).length} profiles unknown</span>
      <details><summary>Review score and evidence</summary><p>Higher means more review priority; lower means fewer observed candidates. Add 2 points per same-name, same-type field found in at least 3 eligible tables, plus 3 per sample dependency with a repeated, non-unique determinant. No clean score is assigned when profiling is unknown and no candidates exist. A score of zero with a sample is still not proof of normalization.</p><p>Dashed links connect repeated fields on this page (up to 48 links). Within-table arrows represent sample equality: distinct(A) = distinct(A,B). Unique determinants are excluded from arrows and scoring. Identifier, audit, reference-key and lookup-like fields are excluded from repetition detection. Names alone do not establish shared meaning.</p></details>
    </div>
    {error && <div className="nl-error" role="alert">{error}</div>}
    <div className="nl-scroll">
      {visible.length ? <div className="nl-board" ref={board}>
        <svg className="nl-links" width={size.width} height={size.height} aria-label="Repeated field candidate links">{links.map(link => <path key={link.id} d={link.path} className={active === link.group ? 'nl-link-active' : active ? 'nl-link-muted' : ''}><title>{link.label}</title></path>)}</svg>
        {visible.map(review => <ReviewCard key={review.table.id} review={review} onSelect={() => onSelectTable(review.table.id)} active={active} setActive={setActive} register={(column, element) => { const key = columnToken(review.table.id, column); if (element) fields.current.set(key, element); else fields.current.delete(key); }}/>) }
      </div> : <div className="nl-empty">{graph.tables.length ? 'No tables match these filters.' : 'No tables in this schema.'}</div>}
    </div>
    <footer className="nl-footer"><span>{filtered.length ? currentPage * pageSize + 1 : 0}-{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length} tables</span>
      <label>Per page <select aria-label="Normalization tables per page" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[4, 8, 12].map(value => <option key={value}>{value}</option>)}</select></label>
      <div><button title="Previous normalization page" aria-label="Previous normalization page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16}/></button><span>{currentPage + 1} / {pages}</span><button title="Next normalization page" aria-label="Next normalization page" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16}/></button></div>
    </footer>
  </section>;
}
