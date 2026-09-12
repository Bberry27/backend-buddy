Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# Drill-through contract

Drill-through is the flagship interaction: any selected table, column, relationship, or finding can be carried into any other view, deep-linked, and returned from, without losing view state. This document defines the selection model, the additive `ViewProps` fields, the route grammar, view-state persistence, the MVP navigation registry (P1-P10), the highlight rules, and the rule that a drill-through may prefill a live query but never runs it. It is the frozen contract for work packages C03 (contract and shell-neutral modules), W02 (inspector), W04 (view wiring), and the F14 feature document. ADR-0004 records the decision.

## 1. Baseline (what exists today)

- The only up-channel is `onSelectTable(id)` with an optional `onSelectTables(ids)` (`packages/explorer/src/types.ts:10`). There is no inbound selection: the host owns `state.selected` (`skill/assets/explorer.html:37`) but never passes it down, so each view keeps a private selection (for example `City.tsx:273`).
- There is no `onSelectColumn`, `onSelectRelationship`, or `onNavigate`; the only view-to-view jumps are the inspector buttons `#focusEntity` and `#entityKeys` (`explorer.html:78`), both to host views.
- Nothing touches the URL. The React tree is torn down on every filter keystroke: `render()` at `explorer.html:178` calls `unmount()` unconditionally, `mount()` at `index.tsx:22` always creates a new root, and the filter inputs at `:68` call `render()` on `input`. City camera, Fan-out root, Schema Diff loaded snapshots, and Column Table paging are lost per keystroke.
- Persistence today: `backend-buddy:<project.key>:theme|reviews` (`explorer.html:39-40`) and `backend-buddy-erd:v1:<project.key>:<fingerprint>` (`living-logic.ts:72`), whose fingerprint comes from `snapshotKey()` (`living-logic.ts:68-73`).

## 2. Selection model

Defined in `packages/explorer/src/selection.ts` (C03). Id forms are those of `schema-graph-contract.md` B3.

```ts
export type ViewId =
  | 'map' | 'entities' | 'keys' | 'review'                       // ported host views (W03)
  | 'fanout' | 'columns' | 'city' | 'living' | 'lens'
  | 'domains' | 'matrix' | 'arcs' | 'diff'                       // index.tsx:22 ids
  | 'insights';                                                  // W06

export interface Selection {
  tableId?: string;            // table.id
  tableIds?: string[];         // multi-selection (Join Matrix cell, Arc cycle group, Domains community)
  columnId?: string;           // table.id#column
  relationshipRef?: string;    // constraintId, else source.column>target.targetColumn
  findingId?: string;          // opaque finding id
  origin?: ViewId;             // the view that produced the selection
}

export interface NavigationTarget {
  view: ViewId;
  selection?: Selection;
  viewState?: Record<string, string>;   // v.* keys for the target view (allowlisted)
  reason?: string;                       // registry entry id, for telemetry and tests
}
```

Rules:

1. A `Selection` is a value, never a mutable store; the shell owns the current selection and passes it down.
2. Exactly one of `tableId`/`tableIds` is set; `columnId` and `relationshipRef` imply their table(s).
3. Unknown ids (not in the loaded graph) are dropped with a console warning and never rendered as selected.
4. `origin` is informational: it lets a view avoid dimming itself when it produced the selection (section 7).

## 3. Additive `ViewProps` fields

`onSelectTable` is unchanged so the nine existing views compile untouched. New fields are optional.

```ts
export interface ViewProps {
  graph: SchemaGraph;                                   // existing: the filtered graph
  onSelectTable: (id: string) => void;                  // existing
  onSelectTables?: (ids: string[]) => void;             // existing
  live?: LiveConnection;                                // existing (types.ts:9)
  selected?: Selection;                                 // inbound selection
  onSelectColumn?: (columnId: string) => void;
  onSelectRelationship?: (relationshipRef: string) => void;
  onNavigate?: (target: NavigationTarget) => void;
  viewState?: Record<string, string>;                   // the view's v.* slice, parsed from the URL
  onViewStateChange?: (patch: Record<string, string | undefined>) => void;
  fullGraph?: SchemaGraph;                              // unfiltered graph, for "show related" and dimming
  theme?: 'light' | 'dark';                             // replaces per-view DOM detection (JoinMatrix.tsx:103-111)
}
```

Notes:

- `graph` keeps today's semantics: filtered tables with the full `links` array (`explorer.html:195` passes `{...data, tables}`), so views must tolerate links whose endpoints are absent. `fullGraph` is provided for views that need the unfiltered neighbourhood.
- The existing fallback pattern `onSelectTables ? onSelectTables(ids) : onSelectTable(ids[0])` (`JoinMatrix.tsx:116`) is the model for every new callback: absence of a callback means the view does not offer that action.
- The artifact host supplies `selected`, `viewState`, and `onNavigate` from `location.hash` (section 5); the SPA supplies them from the router.

