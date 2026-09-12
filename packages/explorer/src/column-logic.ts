import type { SchemaGraph } from './types';

export type ColumnTableEntity = SchemaGraph['tables'][number];
export type ColumnTableColumn = ColumnTableEntity['allColumns'][number];
export const COLUMN_FAMILIES = ['integer', 'decimal', 'text', 'datetime', 'boolean', 'json', 'binary', 'uuid', 'enum', 'other'] as const;
export type ColumnFamily = (typeof COLUMN_FAMILIES)[number];

export function columnFamily(type: string): ColumnFamily {
  const value = type.trim().toLowerCase();
  if (/\[\]|\barray\b/.test(value)) return 'other';
  if (/^(uuid|uniqueidentifier)\b/.test(value)) return 'uuid';
  if (/^(enum|set)\b/.test(value)) return 'enum';
  if (/^(jsonb?|jsonpath)\b/.test(value)) return 'json';
  if (/^(bool|boolean)\b/.test(value)) return 'boolean';
  if (/^(tinyint|smallint|smallinteger|mediumint|bigint|biginteger|integer|int\d*|smallserial|bigserial|serial\d*)\b/.test(value)) return 'integer';
  if (/^(decimal|numeric|number|real|float\d*|double|money|smallmoney)\b/.test(value)) return 'decimal';
  if (/^(date|datetime\d*|timestamp\w*|time\w*|interval|year)\b/.test(value)) return 'datetime';
  if (/^(bytea|binary|largebinary|varbinary|blob|tinyblob|mediumblob|longblob|bit|varbit|image|raw)\b/.test(value)) return 'binary';
  if (/^(text|unicodetext|unicode|tinytext|mediumtext|longtext|ntext|citext|varchar\d*|nvarchar\d*|char|nchar|character|clob|nclob|string)\b/.test(value)) return 'text';
  return 'other';
}

export function knownCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function nullableState(value: unknown): 'nullable' | 'required' | 'unknown' {
  return value === 'True' ? 'nullable' : value === 'False' ? 'required' : 'unknown';
}

function primaryColumns(table: ColumnTableEntity): string[] {
  if (table.primaryKey?.length) return table.primaryKey;
  const marked = table.allColumns.filter(column => column.pk).map(column => column.name);
  return marked.length ? marked : table.pk ? [table.pk] : [];
}

export interface ColumnFacts {
  primary: boolean;
  foreign: boolean;
  inferred: boolean;
  unique: boolean;
  indexed: boolean;
  indexDescription: string;
  uniqueDescription: string;
  foreignDescription: string;
  unindexedDeclared: boolean;
}

export function tableColumnFacts(table: ColumnTableEntity, links: SchemaGraph['links']): Map<string, ColumnFacts> {
  const primary = primaryColumns(table);
  const indexes = [
    ...table.indexes.map(index => ({ columns: index.columns, unique: Boolean(index.unique), origin: 'Index', partial: index.partial, expression: index.expression })),
    ...table.uniques.map(unique => ({ columns: unique.columns, unique: true, origin: 'Unique key', partial: unique.partial, expression: unique.expression })),
    ...(primary.length ? [{ columns: primary, unique: true, origin: 'Primary key', partial: false, expression: false }] : []),
    ...table.allColumns.filter(column => column.unique && !table.uniques.some(key => key.columns.includes(column.name)) && !table.indexes.some(index => index.unique && index.columns.includes(column.name))).map(column => ({ columns: [column.name], unique: true, origin: 'Unique column', partial: false, expression: false })),
  ];
  const declared = links.filter(link => link.source === table.id && link.kind === 'declared FK');
  const inferred = links.filter(link => link.source === table.id && link.kind === 'inferred by naming');
  const groups = new Map<string, string[]>();
  declared.forEach((link, ordinal) => {
    const key = link.constraintId ? JSON.stringify([link.target, link.constraintId]) : `single:${ordinal}`;
    const columns = groups.get(key) ?? [];
    if (!columns.includes(link.column)) columns.push(link.column);
    groups.set(key, columns);
  });
  const uncovered = new Set<string>();
  for (const columns of groups.values()) {
    // Keep the recorded FK order: MySQL requires the same ordered index prefix.
    // This is also conservative for snapshots without a known dialect.
    const covered = indexes.some(index => !index.partial && !index.expression && index.columns.length >= columns.length &&
      columns.every((name, position) => index.columns[position] === name));
    if (!covered) columns.forEach(name => uncovered.add(name));
  }
  return new Map(table.allColumns.map(column => {
    const memberships = indexes.filter(index => index.columns.includes(column.name));
    const uniqueKeys = memberships.filter(index => index.unique);
    const foreignLinks = declared.filter(link => link.column === column.name);
    const inferredLinks = inferred.filter(link => link.column === column.name);
    const foreign = foreignLinks.length > 0 || Boolean(column.fk);
    const hasLeadingIndex = memberships.some(index => !index.partial && !index.expression && index.columns[0] === column.name);
    const indexDescription = memberships.length ? memberships.map(index => {
      const position = index.columns.indexOf(column.name);
      return `${index.origin} (${index.columns.join(', ')}): ${position === 0 ? 'leading column' : `member ${position + 1}, not leading`}${index.partial ? '; partial, FK coverage unverified' : ''}${index.expression ? '; expression, FK coverage unverified' : ''}`;
    }).join('\n') : column.index ? 'Indexed according to column metadata; index order is unknown.' : 'No index recorded.';
    return [column.name, {
      primary: column.pk || primary.includes(column.name),
      foreign,
      inferred: inferredLinks.length > 0,
      unique: column.unique || uniqueKeys.length > 0,
      indexed: column.index || memberships.length > 0,
      indexDescription,
      uniqueDescription: uniqueKeys.length ? uniqueKeys.map(key => `${key.columns.length > 1 ? 'Composite unique membership; this column alone is not necessarily unique' : key.partial || key.expression ? 'Conditional or expression uniqueness; whole-column uniqueness unverified' : 'Individually unique'}: (${key.columns.join(', ')})`).join('\n') : 'Unique column.',
      foreignDescription: [
        ...foreignLinks.map(link => `Declared FK: ${link.column} -> ${link.target}.${link.targetColumn}${link.constraintId ? ` (${link.constraintId})` : ''}`),
        ...(column.fk && !foreignLinks.length ? [`FK metadata: ${column.fk}`] : []),
        ...inferredLinks.map(link => `Inferred by naming, not a declared constraint: ${link.target}.${link.targetColumn}`),
      ].join('\n'),
      unindexedDeclared: uncovered.has(column.name) || (Boolean(column.fk) && !foreignLinks.length && !hasLeadingIndex),
    }];
  }));
}

