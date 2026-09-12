import type { SchemaGraph } from './types';

type Table = SchemaGraph['tables'][number];
export type FanoutNode = {
  id: string; tableId: string; depth: number; rowCount: number | null;
  expandable: boolean; truncated?: boolean;
};
export type FanoutLink = {
  id: string; source: string; target: string; ratio: number | null;
  reason?: string; columns?: string; count?: number; truncated?: boolean;
};
export type FanoutModel = { nodes: FanoutNode[]; links: FanoutLink[]; notices: string[] };
export type LiveFanoutResult = {
  nodes: { id: string; tableId: string; depth: number; rowCount: number; truncated?: boolean }[];
  links: { source: string; target: string; ratio: number | null; count?: number; truncated?: boolean }[];
  truncated: boolean; limit: number;
};

export function knownCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function primaryKeyColumns(table: Table): string[] {
  if (table.primaryKey?.length) return table.primaryKey;
  const marked = table.allColumns.filter(column => column.pk).map(column => column.name);
  return marked.length ? marked : (table.pk || '').split(',').map(key => key.trim()).filter(Boolean);
}

export function parsePrimaryKey(table: Table, text: string): unknown {
  const keys = primaryKeyColumns(table);
  if (!keys.length) throw new Error('This table has no known primary key.');
  if (!text.trim()) throw new Error('Enter a primary key value.');
  if (keys.length === 1) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return text.trim();
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    } catch { /* Unquoted text is a valid single-column key. */ }
    return text.trim();
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Enter a JSON object with every primary key column.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A composite key must be a JSON object.');
  const record = value as Record<string, unknown>;
  if (Object.values(record).some(item => typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))))) {
    throw new Error('Quote large numeric key values as JSON strings to preserve their exact value.');
  }
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key) || record[key] == null || typeof record[key] === 'object')) {
    throw new Error(`Provide exactly these non-null primary key values: ${keys.join(', ')}.`);
  }
  return record;
}

export function localRatio(parent: unknown, child: unknown): { ratio: number | null; reason?: string } {
  const p = knownCount(parent), c = knownCount(child);
  if (p === null || c === null) return { ratio: null, reason: 'Row count unknown' };
  if (p === 0) return { ratio: null, reason: 'Parent has zero rows' };
  const ratio = c / p;
  return Number.isFinite(ratio) ? { ratio } : { ratio: null, reason: 'Ratio exceeds numeric range' };
}