## 4. Route grammar

Route (React Router 7, library mode): `/w/:ws/p/:project/s/:snapshot/:view`

Query parameters, parsed and serialized by `packages/explorer/src/route-state.ts` (pure, node:test):

| Key | Meaning | Value form | Cardinality |
|---|---|---|---|
| `t` | selected table | `table.id` | 0..1 |
| `c` | selected column | `table.id#column` | 0..1; implies `t` |
| `r` | selected relationship | `constraintId`, else `source.column>target.targetColumn` | 0..1 |
| `ts` | multi-selection | comma-separated `table.id` list | 0..1 |
| `f` | selected finding | opaque finding id | 0..1 |
| `q` | search text | string | 0..1 |
| `d` | domain filter | domain string | 0..1 |
| `k` | entity type filter | type string | 0..1 |
| `v.*` | view-local state | `v.<name>=<value>`; names allowlisted per view; values capped at 200 characters | 0..n |

Rules:

1. `t c r ts f q d k` are global: they survive a view change. `v.*` belongs to the current view; switching view drops keys the new view does not allowlist.
2. Serialization is canonical (fixed key order, `encodeURIComponent`, no empty values) so two equal states produce byte-identical URLs and history entries deduplicate.
3. Every `v.*` name is declared in the view's registry entry (`navigation.ts`); an undeclared name or a value over 200 characters is dropped with a warning (CTQ-07 deep-link fuzz).
4. Ids are validated against the loaded graph after parsing; unknown ids are dropped, and the page renders the view with no selection rather than an error.
5. The artifact shares the grammar via `location.hash` (`#t=...&c=...`), parsed by the same `route-state.ts`; the SPA uses the query string. `location.hash` deep links inside the artifact are L-05; the parser is shared from C03 so the two never diverge.

Examples:

- `/w/acme/p/inventory-dev/s/3f2a.../columns?t=public.items&c=public.items%23name`
- `/w/acme/p/inventory-dev/s/3f2a.../fanout?ts=public.orders,public.customers&v.root=public.orders`
- `/w/acme/p/inventory-dev/s/3f2a.../city?d=Inventory&v.districts=discovered&v.mode=flat`

Allowlisted `v.*` names at MVP (frozen in C03; additions need a registry change and a feature-doc section 5 update):

| View | `v.*` names |
|---|---|
| `fanout` | `root`, `depth`, `pk` (prefill only, see section 8) |
| `columns` | `family`, `only` (e.g. `pk`, `fk`, `nullable`), `page` |
| `city` | `mode` (`3d`/`flat`), `districts` (`business`/`discovered`) |
| `living` | `junctions` (`show`/`collapse`), `focus` |
| `lens` | `flagged`, `page`, `size` |
| `domains` | `community`, `page` |
| `matrix` | `order`, `related` |
| `arcs` | `cycle` |
| `diff` | `dialect` (`postgresql`/`mysql`), `side` (`a`/`b`) |
| `map` | `zoom`, `focus`, `link` |
| `keys` | `kind` |
| `review` | `rule`, `category`, `status` |
| `entities` | `sort`, `compare` |
| `insights` | `kind` |

## 5. View-state persistence

Two layers, both keyed by graph fingerprint so state never bleeds between snapshots or projects (C13):

1. **URL layer** (`v.*`): shareable, allowlisted, capped. Camera pose and pan offsets are not URL state (too volatile).
2. **Persisted layer** (`packages/explorer/src/view-state.ts`): a per-view slice stored under `backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>` in localStorage (artifact and SPA) and, for Living ERD positions, also server-side in `erd_layouts` (`data-model.md` 3.13). Contents at MVP: City camera pose and 3D/flat mode, map pan offsets and zoom, Schema Diff loaded A/B snapshots (by fingerprint reference, not by content), Fan-out collapsed set.

The fingerprint function is extracted from `snapshotKey()` (`living-logic.ts:68-73`) into `view-state.ts` with unchanged output: `source.hash ?? source.sourceHash ?? source.sha256 ?? graph.sourceHash`, else the FNV-1a hash (`living-logic.ts:67`) of sorted `source`, `tables`, `links`. The existing key `backend-buddy-erd:v1:<project.key>:<fingerprint>` keeps working (regression test in C03) so saved layouts are not orphaned.

Reads are try/catch-wrapped as today (`explorer.html:35-36`, `living-logic.ts:87-92`); storage failure degrades to in-memory state and a one-time notice. Persisted values are validated with bounds before use (pattern: `parsePositions`, `living-logic.ts:75-86`).

## 6. Navigation registry (MVP entries P1-P10)