export interface ColumnProfileSummary {
  scope?: 'sample' | 'table' | 'unknown';
  nullFraction?: number;
  distinctCount?: number;
  sampleSize?: number;
  sampleRatio?: number;
  rowRatio?: number;
  coverage?: number;
  min?: unknown;
  max?: unknown;
}

export function columnProfile(column: ColumnTableColumn, rowCount: unknown, tableProfiling?: ColumnTableEntity['profiling']): ColumnProfileSummary {
  const profile = column.profiling;
  if (!profile) return {};
  const distinctCount = knownCount(profile.distinctCount) ? profile.distinctCount : undefined;
  const sampleSize = knownCount(profile.sampleSize) ? profile.sampleSize : knownCount(tableProfiling?.sampleSize) ? tableProfiling.sampleSize : undefined;
  const sampled = profile.sampled ?? tableProfiling?.sampled;
  const scope = sampled === false ? 'table' : sampled === true || sampleSize !== undefined || profile.scope === 'sample' ? 'sample' : profile.scope === 'table' ? 'table' : 'unknown';
  return {
    scope: Object.values(profile).some(value => value !== undefined) ? scope : undefined,
    nullFraction: typeof profile.nullFraction === 'number' && Number.isFinite(profile.nullFraction) && profile.nullFraction >= 0 && profile.nullFraction <= 1 ? profile.nullFraction : undefined,
    distinctCount,
    sampleSize,
    sampleRatio: distinctCount !== undefined && sampleSize !== undefined && sampleSize > 0 ? distinctCount / sampleSize : undefined,
    rowRatio: distinctCount !== undefined && knownCount(rowCount) && rowCount > 0 ? distinctCount / rowCount : undefined,
    coverage: sampleSize !== undefined && knownCount(rowCount) && rowCount > 0 ? sampleSize / rowCount : undefined,
    min: profile.min,
    max: profile.max,
  };
}

export interface ColumnFilters {
  search: string;
  families: ReadonlySet<ColumnFamily>;
  nullableOnly: boolean;
  unindexedForeignOnly: boolean;
  idWithoutForeignOnly: boolean;
}

export function matchesColumn(table: ColumnTableEntity, column: ColumnTableColumn, facts: ColumnFacts, filters: ColumnFilters): boolean {
  if (filters.families.size && !filters.families.has(columnFamily(column.type))) return false;
  if (filters.nullableOnly && nullableState(column.nullable) !== 'nullable') return false;
  if (filters.unindexedForeignOnly && !facts.unindexedDeclared) return false;
  if (filters.idWithoutForeignOnly && (!/_id$/i.test(column.name) || facts.foreign)) return false;
  const query = filters.search.trim().toLowerCase();
  return !query || [table.id, table.name, table.schema, table.className, column.name].some(value => value?.toLowerCase().includes(query));
}

export function formatProfileValue(value: unknown): string {
  if (value === undefined) return 'Not available';
  if (value === null) return 'NULL';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
