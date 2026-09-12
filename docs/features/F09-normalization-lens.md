Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F09 Normalization lens

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | view `lens` (`packages/explorer/src/index.tsx:22`; `NormalizationLens.tsx`); host tab `lens` (`skill/assets/explorer.html:22`); live `POST /api/profile` (`packages/explorer/server/serve_explorer.py:94-95`); planned SPA route `/w/:ws/p/:project/s/:snapshot/lens` (W01) |
| CTQs | CTQ-01, CTQ-02, CTQ-08, CTQ-10, CTQ-11 |
| Caveats | C01, C05, C08, C14 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

The Normalization lens is a review board that ranks tables by normalization review candidates: repeated same-name, same-type fields across three or more eligible tables, and sample-only functional dependencies (`distinct(A) = distinct(A, B)`) from profiling. It answers "which tables deserve a normalization conversation first, and what is the evidence". It must never be read as a verdict: a score is review priority, a dependency arrow is sample equality, an unprofiled table is "Unassessed" or "Partial", and no table is ever called normalized.

## 2. Driver

- **Persona**: P1 architect (primary), P3 backend developer, P5 engineering manager (prioritising refactoring).
- **Job to be done**: "Show me where the same attribute is stored in several places and where sampled data suggests a hidden dependency, with the evidence, so I can decide what to review."
- **Business metric**: to be validated (D01). Candidate: review candidates triaged (confirmed or dismissed) per snapshot.

## 3. Current state

Verified against `packages/explorer/src/NormalizationLens.tsx` (144 lines) and `packages/explorer/src/lens-domain-logic.ts` (148 lines).

**Props and mount**

- `NormalizationLens({ graph, onSelectTable, live }: ViewProps)` (`NormalizationLens.tsx:55`); `onSelectTables` is not used. Registered as `lens` (`index.tsx:22`).

**Analysis (`lens-domain-logic.ts`)**

- `analyzeNormalization(graph)` (`:114-148`) returns `reviews` sorted by score then id (`:146`) and `duplicates`.
- Repeated fields: columns are excluded with a stated reason (`:124-125`): "generic identifier or audit field" (regex at `:4-6`: `id`, `uuid`, audit timestamps, `version`, `is_deleted`, `tenant_id`, and `_id|_uuid|_guid` suffixes), "primary-key member", "reference-key member" (column `fk` or a declared FK source column, `:116`), "lookup-like table" (`<= 6` columns, referenced by a declared FK, and a non-generic single unique natural key, `:120-121`), or "type unknown". Remaining columns are bucketed by normalised name and type (`:127-131`); a bucket with three or more tables is a `DuplicateField` (`:139`).
- Sample dependencies: `sampleDependencies(table, { includeVacuous })` (`:90-112`) reads `table.profiling.functionalDependencies`, keeps only well-typed entries with `distinctDeterminant >= 2`, `distinctPair === distinctDeterminant`, and `sampleSize >= distinctPair` (`:99-103`), de-duplicates (`:104-106`), and marks cautions "Declared unique determinant: expected key dependency; no review points." or "Determinant is unique in this sample: equality is automatic; no review points." (`:107-108`). Cautioned dependencies are listed under exclusions, not drawn or scored (`:134-135`).
- `profileKnown` is true when a valid dependency exists or `functionalDependencies` is an array and `profiling.sampleSize >= 2` (`:136`).
- Score: 2 points per duplicate group, 3 per non-vacuous dependency (`:143`); `score` is `null` when there are no points and the profile is unknown (`:144`), so an unprofiled table without candidates is "Unassessed" and a profiled one without candidates scores 0.
- `declaredRelations` and `computeCommunities` live in the same module (`:11-23`, `:29-68`) and are used by F13 and the City wrapper; the lens uses `declaredRelations` for the referenced-table set (`:115`).

**Rendering and interactions (`NormalizationLens.tsx`)**