`packages/explorer/src/navigation.ts` exports `entries`, `targetsFor(selection, currentView)`, and `resolve(entryId, selection, graph): NavigationTarget`. The inspector's "Open in ..." menu (W02), the context menus (W04), and the generated e2e matrix (`tests/e2e/drill-through.spec.ts`) are all produced from this table, so a registry entry that lacks an implementation fails CI.

| Id | From (view, gesture) | To (view) | Inbound selection at target | URL written | Notes |
|---|---|---|---|---|---|
| P1 | Inspector, "Open in" menu | any view | Fan-out root = `t`; Living ERD focus `t`; City fly-to `t`; Column Table `t`,`c`; Join Matrix row `t`; Arc `t`; Map neighbourhood `t`; Keys `t`; Review findings of `t` | `t` (+`c`), `v.root`/`v.focus` as needed | Six-entry breadcrumb and browser history (W02) |
| P2 | Join Matrix cell click | Fan-out | root = row table, target highlighted | `ts=row,col`, `v.root=row` | Cell -> relationship selection (`r`) when a single constraint links the pair |
| P3 | City building (context menu; single click still inspects) | Living ERD focus / Fan-out root / Column Table | `t` | `t`, `v.focus` or `v.root` | Keyboard: Shift+F10 on the focused building |
| P4 | Normalization Lens finding | Column Table filtered to the finding's columns; Review for the same table | `t`, `c` (first column), `f` | `t`, `c`, `f`, `v.only` | Finding id carried as `f` |
| P5 | Arc Diagram cycle group | Living ERD with members selected and fit | `ts` = members | `ts` | Arc click -> relationship selection (`r`) |
| P6 | Domains community | City with `v.districts=discovered` filtered to the community / Living ERD with members | `ts` = members, `d` | `ts`, `d`, `v.districts=discovered`, `v.community` | See caveat C03 (quoted below) |
| P7 | Schema Diff changed table | Column Table and Inspector; removed table -> Inspector on the before-snapshot with a read-only banner | `t` | `t`, `v.side=a` for removed | Before-snapshot route uses the A snapshot id |
| P8 | Review finding | Column Table (finding columns); Living ERD (relationship for FK findings); Fan-out (orphan candidates) | `t`, `c`, `r`, `f` | `t`, `c`/`r`, `f`, `v.root` | See caveat C04 (quoted in section 8) |
| P9 | Fan-out node / link | re-root; relationship selection; Column Table | `t` / `r` | `v.root`, `r`, `t` | Re-root keeps depth |
| P10 | Column Table FK column / PK column with opt-in sample | Living ERD with relationship selected / Fan-out row mode prefilled | `r` / `t`, `v.pk` | `r`; `t`, `v.pk` | Prefill only; user clicks Run (section 8) |

Later (not in G2): Map node -> City fly-to; Keys row -> Living ERD; Living ERD edge -> Join Matrix cell; hover sync; keyboard chords.

P6 carries a community label into City and Living ERD; the label's status is fixed by caveat C03. Quoted from `docs/reference/caveats.md`:

> Discovered communities are analytical suggestions computed from the declared-FK graph. They are structural candidates, not the project's business ownership model and not confirmed business domains.

Registry entry shape (frozen in C03):

```ts
interface NavigationEntry {
  id: 'P1' | 'P2' | /* ... */ 'P10';
  from: ViewId | 'inspector';
  to: ViewId[];
  accepts: (selection: Selection) => boolean;       // does this entry apply to the current selection
  target: (selection: Selection, to: ViewId, graph: SchemaGraph) => NavigationTarget;
  label: string;                                    // menu text, from caveat-strings.ts when a caveat applies
  viewStateKeys: string[];                          // v.* names this entry may write
}
```

## 7. Bidirectional highlight rules

Every view (13 views plus Insights) implements inbound and outbound selection (CTQ-10). The generated matrix asserts each rule.

Inbound (`selected` prop):

1. The selected element carries `data-selected="true"` and the class `is-selected`; there is exactly one primary selected element per view (multi-selection marks each with `data-selected="true"` and the first with `is-primary`).
2. Views dim non-related elements only when `selected.origin` differs from the view's own id; a view never dims in response to its own click.
3. On a selection change the view scrolls, pans, or flies to the element once (Living ERD `setCenter`, `LivingERD.tsx:130`; City eased camera move; Column Table scroll-into-view). It does not re-centre on unrelated re-renders or filter changes.
4. A selected id absent from the current filtered `graph` but present in `fullGraph` shows a "selected item is filtered out" notice with a one-click "clear filters"; it is not silently dropped.
5. Selection is never cleared by a filter change. Today City clears it on any layout change (`City.tsx:309`); W05 clears only when the selected table leaves the graph.
6. Reduced motion (`prefers-reduced-motion`) makes fly-to and scroll instantaneous.

Outbound (callbacks):

