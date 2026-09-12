/**
 * Per-view persisted state and the graph fingerprint (work package C03, feature F14,
 * ADR-0004 decision 4).
 *
 * Two layers carry view state. The URL layer is the `v.*` slice in `route-state.ts`: shareable,
 * allowlisted, capped. This file is the other one - the volatile slice that does not belong in a
 * link because it changes on every frame or holds a loaded document: a camera pose, a pan offset,
 * the pair of snapshots Schema Diff has open, a collapsed set.
 *
 * Key isolation is caveat C13, quoted in `docs/reference/caveats.md` and mirrored for the UI in
 * `caveat-strings.ts`. Every key here is scoped by the project's stable key and by the snapshot
 * fingerprint, so two projects, or two snapshots of one project, never read each other's state:
 *
 *   backend-buddy:view-state:v1:<project scope>:<fingerprint>:<view>
 *
 * `graphFingerprint` is the fingerprint half of `snapshotKey()` (`living-logic.ts`), moved here so
 * the Living ERD layout key and the view-state key cannot drift apart. Its output is unchanged for
 * every input, which is what keeps saved Living ERD layouts from being orphaned; the regression
 * case in `living-logic.test.ts` pins the composed string.
 *
 * Reads never throw: storage can be absent, disabled, or full, and a stored value can be anything
 * a previous version or another tab wrote. Every read goes through a caller-supplied validator in
 * the style of `parsePositions` (`living-logic.ts`), and a failure degrades to no state rather
 * than to a fabricated one.
 */

import type { ViewId } from './selection';
import type { SchemaGraph } from './types';

/** Prefix of the key family this module owns. */
export const VIEW_STATE_KEY_PREFIX = 'backend-buddy:view-state:v1:';

/** FNV-1a over the UTF-16 code units, as the Living ERD has hashed since its first version. */
function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/**
 * The project half of a storage key: the stable project key, else the display name, else `local`.
 * `project.key` is regex-constrained by the renderer, so a colon cannot be smuggled into a key;
 * the name is not, which is why both are percent-encoded here.
 */
export function projectScope(graph: SchemaGraph): string {
  return encodeURIComponent(graph.project?.key || graph.project?.name || 'local');
}

/**
 * Identity of the schema this graph describes. A recorded source hash is authoritative; without
 * one the fingerprint is an FNV-1a hash of the source, the tables sorted by id, and the links
 * sorted by their serialization, so reordering the same graph yields the same fingerprint.
 */
export function graphFingerprint(graph: SchemaGraph): string {
  const source = graph.source || {};
  const identity = source.hash ?? source.sourceHash ?? source.sha256 ?? graph.sourceHash;
  if (identity != null) return encodeURIComponent(String(identity));
  return hash(JSON.stringify({
    source,
    tables: [...graph.tables].sort((a, b) => a.id.localeCompare(b.id)),
    links: [...graph.links].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }));
}

/** The storage key for one view's slice of one snapshot of one project (C13). */
export function viewStateKey(graph: SchemaGraph, view: ViewId): string {
  return VIEW_STATE_KEY_PREFIX + projectScope(graph) + ':' + graphFingerprint(graph) + ':' + view;
}

/** A stored slice: `version` guards the shape, `value` is whatever the view saved. */
interface StoredSlice {
  version: 1;
  value: unknown;
}

/**
 * The stored slice for a view, or null. `validate` decides what a usable value looks like and
 * returns null to reject one; anything it rejects is treated as absent, never as a default.
 */
export function readViewState<T>(graph: SchemaGraph, view: ViewId, validate: (value: unknown) => T | null): T | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(viewStateKey(graph, view));
  } catch {
    // Storage unavailable (disabled, or a sandboxed origin): the view keeps in-memory state.
    return null;
  }
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSlice | null;
    if (!parsed || parsed.version !== 1) return null;
    return validate(parsed.value);
  } catch {
    // A slice written by an older version, or a truncated write, is ignored.
    return null;
  }
}

/** Stores a view's slice. Returns false when storage refused the write, so the view can say so. */
export function writeViewState(graph: SchemaGraph, view: ViewId, value: unknown): boolean {
  try {
    localStorage.setItem(viewStateKey(graph, view), JSON.stringify({ version: 1, value } satisfies StoredSlice));
    return true;
  } catch {
    return false;
  }
}

/** Removes a view's slice. Returns false when storage refused. */
export function clearViewState(graph: SchemaGraph, view: ViewId): boolean {
  try {
    localStorage.removeItem(viewStateKey(graph, view));
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------------------------
// MVP slices. The shapes `drill-through-contract.md` section 5 lists, with a validator each.
// W04 and W05 wire the views to them; nothing in this package reads or writes storage on import.
// --------------------------------------------------------------------------------------------

export type CityMode = '3d' | 'flat';
export type CityDistricts = 'business' | 'discovered';
export interface CityCamera { position: [number, number, number]; target: [number, number, number] }
export interface CityViewState { mode: CityMode; districts: CityDistricts; camera?: CityCamera }
export interface MapViewState { pan: { x: number; y: number }; zoom: number }
/** Schema Diff holds the two sides by fingerprint reference, never by content. */
export interface DiffViewState { a?: string; b?: string }
export interface FanoutViewState { collapsed: string[] }

/** Finite, and inside the coordinate bound `parsePositions` uses for saved layouts. */
const COORDINATE_LIMIT = 1e7;
function finite(value: unknown, limit = COORDINATE_LIMIT): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < limit;
}
function triple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(part => finite(part))) return null;
  return [value[0], value[1], value[2]];
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseCityViewState(value: unknown): CityViewState | null {
  const slice = record(value);
  if (!slice) return null;
  const mode = slice.mode === '3d' || slice.mode === 'flat' ? slice.mode : null;
  const districts = slice.districts === 'business' || slice.districts === 'discovered' ? slice.districts : null;
  if (!mode || !districts) return null;
  const result: CityViewState = { mode, districts };
  const camera = record(slice.camera);
  if (camera) {
    const position = triple(camera.position);
    const target = triple(camera.target);
    if (position && target) result.camera = { position, target };
  }
  return result;
}

export function parseMapViewState(value: unknown): MapViewState | null {
  const slice = record(value);
  const pan = slice ? record(slice.pan) : null;
  if (!slice || !pan) return null;
  const x = pan.x, y = pan.y, zoom = slice.zoom;
  if (!finite(x) || !finite(y) || !finite(zoom, 1e4) || zoom <= 0) return null;
  return { pan: { x, y }, zoom };
}

/** Fingerprint references only: a stored side is a pointer to a snapshot, not the snapshot. */
export function parseDiffViewState(value: unknown): DiffViewState | null {
  const slice = record(value);
  if (!slice) return null;
  const result: DiffViewState = {};
  for (const side of ['a', 'b'] as const) {
    const reference = slice[side];
    if (typeof reference === 'string' && reference && reference.length <= 256) result[side] = reference;
  }
  return result.a || result.b ? result : null;
}

export function parseFanoutViewState(value: unknown): FanoutViewState | null {
  const slice = record(value);
  if (!slice || !Array.isArray(slice.collapsed)) return null;
  const collapsed = slice.collapsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return { collapsed };
}
