import type { SchemaColumn, SchemaGraph, SchemaIndex, SchemaLink, SchemaTable } from './types';

type RecordValue = Record<string, unknown>;
export type DiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';
export type DiffDialect = 'postgresql' | 'mysql';
export interface DiffDetail {
  kind: 'table' | 'column' | 'primary key' | 'foreign key' | 'index' | 'unique';
  name: string;
  status: DiffStatus;
  fields: string[];
  before?: unknown;
  after?: unknown;
  destructive: boolean;
}
export interface TableDiff { id: string; before?: SchemaTable; after?: SchemaTable; status: DiffStatus; details: DiffDetail[] }
export interface ForeignKey {
  source: string; target: string; name?: string; columns: string[]; targetColumns: string[];
  onDelete?: unknown; onUpdate?: unknown; deferrable?: unknown; initiallyDeferred?: unknown;
}
export interface SchemaComparison { tables: TableDiff[]; before: SchemaGraph; after: SchemaGraph }
export interface SqlDraft { sql: string; incomplete: string[]; destructive: string[]; statementCount: number }

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function stableValue(value: unknown): string {
  if (value === undefined) return '[not recorded]';
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort(compareText).map(key => `${JSON.stringify(key)}:${stableValue((value as RecordValue)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? String(value);
}
const same = (a: unknown, b: unknown) => stableValue(a) === stableValue(b);
function metadata(value: unknown, ...keys: string[]): { present: boolean; value?: unknown } {
  const object = record(value);
  for (const key of keys) if (own(object, key)) return { present: true, value: object[key] };
  return { present: false };
}

export function parseSchemaSnapshot(text: string): SchemaGraph {
  const parsed: unknown = JSON.parse(text);
  const stack: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > 32) throw new Error('Snapshot nesting exceeds 32 levels.');
    if (item.value && typeof item.value === 'object') for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
  }
  const value = record(parsed);
  const graph = record(Array.isArray(value.tables) ? parsed : value.graph);
  if (!Array.isArray(graph.tables) || !Array.isArray(graph.links)) throw new Error('Snapshot must contain tables and links arrays.');
  if (graph.tables.length > 20000 || graph.links.length > 100000) throw new Error('Snapshot exceeds 20,000 tables or 100,000 links.');
  const ids = new Set<string>();
  let columnCount = 0;
  for (const candidate of graph.tables) {
    const table = record(candidate);
    if (typeof table.id !== 'string' || !table.id || ids.has(table.id)) throw new Error('Every table must have a unique, nonempty id.');
    ids.add(table.id);
    if (!Array.isArray(table.allColumns) || !Array.isArray(table.indexes) || !Array.isArray(table.uniques)) throw new Error(`Table ${table.id} requires allColumns, indexes and uniques arrays.`);
    if (table.name !== undefined && typeof table.name !== 'string' || table.schema !== undefined && typeof table.schema !== 'string') throw new Error('Table name and schema must be strings.');
    if (table.primaryKey !== undefined && (!Array.isArray(table.primaryKey) || !table.primaryKey.every(item => typeof item === 'string'))) throw new Error(`Invalid primary key in ${table.id}.`);
    const columns = new Set<string>();
    for (const candidateColumn of table.allColumns) {
      const column = record(candidateColumn);
      if (typeof column.name !== 'string' || !column.name || columns.has(column.name) || typeof column.type !== 'string') throw new Error(`Invalid or duplicate column in ${table.id}.`);
      columns.add(column.name);
      if (!['', 'True', 'False'].includes(String(column.nullable ?? ''))) throw new Error(`Invalid nullability for ${table.id}.${column.name}.`);
    }
    columnCount += columns.size;
    if (columnCount > 200000) throw new Error('Snapshot exceeds 200,000 columns.');
    for (const candidateIndex of [...table.indexes, ...table.uniques]) {
      const index = record(candidateIndex);
      if (!Array.isArray(index.columns) || !index.columns.every(item => typeof item === 'string') || index.name !== undefined && typeof index.name !== 'string') throw new Error(`Invalid index in ${table.id}.`);
    }
  }
  for (const candidate of graph.links) {
    const link = record(candidate);
    if (!['source', 'target', 'column', 'targetColumn'].every(key => typeof link[key] === 'string') || !['declared FK', 'inferred by naming'].includes(String(link.kind)) || link.constraintId !== undefined && typeof link.constraintId !== 'string') throw new Error('Invalid relationship in snapshot.');
  }
  // Keep extra catalog metadata as data. Snapshot text is never evaluated.
  return graph as unknown as SchemaGraph;
}

export function resolveDialect(value: unknown): DiffDialect | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^(postgres|postgresql)$/i.test(value)) return 'postgresql';
  if (/^mysql$/i.test(value)) return 'mysql';
  return undefined;
}
export const diffTableLabel = (table: SchemaTable) => table.name ? `${table.schema ? `${table.schema}.` : ''}${table.name}` : table.id;
export function tableKind(table: SchemaTable): string {
  const kind = metadata(table, 'kind', 'tableKind').value;
  if (typeof kind === 'string') { const normalized = kind.toLowerCase().replaceAll('_', ' '); return normalized === 'base table' ? 'table' : normalized; }
  return /view/i.test(table.type || '') ? table.type.toLowerCase() : 'table';
}
function primaryKey(table: SchemaTable): string[] {
  if (table.primaryKey) return table.primaryKey;
  const marked = table.allColumns.filter(column => column.pk).map(column => column.name);
  return marked.length ? marked : table.pk && table.allColumns.some(column => column.name === table.pk) ? [table.pk] : [];
}
const pkName = (table: SchemaTable) => metadata(table, 'primaryKeyName', 'primaryKeyConstraintName', 'pkConstraintName').value;
export function foreignKeys(graph: SchemaGraph): ForeignKey[] {
  const groups = new Map<string, ForeignKey>();
  graph.links.filter(link => link.kind === 'declared FK').forEach((link, index) => {
    const linkName = metadata(link, 'name').value;
    const name = typeof linkName === 'string' && linkName ? linkName : link.constraintId || undefined;
    const groupId = link.constraintId || name;
    const key = groupId ? stableValue([link.source, groupId, link.target]) : `unnamed:${index}`;
    const existing = groups.get(key);
    if (existing) { existing.columns.push(link.column); existing.targetColumns.push(link.targetColumn); }
    else {
      const extras = record(link);
      const sourceColumn = graph.tables.find(table => table.id === link.source)?.allColumns.find(column => column.name === link.column);
      const deletion = metadata(link, 'onDelete', 'ondelete').value ?? metadata(sourceColumn, 'onDelete', 'ondelete').value;
      groups.set(key, { source: link.source, target: link.target, name, columns: [link.column], targetColumns: [link.targetColumn], onDelete: deletion === '' ? undefined : deletion, onUpdate: metadata(link, 'onUpdate', 'onupdate').value, deferrable: extras.deferrable, initiallyDeferred: extras.initiallyDeferred });
    }
  });
  return [...groups.values()].sort((a, b) => compareText(stableValue(a), stableValue(b)));
}
function indexShape(index: SchemaIndex) {
  const extra = record(index);
  return { name: index.name, columns: index.columns, unique: Boolean(index.unique), partial: Boolean(index.partial), expression: extra.expression, predicate: metadata(index, 'where', 'predicate').value, method: extra.method, include: extra.include, orders: extra.orders, lengths: extra.lengths };
}
const sortedIndexes = (indexes: SchemaIndex[]) => indexes.map(indexShape).sort((a, b) => compareText(stableValue(a), stableValue(b)));
const orderedIndexes = (indexes: SchemaIndex[]) => [...indexes].sort((a, b) => compareText(stableValue(indexShape(a)), stableValue(indexShape(b))));
function columnShape(column: SchemaColumn) {
  const type = columnType(column);
  return { type: type.includes("'") ? type.trim() : type.trim().replace(/\s+/g, ' ').toLowerCase(), nullable: column.nullable || '', default: metadata(column, 'default'), serverDefault: metadata(column, 'serverDefault', 'server_default'), applicationDefault: metadata(column, 'applicationDefault'), pk: Boolean(column.pk), indexed: Boolean(column.index), unique: Boolean(column.unique), foreignKey: column.fk || '', generated: Object.fromEntries(['generated', 'computed', 'identity', 'autoIncrement', 'autoincrement'].map(key => [key, metadata(column, key)])), collation: metadata(column, 'collation') };
}
function columnType(column: SchemaColumn): string {
  const definition = metadata(column, 'typeDefinition').value;
  return typeof definition === 'string' && definition ? definition : column.type;
}
const serverDefault = (column: SchemaColumn) => metadata(column, 'serverDefault', 'server_default', 'default');
function changedFields(before: unknown, after: unknown): string[] {
  const a = record(before), b = record(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => !same(a[key], b[key]));
}
export function compareSchemas(before: SchemaGraph, after: SchemaGraph): SchemaComparison {
  const beforeMap = new Map(before.tables.map(table => [table.id, table]));
  const afterMap = new Map(after.tables.map(table => [table.id, table]));
  const fksA = foreignKeys(before), fksB = foreignKeys(after);
  const tables = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(compareText).map(id => {
    const a = beforeMap.get(id), b = afterMap.get(id);
    const details: DiffDetail[] = [];
    if (!a || !b) return { id, before: a, after: b, status: a ? 'removed' as const : 'added' as const, details: [{ kind: 'table' as const, name: id, status: a ? 'removed' as const : 'added' as const, fields: [], before: a, after: b, destructive: Boolean(a) }] };
    const tableShape = (table: SchemaTable) => ({ name: table.name, schema: table.schema, kind: tableKind(table), definition: metadata(table, 'definition', 'viewDefinition', 'view_definition'), checks: metadata(table, 'checks', 'checkConstraints') });
    const tableFields = changedFields(tableShape(a), tableShape(b));
    if (tableFields.length) details.push({ kind: 'table', name: id, status: 'changed', fields: tableFields, before: tableShape(a), after: tableShape(b), destructive: tableFields.some(field => field !== 'definition') });
    const ac = new Map(a.allColumns.map(column => [column.name, column]));
    const bc = new Map(b.allColumns.map(column => [column.name, column]));
    for (const name of [...new Set([...ac.keys(), ...bc.keys()])].sort(compareText)) {
      const ca = ac.get(name), cb = bc.get(name);
      const fields = ca && cb ? changedFields(columnShape(ca), columnShape(cb)) : [];
      if (!ca || !cb || fields.length) details.push({ kind: 'column', name, status: !ca ? 'added' : !cb ? 'removed' : 'changed', fields, before: ca ? columnShape(ca) : undefined, after: cb ? columnShape(cb) : undefined, destructive: !cb || fields.includes('type') || Boolean(fields.includes('nullable') && cb?.nullable === 'False') });
    }
    const checks: [DiffDetail['kind'], unknown, unknown][] = [
      ['primary key', { columns: primaryKey(a), name: pkName(a) }, { columns: primaryKey(b), name: pkName(b) }],
      ['foreign key', fksA.filter(fk => fk.source === id), fksB.filter(fk => fk.source === id)],
      ['index', sortedIndexes(a.indexes), sortedIndexes(b.indexes)],
      ['unique', sortedIndexes(a.uniques), sortedIndexes(b.uniques)],
    ];
    for (const [kind, av, bv] of checks) if (!same(av, bv)) details.push({ kind, name: id, status: 'changed', fields: [kind], before: av, after: bv, destructive: false });
    return { id, before: a, after: b, status: details.length ? 'changed' as const : 'unchanged' as const, details };
  });
  return { before, after, tables };
}

export function quoteIdentifier(value: string, dialect: DiffDialect): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('An identifier is empty or contains control characters.');
  const quote = dialect === 'mysql' ? '`' : '"';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}
export function qualifiedName(table: SchemaTable, dialect: DiffDialect): string {
  if (!table.name && table.id.includes('.')) throw new Error(`${table.id}: supply separate name and schema fields for a qualified identity.`);
  return `${table.schema ? `${quoteIdentifier(table.schema, dialect)}.` : ''}${quoteIdentifier(table.name || table.id, dialect)}`;
}
function comment(text: string): string { return String(text).replace(/\r/g, '').split('\n').map(line => `-- ${line}`).join('\n'); }
const nameList = (columns: string[], dialect: DiffDialect) => columns.map(column => quoteIdentifier(column, dialect)).join(', ');
function supportedType(value: string, dialect: DiffDialect): string | undefined {
  let type = value.trim().replace(/\s+/g, ' ').toLowerCase();
  type = type.replace(/^biginteger\b/, 'bigint').replace(/^smallinteger\b/, 'smallint').replace(/^unicodetext\b/, 'text').replace(/^(?:string|unicode)\b/, 'varchar').replace(/^largebinary\b/, dialect === 'postgresql' ? 'bytea' : 'blob').replace(/^datetime$/, dialect === 'postgresql' ? 'timestamp' : 'datetime');
  const postgres = /^(?:(?:smallint|integer|int|bigint|int2|int4|int8|real|double precision|boolean|bool|text|bytea|uuid|json|jsonb|date|money)|(?:(?:numeric|decimal)(?:\(\d+(?:,\s*\d+)?\))?)|(?:(?:varchar|character varying|char|character|bit|bit varying)(?:\(\d+\))?)|(?:(?:timestamp|time)(?:\(\d+\))?(?: (?:with|without) time zone)?))(?:\[\])*$/;
  const mysql = /^(?:(?:(?:tinyint|smallint|mediumint|int|integer|bigint)(?:\(\d+\))?(?: unsigned)?)|(?:(?:decimal|numeric|float|double)(?:\(\d+(?:,\s*\d+)?\))?(?: unsigned)?)|(?:bool|boolean|text|tinytext|mediumtext|longtext|blob|tinyblob|mediumblob|longblob|json|date|year)|(?:(?:varchar|char|binary|varbinary|bit)\(\d+\))|(?:(?:datetime|timestamp|time)(?:\(\d+\))?))$/;
  return (dialect === 'postgresql' ? postgres : mysql).test(type) ? type.toUpperCase() : undefined;
}
function defaultSql(value: unknown, dialect: DiffDialect): string | undefined {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^(?:null|true|false|current_timestamp(?:\(\))?|current_date(?:\(\))?|current_time(?:\(\))?)$/i.test(trimmed)) return trimmed.toUpperCase().replace(/\(\)$/, '');
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return trimmed;
  if (/^'(?:[^'\\]|'')*'$/.test(trimmed)) return trimmed;
  // Arbitrary SQL, escaped-string dialect modes and ORM callables are not parsed.
  void dialect;
  return undefined;
}

