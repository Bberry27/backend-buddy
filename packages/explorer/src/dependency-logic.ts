import type { SchemaGraph, SchemaLink, SchemaTable } from './types';

export type DependencyOrder = 'alpha' | 'rowcount' | 'schema' | 'rcm';
export type ForeignKeyCardinality = 'one-to-one' | 'one-to-many' | 'unknown';
export interface DependencyFK {
  id: string; source: string; target: string; name: string;
  columns: { source: string; target: string }[];
  cardinality: ForeignKeyCardinality; onDelete: string;
}
export interface DependencyCell {
  source: string; target: string; foreignKeys: DependencyFK[]; cardinality: ForeignKeyCardinality;
}
export interface DependencyModel {
  tables: SchemaTable[]; foreignKeys: DependencyFK[]; cells: Map<string, DependencyCell>;
  related: Set<string>; ignoredLinks: number;
}
export interface DependencyComponent { id: string; members: string[]; cyclic: boolean; selfLoop: boolean }
export interface DependencyArc {
  foreignKey: DependencyFK; sourceIndex: number; targetIndex: number; cyclic: boolean; backward: boolean;
}
export interface DependencyTopology {
  tables: SchemaTable[]; components: DependencyComponent[]; cycles: DependencyComponent[];
  isolated: Set<string>; arcs: DependencyArc[];
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const dependencyName = (table: SchemaTable) => table.name || table.id;
export const dependencyCellKey = (source: string, target: string) => JSON.stringify([source, target]);
const metadata = (link: SchemaLink, keys: string[]) => {
  const data = link as unknown as Record<string, unknown>;
  for (const key of keys) if (typeof data[key] === 'string' && (data[key] as string).trim()) return data[key] as string;
  return undefined;
};

export function buildDependencyModel(graph: SchemaGraph): DependencyModel {
  const ids = new Set(graph.tables.map(table => table.id));
  const byId = new Map(graph.tables.map(table => [table.id, table]));
  const groups = new Map<string, SchemaLink[]>();
  let ignoredLinks = 0;
  for (const link of graph.links) {
    if (link.kind !== 'declared FK' || !ids.has(link.source) || !ids.has(link.target)) { ignoredLinks++; continue; }
    // Names are scoped to endpoints. Without a constraint ID, separate column
    // pairs are separate constraints; composite membership cannot be invented.
    const id = JSON.stringify([link.source, link.target, link.constraintId ? ['constraint', link.constraintId] :
      ['columns', link.column, link.targetColumn]]);
    const group = groups.get(id) || [];
    group.push(link); groups.set(id, group);
  }
  const foreignKeys: DependencyFK[] = [...groups].sort(([a], [b]) => compare(a, b)).map(([id, links]) => {
    const first = links[0];
    const pairs = new Map(links.map(link => [JSON.stringify([link.column, link.targetColumn]), { source: link.column, target: link.targetColumn }]));
    const cardinalities = new Set(links.map(link => link.cardinality || 'unknown'));
    const actions = [...new Set(links.map(link => metadata(link, ['onDelete', 'ondelete', 'deleteRule', 'delete_rule']) ||
      byId.get(link.source)?.allColumns.find(column => column.name === link.column)?.ondelete || 'Unknown'))];
    return { id, source: first.source, target: first.target,
      name: metadata(first, ['constraintName', 'name']) || first.constraintId || 'Unnamed foreign key',
      columns: [...pairs.values()], cardinality: cardinalities.size === 1 ? [...cardinalities][0] : 'unknown',
      onDelete: actions.join(' / ') };
  });
  const cells = new Map<string, DependencyCell>(), related = new Set<string>();
  for (const fk of foreignKeys) {
    related.add(fk.source); related.add(fk.target);
    const key = dependencyCellKey(fk.source, fk.target);
    const cell = cells.get(key) || { source: fk.source, target: fk.target, foreignKeys: [], cardinality: fk.cardinality };
    cell.foreignKeys.push(fk);
    if (cell.cardinality !== fk.cardinality) cell.cardinality = 'unknown';
    cells.set(key, cell);
  }
  return { tables: graph.tables, foreignKeys, cells, related, ignoredLinks };
}

const alpha = (a: SchemaTable, b: SchemaTable) => compare(dependencyName(a).toLowerCase(), dependencyName(b).toLowerCase()) || compare(a.id, b.id);
const knownCount = (table: SchemaTable) => typeof table.rowCount === 'number' && Number.isFinite(table.rowCount) && table.rowCount >= 0 ? table.rowCount : null;

export function orderDependencyTables(model: DependencyModel, order: DependencyOrder, relatedOnly = false): SchemaTable[] {
  const tables = model.tables.filter(table => !relatedOnly || model.related.has(table.id)).sort(alpha);
  if (order === 'alpha') return tables;
  if (order === 'schema') return tables.sort((a, b) => compare(a.schema || '', b.schema || '') || alpha(a, b));
  if (order === 'rowcount') return tables.sort((a, b) => {
    const ac = knownCount(a), bc = knownCount(b);
    return ac === null ? bc === null ? alpha(a, b) : 1 : bc === null ? -1 : bc - ac || alpha(a, b);
  });
  const positions = new Map(tables.map((table, i) => [table.id, i]));
  const neighbors = new Map(tables.map(table => [table.id, new Set<string>()]));
  for (const fk of model.foreignKeys) {
    if (fk.source === fk.target || !neighbors.has(fk.source) || !neighbors.has(fk.target)) continue;
    neighbors.get(fk.source)!.add(fk.target); neighbors.get(fk.target)!.add(fk.source);
  }
  const degreeOrder = (a: string, b: string) => neighbors.get(a)!.size - neighbors.get(b)!.size || positions.get(a)! - positions.get(b)!;
  const unseen = new Set([...neighbors.keys()].sort(degreeOrder));
  const ordered: string[] = [];
  while (unseen.size) {
    const start = unseen.values().next().value!;
    unseen.delete(start);
    const queue = [start], component: string[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor]; component.push(current);
      for (const next of [...neighbors.get(current)!].filter(id => unseen.has(id)).sort(degreeOrder)) {
        unseen.delete(next); queue.push(next);
      }
    }
    ordered.push(...component.reverse());
  }
  const byId = new Map(tables.map(table => [table.id, table]));
  return ordered.map(id => byId.get(id)!);
}

