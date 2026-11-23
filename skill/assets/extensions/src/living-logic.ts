import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import type { SchemaGraph, SchemaLink, SchemaTable } from './types';
import { graphFingerprint, projectScope } from './view-state';
import { computeCommunities, declaredRelations } from './lens-domain-logic';

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
export function serializePositions(positions: Positions, groupBy?: GroupMode): string {
  // The grouping rides along in the same version-1 payload: positions only make sense for the grouping
  // they were laid out under, and older readers ignore the extra field.
  return JSON.stringify(groupBy ? { version: 1, positions, groupBy } : { version: 1, positions });
}
export function parseGroupMode(raw: string | null): GroupMode | undefined {
  try { const value = JSON.parse(raw || 'null'); return value?.version === 1 && (value.groupBy === 'prefix' || value.groupBy === 'relationships') ? value.groupBy : undefined; }
  catch { return undefined; }
}
export function readGroupMode(graph: SchemaGraph): GroupMode | undefined {
  try { return parseGroupMode(localStorage.getItem(snapshotKey(graph))); } catch { return undefined; }
}
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
export function savePositions(key: string, positions: Positions, groupBy?: GroupMode): boolean {
  try { localStorage.setItem(key, serializePositions(positions, groupBy)); return true; } catch { return false; }
}
// --- Grouping and hubs (F05) -------------------------------------------------------------------
// On a real schema the name-prefix domains put close to half the tables in 'Other', and a handful
// of tables (the users, workspaces and accounts everything belongs to) were the target of most
// relationships, so their lines crossed the whole canvas and buried the structure in between.

/** How tables are grouped into the bubbles and regions of the diagram. */
export type GroupMode = 'prefix' | 'relationships';
/** The group every hub table is gathered into, whichever grouping is chosen. */
export const HUB_GROUP = 'Shared hubs';
/** Tables with no declared relationship left once hubs are set aside. */
export const UNCONNECTED_GROUP = 'Unconnected';
/** The group for tables whose only declared keys point at one hub table. */
export const attachedGroup = (hub: string) => `Attached to ${hub}`;
/** Below this many tables every line is readable, so nothing is treated as a hub. */
export const HUB_MIN_TABLES = 25;

const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Tables referenced by so many others that one line per reference would bury the diagram: at least
 * a tenth of all tables (and never fewer than six) refer to it. Counted in distinct referring
 * tables, so a table with several keys into the same hub counts once. Self-references and collapsed
 * junction edges do not count. Both evidence kinds count, because both are drawn as lines.
 */
export function hubTables(tables: SchemaTable[], rels: Relation[]): Set<string> {
  if (tables.length < HUB_MIN_TABLES) return new Set();
  const referrers = new Map<string, Set<string>>();
  for (const relation of rels) {
    if (relation.source === relation.target || relation.junction) continue;
    if (!referrers.has(relation.target)) referrers.set(relation.target, new Set());
    referrers.get(relation.target)!.add(relation.source);
  }
  const threshold = Math.max(6, Math.ceil(tables.length * 0.1));
  return new Set([...referrers].filter(([, from]) => from.size >= threshold).map(([id]) => id).sort(byText));
}

/**
 * The grouping a snapshot opens with. Name prefixes are kept when they actually group the schema;
 * when a quarter or more of the tables have no domain or fall into 'Other', the prefixes say little
 * and the declared relationships are the better guide.
 */
export function defaultGroupMode(tables: SchemaTable[]): GroupMode {
  if (!tables.length) return 'prefix';
  const ungrouped = tables.filter(table => !table.domain || table.domain === 'Other').length;
  return ungrouped / tables.length >= 0.25 ? 'relationships' : 'prefix';
}

/**
 * The group each table is drawn in. Hubs always go to `HUB_GROUP`. With 'prefix' every other table
 * keeps its snapshot domain. With 'relationships' the declared-FK communities are computed with the
 * hubs removed -- with them in, everything is one hop from a hub and collapses into one community --
 * and each community is named after its most connected member. A table left with no relationship
 * but its keys into hubs joins `attachedGroup(hub)` for the hub it refers to most; one with none at
 * all is `UNCONNECTED_GROUP`. Inferred links never shape a group.
 */