class SqlBuilder {
  incomplete: string[] = [];
  destructive: string[] = [];
  constructor(readonly dialect: DiffDialect) {}
  issue(message: string): undefined { if (!this.incomplete.includes(message)) this.incomplete.push(message); return undefined; }
  table(table: SchemaTable): string | undefined {
    try { return qualifiedName(table, this.dialect); } catch (error) { return this.issue(error instanceof Error ? error.message : 'Invalid table name.'); }
  }
  identifier(value: string): string | undefined {
    try { return quoteIdentifier(value, this.dialect); } catch (error) { return this.issue(error instanceof Error ? error.message : 'Invalid identifier.'); }
  }
  columns(columns: string[]): string | undefined {
    if (!columns.length || new Set(columns).size !== columns.length) return this.issue('Empty or duplicate columns in an ordered constraint.');
    try { return nameList(columns, this.dialect); } catch (error) { return this.issue(error instanceof Error ? error.message : 'Invalid column name.'); }
  }
  column(column: SchemaColumn, table: SchemaTable): string | undefined {
    const label = `${diffTableLabel(table)}.${column.name}`;
    const name = this.identifier(column.name), type = supportedType(columnType(column), this.dialect);
    if (!type) return this.issue(`${label}: unsupported type ${columnType(column)}; column DDL omitted.`);
    if (column.nullable !== 'True' && column.nullable !== 'False') return this.issue(`${label}: nullability is not recorded; full column DDL omitted.`);
    const extras = record(column);
    if (['generated', 'computed', 'identity', 'autoIncrement', 'autoincrement', 'collation'].some(key => extras[key] !== undefined && extras[key] !== false && extras[key] !== null)) return this.issue(`${label}: generated, identity, collation or auto-increment semantics require manual DDL.`);
    const server = serverDefault(column);
    let suffix = '';
    if (server.present && server.value !== null) {
      const value = defaultSql(server.value, this.dialect);
      if (value === undefined) return this.issue(`${label}: unsupported server-default expression; DDL omitted.`);
      suffix = ` DEFAULT ${value}`;
    }
    return name ? `${name} ${type}${column.nullable === 'False' ? ' NOT NULL' : ' NULL'}${suffix}` : undefined;
  }
  key(table: SchemaTable, columns: string[], kind: 'PRIMARY KEY' | 'UNIQUE', rawName?: unknown): string | undefined {
    if (kind === 'PRIMARY KEY' && columns.length > 1 && !table.primaryKey) return this.issue(`${table.id}: ordered composite primaryKey metadata is missing.`);
    if (!columns.every(column => table.allColumns.some(candidate => candidate.name === column))) return this.issue(`${table.id}: ${kind} references an absent column.`);
    const list = this.columns(columns), name = typeof rawName === 'string' && rawName ? this.identifier(rawName) : undefined;
    if (rawName !== undefined && rawName !== null && !name) return this.issue(`${table.id}: constraint name must be a nonempty string.`);
    return list ? `${name ? `CONSTRAINT ${name} ` : ''}${kind} (${list})` : undefined;
  }
  index(table: SchemaTable, index: SchemaIndex): string | undefined {
    const extra = record(index);
    if (index.partial || index.expression || ['where', 'predicate', 'include', 'method', 'orders', 'lengths'].some(key => extra[key] !== undefined)) return this.issue(`${table.id}: index ${index.name || stableValue(index.columns)} has unsupported partial, expression or index options.`);
    if (!index.columns.every(column => table.allColumns.some(candidate => candidate.name === column))) return this.issue(`${table.id}: index references an absent column.`);
    const tableName = this.table(table), columns = this.columns(index.columns);
    const name = index.name ? this.identifier(index.name) : undefined;
    if (!name && this.dialect === 'mysql') return this.issue(`${table.id}: MySQL index name is not recorded.`);
    return tableName && columns ? `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX${name ? ` ${name}` : ''} ON ${tableName} (${columns});` : undefined;
  }
  foreign(fk: ForeignKey, graph: SchemaGraph): string | undefined {
    const source = graph.tables.find(table => table.id === fk.source), target = graph.tables.find(table => table.id === fk.target);
    if (!source || !target || tableKind(source) !== 'table' || tableKind(target) !== 'table') return this.issue(`${fk.source}: FK ${fk.name || stableValue(fk.columns)} references an absent or unsupported table.`);
    if (!fk.columns.every(name => source.allColumns.some(column => column.name === name)) || !fk.targetColumns.every(name => target.allColumns.some(column => column.name === name))) return this.issue(`${fk.source}: FK columns are absent from the snapshot.`);
    const tableName = this.table(source), targetName = this.table(target), columns = this.columns(fk.columns), targetColumns = this.columns(fk.targetColumns);
    const name = fk.name ? this.identifier(fk.name) : undefined;
    if (fk.name && !name) return undefined;
    let options = '';
    for (const [label, value] of [['DELETE', fk.onDelete], ['UPDATE', fk.onUpdate]] as const) if (value !== undefined) {
      const action = typeof value === 'string' ? value.toUpperCase() : '';
      if (!['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'].includes(action) || this.dialect === 'mysql' && action === 'SET DEFAULT') return this.issue(`${fk.source}: unsupported ON ${label} action.`);
      options += ` ON ${label} ${action}`;
    }
    if (fk.deferrable || fk.initiallyDeferred) {
      if (this.dialect !== 'postgresql' || fk.deferrable !== true || fk.initiallyDeferred !== undefined && typeof fk.initiallyDeferred !== 'boolean') return this.issue(`${fk.source}: unsupported FK deferrability.`);
      options += ` DEFERRABLE${fk.initiallyDeferred ? ' INITIALLY DEFERRED' : ' INITIALLY IMMEDIATE'}`;
    }
    return tableName && targetName && columns && targetColumns ? `ALTER TABLE ${tableName} ADD ${name ? `CONSTRAINT ${name} ` : ''}FOREIGN KEY (${columns}) REFERENCES ${targetName} (${targetColumns})${options};` : undefined;
  }
  createTable(table: SchemaTable, graph: SchemaGraph): string | undefined {
    if (tableKind(table) !== 'table') return this.issue(`${table.id}: ${tableKind(table)} definition requires manual DDL.`);
    const name = this.table(table), columns = table.allColumns.map(column => this.column(column, table));
    const checks = metadata(table, 'checks', 'checkConstraints').value;
    if (checks && (!Array.isArray(checks) || checks.length)) this.issue(`${table.id}: check-constraint expressions are not reconstructed.`);
    for (const column of table.allColumns) {
      if (column.index && !table.indexes.some(index => index.columns.includes(column.name)) && !primaryKey(table).includes(column.name) && !table.uniques.some(key => key.columns.includes(column.name))) this.issue(`${table.id}.${column.name}: index flag lacks a full index definition.`);
      if (column.unique && !table.uniques.some(key => key.columns.includes(column.name)) && !table.indexes.some(index => index.unique && index.columns.includes(column.name)) && !primaryKey(table).includes(column.name)) this.issue(`${table.id}.${column.name}: unique flag lacks an ordered constraint definition.`);
      if (column.fk && !graph.links.some(link => link.source === table.id && link.column === column.name && link.kind === 'declared FK')) this.issue(`${table.id}.${column.name}: FK metadata lacks a declared relationship definition.`);
    }
    if (!columns.length || columns.some(column => !column)) return this.issue(`${table.id}: CREATE TABLE omitted because its column definitions are incomplete.`);
    return name ? `CREATE TABLE ${name} (\n${columns.map(column => `  ${column}`).join(',\n')}\n);` : undefined;
  }
  result(lines: string[]): SqlDraft {
    const header = [comment(`DRAFT ONLY - ${this.dialect}; A -> B. No execution is performed.`), ...this.destructive.map(item => comment(`DESTRUCTIVE / DATA REVIEW: ${item}`)), ...this.incomplete.map(item => comment(`INCOMPLETE: ${item}`))];
    return { sql: [...header, '', ...lines].join('\n'), incomplete: this.incomplete, destructive: this.destructive, statementCount: lines.filter(line => !line.startsWith('--') && line.trim()).length };
  }
}

