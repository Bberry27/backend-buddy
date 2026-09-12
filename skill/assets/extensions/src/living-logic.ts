import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { SchemaGraph, SchemaLink, SchemaTable } from './types';
import { graphFingerprint, projectScope } from './view-state';

export interface SavedPosition { x: number; y: number; pinned: boolean }
export type Positions = Record<string, SavedPosition>;
export interface Relation { id: string; source: string; target: string; pairs: SchemaLink[]; kind: SchemaLink['kind']; cardinality: 'one-to-one' | 'one-to-many' | 'unknown'; junction?: string }
export function knownRows(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
export function rowLabel(table: SchemaTable): string { return knownRows(table.rowCount) ? `${table.rowCount.toLocaleString()} rows` : 'Rows unknown'; }
export function nodeSize(table: SchemaTable) { return { width: 250 + (knownRows(table.rowCount) ? Math.min(80, Math.log10(table.rowCount + 1) * 12) : 0), height: Math.min(350, 78 + table.allColumns.length * 46) }; }
export function uniqueKeys(table: SchemaTable): string[][] {
  const pk = table.primaryKey?.length ? table.primaryKey : table.allColumns.filter(c => c.pk).map(c => c.name);
  return [pk, ...table.uniques.filter(k => !k.partial && !k.expression).map(k => k.columns), ...table.indexes.filter(k => k.unique && !k.partial && !k.expression).map(k => k.columns), ...table.allColumns.filter(c => c.unique).map(c => [c.name])].filter(k => k.length > 0);
}
function isUnique(table: SchemaTable, columns: string[]) { return uniqueKeys(table).some(key => key.every(column => columns.includes(column))); }
export function relations(graph: SchemaGraph): Relation[] {
  const tables = new Map(graph.tables.map(t => [t.id, t]));
  const groups = new Map<string, SchemaLink[]>();
  for (const link of graph.links) {
    if (!tables.has(link.source) || !tables.has(link.target)) continue;
    const id = JSON.stringify([link.source, link.target, link.kind, link.constraintId || [link.column, link.targetColumn]]);
    groups.set(id, [...(groups.get(id) || []), link]);
  }
  return [...groups].map(([id, pairs]) => {
    const link = pairs[0];
    const targetUnique = isUnique(tables.get(link.target)!, pairs.map(p => p.targetColumn));
    const cardinality = link.kind === 'declared FK' && targetUnique ? (isUnique(tables.get(link.source)!, pairs.map(p => p.column)) ? 'one-to-one' : 'one-to-many') : 'unknown';
    return { id, source: link.source, target: link.target, kind: link.kind, pairs, cardinality };
  });
}
export function junctions(graph: SchemaGraph, grouped = relations(graph)): Map<string, Relation[]> {
  const found = new Map<string, Relation[]>();
  for (const table of graph.tables) {
    if (table.kind === 'view' || table.type === 'view') continue;
    const outgoing = grouped.filter(r => r.source === table.id);
    if (outgoing.length < 2 || outgoing.some(r => r.kind !== 'declared FK' || r.cardinality !== 'one-to-many' || r.target === table.id)) continue;
    const fullKey = new Set(outgoing.flatMap(r => r.pairs.map(p => p.column)));
    if (uniqueKeys(table).some(key => key.length === fullKey.size && key.every(c => fullKey.has(c)))) found.set(table.id, outgoing);
  }
  return found;
}
export function visibleGraph(graph: SchemaGraph, showJunctions: boolean, reveal?: string) {
  const grouped = relations(graph);
  const candidates = junctions(graph, grouped);
  const hidden = new Set<string>();
  const collapsed: Relation[] = [];
  if (!showJunctions) for (const [id, outgoing] of candidates) {
    // A ternary relation, or a referenced junction, cannot be replaced by one binary edge.
    if (id === reveal || outgoing.length !== 2 || grouped.some(r => r.target === id)) continue;
    hidden.add(id);
    collapsed.push({ id: `junction:${id}`, source: outgoing[0].target, target: outgoing[1].target, kind: 'declared FK', cardinality: 'one-to-many', pairs: outgoing.flatMap(r => r.pairs), junction: id });
  }
  return { tables: graph.tables.filter(t => !hidden.has(t.id)), relations: [...grouped.filter(r => !hidden.has(r.source) && !hidden.has(r.target)), ...collapsed], hidden };
}
// The project scope and the fingerprint moved to view-state.ts (C03) so that this key and the
// per-view state key cannot drift apart (C13). The string this returns is unchanged for every
// input, which is what keeps saved layouts from being orphaned; living-logic.test.ts pins it.
export function snapshotKey(graph: SchemaGraph): string {
  return `backend-buddy-erd:v1:${projectScope(graph)}:${graphFingerprint(graph)}`;
}
export function serializePositions(positions: Positions): string { return JSON.stringify({ version: 1, positions }); }
export function parsePositions(raw: string | null, ids: Iterable<string>): Positions {
  const result: Positions = Object.create(null);
  try {
    const value = JSON.parse(raw || 'null');
    if (value?.version !== 1 || !value.positions || typeof value.positions !== 'object') return result;
    for (const id of ids) {
      const p = Object.hasOwn(value.positions, id) ? value.positions[id] : null;
      if (p && typeof p.x === 'number' && Number.isFinite(p.x) && Math.abs(p.x) < 1e7 && typeof p.y === 'number' && Number.isFinite(p.y) && Math.abs(p.y) < 1e7 && typeof p.pinned === 'boolean') result[id] = { x: p.x, y: p.y, pinned: p.pinned };
    }
  } catch { /* Invalid or older saved layouts are ignored. */ }
  return result;
}
export function readPositions(graph: SchemaGraph): Positions {
  try { return parsePositions(localStorage.getItem(snapshotKey(graph)), graph.tables.map(t => t.id)); } catch { return Object.create(null); }
}
export function savePositions(key: string, positions: Positions): boolean {
  try { localStorage.setItem(key, serializePositions(positions)); return true; } catch { return false; }
}
export interface DomainCell { id: string; x: number; y: number; width: number; height: number }

/**
 * A rectangle per domain, sized to the area that domain's own tables need and packed into rows.
 * The layout used one fixed 1100x1000 anchor per domain regardless of how many tables it held, and
 * anchored so weakly that tables drifted out of their own region. Two things went wrong: a large
 * domain sprawled across its neighbours, and a small one left a hole. Sizing each cell to its
 * contents and anchoring firmly inside it keeps a domain together, which is what lets the bubbles
 * at the clustered tiers enclose a domain without overlapping the next one.
 */
export function domainCells(domains: { id: string; area: number }[], gap = 260): DomainCell[] {
  // The force layout does not respect a cell edge exactly: link and collision forces push the
  // outermost tables of a domain roughly a tenth of the cell past it. Packing a padded rectangle
  // and reporting the smaller cell inside it turns that into proportional clearance, so a large
  // domain's overspill cannot reach into a small neighbour. A fixed gap could not: the spill grows
  // with the domain while the gap did not.
  const SPREAD = 1.34;
  // A square that holds the members' combined area with room for the aisles the collision force
  // opens up, and never smaller than a single comfortable card.
  const sized = domains.map(domain => {
    const side = Math.max(620, Math.sqrt(Math.max(1, domain.area) * 2.8));
    return { id: domain.id, width: side, height: side };
  });
  // Wrap into rows at roughly the square root of the total padded area, so the whole diagram stays
  // close to square instead of becoming one very long strip.
  const rowLimit = Math.sqrt(sized.reduce((sum, cell) => sum + cell.width * cell.height, 0)) * 1.3 * SPREAD;
  const placed: DomainCell[] = [];
  let x = 0, y = 0, rowHeight = 0;
  for (const cell of sized) {
    const outerWidth = cell.width * SPREAD, outerHeight = cell.height * SPREAD;
    if (x > 0 && x + outerWidth > rowLimit) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    placed.push({ id: cell.id, width: cell.width, height: cell.height,
      x: x + (outerWidth - cell.width) / 2, y: y + (outerHeight - cell.height) / 2 });
    x += outerWidth + gap;
    rowHeight = Math.max(rowHeight, outerHeight);
  }
  return placed;
}

interface Particle extends SimulationNodeDatum { id: string; width: number; height: number; anchorX: number; anchorY: number }
export function layoutTables(graph: SchemaGraph, saved: Positions = {}, retainUnpinned = true): Positions {
  const domains = [...new Set(graph.tables.map(t => t.domain || 'Other'))].sort();
  const area = new Map<string, number>();
  const members = new Map<string, string[]>();
  for (const table of graph.tables) {
    const domain = table.domain || 'Other', size = nodeSize(table);
    area.set(domain, (area.get(domain) || 0) + size.width * size.height);
    members.set(domain, [...(members.get(domain) || []), table.id]);
  }
  const cells = new Map(domainCells(domains.map(id => ({ id, area: area.get(id) || 0 }))).map(cell => [cell.id, cell]));
  const particles: Particle[] = graph.tables.map(table => {
    const domain = table.domain || 'Other';
    const cell = cells.get(domain)!;
    const anchorX = cell.x + cell.width / 2, anchorY = cell.y + cell.height / 2;
    const size = nodeSize(table), old = saved[table.id];
    // Seed on a sunflower spiral inside the domain's own cell, so the simulation starts from an
    // arrangement that is already grouped rather than having to pull one together from scratch.
    const group = members.get(domain)!;
    const rank = group.indexOf(table.id);
    const radius = Math.min(cell.width, cell.height) * 0.42 * Math.sqrt((rank + 0.5) / group.length);
    const x = old ? old.x + size.width / 2 : anchorX + Math.cos(rank * 2.39996) * radius;
    const y = old ? old.y + size.height / 2 : anchorY + Math.sin(rank * 2.39996) * radius;
    return { id: table.id, ...size, anchorX, anchorY, x, y, ...(old && (old.pinned || retainUnpinned) ? { fx: x, fy: y } : {}) };
  });
  const simulation = forceSimulation(particles).stop()
    .force('link', forceLink<Particle, {source: string; target: string}>(relations(graph).filter(r => r.source !== r.target).map(r => ({ source: r.source, target: r.target }))).id(n => n.id).distance(410).strength(0.035))
    // Bounded repulsion: without a range limit every table pushes every other one, which is what
    // tore the domains apart and left the acres of empty canvas between the cards.
    .force('charge', forceManyBody<Particle>().strength(-230).distanceMax(1000))
    .force('collision', forceCollide<Particle>().radius(n => Math.hypot(n.width, n.height) / 2 + 25).iterations(3))
    .force('x', forceX<Particle>(n => n.anchorX).strength(0.09))
    .force('y', forceY<Particle>(n => n.anchorY).strength(0.09));
  simulation.tick(220); simulation.stop();
  const positions: Positions = Object.create(null);
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  // Resolve any remaining rectangular overlap; saved user placements remain authoritative.
  for (const n of [...particles].sort((a,b) => Number(b.fx != null) - Number(a.fx != null))) {
    const baseX = (n.x || 0) - n.width / 2, baseY = (n.y || 0) - n.height / 2;
    let x = baseX, y = baseY;
    if (n.fx == null) {
      // Search outward from where the simulation left the table, rather than pushing it straight
      // down. A downward push walked tables out of their own domain and into the one below, which
      // is what made the domain bubbles at the clustered tiers overlap.
      for (let attempt = 0; attempt <= particles.length * 4; attempt++) {
        const conflict = placed.find(p => x < p.x+p.width+24 && x+n.width+24 > p.x && y < p.y+p.height+24 && y+n.height+24 > p.y);
        if (!conflict) break;
        const angle = attempt * 2.39996, radius = 48 + attempt * 22;
        x = baseX + Math.cos(angle) * radius;
        y = baseY + Math.sin(angle) * radius;
      }
    }
    positions[n.id] = { x, y, pinned: saved[n.id]?.pinned || false };
    placed.push({x,y,width:n.width,height:n.height});
  }
  return positions;
}

// --- Level of detail (F05) ---------------------------------------------------------------------
// The diagram used to switch between two states at fixed zoom values, so 0.39 showed isolated
// domain bubbles with no relationships and 0.40 showed every table at once. These four tiers give
// the intermediate steps, and the hysteresis margin stops a diagram parked on a boundary from
// flickering between two of them while the user nudges the wheel.
export type ErdTier = 'overview' | 'domains' | 'tables' | 'detail';
export const ERD_TIERS: ErdTier[] = ['overview', 'domains', 'tables', 'detail'];
/** Zoom values separating one tier from the next, ascending. */
export const ERD_TIER_EDGES = [0.16, 0.42, 1.15];
/** A boundary must be cleared by this factor before the tier changes, in either direction. */
export const ERD_TIER_HYSTERESIS = 1.06;

export function erdTier(zoom: number, previous: ErdTier = 'tables'): ErdTier {
  const previousIndex = Math.max(0, ERD_TIERS.indexOf(previous));
  let index = 0;
  for (let edge = 0; edge < ERD_TIER_EDGES.length; edge++) {
    // Already above this edge: hold the higher tier until the zoom drops clearly below it.
    // Still below it: do not climb until the zoom clearly clears it.
    const threshold = previousIndex > edge
      ? ERD_TIER_EDGES[edge] / ERD_TIER_HYSTERESIS
      : ERD_TIER_EDGES[edge] * ERD_TIER_HYSTERESIS;
    if (zoom >= threshold) index = edge + 1;
  }
  return ERD_TIERS[index];
}

export interface DomainAggregate { id: string; tables: SchemaTable[] }
export interface DomainRibbon {
  id: string; source: string; target: string; count: number; declared: number; inferred: number;
}

/**
 * Domains and the relationships that cross between them. The overview tier draws these so the
 * shape of the schema is visible before any table is: a bubble with no ribbon really is an
 * unconnected domain, which is worth seeing.
 */
export function domainAggregates(tables: SchemaTable[], relations: Relation[]):
  { domains: DomainAggregate[]; ribbons: DomainRibbon[] } {
  const byDomain = new Map<string, SchemaTable[]>();
  const domainOf = new Map<string, string>();
  for (const table of tables) {
    const domain = table.domain || 'Other';
    domainOf.set(table.id, domain);
    byDomain.set(domain, [...(byDomain.get(domain) || []), table]);
  }
  const domains = [...byDomain].sort(([a], [b]) => a.localeCompare(b)).map(([id, members]) => ({ id, tables: members }));
  const pairs = new Map<string, DomainRibbon>();
  for (const relation of relations) {
    const from = domainOf.get(relation.source), to = domainOf.get(relation.target);
    if (!from || !to || from === to) continue;
    // One ribbon per unordered pair, so A->B and B->A are the same thread.
    const [source, target] = from < to ? [from, to] : [to, from];
    const id = `__lerd_ribbon_${source}__${target}`;
    const existing = pairs.get(id) || { id, source, target, count: 0, declared: 0, inferred: 0 };
    existing.count += 1;
    if (relation.kind === 'inferred by naming') existing.inferred += 1; else existing.declared += 1;
    pairs.set(id, existing);
  }
  return { domains, ribbons: [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

/**
 * A table and everything within `hops` relationships of it. Focusing a table fits this set rather
 * than a fixed zoom, so arriving at a table also shows what it is attached to.
 */
export function neighborhood(relations: Relation[], rootId: string, hops = 1): Set<string> {
  const ids = new Set([rootId]);
  let frontier = [rootId];
  for (let hop = 0; hop < Math.max(0, hops); hop++) {
    const next: string[] = [];
    for (const relation of relations) {
      for (const [from, to] of [[relation.source, relation.target], [relation.target, relation.source]]) {
        if (frontier.includes(from) && !ids.has(to)) { ids.add(to); next.push(to); }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return ids;
}

export interface DomainBox { id: string; x: number; y: number; width: number; height: number }

/**
 * Each domain's bubble drawn around where its tables actually sit, rather than in a separate grid.
 * One coordinate space for both tiers is what lets a domain expand in place: the tables appear
 * inside the outline the bubble occupied, so zooming in adds detail instead of replacing the view.
 */
export function domainBounds(domains: DomainAggregate[], positions: Positions, pad = 60): DomainBox[] {
  return domains.map(domain => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const table of domain.tables) {
      const at = positions[table.id];
      if (!at) continue;
      const size = nodeSize(table);
      minX = Math.min(minX, at.x); minY = Math.min(minY, at.y);
      maxX = Math.max(maxX, at.x + size.width); maxY = Math.max(maxY, at.y + size.height);
    }
    // A domain whose tables have no position yet still needs a box, or its bubble cannot render.
    if (!Number.isFinite(minX)) return { id: domain.id, x: 0, y: 0, width: 420, height: 260 };
    return { id: domain.id, x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
  });
}

/**
 * Which relationships can be drawn between whatever is currently visible. Each endpoint resolves
 * to the node standing in for it -- the table itself when it is shown, otherwise its domain bubble
 * -- so a relationship from an expanded table into a collapsed domain still appears, as a ribbon
 * to that bubble, instead of being dropped. Relationships wholly inside one collapsed domain are
 * not drawn: both ends would be the same bubble.
 */
export function planErdEdges(rels: Relation[], resolve: (tableId: string) => string):
  { direct: Relation[]; ribbons: DomainRibbon[] } {
  const direct: Relation[] = [];
  const pairs = new Map<string, DomainRibbon>();
  for (const relation of rels) {
    const from = resolve(relation.source), to = resolve(relation.target);
    if (from === relation.source && to === relation.target) { direct.push(relation); continue; }
    if (from === to) continue;
    const [source, target] = from < to ? [from, to] : [to, from];
    const id = `__lerd_ribbon_${source}__${target}`;
    const existing = pairs.get(id) || { id, source, target, count: 0, declared: 0, inferred: 0 };
    existing.count += 1;
    if (relation.kind === 'inferred by naming') existing.inferred += 1; else existing.declared += 1;
    pairs.set(id, existing);
  }
  return { direct, ribbons: [...pairs.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