type Relationship = { id: string; parent: string; child: string; columns: string[] };
function relationships(graph: SchemaGraph): Relationship[] {
  const tables = new Map(graph.tables.map(table => [table.id, table]));
  const groups = new Map<string, SchemaGraph['links']>();
  for (const link of graph.links) {
    if (link.kind !== 'declared FK' || !tables.has(link.source) || !tables.has(link.target)) continue;
    const key = JSON.stringify([link.source, link.target, link.constraintId || `${link.column}->${link.targetColumn}`]);
    const group = groups.get(key) || [];
    group.push(link);
    groups.set(key, group);
  }
  const result: Relationship[] = [];
  for (const [id, links] of groups) {
    const child = tables.get(links[0].source)!;
    const columns = [...new Set(links.map(link => link.column))];
    const uniqueSets = [primaryKeyColumns(child), ...child.uniques.filter(index => !index.partial && !index.expression).map(index => index.columns),
      ...child.indexes.filter(index => index.unique && !index.partial && !index.expression).map(index => index.columns),
      ...child.allColumns.filter(column => column.unique).map(column => [column.name])];
    // A unique subset of the FK tuple makes the whole child tuple unique.
    const unique = uniqueSets.some(keys => keys.length > 0 && keys.every(key => columns.includes(key)));
    if (unique || links.some(link => link.cardinality === 'one-to-one')) continue;
    result.push({ id, child: child.id, parent: links[0].target, columns });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * How many eligible children each table has: the number of declared non-unique foreign keys
 * pointing at it, grouped the way `relationships()` groups them. A table absent from the map fans
 * out to nothing, so choosing it as the root yields a single node and no links.
 */
export function fanoutChildCounts(graph: SchemaGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const relationship of relationships(graph)) {
    counts.set(relationship.parent, (counts.get(relationship.parent) || 0) + 1);
  }
  return counts;
}

/**
 * A root worth opening on. The view defaulted to the first table alphabetically, which on a real
 * schema is very likely to be one of the many with no children at all -- two thirds of the tables
 * in the medium fixture -- so the view opened on a lone node and looked broken. Pick the table that
 * fans out widest instead, breaking ties by id so the choice is stable for a given graph.
 */
export function defaultFanoutRoot(graph: SchemaGraph): string {
  const counts = fanoutChildCounts(graph);
  const ids = graph.tables.map(table => table.id).sort((a, b) => a.localeCompare(b));
  let best = ids[0] || '';
  let most = 0;
  for (const id of ids) {
    const count = counts.get(id) || 0;
    if (count > most) { most = count; best = id; }
  }
  return best;
}

export function buildFanout(graph: SchemaGraph, root: string, requestedDepth: number, collapsed: ReadonlySet<string>): FanoutModel {
  const tables = new Map(graph.tables.map(table => [table.id, table]));
  if (!tables.has(root)) return { nodes: [], links: [], notices: [] };
  const depthLimit = Math.max(1, Math.min(4, requestedDepth));
  const outgoing = new Map<string, Relationship[]>();
  for (const relationship of relationships(graph)) outgoing.set(relationship.parent, [...(outgoing.get(relationship.parent) || []), relationship]);
  const nodes = new Map<string, FanoutNode>(), edges = new Map<string, FanoutLink>();
  const cycles = new Set<string>();
  let capped = false;
  const visits = new Set<string>();
  function visit(tableId: string, depth: number, ancestors: Set<string>): string | null {
    const id = JSON.stringify([depth, tableId]);
    if (!nodes.has(id) && nodes.size >= 400) { capped = true; return null; }
    nodes.set(id, { id, tableId, depth, rowCount: knownCount(tables.get(tableId)?.rowCount), expandable: depth < depthLimit && !!outgoing.get(tableId)?.length });
    const visitKey = JSON.stringify([id, [...ancestors].sort()]);
    if (depth >= depthLimit || collapsed.has(id) || visits.has(visitKey)) return id;
    if (visits.size >= 5000) { capped = true; return id; }
    visits.add(visitKey);
    const path = new Set([...ancestors, tableId]);
    for (const relationship of outgoing.get(tableId) || []) {
      if (path.has(relationship.child)) { cycles.add(relationship.id); continue; }
      const target = visit(relationship.child, depth + 1, path);
      if (!target) continue;
      const edgeId = JSON.stringify([depth, relationship.id]);
      edges.set(edgeId, { id: edgeId, source: id, target, columns: relationship.columns.join(', '),
        ...localRatio(tables.get(tableId)?.rowCount, tables.get(relationship.child)?.rowCount) });
    }
    return id;
  }
  visit(root, 0, new Set());
  const notices: string[] = [];
  if (cycles.size) notices.push(`${cycles.size} cyclic relationship${cycles.size === 1 ? '' : 's'} pruned on affected paths.`);
  if (capped) notices.push('View safety limit reached (400 nodes or 5,000 paths). Collapse a branch or reduce depth to inspect other paths.');
  if (new Set([...nodes.values()].map(node => node.tableId)).size < nodes.size) notices.push('Some tables recur at different depths. Their row counts are repeated, never added.');
  return { nodes: [...nodes.values()], links: [...edges.values()], notices };
}

export function buildLiveFanout(result: LiveFanoutResult, rootTable: string, collapsed: ReadonlySet<string>, graph?: SchemaGraph): FanoutModel {
  const byId = new Map(result.nodes.map(node => [node.id, node]));
  const eligible = graph ? new Set(relationships(graph).map(link => JSON.stringify([link.parent, link.child]))) : null;
  const forward = result.links.filter(link => byId.has(link.source) && byId.has(link.target) && byId.get(link.target)!.depth > byId.get(link.source)!.depth);
  const valid = forward.filter(link => !eligible || eligible.has(JSON.stringify([byId.get(link.source)!.tableId, byId.get(link.target)!.tableId])));
  const roots = result.nodes.filter(node => node.tableId === rootTable && node.depth === 0);
  const visible = new Set(roots.map(node => node.id));
  const links: FanoutLink[] = [];
  for (const node of [...result.nodes].sort((a, b) => a.depth - b.depth)) {
    if (!visible.has(node.id) || collapsed.has(node.id)) continue;
    valid.filter(link => link.source === node.id).forEach((link, index) => {
      visible.add(link.target);
      const ratio = knownCount(link.ratio);
      links.push({ ...link, ratio, id: JSON.stringify([link.source, link.target, index]), reason: ratio === null ? 'Live ratio unavailable' : undefined });
    });
  }
  const notices = [];
  if (result.truncated || result.nodes.some(node => node.truncated) || result.links.some(link => link.truncated)) notices.push(`Live results are truncated (limit ${result.limit.toLocaleString()}). Counts and ratios may be partial.`);
  if (forward.length !== result.links.length) notices.push('Invalid or non-forward live links were omitted to keep the diagram acyclic.');
  if (valid.length !== forward.length) notices.push('Live relationships without an eligible declared non-unique FK were omitted.');
  const visibleNodes = result.nodes.filter(node => visible.has(node.id));
  if (new Set(visibleNodes.map(node => node.tableId)).size < visibleNodes.length) notices.push('Live paths revisit some tables. Their row sets may overlap; path counts are never added.');
  if (!roots.length) notices.push('The live response has no depth-zero node for the selected root.');
  return { nodes: visibleNodes.map(node => ({ ...node, rowCount: knownCount(node.rowCount), expandable: valid.some(link => link.source === node.id) })), links, notices };
}
