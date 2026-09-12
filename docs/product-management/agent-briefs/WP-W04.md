Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-W04 Drill-through P1-P10

| Field | Value |
|---|---|
| Work package | W04 (track W, phase 2) |
| Features | F14 (primary); F05, F06, F07, F08 (inbound/outbound only), F09, F10, F11, F12, F13 |
| CTQs | CTQ-03, CTQ-06, CTQ-10, CTQ-11 |
| Caveats | C03 (P6 label), C04 (P8 SQL), C13 (view-state slice), C14 (live actions require a click) |
| Depends on | W02, W03 |
| Blocks | W05, W06, Q02, Q04 |
| Branch | `f14/drill-through-p1-p10` |
| Gate | G2 |

### 1. Goal

Make the nine React views bidirectional: each accepts the inbound `selected` prop (marking the element with `data-selected="true"` and `is-selected`, dimming non-related elements only when the selection came from another view, and scrolling/panning/flying to it once per selection change) and emits outbound `onSelectColumn`, `onSelectRelationship`, and `onNavigate` according to the registry entries P1-P10 below. A drill-through may prefill a live query but never runs it without a click. `tests/e2e/drill-through.spec.ts` is generated from `navigation.ts` so that an entry without an implementation fails CI. A verifier can check the generated matrix, the no-remount counter, and that no `/api/subtree` or `/api/profile` request happens before a click on Run for every entry.

### 2. Reading list (ordered)

1. `docs/features/F14-drill-through-navigation.md` (D05, G0): the behaviours and acceptance criteria this package closes; section 14 is updated by this package.
2. `docs/architecture/drill-through-contract.md`: section 3 (`ViewProps` fields), 4 (route grammar and the `v.*` allowlist per view), 6 (registry P1-P10 and the `NavigationEntry` shape), 7 (inbound rules 1-6 and outbound rules 1-5), 8 (prefill, never execute), 10 (tests).
3. The nine feature documents, section 5 of each (F05, F06, F07, F08, F09, F10, F11, F12, F13): view-specific inbound/outbound obligations, especially F06 B1-B3 and B6 (`data-rowcount`), F08 section 5 (City inbound is finished in W05; W04 delivers P3 outbound and the `selected` prop plumbing).
4. `docs/architecture/adr/ADR-0004-selection-and-routing-contract.md`.
5. C03 deliverables: `packages/explorer/src/{selection,route-state,navigation,view-state,mount-policy,caveat-strings}.ts` and tests; W02 deliverables `Inspector.tsx`, `ContextMenu.tsx`; W03 deliverables (`MapView`, `EntityIndex`, `KeyIndex`, `ReviewView` already carry inbound markers).
6. Existing view code, the exact hooks to extend: `packages/explorer/src/JoinMatrix.tsx:116` (`onSelectTables ? onSelectTables(ids) : onSelectTable(...)`, the fallback pattern for every new callback) and `:130-131` (header clicks); `ArcDiagram.tsx:56-57` (arc click, same fallback) and `:126` (cycle member buttons); `LivingERD.tsx:129-130` (search result -> `setCenter`, the focus pattern for inbound selection) and `:195` (`onNodeClick`); `Fanout.tsx:94` (`live.subtree` call, must stay behind the "Load subtree" button at `:119`) and `:145`, `:159-160` (node and link buttons); `ColumnTable.tsx:149` (`live.profile` never triggered by arrival) and `:202` (`onSelect` column), `:211` ("Inspect table"); `NormalizationLens.tsx:127` (profile button; the only path to `live.profile`) and `:136` (`ReviewCard onSelect`); `Domains.tsx:133`, `:138`, `:147` (community and table clicks); `SchemaDiff.tsx:137` (inspect button, disabled for removed tables today); `City.tsx:181` (`raycast={() => {}}`, roads not inspectable; enabling is W05) and `:309` (`setSelected(null)` on layout change; W05 item 9).
7. `docs/reference/caveats.md` C03, C04, C13, C14 and `caveat-strings.ts`.
8. `docs/engineering/accessibility-standards.md` (context menu keyboard model, focus visible on `[data-selected="true"]`), `standards.md`, `testing-policy.md` (D03).

### 3. In scope