export function tableDDL(graph: SchemaGraph, table: SchemaTable | undefined, dialectValue: string): SqlDraft {
  const dialect = resolveDialect(dialectValue);
  if (!dialect) return { sql: comment(`INCOMPLETE: unsupported dialect ${dialectValue || '(unknown)'}.`), incomplete: ['Unsupported or unknown dialect.'], destructive: [], statementCount: 0 };
  const builder = new SqlBuilder(dialect);
  if (graph.project?.dialect && resolveDialect(graph.project.dialect) !== dialect) {
    builder.issue(`Snapshot dialect ${graph.project.dialect} does not match ${dialect}; DDL translation is unsupported.`);
    return builder.result([]);
  }
  if (!table) return builder.result([comment('Table absent in this snapshot.')]);
  if (tableKind(table) !== 'table') {
    builder.issue(`${table.id}: view or non-table definition is displayed as source text only.`);
    const definition = metadata(table, 'definition', 'viewDefinition', 'view_definition').value;
    return builder.result([comment(`Definition: ${definition === undefined ? '[not recorded]' : typeof definition === 'string' ? definition : stableValue(definition)}`)]);
  }
  const lines: string[] = [];
  const create = builder.createTable(table, graph);
  if (create) {
    lines.push(create);
    const tableName = builder.table(table)!;
    if (primaryKey(table).length) { const key = builder.key(table, primaryKey(table), 'PRIMARY KEY', pkName(table)); if (key) lines.push(`ALTER TABLE ${tableName} ADD ${key};`); }
    for (const unique of orderedIndexes(table.uniques)) {
      if (unique.partial || unique.expression) { builder.issue(`${table.id}: unsupported unique expression or predicate.`); continue; }
      const key = builder.key(table, unique.columns, 'UNIQUE', unique.name); if (key) lines.push(`ALTER TABLE ${tableName} ADD ${key};`);
    }
    for (const index of orderedIndexes(table.indexes)) { const sql = builder.index(table, index); if (sql) lines.push(sql); }
    for (const fk of foreignKeys(graph).filter(fk => fk.source === table.id)) { const sql = builder.foreign(fk, graph); if (sql) lines.push(sql); }
  }
  return builder.result(lines);
}

