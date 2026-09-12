/**
 * Navigation registry P1-P10 (work package C03, feature F14, ADR-0004 decision 5).
 *
 * One table drives every drill-through surface: the inspector's "Open in ..." menu (W02), the
 * per-view context menus (W04), and the generated end-to-end matrix. A new entry is a change to
 * `docs/architecture/drill-through-contract.md` section 6 and to this file together; an entry that
 * has no implementation fails the generated matrix rather than living on as dead menu text.
 *
 * Entry shape. `from` is the surface that offers the entry, `toAll` the views it can open in the
 * order the contract lists them, and `to` the first of those - the target a caller takes when it
 * does not choose. `requires` is the selection shape the entry needs, `carries` what the target
 * additionally consumes when present. `viewState` produces the `v.*` slice for a chosen target and
 * `viewStateKeys` declares every name it may write; both are checked against the target view's
 * allowlist in `route-state.ts` by `navigation.test.ts`, so a producer cannot write a name the
 * route grammar would silently drop.
 *
 * Prefill, never execute (`drill-through-contract.md` section 8, CTQ-06). P2 writes a Fan-out root
 * and P10 a Fan-out primary-key prefill; both are marked `prefillOnly`, and nothing in this module
 * performs I/O or calls a live connection - resolving an entry only computes strings. The Run
 * button stays the only path to a live query.
 *
 * Where an entry carries a claim a caveat governs, the entry names the caveat id and the surface
 * takes the wording from `caveat-strings.ts`; no menu text paraphrases a caveat.
 */

import { CAVEATS, type CaveatId } from './caveat-strings';
import {
  type NavigationTarget,
  type Selection,
  type SelectionShape,
  type ViewId,
  isEmptySelection,
  selectionShapes,
  validateSelection,
} from './selection';
import { VIEW_STATE_ALLOWLIST, filterViewState } from './route-state';
import type { SchemaGraph } from './types';

export type NavigationEntryId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10';

export interface NavigationEntry {
  id: NavigationEntryId;
  /** The view whose gesture offers this entry, or the inspector menu. */
  from: ViewId | 'inspector';
  /** The default target: `toAll[0]`. */
  to: ViewId;
  /** Every target the entry offers, in contract order. */
  toAll: readonly ViewId[];
  /** Selection shapes that must all be present for the entry to apply. */
  requires: readonly SelectionShape[];
  /** Shapes the target also consumes when the selection carries them. */
  carries: readonly SelectionShape[];
  /** Menu text. Wording that restates a caveat comes from `caveat-strings.ts`, never from here. */
  label: string;
  /** The caveat that governs what this entry carries, when one does. */
  caveat?: CaveatId;
  /**
   * Every `v.*` name `viewState` may write. Each name is allowlisted for at least one member of
   * `toAll`, and the producer emits a name only for a target whose allowlist declares it.
   */
  viewStateKeys: readonly string[];
  /** The `v.*` slice for one chosen target. Only names in `viewStateKeys` are produced. */
  viewState: (selection: Selection, to: ViewId) => Record<string, string>;
  /** True when the entry only prefills a live query; the user still has to click Run. */
  prefillOnly?: true;
}

/** True when the selection carries every shape the entry requires. */
export function accepts(entry: NavigationEntry, selection: Selection): boolean {
  const present = selectionShapes(selection);
  return entry.requires.every(shape => present.includes(shape));
}

/** The primary table of a selection: the single table, else the first of a multi-selection. */
function primaryTable(selection: Selection): string | undefined {
  return selection.tableId || selection.tableIds?.[0];
}

const NONE = (): Record<string, string> => ({});

/** A producer that roots Fan-out at the selection's primary table. */
const fanoutRoot = (selection: Selection, to: ViewId): Record<string, string> => {
  const root = primaryTable(selection);
  return to === 'fanout' && root ? { root } : {};
};