**Inbound, all nine views** (`drill-through-contract.md` section 7, inbound rules 1-6):
- `selected?: Selection` drives `data-selected="true"` and `is-selected` on the primary element; multi-selection (`ts`) marks each and the first with `is-primary`.
- Dimming of non-related elements only when `selected.origin !== <view id>`.
- One scroll/pan/fly per selection change (Living ERD `setCenter`; Column Table `scrollIntoView`; Join Matrix scroll to row/col; Arc and Domains focus; Fan-out node into view). No re-centre on unrelated re-renders or filter changes.
- "Selected item is filtered out" notice with a one-click "clear filters" when the id is in `fullGraph` but not in `graph`.
- Selection never cleared by a filter change (City's `:309` reset is narrowed in W05; W04 must not regress it further).
- Reduced motion makes movement instantaneous.

**Outbound and navigation, the registry P1-P10** (embedded here from `drill-through-contract.md` section 6; the registry code lives in `navigation.ts`, C03):

| Id | From (view, gesture) | To (view) | Inbound selection at target | URL written | W04 implementation notes |
|---|---|---|---|---|---|
| P1 | Inspector, "Open in" menu | any view | Fan-out root = `t`; Living ERD focus `t`; City fly-to `t`; Column Table `t`,`c`; Join Matrix row `t`; Arc `t`; Map neighbourhood `t`; Keys `t`; Review findings of `t` | `t` (+`c`), `v.root`/`v.focus` as needed | Menu is W02; W04 makes every target view honour the inbound selection |
| P2 | Join Matrix cell click | Fan-out | root = row table, target highlighted | `ts=row,col`, `v.root=row` | Cell -> `onSelectRelationship(r)` when exactly one constraint links the pair, else `onSelectTables` fallback (`JoinMatrix.tsx:116`) |
| P3 | City building (context menu; single click still inspects) | Living ERD focus / Fan-out root / Column Table | `t` | `t`, `v.focus` or `v.root` | Context menu on the building's accessible element and Shift+F10; W05 owns fly-to and the drawer |
| P4 | Normalization Lens finding | Column Table filtered to the finding's columns; Review for the same table | `t`, `c` (first column), `f` | `t`, `c`, `f`, `v.only` | Finding id carried as `f`; no `live.profile` on arrival |
| P5 | Arc Diagram cycle group | Living ERD with members selected and fit | `ts` = members | `ts` | Arc click -> `onSelectRelationship(r)`; cycle = SCC (C12 wording stays as in `dependency-logic.ts`) |
| P6 | Domains community | City with `v.districts=discovered` filtered to the community / Living ERD with members | `ts` = members, `d` | `ts`, `d`, `v.districts=discovered`, `v.community` | Menu label carries the C03 string from `caveat-strings.ts` |
| P7 | Schema Diff changed table | Column Table and Inspector; removed table -> Inspector on the before-snapshot with a read-only banner | `t` | `t`, `v.side=a` for removed | Replaces the disabled state at `SchemaDiff.tsx:137` for removed tables |
| P8 | Review finding | Column Table (finding columns); Living ERD (relationship for FK findings); Fan-out (orphan candidates) | `t`, `c`, `r`, `f` | `t`, `c`/`r`, `f`, `v.root` | Fan-out target is a prefilled root only; C04 string shown with any SQL |
| P9 | Fan-out node / link | re-root; relationship selection; Column Table | `t` / `r` | `v.root`, `r`, `t` | Re-root keeps depth; link click -> `onSelectRelationship` |
| P10 | Column Table FK column / PK column with opt-in sample | Living ERD with relationship selected / Fan-out row mode prefilled | `r` / `t`, `v.pk` | `r`; `t`, `v.pk` | Prefill only; the user still clicks "Load subtree" (`Fanout.tsx:119`) |

- Outbound rule: click on a table -> `onSelectTable`; on a column -> `onSelectColumn` (falls back to `onSelectTable` of its table when absent); on a relationship (edge, arc, matrix cell with a single constraint, fan-out link) -> `onSelectRelationship` (falls back to `onSelectTables` of both endpoints).
- Context menu (W02 component) wired in every view on each selectable element with `targetsFor(selection, view)`; choosing an item calls `onNavigate`.
- Views never call `history` or touch `location`.
- `tests/e2e/drill-through.spec.ts`: generated at test time from `navigation.entries`; for each entry and each `to` view: performs the gesture on the medium fixture, asserts the target view shows `[data-selected="true"]` on the expected element, asserts the URL contains the listed keys, reloads and asserts the selection survives, asserts `window.__backend-buddyMounts` unchanged, and asserts no request to `/api/subtree` or `/api/profile` occurred before a click on Run (`CTQ-06 drill-through prefills but does not run live query`); test names `CTQ-10 <entry> <from> -> <to>`.
- `CTQ-10 no remount over 20 keystrokes` per view (extends the W01 shell test to all 13 views).
- Two keyboard-only journeys skeletons completed for P1 (inspector -> Living ERD) and P4 or P8 (review -> columns) in `tests/a11y/keyboard-journeys.spec.ts`; the "inspector -> city" journey is finished in W05.
- Feature docs: F14 sections 3 and 14; each of the nine feature docs section 14 (one row) and section 3 where the current-state line changes.

### 4. Out of scope

- Schema City fly-to, outline mesh, road raycast, district labels, palette, drawer, view-state persistence (W05 items 1-9); W04 only plumbs `selected` and P3's context menu into City.
- Insights view (W06).
- Later registry entries: Map node -> City fly-to; Keys row -> Living ERD; Living ERD edge -> Join Matrix cell; hover sync; keyboard chords.
- Changes to `navigation.ts`, `route-state.ts`, the `v.*` allowlists, or `types.ts` (C03; a missing name is an "Out of scope, found" item and a roadmap change request).
- Artifact hash deep links and Open-in inside the artifact (L-05); W04's artifact obligation is only that the nine views still mount and behave with `selected` undefined.
- Finding id scheme (L-06), sha256 signatures.

### 5. May modify

```
packages/explorer/src/LivingERD.tsx
packages/explorer/src/LivingERD.css
packages/explorer/src/Fanout.tsx
packages/explorer/src/Fanout.css
packages/explorer/src/ColumnTable.tsx
packages/explorer/src/ColumnTable.css
packages/explorer/src/NormalizationLens.tsx
packages/explorer/src/NormalizationLens.css
packages/explorer/src/Domains.tsx
packages/explorer/src/Domains.css
packages/explorer/src/JoinMatrix.tsx
packages/explorer/src/JoinMatrix.css
packages/explorer/src/ArcDiagram.tsx
packages/explorer/src/ArcDiagram.css
packages/explorer/src/SchemaDiff.tsx
packages/explorer/src/SchemaDiff.css
packages/explorer/src/City.tsx                     (selected prop plumbing and P3 context menu only; no scene changes)
packages/explorer/src/*-logic.ts                   (helpers needed for selection lookup, e.g. relationship ref resolution; no behaviour change to existing exports)
packages/explorer/src/*-logic.test.ts
tests/e2e/drill-through.spec.ts
tests/e2e/views/*.spec.ts                          (inbound/outbound cases added to the S02-converted suites)
tests/a11y/keyboard-journeys.spec.ts
packages/web/src/**                                (shell glue for onSelectColumn/onSelectRelationship/onNavigate into the store; no new routes)
docs/features/F14-drill-through-navigation.md     (sections 3 and 14)
docs/features/F05-*.md ... F13-*.md                (sections 3 and 14 only)
CHANGELOG.md                                       ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change in this brief
packages/explorer/src/types.ts          C01/C03 only
packages/explorer/src/{route-state,selection,navigation,view-state,mount-policy,caveat-strings}.ts   C03; read-only
packages/explorer/src/city-layout.ts    W05
packages/explorer/src/Inspector.tsx, inspector-logic.ts, decisions.ts, ContextMenu.tsx   W02 (bug reports go to "Out of scope, found")
packages/explorer/src/{MapView,EntityIndex,KeyIndex,ReviewView}.tsx   W03 (they already implement inbound/outbound; a gap is reported)
skill/assets/explorer.html              S01, S03, W03 only
skill/scripts/build_explorer.py         S01 only
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
services/api/**                         A track
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| `ViewProps` additive fields; `onSelectTable(id)` unchanged; absence of a callback means the view does not offer that action | `types.ts` (C03); `drill-through-contract.md` section 3 | `npm run typecheck`, `navigation.test.ts` |
| Registry P1-P10 as tabulated above; `viewStateKeys` of every entry are in the target view's allowlist | `navigation.ts` (C03); `drill-through-contract.md` section 6 | `navigation.test.ts`; generated matrix |
| Route grammar and `v.*` allowlists (`fanout: root depth pk`, `columns: family only page`, `city: mode districts`, `living: junctions focus`, `lens: flagged page size`, `domains: community page`, `matrix: order related`, `arcs: cycle`, `diff: dialect side`) | `drill-through-contract.md` section 4 | `route-state.test.ts` |
| Selector contract `[data-selected="true"]`, `.is-selected`, `.is-primary`, `.schema-city-*`, `[data-rowcount]`, `#tab-<view>`, `[data-view]` | `drill-through-contract.md` section 7 | `tests/e2e/drill-through.spec.ts`, `verify_host.mjs` |
| Relationship ref = `constraintId` else `source.column>target.targetColumn` | `drill-through-contract.md` section 4 (`r`); `schema-graph-contract.md` B3 | `selection.test.ts` |
| Prefill, never execute: no `/api/subtree` or `/api/profile` before Run; `Fanout.tsx:94`, `ColumnTable.tsx:149`, `NormalizationLens.tsx:127` stay behind buttons | C04, C14, CTQ-06 | `CTQ-06 drill-through prefills but does not run live query` |
| Views never touch `history`/`location` | section 7 outbound rule 3 | ESLint restricted globals (S02) |
| No remount: `__backend-buddyMounts` constant over 20 keystrokes in all 13 views | `mount-policy.ts` (C03) | `CTQ-10 no remount over 20 keystrokes` |
| Storage key families (`backend-buddy:view-state:v1:<project.key>:<fingerprint>:<view>`) | C13; `view-state.ts` | `view-state.test.ts`; storage-isolation e2e (Q02) |
| Unknown stays unknown: `data-rowcount="unknown"|"0"|<n>` on count-encoding elements (F05, F06, F07, F09, F11, F13) | C01, CTQ-01 | `tests/e2e/rowcount.spec.ts` |
| Caveat wording from `caveat-strings.ts` only (C03 in P6 label, C04 in P8) | `docs/reference/caveats.md` | `caveats.test.ts`, docs lint DL-05 |
| Existing pure-logic exports keep their outputs (`buildFanout`, `analyzeNormalization`, `dependencyTopology`, `computeCommunities`, `snapshotKey`) | the 75 existing unit tests | `npm test` |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with the F/CTQ id, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F14 in full; F05-F13 section 14 rows)
- [ ] Migration: none, because this package has no server-side state
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (no live request before click; no `innerHTML`; deep-link values only through `route-state.ts`)
- [ ] Accessibility result recorded (axe 0 serious/critical for all 13 views x 2 themes x 1366/390 with a selection present; two keyboard-only journeys)
- [ ] Performance measurement recorded: shell and chunk sizes unchanged within budget; any new per-selection work measured on the medium fixture (TTI harness lands in Q01; record a manual `performance.mark` number here)
- [ ] Caveat text only from `packages/explorer/src/caveat-strings.ts`
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: the generated matrix has one test per (entry, to-view) pair and 0 skipped tests

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run typecheck
npm test
npm --prefix packages/web test -- --coverage
npm run build
git diff --exit-code skill/assets/extensions
npx playwright test tests/e2e/drill-through.spec.ts --reporter=junit     # CTQ-10 <entry> <from> -> <to>; CTQ-06 prefill case; 0 skipped
npx playwright test tests/e2e/views/                                     # converted suites plus inbound/outbound cases
npx playwright test tests/e2e/shell.spec.ts                              # CTQ-10 no remount over 20 keystrokes, all 13 views
npx playwright test tests/a11y/routes.spec.ts tests/a11y/keyboard-journeys.spec.ts
node scripts/verify_host.mjs dist/backend-buddy.html <out> --widths=1920,1366,390   # nine views still mount in the artifact
node scripts/no-skip-check.mjs <junit-output>                            # skipped = 0 (S02)
```

Package-specific assertions: for P10 the matrix asserts the Fan-out PK field is prefilled and the network log contains no `/api/subtree` until "Load subtree" is clicked; for P7 a removed table shows the read-only banner and `v.side=a`; for P6 the City receives `v.districts=discovered` and the label text equals the C03 string.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Add a per-entry table P1-P10 with implemented `to` views and test names.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-02 contract churn | Registry and grammar are consumed read-only; a missing `v.*` name is reported with a change request, not added. |
| RK-04 strict SPA CSP | Context menus use React portals, no inline handlers or `javascript:` URLs; `tests/e2e/csp.spec.ts` stays green. |
| RK-05 remount lifecycle | Every view gets a component test for `selected` prop changes and filter prop changes; Schema Diff loaded snapshots must survive prop updates. |
| RK-10 scope creep | City scene work is W05; a tempting fix inside `city-layout.ts` is reported. |
| RK-14 sensitive values | P10's opt-in sample display does not add new value rendering; sample values remain as today (`LivingERD.tsx:35`). |
| RK-19 storage origin split | View-state writes only through `view-state.ts`. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
