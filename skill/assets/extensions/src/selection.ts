/**
 * Selection model for drill-through (work package C03, feature F14, ADR-0004 decision 1).
 *
 * A `Selection` is a value, never a store: the shell owns the current one and passes it down
 * through `ViewProps.selected`. This module holds the view-id union, the selection and
 * navigation-target shapes, and the pure helpers that build, parse and validate the id forms of
 * `docs/architecture/schema-graph-contract.md` B3:
 *
 *   table         `table.id`
 *   column        `table.id#column`
 *   relationship  `constraintId`, else `source.column>target.targetColumn`
 *   finding       an opaque id, not resolvable against the graph
 *
 * Separator safety (C03 brief open question 2). B3 states that `#` and `>` are not permitted in
 * identifiers, but the contract imposes no character-set pattern on `table.id` or `column.name`
 * (`schema-graph-contract.md` B4) and `fixtures/schemas/hostile.json` ships a table id containing
 * `>`. So the two composite forms escape the characters that would otherwise be read as their own
 * separator - `%`, `#`, `>` and `,` - inside each component, and `parseColumnId` unescapes them.
 * An id built from ordinary characters is byte-identical to the plain concatenation, so the forms
 * above stay exactly as B3 writes them. The dot in the relationship fallback is deliberately not
 * escaped: a table id may contain dots (B3), so the fallback is never parsed positionally;
 * `resolveRelationshipRef` compares a ref against the refs computed from the graph's own links.
 *
 * This module performs no I/O: it never reads storage, never touches `location`, and never calls
 * a live connection. Warnings name the dropped field, never its value, because a selection can
 * arrive from an untrusted deep link (CTQ-07).
 */

import type { SchemaGraph, SchemaLink } from './types';

/** Every mountable view: the four ported host views, the nine bundle views, and Insights (W06). */
export type ViewId =
  | 'map' | 'entities' | 'keys' | 'review'
  | 'fanout' | 'columns' | 'city' | 'living' | 'lens' | 'domains' | 'matrix' | 'arcs' | 'diff'
  | 'insights';

/** The view ids in the order `drill-through-contract.md` section 2 lists them. */
export const VIEW_IDS: readonly ViewId[] = Object.freeze([
  'map', 'entities', 'keys', 'review',
  'fanout', 'columns', 'city', 'living', 'lens', 'domains', 'matrix', 'arcs', 'diff',
  'insights',
] as const);

/** Narrows an arbitrary value to a view id. */
export function isViewId(value: unknown): value is ViewId {
  return typeof value === 'string' && (VIEW_IDS as readonly string[]).includes(value);
}

export interface Selection {
  /** `table.id`. Exactly one of `tableId` and `tableIds` is set. */
  tableId?: string;
  /** Multi-selection: a Join Matrix cell, an Arc Diagram cycle group, a Domains community. */
  tableIds?: string[];
  /** `table.id#column`. Implies its table. */
  columnId?: string;
  /** `constraintId`, else `source.column>target.targetColumn`. Implies its two tables. */
  relationshipRef?: string;
  /** Opaque finding id. It cannot be resolved against the graph, so it is never dropped as unknown. */
  findingId?: string;
  /** The view that produced the selection. Informational: it lets a view avoid dimming itself. */
  origin?: ViewId;
}

export interface NavigationTarget {
  view: ViewId;
  selection?: Selection;
  /** The target view's `v.*` slice. Allowlisted by `route-state.ts`. */
  viewState?: Record<string, string>;
  /** The registry entry id that produced this target, for tests and telemetry. */
  reason?: string;
}

/** The selection fields a navigation entry can require or forward. */
export type SelectionShape = 'table' | 'tables' | 'column' | 'relationship' | 'finding';

const COLUMN_SEPARATOR = '#';
const RELATIONSHIP_SEPARATOR = '>';
const ESCAPES: readonly (readonly [string, string])[] = Object.freeze([
  ['%', '%25'],
  [COLUMN_SEPARATOR, '%23'],
  [RELATIONSHIP_SEPARATOR, '%3E'],
  [',', '%2C'],
] as const);

/**
 * Escapes the four separator characters inside one component of a composite id. `%` goes first so
 * that the mapping stays reversible when an identifier already contains a percent sign.
 */
export function encodeIdComponent(value: string): string {
  let result = value;
  for (const [raw, escaped] of ESCAPES) result = result.split(raw).join(escaped);
  return result;
}

/** Reverses `encodeIdComponent`. `%` goes last, mirroring the encode order. */
export function decodeIdComponent(value: string): string {
  let result = value;
  for (const [raw, escaped] of [...ESCAPES].reverse()) result = result.split(escaped).join(raw);
  return result;
}

/** `table.id#column`. */
export function columnId(tableId: string, column: string): string {
  return encodeIdComponent(tableId) + COLUMN_SEPARATOR + encodeIdComponent(column);
}