/**
 * The registry. Ids, directions and notes follow `drill-through-contract.md` section 6 row for
 * row; the `viewState` producers write only what the selection actually establishes, so a name a
 * later work package fills from its own model (a Fan-out primary-key value for P10, a Column Table
 * family filter for P4) is declared in `viewStateKeys` and produced by that package's view.
 */
export const entries: readonly NavigationEntry[] = Object.freeze([
  {
    id: 'P1',
    from: 'inspector',
    to: 'fanout',
    toAll: Object.freeze(['fanout', 'living', 'city', 'columns', 'matrix', 'arcs', 'map', 'keys', 'review'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table', 'column', 'relationship', 'finding'] as const),
    label: 'Open in',
    viewStateKeys: Object.freeze(['root', 'focus'] as const),
    viewState: (selection: Selection, to: ViewId): Record<string, string> => {
      const table = primaryTable(selection);
      if (!table) return {};
      if (to === 'fanout') return { root: table };
      if (to === 'living' || to === 'map') return { focus: table };
      return {};
    },
  },
  {
    id: 'P2',
    from: 'matrix',
    to: 'fanout',
    toAll: Object.freeze(['fanout'] as const),
    requires: Object.freeze(['tables'] as const),
    carries: Object.freeze(['tables', 'relationship'] as const),
    label: 'Open the pair in Row fan-out',
    viewStateKeys: Object.freeze(['root'] as const),
    viewState: fanoutRoot,
    prefillOnly: true,
  },
  {
    id: 'P3',
    from: 'city',
    to: 'living',
    toAll: Object.freeze(['living', 'fanout', 'columns'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table'] as const),
    label: 'Open the building elsewhere',
    viewStateKeys: Object.freeze(['focus', 'root'] as const),
    viewState: (selection: Selection, to: ViewId): Record<string, string> => {
      const table = primaryTable(selection);
      if (!table) return {};
      if (to === 'living') return { focus: table };
      if (to === 'fanout') return { root: table };
      return {};
    },
  },
  {
    id: 'P4',
    from: 'lens',
    to: 'columns',
    toAll: Object.freeze(['columns', 'review'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table', 'column', 'finding'] as const),
    label: 'Open the flagged columns',
    caveat: 'C08',
    viewStateKeys: Object.freeze(['only'] as const),
    viewState: NONE,
  },
  {
    id: 'P5',
    from: 'arcs',
    to: 'living',
    toAll: Object.freeze(['living'] as const),
    requires: Object.freeze(['tables'] as const),
    carries: Object.freeze(['tables', 'relationship'] as const),
    label: 'Open the cycle members in the Living ERD',
    caveat: 'C12',
    viewStateKeys: Object.freeze([] as const),
    viewState: NONE,
  },
  {
    id: 'P6',
    from: 'domains',
    to: 'city',
    toAll: Object.freeze(['city', 'living'] as const),
    requires: Object.freeze(['tables'] as const),
    carries: Object.freeze(['tables'] as const),
    label: 'Open the community members',
    caveat: 'C03',
    viewStateKeys: Object.freeze(['districts'] as const),
    viewState: (_selection: Selection, to: ViewId): Record<string, string> => (to === 'city' ? { districts: 'discovered' } : {}),
  },
  {
    id: 'P7',
    from: 'diff',
    to: 'columns',
    toAll: Object.freeze(['columns', 'diff'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table'] as const),
    label: 'Open the changed table',
    caveat: 'C09',
    viewStateKeys: Object.freeze(['side'] as const),
    // A removed table exists only on the before-snapshot, so that route opens side A read-only.
    viewState: (_selection: Selection, to: ViewId): Record<string, string> => (to === 'diff' ? { side: 'a' } : {}),
  },
  {
    id: 'P8',
    from: 'review',
    to: 'columns',
    toAll: Object.freeze(['columns', 'living', 'fanout'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table', 'column', 'relationship', 'finding'] as const),
    label: 'Open the finding evidence',
    caveat: 'C04',
    viewStateKeys: Object.freeze(['root'] as const),
    viewState: fanoutRoot,
  },
  {
    id: 'P9',
    from: 'fanout',
    to: 'fanout',
    toAll: Object.freeze(['fanout', 'columns'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table', 'relationship'] as const),
    // Re-rooting writes `root` only: the existing `v.depth` travels unchanged.
    label: 'Re-root the fan-out here',
    viewStateKeys: Object.freeze(['root'] as const),
    viewState: fanoutRoot,
  },
  {
    id: 'P10',
    from: 'columns',
    to: 'living',
    toAll: Object.freeze(['living', 'fanout'] as const),
    requires: Object.freeze(['table'] as const),
    carries: Object.freeze(['table', 'column', 'relationship'] as const),
    label: 'Follow the key',
    caveat: 'C14',
    // `pk` is a value the user opted into in Column Table; the view fills it (W04) and the Run
    // button still has to be clicked.
    viewStateKeys: Object.freeze(['root', 'pk'] as const),
    viewState: fanoutRoot,
    prefillOnly: true,
  },
] as const);

const BY_ID = new Map<string, NavigationEntry>();
for (const item of entries) BY_ID.set(item.id, item);

/** The entry with this id, or undefined. */
export function entry(entryId: string): NavigationEntry | undefined {
  return BY_ID.get(entryId);
}

/**
 * The entries a surface can offer for the current selection: those whose `from` is this surface
 * and whose `requires` the selection satisfies. The inspector passes `'inspector'`.
 */
export function targetsFor(selection: Selection, currentView: ViewId | 'inspector'): NavigationEntry[] {
  return entries.filter(candidate => candidate.from === currentView && accepts(candidate, selection));
}

/**
 * The navigation target for one entry. Throws on an unknown entry id, or on a target the entry
 * does not offer, because both mean a caller and the registry have gone out of step - a silent
 * fallback would hide it until the menu opened in front of a user. The returned selection has
 * been through `validateSelection`, so a target never carries an id the graph does not resolve,
 * and `origin` records the surface the gesture came from unless the selection already named one.
 */
export function resolve(entryId: string, selection: Selection, graph: SchemaGraph, to?: ViewId): NavigationTarget {
  const found = entry(entryId);
  if (!found) throw new Error('navigation.resolve: unknown entry ' + entryId);
  const view = to ?? found.to;
  if (!found.toAll.includes(view)) throw new Error('navigation.resolve: ' + found.id + ' does not open ' + view);
  const validated = validateSelection(selection, graph);
  const target: NavigationTarget = { view, reason: found.id };
  if (!isEmptySelection(validated)) {
    // `origin` records the surface the gesture came from, so the target view can tell its own
    // click apart from an inbound one. An empty selection gets no origin: there is nothing to own.
    if (!validated.origin && found.from !== 'inspector') validated.origin = found.from;
    target.selection = validated;
  }
  const viewState = filterViewState(view, found.viewState(validated, view));
  if (Object.keys(viewState).length) target.viewState = viewState;
  return target;
}

/**
 * The caveat text a surface must show with an entry, taken from the mirror of
 * `docs/reference/caveats.md`. Undefined when the entry carries no caveat.
 */
export function caveatFor(entryId: string): string | undefined {
  const found = entry(entryId);
  return found?.caveat ? CAVEATS[found.caveat].text : undefined;
}

/** Every `v.*` name the registry may write for a view, for the allowlist cross-check. */
export function declaredViewStateKeys(view: ViewId): string[] {
  const names = new Set<string>();
  for (const candidate of entries) {
    if (!candidate.toAll.includes(view)) continue;
    for (const name of candidate.viewStateKeys) {
      if (VIEW_STATE_ALLOWLIST[view].includes(name)) names.add(name);
    }
  }
  return [...names].sort();
}