- Toolbar: search over table label and column names (`:124`, `:67`), domain select with "All domains" (`:125`, domains from `table.domain || 'Unassigned'`, `:65`), "Only flagged" (`:126`), and "Profile visible tables" enabled only with `live.profile`, title "Request up to 1,000 rows per visible table from the connected profiler" or "Live profiler unavailable in this offline graph" (`:127`).
- Overview: "N tables flagged", "N repeated field groups", "N profiles unknown" (`:129`), and a `<details>` "Review score and evidence" explaining the points, "No clean score is assigned when profiling is unknown and no candidates exist. A score of zero with a sample is still not proof of normalization.", the 48-link cap, and "Names alone do not establish shared meaning." (`:130`).
- `ReviewCard` (`:12-53`): `article.nl-card[data-table=<id>]` (`:20`); title button "Inspect <table>" calling `onSelectTable` (`:21`, wired at `:136`); domain and "<n> rows" or "Rows unknown" (`:22`); score "Unassessed" or "<n> review points" with "Sample evidence only" or "Partial: profile unknown" (`:23`); an SVG of the first 8 dependency arrows (`:19`, `:26-31`, `aria-label="Sample-only functional dependency arrows"`, per-arrow `<title>` "sample only, N rows"); the column list with PK / FK markers (`:35`) and duplicate names as buttons that highlight their link group on hover, focus, or click (`:36`); a flags block explaining each duplicate "(+2)" and dependency "(+3)" with what to check (`:43-44`) and "First N sample dependencies drawn; all M listed." (`:45`); an "Evidence and exclusions (N)" `<details>` with the lookup reason and the sentence "No sampled violation is not proof of a normal form." or "Functional-dependency coverage is unknown; absent statistics do not earn a clean score." (`:47-51`).
- Cross-card links: dashed SVG paths between repeated fields on the current page, measured from the DOM with `getBoundingClientRect` in a `useLayoutEffect` with a `ResizeObserver` on the board and every card (`:75-109`), capped at 48 (`:91`), each with a `<title>` "<field>: <a> and <b>; repeated-name candidate, not a foreign key" (`:100`, `:135`).
- Pagination: 4 / 8 / 12 per page, default 8 (`:57`, `:140`), previous / next (`:141`), page reset on any filter or graph change (`:70`).
- Live profile (`:110-121`): `live.profile({ tables: visible table ids, maxRowsPerTable: 1000 }, signal)` (`:115`) with a request token and `AbortController` (`:60`, `:112`); the result is merged table-by-table into an overlay tied to the current `graph` object (`:118`, `:63`); the overlay and any pending request are dropped when `graph` or `live` changes (`:71-74`). Errors are `role="alert"` (`:132`).

**Known limitations**

- Findings never leave the view: duplicate groups and dependencies are shown per card but only `onSelectTable(table.id)` is emitted (`:136`); there is no column-level or finding-level outbound channel, and no inbound selection.
- No export of findings (host toolbar substitutes a whole-schema JSON dump, `skill/assets/explorer.html:180`).
- Cross-card links are geometry, page-scoped, and recomputed on layout; they cannot be exported or reused.
- Overlay keyed on graph object identity (`:63`) and host remount per keystroke (`explorer.html:68`, `:178`) together discard the profiled result, page, and filters.
- No completion announcement after profiling (only errors are announced, `:132`).
- `maxRowsPerTable: 1000` is a literal (`:115`).
- The scoring expression at `lens-domain-logic.ts:144` relies on operator precedence (`points || profileKnown ? points : null`); it matches the intent but is fragile.

## 4. Intended behaviour

### MVP

- **B1** Honour inbound `selected.tableId`: page to the card, mark it `data-selected="true"` and `is-selected`, scroll it into view once per selection change.
- **B2** Give every finding a stable id (`f`): duplicate group `dup:<name>:<type>` and dependency `fd:<table>:<determinant>:<dependent>`; an inbound `f` highlights the finding and its link group.
- **B3** Outbound P4 (shape per `docs/architecture/drill-through-contract.md` section 6, row P4): a finding offers "Open in Column Table" with `t`, `c` = the finding's first column in `table.id#column` form (`c` is 0..1; the Column Table resolves the remaining columns from `f`, F07 B2), `f` = the finding id, and `v.only=finding`; and "Open in Review" with `t` and `f`; both via `onNavigate`. Keep `onSelectTable` on the card title. Emit `onSelectColumn('<table.id>#<column>')` when a column name is activated.
- **B4** Wording from `caveat-strings.ts` for C01, C05, C08, C14 in the score line, the exclusions block, the "Review score and evidence" panel, and the profile button title.
- **B5** Survive filter keystrokes without remount (C03): page, filters, active link group, and profiled overlay persist; the overlay is keyed on graph fingerprint.
- **B6** Announce profiling completion in a live region ("Profiled N tables, up to M rows each; sample evidence only") and keep "Cancel" available while pending.
- **B7** Findings feed Insights v0 (F18, W06) through `analyzeNormalization` without re-implementation, carrying C08 wording ("review candidates, not verdicts").
- **B8** Never describe a table as normalized: the only states are "Unassessed", "Partial: profile unknown", and "<n> review points / Sample evidence only" (CTQ-01, C05).