/** Splits `table.id#column`, or returns null when the id is not exactly one escaped pair. */
export function parseColumnId(id: string): { tableId: string; column: string } | null {
  const parts = id.split(COLUMN_SEPARATOR);
  if (parts.length !== 2) return null;
  const tableId = decodeIdComponent(parts[0]);
  const column = decodeIdComponent(parts[1]);
  if (!tableId || !column) return null;
  return { tableId, column };
}

/**
 * `constraintId` when the link carries one, else `source.column>target.targetColumn`. Every pair of
 * one composite foreign key shares the constraint id and therefore one ref (C11).
 */
export function relationshipRef(link: SchemaLink): string {
  if (link.constraintId) return link.constraintId;
  const source = encodeIdComponent(link.source) + '.' + encodeIdComponent(link.column);
  const target = encodeIdComponent(link.target) + '.' + encodeIdComponent(link.targetColumn);
  return source + RELATIONSHIP_SEPARATOR + target;
}

/**
 * Every link of the relationship a ref names, in graph order. A composite foreign key returns one
 * link per column pair. An unresolved ref returns an empty array; the caller drops it rather than
 * guessing (B3).
 */
export function resolveRelationshipRef(ref: string, graph: SchemaGraph): SchemaLink[] {
  if (!ref) return [];
  return graph.links.filter(link => relationshipRef(link) === ref);
}

/** The tables a relationship ref touches, source and target, deduplicated in graph order. */
export function relationshipTables(ref: string, graph: SchemaGraph): string[] {
  const tables: string[] = [];
  for (const link of resolveRelationshipRef(ref, graph)) {
    for (const id of [link.source, link.target]) if (!tables.includes(id)) tables.push(id);
  }
  return tables;
}

/** True when the selection carries nothing a view could highlight. */
export function isEmptySelection(selection: Selection): boolean {
  return !selection.tableId && !selection.tableIds?.length
    && !selection.columnId && !selection.relationshipRef && !selection.findingId;
}

/** The shapes a selection actually carries, for a navigation entry's `requires` check. */
export function selectionShapes(selection: Selection): SelectionShape[] {
  const shapes: SelectionShape[] = [];
  if (selection.tableId) shapes.push('table');
  if (selection.tableIds?.length) shapes.push('tables');
  if (selection.columnId) shapes.push('column');
  if (selection.relationshipRef) shapes.push('relationship');
  if (selection.findingId) shapes.push('finding');
  return shapes;
}

function warn(field: string, reason: string): void {
  // The field name is enough to debug a bad deep link; the value may carry schema identifiers.
  console.warn('selection: dropped ' + field + ' (' + reason + ')');
}

/**
 * Drops everything the loaded graph does not resolve and enforces "exactly one of
 * `tableId`/`tableIds`". Rules, in order:
 *
 *   1. an unknown table id is dropped with a warning, never rendered as selected (section 2 rule 3);
 *   2. `tableIds` wins when both table fields arrive, because a multi-selection carries its own
 *      primary in the first position; `tableId` is then dropped with a warning;
 *   3. `columnId` and `relationshipRef` imply their table(s): a column supplies `tableId` when the
 *      caller left it out, and both are dropped when they do not resolve;
 *   4. `findingId` is opaque and is kept as given; `origin` is kept only when it is a view id.
 *
 * The result is a new object; the input is never mutated.
 */
export function validateSelection(selection: Selection | undefined, graph: SchemaGraph): Selection {
  const result: Selection = {};
  if (!selection) return result;
  const known = new Set(graph.tables.map(table => table.id));

  if (selection.tableIds?.length) {
    const ids = selection.tableIds.filter(id => known.has(id));
    if (ids.length !== selection.tableIds.length) warn('ts', 'unknown table id');
    if (ids.length) result.tableIds = ids;
  }
  if (selection.tableId) {
    if (!known.has(selection.tableId)) warn('t', 'unknown table id');
    else if (result.tableIds) warn('t', 'tableIds already sets the selection');
    else result.tableId = selection.tableId;
  }
  if (selection.columnId) {
    const parsed = parseColumnId(selection.columnId);
    const table = parsed ? graph.tables.find(candidate => candidate.id === parsed.tableId) : undefined;
    if (!parsed || !table) warn('c', 'unknown column id');
    else if (!table.allColumns.some(column => column.name === parsed.column)) warn('c', 'column not in table');
    else {
      result.columnId = selection.columnId;
      if (!result.tableId && !result.tableIds) result.tableId = parsed.tableId;
    }
  }
  if (selection.relationshipRef) {
    if (!resolveRelationshipRef(selection.relationshipRef, graph).length) warn('r', 'unresolved relationship ref');
    else result.relationshipRef = selection.relationshipRef;
  }
  if (selection.findingId) result.findingId = selection.findingId;
  if (selection.origin !== undefined) {
    if (isViewId(selection.origin)) result.origin = selection.origin;
    else warn('origin', 'not a view id');
  }
  return result;
}
