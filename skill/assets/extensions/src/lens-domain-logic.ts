import type { SchemaGraph, SchemaLink, SchemaTable } from './types';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const genericName = /^(id|uuid|guid|pk|(?:created|updated|modified|deleted|inserted)(?:_at|_on|_by|_date|_time)?|(?:date|time)_(?:created|updated|modified|deleted|inserted)|timestamp|row_version|version|is_deleted|tenant_id)$/i;
const normalizedName = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const isGeneric = (name: string) => genericName.test(normalizedName(name)) || /_(id|uuid|guid)$/.test(normalizedName(name));
export const tableLabel = (table: SchemaTable) => table.name ? `${table.schema ? `${table.schema}.` : ''}${table.name}` : table.id;

export interface DeclaredRelation { id: string; source: string; target: string; pairs: SchemaLink[] }

export function declaredRelations(graph: SchemaGraph): DeclaredRelation[] {
  const ids = new Set(graph.tables.map(table => table.id));
  const grouped = new Map<string, DeclaredRelation>();
  for (const link of graph.links) {
    if (link.kind !== 'declared FK' || !ids.has(link.source) || !ids.has(link.target)) continue;
    const id = JSON.stringify([link.source, link.target, link.constraintId || [link.column, link.targetColumn]]);
    const relation = grouped.get(id) || { id, source: link.source, target: link.target, pairs: [] };
    if (!relation.pairs.some(pair => pair.column === link.column && pair.targetColumn === link.targetColumn)) relation.pairs.push(link);
    grouped.set(id, relation);
  }
  return [...grouped.values()].sort((a, b) => compare(a.id, b.id)).map(relation => ({ ...relation,
    pairs: [...relation.pairs].sort((a, b) => compare(a.column, b.column) || compare(a.targetColumn, b.targetColumn)) }));
}

/** Deterministic local modularity optimization on the undirected declared-FK graph.
 * Composite column pairs contribute one edge; independent constraints retain their weight.
 * Community IDs are their lexically first table IDs, suitable for other views to reuse.
 */
export function computeCommunities(graph: SchemaGraph): Map<string, string> {
  const ids = graph.tables.map(table => table.id).sort(compare);
  const adjacent = new Map(ids.map(id => [id, new Map<string, number>()]));
  for (const relation of declaredRelations(graph)) {
    if (relation.source === relation.target) continue;
    const a = adjacent.get(relation.source)!, b = adjacent.get(relation.target)!;
    a.set(relation.target, (a.get(relation.target) || 0) + 1);
    b.set(relation.source, (b.get(relation.source) || 0) + 1);
  }
  const degree = new Map(ids.map(id => [id, [...adjacent.get(id)!.values()].reduce((a, b) => a + b, 0)]));
  const totalDegree = [...degree.values()].reduce((a, b) => a + b, 0);
  const labels = new Map(ids.map(id => [id, id]));
  const totals = new Map(degree);
  if (totalDegree) for (let pass = 0; pass < 100; pass++) {
    let changes = 0;
    for (const id of ids) {
      const old = labels.get(id)!, k = degree.get(id)!;
      if (!k) continue;
      const weights = new Map<string, number>();
      for (const [other, weight] of adjacent.get(id)!) {
        const label = labels.get(other)!;
        weights.set(label, (weights.get(label) || 0) + weight);
      }
      totals.set(old, totals.get(old)! - k);
      const gain = (label: string) => (weights.get(label) || 0) - k * (totals.get(label) || 0) / totalDegree;
      let best = old, bestGain = gain(old);
      for (const label of [...weights.keys()].sort(compare)) {
        const candidate = gain(label);
        // Retain the current community on ties to avoid cycling and arbitrary merges.
        if (candidate > bestGain + 1e-10) { best = label; bestGain = candidate; }
      }
      labels.set(id, best); totals.set(best, (totals.get(best) || 0) + k);
      if (old !== best) changes++;
    }
    if (!changes) break;
  }
  const representatives = new Map<string, string>();
  for (const id of ids) if (!representatives.has(labels.get(id)!)) representatives.set(labels.get(id)!, id);
  return new Map(ids.map(id => [id, representatives.get(labels.get(id)!)!]));
}

export interface SampleDependency {
  determinant: string; dependent: string; distinctDeterminant: number; distinctPair: number; sampleSize: number;
  caution: string | null;
}
export interface DuplicateField { id: string; name: string; type: string; tableIds: string[] }
export interface NormalizationReview {
  table: SchemaTable; duplicates: DuplicateField[]; dependencies: SampleDependency[];
  score: number | null; profileKnown: boolean; excluded: string[]; lookupReason: string | null;
}

function singleUniqueColumns(table: SchemaTable) {
  const names = new Set(table.allColumns.filter(column => column.unique).map(column => column.name));
  const pk = table.primaryKey?.length ? table.primaryKey : table.allColumns.filter(column => column.pk).map(column => column.name);
  if (pk.length === 1) names.add(pk[0]);
  for (const key of [...table.uniques, ...table.indexes.filter(index => index.unique)]) {
    if (!key.partial && !key.expression && key.columns.length === 1) names.add(key.columns[0]);
  }
  return names;
}

