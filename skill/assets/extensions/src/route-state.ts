/**
 * Route-state parser and canonical serializer (work package C03, feature F14, ADR-0004 decision 3).
 *
 * One grammar for both shells. The SPA carries it in the query string of
 * `/w/:ws/p/:project/s/:snapshot/:view`; the offline artifact carries the same keys in
 * `location.hash` (`fromHash`/`toHash`, wired by L-05). Because both sides parse with this module,
 * a deep link cannot mean two different things.
 *
 * Keys (`drill-through-contract.md` section 4): `t c r ts f q d k` are global and survive a view
 * change; `v.<name>` is view-local and is dropped when the next view does not allowlist the name.
 *
 * Everything here treats the input as hostile (CTQ-07 deep-link fuzz):
 *
 *   - a value longer than `MAX_VALUE_LENGTH` is dropped with a warning (per element for `ts`);
 *   - an undeclared `v.*` name, or a key outside the grammar, is dropped with a warning;
 *   - a repeated key keeps the first occurrence, so appending a second `t=` cannot override the
 *     link the user actually opened;
 *   - ids are validated against the loaded graph by `validateSelection` once a graph is supplied,
 *     and the view renders with no selection rather than an error.
 *
 * Warnings name the key, never the value.
 *
 * Serialization is canonical: a fixed key order, `v.*` sorted by name, `encodeURIComponent` on
 * every value, and no empty values. Two equal states therefore produce byte-identical strings, so
 * history entries deduplicate. The list key `ts` joins its members with a literal comma, which
 * `encodeURIComponent` cannot produce for a member, so the split back is unambiguous.
 *
 * `Selection.origin` is not part of the grammar: it says which view produced a selection in the
 * running session, which a shared link cannot carry. `serializeRouteState` ignores it.
 */

import { type Selection, type ViewId, isViewId, validateSelection } from './selection';
import type { SchemaGraph } from './types';

/** Longest accepted value for any single route value, and for one `ts` member. */
export const MAX_VALUE_LENGTH = 200;

/** The global keys, in canonical serialization order. */
export const ROUTE_KEYS: readonly string[] = Object.freeze(['t', 'c', 'r', 'ts', 'f', 'q', 'd', 'k'] as const);

/** The prefix that marks a view-local key. */
export const VIEW_STATE_PREFIX = 'v.';

/**
 * The `v.*` names each view accepts, frozen to the table in `drill-through-contract.md` section 4.
 * A new name is a contract change: the table, this map and the view's feature document section 5
 * move together (ADR-0004 decision 3).
 */
export const VIEW_STATE_ALLOWLIST: Readonly<Record<ViewId, readonly string[]>> = Object.freeze({
  map: Object.freeze(['zoom', 'focus', 'link'] as const),
  entities: Object.freeze(['sort', 'compare'] as const),
  keys: Object.freeze(['kind'] as const),
  review: Object.freeze(['rule', 'category', 'status'] as const),
  fanout: Object.freeze(['root', 'depth', 'pk'] as const),
  columns: Object.freeze(['family', 'only', 'page'] as const),
  city: Object.freeze(['mode', 'districts'] as const),
  living: Object.freeze(['junctions', 'focus'] as const),
  lens: Object.freeze(['flagged', 'page', 'size'] as const),
  domains: Object.freeze(['community', 'page'] as const),
  matrix: Object.freeze(['order', 'related'] as const),
  arcs: Object.freeze(['cycle'] as const),
  diff: Object.freeze(['dialect', 'side'] as const),
  insights: Object.freeze(['kind'] as const),
});

export interface RouteState {
  /** `t c r ts f`, ready to hand to `ViewProps.selected`. */
  selection: Selection;
  /** `q`: search text. */
  query?: string;
  /** `d`: domain filter. */
  domain?: string;
  /** `k`: entity-type filter. */
  entityType?: string;
  /** `v.*` for the view this state was parsed for, names already allowlisted. */
  viewState: Record<string, string>;
}

/** True when the view declares this `v.*` name. */
export function allowsViewStateKey(view: ViewId, name: string): boolean {
  return VIEW_STATE_ALLOWLIST[view].includes(name);
}

function warn(key: string, reason: string): void {
  // The key name is enough to debug a bad deep link; the value can carry schema identifiers.
  console.warn('route-state: dropped ' + key + ' (' + reason + ')');
}

/**
 * The subset of a `v.*` record the view declares. Used when switching view (rule 1: the new view
 * drops names it does not allowlist) and when a navigation entry produces view state.
 */
export function filterViewState(view: ViewId, viewState: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(viewState || {})) {
    if (!allowsViewStateKey(view, name)) { warn(VIEW_STATE_PREFIX + name, 'not allowlisted for this view'); continue; }
    if (!value) continue;
    if (value.length > MAX_VALUE_LENGTH) { warn(VIEW_STATE_PREFIX + name, 'value over the length cap'); continue; }
    result[name] = value;
  }
  return result;
}

/** Applies a patch from `onViewStateChange`: an `undefined` or empty value removes the name. */
export function patchViewState(
  view: ViewId,
  viewState: Record<string, string> | undefined,
  patch: Record<string, string | undefined>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(viewState || {}) };
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete merged[name];
    else merged[name] = value;
  }
  return filterViewState(view, merged);
}