### Later

- **B10** CSV export of findings with evidence and exclusions (F19).
- **B11** Server-side review decisions per finding id (`PUT /reviews/{findingId}`, A04) shown on the card.
- **B12** Replace DOM-measured links with a layout computed from data so links can be exported and tested headlessly.

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03.

### Inbound

No registry entry P1-P10 targets the lens at MVP (P1 "Inspector -> any view" enumerates Fan-out, Living ERD, City, Column Table, Join Matrix, Arc, Map, Keys, Review). The view still honours `selected.tableId` (B1) and `f` (B2) when routed to directly, so an Inspector "Open in Normalization Lens" entry can be added without view changes (section 13).

### Outbound

- `onSelectTable(id)` from the card title (`NormalizationLens.tsx:21`, `:136`) - exists today.
- P4: finding -> Column Table filtered to the finding's columns: `onNavigate({ view: 'columns', selection: { tableId, columnId: '<table.id>#<first column>', findingId }, viewState: { only: 'finding' }, reason: 'P4' })`; and Review for the same table: `onNavigate({ view: 'review', selection: { tableId, findingId }, reason: 'P4' })` - B3. For `fd:<table>:<determinant>:<dependent>` the first column is the determinant; for `dup:<name>:<type>` it is `<name>` in the card's table.
- `onSelectColumn('<table.id>#<column>')` on column activation (`columnId` form per `docs/architecture/drill-through-contract.md` section 3) - B3.
- Rule: a drill-through may prefill a live query but never runs it without a click; "Profile visible tables" runs only on click (`:127`, `:110`).

### URL state

- Reads and writes shared keys `t`, `f`, `q` (search), `d` (domain).
- View-local keys registered for the C03 allowlist (proposed, frozen in C03): `v.flagged=1`, `v.page` (0-based), `v.size` (4|8|12). Values capped at 200 characters.
- Deliberately not in the URL: profiled overlay, active link group (hover), measured link geometry; these live in the `viewState` slice keyed by graph fingerprint or are transient.

## 6. Data contract dependencies

| Field | Required | When absent |
|---|---|---|
| `tables[].id`, `name`, `schema`, `domain` | `id` required | label falls back to id (`lens-domain-logic.ts:7`); domain "Unassigned" (`NormalizationLens.tsx:22`, `:65`) |
| `tables[].rowCount` | optional | "Rows unknown" (`:22`) |
| `tables[].allColumns[].{name,type,pk,fk,unique}` | required | empty type excluded as "type unknown" (`lens-domain-logic.ts:125`); empty list shows "No column metadata" (`NormalizationLens.tsx:40`) |
| `tables[].primaryKey`, `uniques`, `indexes[].unique` | optional | single unique columns from these feed the vacuous-determinant check (`lens-domain-logic.ts:80-88`) |
| `tables[].profiling.functionalDependencies[]` (`determinant`, `dependent`, `distinctDeterminant`, `distinctPair`, `sampleSize`) | optional | no arrows; `profileKnown` false; score `null` without duplicates |
| `tables[].profiling.sampleSize` | optional | `profileKnown` requires `>= 2` when no dependency is valid (`:136`) |
| `links[].kind === 'declared FK'` | used | reference-key exclusion and lookup detection (`:115-116`) |

`LiveConnection` method used: `profile({ tables, maxRowsPerTable: 1000 }, signal)` (`types.ts:9`). Note: `functionalDependencies` is read through the open `[key: string]: unknown` part of `SchemaTable.profiling` (`types.ts:4`); C01 must add it to `schema-graph.v1.json` explicitly (section 13).

## 7. Caveats

> C01: "Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero."
> Shown: "Rows unknown" (`NormalizationLens.tsx:22`); "Unassessed" and "Partial: profile unknown" (`:23`); overview "N profiles unknown" (`:129`); exclusions sentence "Functional-dependency coverage is unknown; absent statistics do not earn a clean score." (`:49`).

> C05: "Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized."
> Shown: "Sample evidence only" (`:23`); arrows `aria-label` "Sample-only functional dependency arrows" (`:26`) and per-arrow "sample only, N rows" (`:30`); flags "sample only, ..." (`:44`); "No sampled violation is not proof of a normal form." (`:49`); "A score of zero with a sample is still not proof of normalization." (`:130`).