export function tableGroups(graph: SchemaGraph, mode: GroupMode, hubs: ReadonlySet<string>): Map<string, string> {
  const groups = new Map<string, string>();
  if (mode === 'prefix') {
    for (const table of graph.tables) groups.set(table.id, hubs.has(table.id) ? HUB_GROUP : (table.domain || 'Other'));
    return groups;
  }
  const rest: SchemaGraph = { ...graph, tables: graph.tables.filter(table => !hubs.has(table.id)),
    links: graph.links.filter(link => !hubs.has(link.source) && !hubs.has(link.target)) };
  const community = computeCommunities(rest);
  const degree = new Map<string, number>();
  for (const relation of declaredRelations(rest)) {
    if (relation.source === relation.target || community.get(relation.source) !== community.get(relation.target)) continue;
    for (const id of [relation.source, relation.target]) degree.set(id, (degree.get(id) || 0) + 1);
  }
  // A table whose only declared keys point at hubs belongs with the hub it hangs off most, so the
  // tables owned by a workspace sit together instead of in one undifferentiated leftover pile.
  const hubKeys = new Map<string, Map<string, number>>();
  for (const relation of declaredRelations(graph)) {
    if (!hubs.has(relation.target) || hubs.has(relation.source) || relation.source === relation.target) continue;
    const counts = hubKeys.get(relation.source) || new Map<string, number>();
    counts.set(relation.target, (counts.get(relation.target) || 0) + 1);
    hubKeys.set(relation.source, counts);
  }
  const attached = (id: string) => {
    const counts = hubKeys.get(id);
    if (!counts) return UNCONNECTED_GROUP;
    return attachedGroup([...counts].sort((a, b) => (b[1] - a[1]) || byText(a[0], b[0]))[0][0]);
  };
  const members = new Map<string, string[]>();
  for (const [id, label] of community) members.set(label, [...(members.get(label) || []), id]);
  const reserved = new Set([HUB_GROUP, UNCONNECTED_GROUP]);
  for (const ids of members.values()) {
    const connected = ids.filter(id => degree.get(id));
    if (!connected.length) { for (const id of ids) groups.set(id, attached(id)); continue; }
    const centre = [...connected].sort((a, b) => (degree.get(b)! - degree.get(a)!) || byText(a, b))[0];
    const name = reserved.has(centre) ? `${centre} (group)` : centre;
    for (const id of ids) groups.set(id, name);
  }
  for (const id of hubs) groups.set(id, HUB_GROUP);
  return groups;
}

/** The grouping that applies when none is supplied: the snapshot's own domain. */
export const domainGroup = (table: SchemaTable) => table.domain || 'Other';

export interface GroupBox { id: string; x: number; y: number; width: number; height: number }

/**
 * Place each group's finished rectangle on the canvas, row by row, `gap` apart. Rectangles are
 * placed whole, so two groups cannot overlap however their tables were arranged inside them. The
 * order puts `first` (the hubs) at the start, then grows from the largest group by repeatedly taking
 * the group most connected to those already placed, so related groups end up near each other.
 */
export function packGroups(sizes: { id: string; width: number; height: number }[],
  weight: (a: string, b: string) => number = () => 0, first?: string, gap = 240): GroupBox[] {
  const pending = [...sizes].sort((a, b) => (b.width * b.height - a.width * a.height) || byText(a.id, b.id));
  const ordered: typeof pending = [];
  const take = (index: number) => { ordered.push(pending[index]); pending.splice(index, 1); };
  const lead = pending.findIndex(size => size.id === first);
  if (lead >= 0) take(lead);
  while (pending.length) {
    let best = 0, bestWeight = -1;
    pending.forEach((candidate, index) => {
      const total = ordered.reduce((sum, placed) => sum + weight(placed.id, candidate.id), 0);
      if (total > bestWeight) { best = index; bestWeight = total; }
    });
    take(best);
  }
  // A row limit near the square root of the total area keeps the diagram close to the shape of a
  // wide screen instead of one long strip; a group wider than the limit gets a row to itself.
  const area = ordered.reduce((sum, size) => sum + (size.width + gap) * (size.height + gap), 0);
  const rowLimit = Math.max(Math.sqrt(area) * 1.45, ...ordered.map(size => size.width));
  const boxes: GroupBox[] = [];
  let x = 0, y = 0, rowHeight = 0;
  for (const size of ordered) {
    if (x > 0 && x + size.width > rowLimit) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    boxes.push({ id: size.id, x, y, width: size.width, height: size.height });
    x += size.width + gap;
    rowHeight = Math.max(rowHeight, size.height);
  }
  return boxes;
}

interface Particle extends SimulationNodeDatum { id: string; width: number; height: number }