function constraintMatch(fk: ForeignKey): string { return stableValue([fk.source, fk.target, fk.name, fk.columns, fk.targetColumns, fk.onDelete, fk.onUpdate, fk.deferrable, fk.initiallyDeferred]); }
function indexDelta(before: SchemaIndex[], after: SchemaIndex[]): { removed: SchemaIndex[]; added: SchemaIndex[] } {
  return { removed: orderedIndexes(before.filter(index => !after.some(other => same(indexShape(index), indexShape(other))))), added: orderedIndexes(after.filter(index => !before.some(other => same(indexShape(index), indexShape(other))))) };
}

export function migrationDraft(comparison: SchemaComparison, dialectValue: string): SqlDraft {
  const dialect = resolveDialect(dialectValue);
  if (!dialect) return { sql: comment(`INCOMPLETE: unsupported dialect ${dialectValue || '(unknown)'}. No migration SQL generated.`), incomplete: ['Unsupported or unknown dialect.'], destructive: [], statementCount: 0 };
  const builder = new SqlBuilder(dialect);
  const { before, after } = comparison;
  for (const graph of [before, after]) {
    const sourceDialect = graph.project?.dialect;
    if (sourceDialect && resolveDialect(sourceDialect) !== dialect) {
      builder.issue(`Snapshot dialect ${sourceDialect} does not match ${dialect}; cross-dialect translation is unsupported.`);
      return builder.result([]);
    }
  }
  const changed = comparison.tables.filter(table => table.status !== 'unchanged');
  const touched = new Set(changed.filter(table => table.details.some(detail => detail.kind !== 'column' || detail.status !== 'changed' || detail.fields.some(field => field !== 'applicationDefault'))).map(table => table.id));
  const aFks = foreignKeys(before), bFks = foreignKeys(after);
  const dropFks = aFks.filter(fk => touched.has(fk.source) || touched.has(fk.target) || !bFks.some(other => constraintMatch(other) === constraintMatch(fk)));
  const addFks = bFks.filter(fk => touched.has(fk.source) || touched.has(fk.target) || !aFks.some(other => constraintMatch(other) === constraintMatch(fk)));
  const blocked = new Set<string>();
  // A missing drop name must not leave active dependent ALTER statements behind.
  for (const fk of dropFks) if (!fk.name) {
    builder.issue(`${fk.source}: affected FK (${fk.columns.join(', ')}) has no constraintId; dependent edits omitted.`);
    blocked.add(fk.source); blocked.add(fk.target);
  }
  for (const diff of changed) {
    const a = diff.before, b = diff.after;
    if (a && tableKind(a) !== 'table' || b && tableKind(b) !== 'table') { builder.issue(`${diff.id}: view or non-table changes require manual DDL.`); blocked.add(diff.id); }
    if (a && b && (a.name !== b.name || a.schema !== b.schema || tableKind(a) !== tableKind(b))) { builder.issue(`${diff.id}: name, schema or object-kind change requires explicit rename/conversion DDL.`); blocked.add(diff.id); }
    if (diff.details.some(detail => detail.kind === 'table' && detail.fields.some(field => ['definition', 'checks'].includes(field)))) { builder.issue(`${diff.id}: definition or check-expression changes require manual DDL.`); blocked.add(diff.id); }
    if (a && b && !same({ columns: primaryKey(a), name: pkName(a) }, { columns: primaryKey(b), name: pkName(b) }) && primaryKey(a).length && dialect === 'postgresql' && typeof pkName(a) !== 'string') {
      builder.issue(`${diff.id}: PostgreSQL primary-key constraint name is missing; dependent edits omitted.`); blocked.add(diff.id);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const fk of [...dropFks, ...addFks]) if (blocked.has(fk.source) !== blocked.has(fk.target)) {
      blocked.add(fk.source); blocked.add(fk.target); grew = true;
    }
  }
  const phases: { sql: string; owners: string[] }[][] = [[], [], [], [], []];
  let currentOwners: string[] = [];
  const append = (phase: number, sql: string | undefined) => { if (sql) phases[phase].push({ sql, owners: [...currentOwners] }); };
  for (const fk of dropFks) {
    currentOwners = [fk.source, fk.target];
    if (blocked.has(fk.source) || blocked.has(fk.target)) continue;
    const source = before.tables.find(table => table.id === fk.source);
    if (!source) { builder.issue(`${fk.source}: source table is absent for FK removal.`); blocked.add(fk.source); blocked.add(fk.target); continue; }
    const name = builder.identifier(fk.name!), tableName = builder.table(source);
    if (name && tableName) append(0, `ALTER TABLE ${tableName} DROP ${dialect === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT'} ${name};`);
    else { blocked.add(fk.source); blocked.add(fk.target); }
  }
  for (const diff of changed) {
    currentOwners = [diff.id];
    const issueCount = builder.incomplete.length;
    if (blocked.has(diff.id)) { builder.issue(`${diff.id}: table edits withheld due to unresolved constraint or object dependencies.`); continue; }
    const a = diff.before, b = diff.after;
    const table = b || a!, tableName = builder.table(table);
    if (!tableName) continue;
    if (!b) { builder.destructive.push(`DROP TABLE ${diffTableLabel(a!)} removes its data.`); append(2, `DROP TABLE ${tableName};`); continue; }
    if (!a) {
      const create = builder.createTable(b, after);
      if (create) append(2, create);
      else { blocked.add(diff.id); continue; }
    }
    const pkChanged = !a || !same({ columns: primaryKey(a), name: pkName(a) }, { columns: primaryKey(b), name: pkName(b) });
    if (a && pkChanged && primaryKey(a).length) {
      if (dialect === 'mysql') append(1, `ALTER TABLE ${tableName} DROP PRIMARY KEY;`);
      else { const name = builder.identifier(String(pkName(a))); if (name) append(1, `ALTER TABLE ${tableName} DROP CONSTRAINT ${name};`); }
    }
    const withoutBackingIndexes = (table: SchemaTable | undefined) => table?.indexes.filter(index => !index.name || index.name !== pkName(table) && !table.uniques.some(unique => unique.name === index.name)) || [];
    const indexes = indexDelta(withoutBackingIndexes(a), withoutBackingIndexes(b)), uniques = indexDelta(a?.uniques || [], b.uniques);
    for (const [kind, delta] of [['index', indexes], ['unique', uniques]] as const) for (const old of delta.removed) {
      if (!old.name) { builder.issue(`${diff.id}: removed ${kind} (${old.columns.join(', ')}) has no catalog name.`); continue; }
      const name = builder.identifier(old.name);
      if (!name) continue;
      if (kind === 'unique' && dialect === 'postgresql') append(1, `ALTER TABLE ${tableName} DROP CONSTRAINT ${name};`);
      else if (dialect === 'mysql') append(1, `DROP INDEX ${name} ON ${tableName};`);
      else { const schema = table.schema ? builder.identifier(table.schema) : undefined; if (!table.schema || schema) append(1, `DROP INDEX ${schema ? `${schema}.` : ''}${name};`); }
    }
    if (a) for (const detail of diff.details.filter(detail => detail.kind === 'column')) {
      const old = a.allColumns.find(column => column.name === detail.name), next = b.allColumns.find(column => column.name === detail.name);
      const columnName = builder.identifier(detail.name);
      if (!columnName) continue;
      if (!next) { builder.destructive.push(`DROP COLUMN ${diff.id}.${detail.name} removes its data.`); append(2, `ALTER TABLE ${tableName} DROP COLUMN ${columnName};`); continue; }
      if (!old) {
        if (next.nullable === 'False') builder.destructive.push(`${diff.id}.${detail.name}: new NOT NULL column may need a backfill.`);
        append(2, (() => { const column = builder.column(next, b); return column ? `ALTER TABLE ${tableName} ADD COLUMN ${column};` : undefined; })()); continue;
      }
      if (detail.fields.includes('applicationDefault')) append(2, comment(`${diff.id}.${detail.name}: applicationDefault changed; no database DDL applies.`));
      if (detail.fields.includes('foreignKey') && ![...aFks, ...bFks].some(fk => fk.source === diff.id && fk.columns.includes(detail.name))) builder.issue(`${diff.id}.${detail.name}: FK metadata changed without a declared relationship definition.`);
      if (detail.fields.some(field => ['generated', 'collation'].includes(field))) { builder.issue(`${diff.id}.${detail.name}: generated or collation changes need manual DDL.`); continue; }
      if (detail.fields.includes('indexed') && !b.indexes.some(index => index.columns.includes(next.name)) && !a.indexes.some(index => index.columns.includes(next.name))) builder.issue(`${diff.id}.${detail.name}: index flag changed without a full index definition.`);
      if (detail.fields.includes('unique') && ![...b.uniques, ...a.uniques, ...b.indexes.filter(index => index.unique), ...a.indexes.filter(index => index.unique)].some(key => key.columns.includes(next.name))) builder.issue(`${diff.id}.${detail.name}: unique flag changed without an ordered constraint definition.`);
      const typeChanged = detail.fields.includes('type'), nullableChanged = detail.fields.includes('nullable');
      if (typeChanged) builder.destructive.push(`${diff.id}.${detail.name}: type change ${columnType(old)} -> ${columnType(next)} may require a data conversion.`);
      if (nullableChanged && next.nullable === 'False') builder.destructive.push(`${diff.id}.${detail.name}: NOT NULL rejects existing nulls.`);
      if (dialect === 'mysql' && (typeChanged || nullableChanged)) {
        if (!serverDefault(next).present) { builder.issue(`${diff.id}.${detail.name}: full MySQL column modification requires explicit server-default metadata, including null for no default.`); continue; }
        const column = builder.column(next, b);
        if (column) append(2, `ALTER TABLE ${tableName} MODIFY COLUMN ${column};`);
        continue;
      }
      if (typeChanged) {
        const type = supportedType(columnType(next), dialect);
        if (!type) { builder.issue(`${diff.id}.${detail.name}: unsupported type ${columnType(next)}; ALTER TYPE omitted.`); continue; }
        if (serverDefault(old).present && serverDefault(old).value !== null || serverDefault(next).present) append(2, `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT;`);
        append(2, comment(`${diff.id}.${detail.name}: verify assignment cast and existing default compatibility; no USING expression is guessed.`));
        append(2, `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${type};`);
      }
      if (nullableChanged) {
        if (next.nullable !== 'True' && next.nullable !== 'False') builder.issue(`${diff.id}.${detail.name}: target nullability is unknown.`);
        else append(2, `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} ${next.nullable === 'False' ? 'SET' : 'DROP'} NOT NULL;`);
      }
      if (detail.fields.includes('serverDefault') || detail.fields.includes('default') || typeChanged && (serverDefault(old).present && serverDefault(old).value !== null || serverDefault(next).present)) {
        const server = serverDefault(next);
        if (!server.present) builder.issue(`${diff.id}.${detail.name}: target server default is not recorded; no DROP DEFAULT inferred.`);
        else if (server.value === null) append(2, `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT;`);
        else { const value = defaultSql(server.value, dialect); if (value !== undefined) append(2, `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${value};`); else builder.issue(`${diff.id}.${detail.name}: unsupported server-default expression.`); }
      }
    }
    if (pkChanged && primaryKey(b).length) { const key = builder.key(b, primaryKey(b), 'PRIMARY KEY', pkName(b)); if (key) append(3, `ALTER TABLE ${tableName} ADD ${key};`); }
    for (const index of indexes.added) append(3, builder.index(b, index));
    for (const unique of uniques.added) {
      if (unique.partial || unique.expression) { builder.issue(`${diff.id}: unsupported unique expression or predicate.`); continue; }
      const key = builder.key(b, unique.columns, 'UNIQUE', unique.name); if (key) append(3, `ALTER TABLE ${tableName} ADD ${key};`);
    }
    if (builder.incomplete.length > issueCount) blocked.add(diff.id);
  }
  for (const fk of addFks) if (!blocked.has(fk.source) && !blocked.has(fk.target)) {
    currentOwners = [fk.source, fk.target];
    const sql = builder.foreign(fk, after);
    if (sql) append(4, sql); else { blocked.add(fk.source); blocked.add(fk.target); }
  }
  grew = true;
  while (grew) {
    grew = false;
    for (const fk of [...dropFks, ...addFks]) if (blocked.has(fk.source) !== blocked.has(fk.target)) { blocked.add(fk.source); blocked.add(fk.target); grew = true; }
  }
  for (const id of blocked) if (touched.has(id)) builder.issue(`${id}: dependent SQL withheld until incomplete metadata is resolved.`);
  const titles = ['1. Drop affected foreign keys', '2. Drop replaced keys and indexes', '3. Change tables and columns', '4. Recreate keys and indexes', '5. Recreate foreign keys'];
  const lines = phases.flatMap((statements, index) => {
    const supported = statements.filter(statement => !statement.owners.some(id => blocked.has(id))).map(statement => statement.sql);
    return supported.length ? [comment(titles[index]), ...supported, ''] : [];
  });
  if (!lines.length && !builder.incomplete.length) lines.push(comment('No structural changes.'));
  return builder.result(lines);
}

export interface UnionEdge { key: string; source: string; target: string; status: DiffStatus; before?: SchemaLink[]; after?: SchemaLink[] }
export function unionEdges(before: SchemaGraph, after: SchemaGraph): UnionEdge[] {
  const group = (graph: SchemaGraph) => {
    const result = new Map<string, SchemaLink[]>();
    graph.links.forEach(link => { const key = stableValue([link.source, link.target, link.constraintId || link.column, link.kind]); const list = result.get(key) || []; list.push(link); result.set(key, list); });
    return result;
  };
  const a = group(before), b = group(after);
  return [...new Set([...a.keys(), ...b.keys()])].sort(compareText).map(key => {
    const av = a.get(key), bv = b.get(key), link = (bv || av)![0];
    return { key, source: link.source, target: link.target, status: !av ? 'added' : !bv ? 'removed' : same(av, bv) ? 'unchanged' : 'changed', before: av, after: bv };
  });
}