> C08: "Heuristic findings are review candidates, not verdicts. Each finding names its columns, its observable evidence, why it might matter, and what would confirm or dismiss it. A structural heuristic does not prove a normal-form violation, a functional dependency, or a design defect."
> Shown: "Higher means more review priority; lower means fewer observed candidates." and "Names alone do not establish shared meaning." (`:130`); each flag names columns, evidence, and what to check (`:43-44`); link title "repeated-name candidate, not a foreign key" (`:100`); exclusions list with reasons (`:50`).

> C14: "The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows."
> Shown: profile button disabled without `live.profile`, title "Live profiler unavailable in this offline graph" (`:127`); the request runs only on click with a 1,000-row cap per visible table (`:115`).

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the medium fixture and page size 8, when the route is `?t=<id>` for a table on page 3, then the view shows page 3, the card `<id>` carries `data-selected="true"`, and it is scrolled into view once.
- **AC2** (B2, CTQ-10) Given `?f=dup:<name>:<type>`, then every card in that duplicate group highlights the field and the cross-card links for the group are active.
- **AC3** (B3, CTQ-10) Given a dependency finding, when "Open in Column Table" is chosen, then the route becomes `.../columns?t=<a>&c=<a>%23<det>&f=fd:<a>:<det>:<dep>&v.only=finding`, the Column Table shows only `<det>` and `<dep>` (F07 AC2), and no `/api/*` request occurs.
- **AC4** (B8, CTQ-01) Given the medium fixture (unprofiled), then no card shows a numeric score without candidates, every unprofiled card shows "Unassessed" or "Partial: profile unknown", and the word "normalized" does not appear as a state.
- **AC5** (B8, CTQ-08) Given the medium-measured fixture with a table whose `functionalDependencies` includes a unique determinant, then that dependency appears under "Evidence and exclusions" with the caution text and adds no points.
- **AC6** (B6, CTQ-08) Given a live connection, when "Profile visible tables" is clicked, then exactly one `/api/profile` request is made with `maxRowsPerTable <= 1000` and only the visible table ids, and a `role="status"` completion message appears.
- **AC7** (B5, CTQ-10) Given page 2 and "Only flagged", when 20 host filter keystrokes are typed, then `window.__backend-buddyMounts` is unchanged and page and filter persist.
- **AC8** (B4, CTQ-01) Given any render, then the score-line and exclusions strings equal the C05 and C08 entries in `caveat-strings.ts`.
- **AC9** (CTQ-02; responsive matrix, no behaviour tag) Given 390 px width, then cards stack in one column, links are hidden or redrawn without overflow, and the body does not scroll horizontally.

## 9. Test expectations

- Unit (node:test): `lens-domain-logic.test.ts` (7 tests today) covers `computeCommunities`, `sampleDependencies`, `analyzeNormalization`; add `F09` cases for finding-id generation, the score `null` versus `0` distinction, and exclusion reasons.
- Component (Vitest, `packages/web`): `F09` tests for inbound `t` paging, `f` highlighting, abort on unmount, and the completion live region.
- E2E: no legacy browser suite exists for the lens; add `tests/e2e/views/lens.spec.ts` (S02) and `tests/e2e/drill-through.spec.ts` rows for P4 (outbound to `columns` and `review`).
- A11y: axe on `lens` route x 2 themes x 1366/390; keyboard journey "Tab to duplicate field, Enter (highlight), Tab to card title, Enter".
- Perf: `analyzeNormalization(large)` within the view TTI budget; link measurement on a 12-card page stays under one frame (to be baselined in Q01).
- Security: hostile fixture with markup in column names renders as text in flags and titles; `functionalDependencies` entries with wrong types are dropped (existing unit coverage of `sampleDependencies`).
- Python: profiler FD extraction (`_fd_codes`, `MAX_FD_COLUMNS`) is F17's test scope.
- Fixtures: `medium` (unprofiled), `medium-measured` (profiling with FDs including a vacuous one), `large`, `hostile`.

## 10. Security and privacy

- Inputs: search text and domain select (in-memory filters) and the profile click. No free text reaches a query; table ids are validated by the profiler allowlist (F17).
- Renders from untrusted data: names, types, domains, and profiling numbers, all as React text or `<title>` nodes. `sampleDependencies` type-checks every field before use (`lens-domain-logic.ts:97-103`).
- Sensitive data: the lens shows counts (distinct values, sample sizes), never values; no `min`/`max`/`sampleValues` are rendered.
- Storage: none today; MVP `viewState` (C13).
- Live: `profile` with `AbortSignal` (`:112`, `:115`), 1,000 rows per visible table, on click only (C14). Server caps in `docs/reference/limits-and-caps.md` A1-A2.
- CTQ-07: hostile fixture render; no SQL anywhere in this view.