/** Lay out one group's tables around the origin and return their top-left corners. */
function layoutGroup(tables: SchemaTable[], rels: Relation[]): Map<string, { x: number; y: number }> {
  const ids = new Set(tables.map(table => table.id));
  const particles: Particle[] = tables.map((table, rank) => {
    // Seed on a sunflower spiral, so the simulation starts from a compact arrangement.
    const radius = 160 * Math.sqrt(rank + 0.5);
    return { id: table.id, ...nodeSize(table), x: Math.cos(rank * 2.39996) * radius, y: Math.sin(rank * 2.39996) * radius };
  });
  const links = rels.filter(r => r.source !== r.target && ids.has(r.source) && ids.has(r.target))
    .map(r => ({ source: r.source, target: r.target }));
  const simulation = forceSimulation(particles).stop()
    .force('link', forceLink<Particle, { source: string; target: string }>(links).id(n => n.id).distance(380).strength(0.08))
    .force('charge', forceManyBody<Particle>().strength(-260).distanceMax(1200))
    .force('collision', forceCollide<Particle>().radius(n => Math.hypot(n.width, n.height) / 2 + 25).iterations(3))
    .force('x', forceX<Particle>(0).strength(0.06))
    .force('y', forceY<Particle>(0).strength(0.06));
  simulation.tick(220); simulation.stop();
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  const corners = new Map<string, { x: number; y: number }>();
  // Resolve any remaining rectangular overlap by searching outward from where the simulation left
  // each table. This happens inside the group, before the group is placed, so it cannot push a
  // table into another group.
  for (const n of particles) {
    const baseX = (n.x || 0) - n.width / 2, baseY = (n.y || 0) - n.height / 2;
    let x = baseX, y = baseY;
    for (let attempt = 0; attempt <= particles.length * 4; attempt++) {
      if (!placed.some(p => x < p.x + p.width + 24 && x + n.width + 24 > p.x && y < p.y + p.height + 24 && y + n.height + 24 > p.y)) break;
      const angle = attempt * 2.39996, radius = 48 + attempt * 22;
      x = baseX + Math.cos(angle) * radius; y = baseY + Math.sin(angle) * radius;
    }
    corners.set(n.id, { x, y });
    placed.push({ x, y, width: n.width, height: n.height });
  }
  return corners;
}

const pairKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);

/**
 * Positions for every table. Each group is laid out on its own and its bounding rectangle is then
 * packed beside the others, so the bubbles drawn around groups cannot overlap; the earlier single
 * simulation over the whole schema let heavily referenced tables drag their referrers across
 * every region. Saved placements stay authoritative: pinned ones always, unpinned ones while
 * `retainUnpinned` holds. Only tables without a kept placement are laid out, packed below the kept
 * ones so a new group never lands on a table the user placed.
 */
export function layoutTables(graph: SchemaGraph, saved: Positions = {}, retainUnpinned = true,
  groupOf: (table: SchemaTable) => string = domainGroup, first?: string): Positions {
  const positions: Positions = Object.create(null);
  const free: SchemaTable[] = [];
  let floor = 0;
  for (const table of graph.tables) {
    const old = saved[table.id];
    if (old && (old.pinned || retainUnpinned)) {
      positions[table.id] = { x: old.x, y: old.y, pinned: old.pinned };
      floor = Math.max(floor, old.y + nodeSize(table).height + 240);
    } else free.push(table);
  }
  if (!free.length) return positions;
  const rels = relations(graph);
  const members = new Map<string, SchemaTable[]>();
  for (const table of [...free].sort((a, b) => byText(a.id, b.id))) {
    const group = groupOf(table);
    members.set(group, [...(members.get(group) || []), table]);
  }
  const local = new Map<string, Map<string, { x: number; y: number }>>();
  const origin = new Map<string, { x: number; y: number }>();
  const sizes: { id: string; width: number; height: number }[] = [];
  for (const [group, tables] of members) {
    const corners = layoutGroup(tables, rels);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const table of tables) {
      const at = corners.get(table.id)!, size = nodeSize(table);
      minX = Math.min(minX, at.x); minY = Math.min(minY, at.y);
      maxX = Math.max(maxX, at.x + size.width); maxY = Math.max(maxY, at.y + size.height);
    }
    local.set(group, corners);
    origin.set(group, { x: minX, y: minY });
    sizes.push({ id: group, width: maxX - minX, height: maxY - minY });
  }
  const groupOfId = new Map(graph.tables.map(table => [table.id, groupOf(table)]));
  const crossing = new Map<string, number>();
  for (const relation of rels) {
    const a = groupOfId.get(relation.source)!, b = groupOfId.get(relation.target)!;
    if (a !== b) crossing.set(pairKey(a, b), (crossing.get(pairKey(a, b)) || 0) + 1);
  }
  for (const box of packGroups(sizes, (a, b) => crossing.get(pairKey(a, b)) || 0, first)) {
    const shift = origin.get(box.id)!;
    for (const [id, at] of local.get(box.id)!) {
      positions[id] = { x: box.x + at.x - shift.x, y: floor + box.y + at.y - shift.y, pinned: false };
    }
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
export function domainAggregates(tables: SchemaTable[], relations: Relation[],
  groupOf: (table: SchemaTable) => string = domainGroup): { domains: DomainAggregate[]; ribbons: DomainRibbon[] } {
  const byDomain = new Map<string, SchemaTable[]>();
  const domainOf = new Map<string, string>();
  for (const table of tables) {
    const domain = groupOf(table);
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