// Iterative Kosaraju avoids recursion limits for large schema dependency chains.
export function dependencyTopology(model: DependencyModel): DependencyTopology {
  const sorted = [...model.tables].sort(alpha), ids = sorted.map(table => table.id);
  const adjacency = new Map(ids.map(id => [id, new Set<string>()]));
  const reverse = new Map(ids.map(id => [id, new Set<string>()]));
  const isolated = new Set(ids);
  for (const fk of model.foreignKeys) {
    adjacency.get(fk.source)!.add(fk.target); reverse.get(fk.target)!.add(fk.source);
    isolated.delete(fk.source); isolated.delete(fk.target);
  }
  const visited = new Set<string>(), finish: string[] = [];
  for (const start of ids) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: { id: string; iterator: Iterator<string> }[] = [{ id: start, iterator: adjacency.get(start)!.values() }];
    while (stack.length) {
      const current = stack[stack.length - 1], next = current.iterator.next();
      if (next.done) { finish.push(current.id); stack.pop(); }
      else if (!visited.has(next.value)) {
        visited.add(next.value); stack.push({ id: next.value, iterator: adjacency.get(next.value)!.values() });
      }
    }
  }
  const assigned = new Set<string>(), components: DependencyComponent[] = [];
  for (const start of finish.reverse()) {
    if (assigned.has(start)) continue;
    const stack = [start], members: string[] = [];
    assigned.add(start);
    while (stack.length) {
      const current = stack.pop()!; members.push(current);
      for (const next of reverse.get(current)!) if (!assigned.has(next)) { assigned.add(next); stack.push(next); }
    }
    members.sort(compare);
    const selfLoop = members.some(id => adjacency.get(id)!.has(id));
    components.push({ id: members[0], members, cyclic: members.length > 1 || selfLoop, selfLoop });
  }
  components.sort((a, b) => compare(a.id, b.id));
  const componentOf = new Map(components.flatMap(component => component.members.map(id => [id, component.id] as const)));
  const children = new Map(components.map(component => [component.id, new Set<string>()]));
  const indegree = new Map(components.map(component => [component.id, 0]));
  for (const fk of model.foreignKeys) {
    const parent = componentOf.get(fk.target)!, child = componentOf.get(fk.source)!;
    if (parent !== child && !children.get(parent)!.has(child)) {
      children.get(parent)!.add(child); indegree.set(child, indegree.get(child)! + 1);
    }
  }
  const byComponent = new Map(components.map(component => [component.id, component]));
  const ready = components.filter(component => indegree.get(component.id) === 0).map(component => component.id).sort(compare);
  const ordered: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(...byComponent.get(id)!.members);
    for (const child of children.get(id)!) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) { ready.push(child); ready.sort(compare); }
    }
  }
  const byId = new Map(sorted.map(table => [table.id, table]));
  const tables = [...ordered.filter(id => !isolated.has(id)), ...ids.filter(id => isolated.has(id))].map(id => byId.get(id)!);
  const indices = new Map(tables.map((table, index) => [table.id, index]));
  const arcs = model.foreignKeys.map(foreignKey => {
    const sourceIndex = indices.get(foreignKey.source)!, targetIndex = indices.get(foreignKey.target)!;
    const same = componentOf.get(foreignKey.source) === componentOf.get(foreignKey.target);
    const cyclic = same && byComponent.get(componentOf.get(foreignKey.source)!)!.cyclic;
    return { foreignKey, sourceIndex, targetIndex, cyclic, backward: cyclic && targetIndex >= sourceIndex };
  });
  return { tables, components, cycles: components.filter(component => component.cyclic), isolated, arcs };
}

export function dependencyDescription(cell: DependencyCell): string {
  return `${cell.source} -> ${cell.target}; ${cell.foreignKeys.length} foreign ${cell.foreignKeys.length === 1 ? 'key' : 'keys'}; ` +
    cell.foreignKeys.map(fk => `${fk.name}: ${fk.columns.map(column => `${column.source} -> ${column.target}`).join(', ')}; ON DELETE ${fk.onDelete}`).join('; ');
}