1. Click on a table element -> `onSelectTable`; on a column -> `onSelectColumn` (falls back to `onSelectTable` of its table when absent); on a relationship (edge, road, arc, matrix cell with a single constraint) -> `onSelectRelationship` (falls back to `onSelectTables` of both endpoints).
2. Context menu (right-click, Shift+F10) offers `targetsFor(selection, view)`; choosing one calls `onNavigate`.
3. Views never call `history` or touch `location`; only the shell (SPA router or artifact hash bridge) serialises URLs.
4. The shell updates the inspector and the URL in one transaction so back/forward restores selection, view, and filters together.
5. No remount: `window.__backend-buddyMounts` (non-production test hook) stays constant across 20 filter keystrokes (CTQ-10).

Selector contract frozen for tests: `[data-selected="true"]`, `.is-selected`, `.is-primary`, `.schema-city-*`, `[data-rowcount]`, `#tab-<view>`, `[data-view]`.

## 8. Prefill, never execute

A drill-through may prefill a live query but never runs it without an explicit click.

- P10 prefills Fan-out row mode with `v.pk`; the Run button remains the only path to `live.subtree` (`Fanout.tsx:94`). Likewise, arriving at Column Table or Normalization Lens never triggers `live.profile` (`ColumnTable.tsx:149`, `NormalizationLens.tsx:110-121` behind a button at `:127`).
- `tests/e2e/drill-through.spec.ts` asserts no request to `/api/subtree` or `/api/profile` occurs before a click on Run, for every registry entry.
- Validation SQL and migration SQL are drafts and are never executed by the product (C04). Quoted from `docs/reference/caveats.md`:

> Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf.

- Live actions require an explicitly selected read-only connection (C14). Quoted from `docs/reference/caveats.md`:

> The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows.

## 9. Storage isolation

Quoted from `docs/reference/caveats.md` (C13):

> Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state.

Key families after C03: `backend-buddy:<project.key>:theme|reviews` (unchanged), `backend-buddy-erd:v1:<project.key>:<fingerprint>` (unchanged), `backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>` (new). `project.key` is regex-constrained (`build_explorer.py:24`), so a colon cannot be smuggled into a key.

## 10. Testing

Implementation status (C03, gate G1): sections 2 to 6, 8 and 9 are implemented as pure modules in
`packages/explorer/src`, with the mount policy of ADR-0002 decision 3. Section 7 (the highlight
rules) and the generated end-to-end matrix are W04; no view is wired yet.

| Concern | Implementation | Tests |
|---|---|---|
| Section 2 selection model, id forms | `packages/explorer/src/selection.ts` | `selection.test.ts` (8 cases) |
| Section 3 additive `ViewProps` | `packages/explorer/src/types.ts` | `npm run typecheck` with the nine views untouched; `navigation.test.ts` |
| Section 4 route grammar, `v.*` allowlist, 200-character cap | `packages/explorer/src/route-state.ts` | `route-state.test.ts` (11 cases) |
| Section 5 fingerprint and persisted slices | `packages/explorer/src/view-state.ts` (`graphFingerprint`, `viewStateKey`), called by `living-logic.ts` `snapshotKey()` | `view-state.test.ts` (5 cases); `living-logic.test.ts` pins `snapshotKey()` output |
| Section 6 registry P1-P10 | `packages/explorer/src/navigation.ts` | `navigation.test.ts` (6 cases) |
| Section 8 prefill, never execute | `prefillOnly` on P2 and P10; no module performs I/O | `navigation.test.ts`; the C03 acceptance grep for `live.` |
| Section 9 storage isolation (C13) | `packages/explorer/src/view-state.ts` key family | `view-state.test.ts` |
| No remount (ADR-0004 decision 8) | `packages/explorer/src/mount-policy.ts`, `index.tsx` root reuse and `mountCount()` | `mount-policy.test.ts` (3 cases) |
| Caveat wording | `packages/explorer/src/caveat-strings.ts` | `caveats.test.ts` (3 cases, 16 equalities) |

Still to come:

- `tests/e2e/drill-through.spec.ts` (W04): generated from the registry; asserts inbound markers, no remount, URL round trip via reload, and no live request before Run.
- Keyboard-only journeys (two at G2, CTQ-11) traverse P1 and P3 without a pointer.
- The artifact host still rebuilds its `#extensionHost` container on every `render()`
  (`skill/assets/explorer.html`), so `mount()` sees a new container and recreates the root. Root
  reuse therefore takes effect in the artifact only once that container is kept, which belongs to
  the host work (L-05 / S03); the policy and the counter are in place and covered here.

## 11. Open questions

1. Whether `ts` should be capped in count (e.g. 50 ids) to keep URLs shareable; the plan caps only `v.*` values.
2. Whether the artifact should write `location.hash` on every selection at MVP (helps QA) or only read it (L-05 scope).
3. Whether `theme` on `ViewProps` should be required once C02 lands, which would touch all nine views.