## 11. Performance budget

| Budget or cap | Value | Source |
|---|---|---|
| View TTI on medium fixture | <= 1.5 s | limits B (Q01) |
| Dependency arrows drawn per card | 8 (all listed) | `NormalizationLens.tsx:19`, `:45` |
| Cross-card links per page | 48 | `NormalizationLens.tsx:91` |
| Page size | 4 / 8 / 12, default 8 | `:57`, `:140` |
| Live rows per visible table | 1,000 | `:115` |
| Duplicate threshold | 3 or more eligible tables | `lens-domain-logic.ts:139` |
| Community passes (shared module) | 100 | `lens-domain-logic.ts:42` |
| Repeated `getBoundingClientRect` per layout pass | one per duplicate column on the page | `:75-109` (B12 removes) |

## 12. Accessibility

- Roles and names: `section[aria-label="Normalization lens"]` (`:122`); search and selects with `aria-label` (`:124-125`, `:140`); pagination buttons labelled (`:141`); arrow SVG `aria-label` (`:26`) and link SVG `aria-label` (`:135`) with per-path `<title>`; errors `role="alert"` (`:132`); `<details>` for evidence and exclusions (`:47`) and the scoring explanation (`:130`).
- Keyboard: duplicate field names are buttons with focus and blur handlers mirroring hover (`:36`); card titles are buttons (`:21`); all filters are native controls.
- Text alternative: every arrow and link has a textual counterpart in the flags block (`:43-45`) and exclusions (`:50`).
- Live regions: errors only today; B6 adds completion.
- Colour independence: duplicate and caution states use class plus text; link activity is also expressed by the highlighted field name.
- Motion: none.
- Axe coverage: `lens` route x 2 themes x 1366/390 (CTQ-11).

## 13. Open questions

1. Should the Inspector's "Open in ..." menu (P1) include the Normalization lens, and should the City context menu (P3) too? The registry omits the lens from every inbound entry. Owner: Product owner. Gate: G0.
2. `functionalDependencies` and `sampleSize` are read from the open `profiling` map; C01 must declare them in `schema-graph.v1.json` with the field shapes at `lens-domain-logic.ts:97-103`. Owner: Backend lead. Gate: G1.
3. Finding-id scheme: is `dup:<name>:<type>` stable enough for server-side decisions (A04) when a type string is normalised differently by two extractors? Owner: Frontend lead with Backend lead. Gate: G1 (before A04 `review_decisions`).
4. Should the lens profile all filtered tables rather than only the visible page, matching the Column Table? Owner: Product owner. Gate: G0.
5. Does F18 Insights v0 re-rank lens scores or surface them unchanged? Owner: Product owner. Gate: G0 (F18 MVP v0 doc).

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| View | `packages/explorer/src/NormalizationLens.tsx` |
| Logic | `packages/explorer/src/lens-domain-logic.ts` (shared with F13 Domains and the City wrapper in `index.tsx`) |
| Styles | `packages/explorer/src/NormalizationLens.css` |
| Live route | `packages/explorer/server/serve_explorer.py:94-95` (`/api/profile`); `schema_profiler.py` (`profile`, `_fd_codes`) |
| Contract | `packages/explorer/src/types.ts` (`SchemaTable.profiling`, `LiveConnection.profile`) |
| Navigation | `packages/explorer/src/navigation.ts` (P4 outbound) after C03 |
| Insights | `packages/explorer/src/insights-logic.ts` (W06) consumes `analyzeNormalization` |
| Tests | `packages/explorer/src/lens-domain-logic.test.ts`; `tests/e2e/views/lens.spec.ts` (new, S02); `tests/e2e/drill-through.spec.ts` (W04) |
| Host mount | `packages/explorer/src/index.tsx:22`; `skill/assets/explorer.html:195` |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-07 | - | D05 | Review fixes: P4 outbound rewritten to the contract shape (`c` = first column as `table.id#column`, `f`, `v.only=finding`; B3, AC3, Outbound); `onSelectColumn` takes a `columnId` string; `declaredRelations` cited as `:11-23`; AC9 tagged to CTQ-02 only. |
| 2026-09-07 | - | D05 | Initial document from the pre-repo baseline. |