function decodeValue(raw: string): string | null {
  try {
    // `+` is left alone rather than read as a space: the serializer percent-encodes it, so a raw
    // `+` in a hand-written link is a literal character of an identifier.
    return decodeURIComponent(raw);
  } catch {
    // A lone percent sign is not decodable; the whole value is untrustworthy, so it goes.
    return null;
  }
}

/**
 * Parses a query string (with or without a leading `?`) into the state for `view`. Ids are
 * validated against `graph` when one is given; without a graph the ids are returned as parsed, so
 * a shell can parse before its snapshot has loaded and re-validate afterwards.
 */
export function parseRouteState(search: string, view: ViewId, graph?: SchemaGraph): RouteState {
  if (!isViewId(view)) throw new Error('parseRouteState: unknown view id');
  const state: RouteState = { selection: {}, viewState: {} };
  const seen = new Set<string>();
  const raw: Record<string, string> = {};
  const viewState: Record<string, string> = {};
  // `ts` is the one list-valued key: its members are joined with a literal comma, so it is split
  // before decoding. Decoding first would turn a member's own `%2C` into a separator.
  let rawMembers = '';

  for (const segment of String(search || '').replace(/^[?#]/, '').split('&')) {
    if (!segment) continue;
    const separator = segment.indexOf('=');
    const rawKey = separator === -1 ? segment : segment.slice(0, separator);
    const rawValue = separator === -1 ? '' : segment.slice(separator + 1);
    const key = decodeValue(rawKey);
    if (key === null) continue;
    if (seen.has(key)) { warn(key, 'repeated key'); continue; }
    seen.add(key);
    const isViewStateKey = key.startsWith(VIEW_STATE_PREFIX);
    if (!isViewStateKey && !ROUTE_KEYS.includes(key)) { warn(key, 'not part of the route grammar'); continue; }
    if (key === 'ts') { rawMembers = rawValue; continue; }
    const value = decodeValue(rawValue);
    if (value === null) { warn(key, 'value is not decodable'); continue; }
    if (!value) continue;
    if (value.length > MAX_VALUE_LENGTH) { warn(key, 'value over the length cap'); continue; }
    if (isViewStateKey) viewState[key.slice(VIEW_STATE_PREFIX.length)] = value;
    else raw[key] = value;
  }

  const selection: Selection = {};
  if (raw.t) selection.tableId = raw.t;
  if (raw.c) selection.columnId = raw.c;
  if (raw.r) selection.relationshipRef = raw.r;
  if (raw.f) selection.findingId = raw.f;
  if (rawMembers) {
    const members: string[] = [];
    for (const member of rawMembers.split(',')) {
      const id = decodeValue(member);
      if (id === null || !id) continue;
      if (id.length > MAX_VALUE_LENGTH) { warn('ts', 'member over the length cap'); continue; }
      if (!members.includes(id)) members.push(id);
    }
    if (members.length) selection.tableIds = members;
  }
  state.selection = graph ? validateSelection(selection, graph) : selection;
  if (raw.q) state.query = raw.q;
  if (raw.d) state.domain = raw.d;
  if (raw.k) state.entityType = raw.k;
  state.viewState = filterViewState(view, viewState);
  return state;
}

/**
 * The canonical query string for a state, without a leading `?`. Key order is
 * `t c r ts f q d k` followed by `v.*` sorted by name, so two equal states serialize to the same
 * bytes. Over-length values are dropped with a warning rather than truncated: half an id is not a
 * better link than no id.
 */
export function serializeRouteState(state: RouteState): string {
  const parts: string[] = [];
  const push = (key: string, value: string | undefined): void => {
    if (!value) return;
    if (value.length > MAX_VALUE_LENGTH) { warn(key, 'value over the length cap'); return; }
    parts.push(key + '=' + encodeURIComponent(value));
  };
  const selection = state.selection || {};
  push('t', selection.tableId);
  push('c', selection.columnId);
  push('r', selection.relationshipRef);
  const members = (selection.tableIds || []).filter(id => {
    if (!id) return false;
    if (id.length > MAX_VALUE_LENGTH) { warn('ts', 'member over the length cap'); return false; }
    return true;
  });
  if (members.length) parts.push('ts=' + members.map(encodeURIComponent).join(','));
  push('f', selection.findingId);
  push('q', state.query);
  push('d', state.domain);
  push('k', state.entityType);
  for (const name of Object.keys(state.viewState || {}).sort()) {
    push(VIEW_STATE_PREFIX + name, state.viewState[name]);
  }
  return parts.join('&');
}

/** Parses the artifact's `location.hash` form, `#t=...&c=...`. */
export function fromHash(hash: string, view: ViewId, graph?: SchemaGraph): RouteState {
  return parseRouteState(String(hash || '').replace(/^#/, ''), view, graph);
}

/** The artifact's `location.hash` form for a state, or an empty string when the state is empty. */
export function toHash(state: RouteState): string {
  const serialized = serializeRouteState(state);
  return serialized ? '#' + serialized : '';
}