export function sampleDependencies(table: SchemaTable, options: { includeVacuous?: boolean } = {}): SampleDependency[] {
  const raw = table.profiling?.functionalDependencies;
  if (!Array.isArray(raw)) return [];
  const names = new Set(table.allColumns.map(column => column.name));
  const unique = singleUniqueColumns(table), seen = new Set<string>();
  return raw.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const fd = value as Record<string, unknown>;
    const { determinant, dependent, distinctDeterminant, distinctPair, sampleSize } = fd;
    if (typeof determinant !== 'string' || typeof dependent !== 'string' || determinant === dependent ||
      !names.has(determinant) || !names.has(dependent) ||
      typeof distinctDeterminant !== 'number' || !Number.isSafeInteger(distinctDeterminant) || distinctDeterminant < 2 ||
      typeof distinctPair !== 'number' || distinctPair !== distinctDeterminant ||
      typeof sampleSize !== 'number' || !Number.isSafeInteger(sampleSize) || sampleSize < distinctPair) return [];
    const key = JSON.stringify([determinant, dependent]);
    if (seen.has(key)) return [];
    seen.add(key);
    const caution = unique.has(determinant) ? 'Declared unique determinant: expected key dependency; no review points.'
      : distinctDeterminant === sampleSize ? 'Determinant is unique in this sample: equality is automatic; no review points.' : null;
    if (caution && !options.includeVacuous) return [];
    return [{ determinant, dependent, distinctDeterminant, distinctPair, sampleSize, caution }];
  }).sort((a, b) => compare(a.determinant, b.determinant) || compare(a.dependent, b.dependent));
}

export function analyzeNormalization(graph: SchemaGraph): { reviews: NormalizationReview[]; duplicates: DuplicateField[] } {
  const referenced = new Set(declaredRelations(graph).map(link => link.target));
  const foreignColumns = new Set(graph.links.filter(link => link.kind === 'declared FK').map(link => JSON.stringify([link.source, link.column])));
  const buckets = new Map<string, DuplicateField>();
  const reviews: NormalizationReview[] = graph.tables.map(table => {
    const naturalKeys = [...singleUniqueColumns(table)].filter(name => !isGeneric(name) && !table.allColumns.find(column => column.name === name)?.fk);
    const lookupReason = table.allColumns.length <= 6 && referenced.has(table.id) && naturalKeys.length
      ? `Lookup-like: ${table.allColumns.length} columns, referenced by a declared FK, and unique natural-key candidate ${naturalKeys.join(', ')}. Repeated lookup attributes are excluded.` : null;
    const excluded: string[] = [];
    for (const column of table.allColumns) {
      const reason = isGeneric(column.name) ? 'generic identifier or audit field' : column.pk || table.primaryKey?.includes(column.name)
        ? 'primary-key member' : column.fk || foreignColumns.has(JSON.stringify([table.id, column.name])) ? 'reference-key member' : lookupReason ? 'lookup-like table' : !column.type.trim() ? 'type unknown' : null;
      if (reason) { excluded.push(`${column.name}: ${reason}`); continue; }
      const name = normalizedName(column.name), type = column.type.trim().replace(/\s+/g, ' ').toLowerCase();
      const id = JSON.stringify([name, type]);
      const bucket = buckets.get(id) || { id, name, type, tableIds: [] };
      if (!bucket.tableIds.includes(table.id)) bucket.tableIds.push(table.id);
      buckets.set(id, bucket);
    }
    const observedDependencies = sampleDependencies(table, { includeVacuous: true });
    const dependencies = observedDependencies.filter(fd => !fd.caution);
    for (const fd of observedDependencies) if (fd.caution) excluded.push(`Sample FD ${fd.determinant} -> ${fd.dependent}: ${fd.caution} Excluded from arrows and scoring.`);
    const profileKnown = observedDependencies.length > 0 || (Array.isArray(table.profiling?.functionalDependencies) && typeof table.profiling?.sampleSize === 'number' && Number.isFinite(table.profiling.sampleSize) && table.profiling.sampleSize >= 2);
    return { table, duplicates: [], dependencies, score: null, profileKnown, excluded, lookupReason };
  });
  const duplicates = [...buckets.values()].filter(field => field.tableIds.length >= 3)
    .sort((a, b) => compare(a.id, b.id)).map(field => ({ ...field, tableIds: field.tableIds.sort(compare) }));
  for (const review of reviews) {
    review.duplicates = duplicates.filter(field => field.tableIds.includes(review.table.id));
    const points = review.duplicates.length * 2 + review.dependencies.filter(fd => !fd.caution).length * 3;
    review.score = points || review.profileKnown ? points : null;
  }
  reviews.sort((a, b) => (b.score || 0) - (a.score || 0) || compare(a.table.id, b.table.id));
  return { reviews, duplicates };
}
