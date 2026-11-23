Status: draft | Owner: Frontend lead | Last verified against code: 2026-11-22

# F03 PK/FK index

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | host view `keys` (`skill/assets/explorer.html`, tab `#tab-keys` at `:22`, renderer `renderKeys` at `:90-96`, row builder `keyRows` at `:81`); planned React `KeyIndex` with `key-logic.ts` registered under `keys` (W03); planned SPA route `/w/:ws/p/:project/s/:snapshot/keys` (W01) |
| CTQs | CTQ-02, CTQ-10, CTQ-11 |
| Caveats | C06, C07 |
| Last verified | 2026-11-22 |

## 1. Purpose

The PK/FK index lists every key-like column in the snapshot with its role (PK, PK + FK, declared FK, inferred reference, unresolved ID), type and nullability, reference target and target type, index coverage, and the unique key groups it belongs to. A user answers "which columns carry keys, which references are declared versus guessed, and which FK columns lack a leading index". It is a column-level evidence table, not a proof of uniqueness: a column named `id` is not automatically a PK, an `_id` suffix is not proof of an FK, and composite key membership does not make a column unique on its own.

## 2. Driver

- **Persona**: P2 DBA/performance engineer (primary), P3 backend developer, P1 architect (definitions in `docs/business/business-case.md`, D01).
- **Job to be done**: "Show me every key column, whether its reference is declared or only inferred, and whether it is covered by an index, so I can decide what to validate."
- **Business metric**: to be validated (business case D01 in progress).

## 3. Current state

Verified against `skill/assets/explorer.html` and `skill/scripts/build_explorer.py`.

**Row model**

- `keyRows(tables)` at `explorer.html:81` emits one row per column where `c.pk || c.fk || c.name.endsWith('_id')`. `matches` = outgoing links whose `column` equals the column name. Role: `PK + FK` when both flags, else `PK`, else `Declared FK` when `c.fk` is set, else `Inferred reference` when at least one link matches, else `Unresolved ID`.
- `c.fk` is stamped only for `declared FK` links by `normalize()` (`build_explorer.py:88`); an inferred link never sets `fk` (`test_renderer.py:38-42`), so an inferred reference cannot receive a declared role (C07).
- `uniqueGroups(t)` at `:43`: the primary key (or the `pk` columns), plus `uniques` and unique `indexes` that are neither `partial` nor `expression`. `fullyIndexed(t,c)` at `:44`: `c.index || c.unique`, or the column leads a unique group, or leads a non-partial, non-expression index. `indexed(t,c)` (same line) also accepts a partial index that leads with the column when its filter only requires that column to be non-null.
- Partial-index coverage (B11), all on `:44`: `nullGuard(predicate, names)` returns the columns a partial-index filter requires to be non-null when the filter says nothing else (a conjunction of `<column> IS NOT NULL`, parenthesised or not, quoted or not), otherwise `null`; it parses display-only text and never executes it. `coverage(t,c)` is `full` (as `fullyIndexed`), `guarded` (a partial index leads with the column and its filter is a null guard on that column alone), `partial` (only partial indexes with any other filter, or with no recorded filter, lead with it) or `none`. An equality lookup or join on the column, including the referential check a parent delete runs, implies the column is not null, so a `guarded` index serves it; a `partial` one serves only rows inside its filter. `packages/explorer/src/index-coverage.ts` is the commented original, and `index-coverage.test.ts` checks the host copy against it.

**Rendering**

- `renderKeys(tables)` at `:90-96`. The search text is applied a second time inside the view against the row's table id, class name, domain, column name, and `target.targetColumn` strings (`:92`), so a search for a target column narrows key rows even though `scoped()` (`:60`) matched by table.
- Toolbar (`:93`): `N key columns`, key-type select (`aria-label="Key type"`, options `All key types | PK | PK + FK | Declared FK | Inferred reference | Unresolved ID`, state `state.keyKind` at `:37`), and the note text `Composite key membership retained`.
- Table columns (`:93`): `Entity / column` (table-link + column name), `Role` (badge; `good` styling when `pk` or `fk`), `Type / nullability` (`PK required` | `Nullable` | `Required` | `Implicit / unknown`), `Reference / target type` (per match: `target.targetColumn`, target column type or `Target column not found`, link `kind`, and `DELETE <ondelete>` when set; when no match but `c.fk` is set the raw `fk` string; otherwise `No target recorded`), `Index coverage` (`Leading column / unique key` | `Leading column of a partial index that only excludes NULL keys`, with the index name, its filter and `covers lookups by this column` | `Leading column of a partial index only`, with each such index and its filter (or `filter not recorded`) and `lookups outside the filter are not covered` | `Not recorded as leading column`), `Unique key groups` (each group as `(a, b)` or `None recorded`). Rows carry `data-row="<table id>"`; the selected table's rows highlight (`:65`).
- Inspector `Keys` button (`:78`) clears the domain and type filters, sets the search box to the table id, resets `keyKind`, and switches to this view; this is the only inbound navigation to the view today.

**Export**

- `exportRows` (`:95`): `table column role type nullable target index_leading index_partial unique_groups source_line`. `index_leading` is `true` for `full` and `guarded` coverage, `partial` for `partial`, `false` for `none`; `index_partial` lists `<index> WHERE <filter>` (or `<index> (filter not recorded)`) for the partial indexes behind a `guarded` or `partial` value and is empty otherwise.
- F19: an in-view `Export PK / FK index as CSV` button (`explorer.html:93`, wired at `:94`) calls the shared `exportCSV` (`:182`), so the export is reachable at every width. Every host CSV now opens with `# ` provenance lines (view, project, `source.generated`, `source.basis`, source identifiers, export time, scope from the search, domain, entity-type and key-type filters), each a formula-guarded cell.

**Defects and gaps (current state)**

- Rebuild on every filter keystroke (`:68`, `:178`) and the unconditional `unmount()` at `:178`.
- The `_id` suffix heuristic at `:81` is the only way a column with no key flag and no link enters the index (`Unresolved ID`); columns referenced by inferred links whose names do not end in `_id` still appear because `matches` is computed after the filter only for included columns, so a non-`_id` inferred source column is excluded from the index. Whether that is intended is open question 2.
- The note `Composite key membership retained` (`:93`) is a paraphrase of C06; MVP uses the canonical string.
- `nullable` is exported as the raw string (`'True' | 'False' | ''` -> `implicit`) at `:95`.
- No `data-selected` attribute; the view has no column-level selection even though its rows are columns.
- `Index coverage` is a leading-column test (`:44`). Expression indexes are still excluded. Partial indexes are judged by their recorded filter (B11): only a filter that requires nothing but non-null key columns counts as coverage, so `WHERE deleted_at IS NULL` and similar filters stay `partial` even where the application only ever queries those rows. Predicates are recorded by the PostgreSQL catalog reader (contract 1.1); other adapters that set only `partial: true` show `filter not recorded`.
- The header export button is hidden at widths <= 700 px (`:14`); the in-view button added by F19 is not.

## 4. Intended behaviour

### MVP

- **B1** `KeyIndex` (React, `packages/explorer/src/KeyIndex.tsx`) replaces `renderKeys` and registers under `keys` (W03). `uniqueGroups`, `indexed`, and `keyRows` are lifted into `key-logic.ts` with unit tests and identical output to the host on the medium fixture.
- **B2** Filter changes update props without remounting (CTQ-10).
- **B3** Inbound selection: `selected.tableId` highlights that table's rows (`data-selected="true"`, `is-selected`) and scrolls the first one into view; `selected.columnId` highlights the exact row.
- **B4** Outbound: table-link -> `onSelectTable(id)`; row click -> `onSelectColumn({tableId, column})`; reference cell click -> `onSelectRelationship(ref)`; row context menu -> `onNavigate` (Column Table for that table and column; Living ERD with the relationship; Review findings for the table).
- **B5** Key-type filter and the in-view search are URL state (`v.kind`, shared `q`).
- **B6** Legend and notes use canonical caveat strings: C06 in the `Unique key groups` header note; C07 in the `Role` legend (declared vs inferred vs unresolved).
- **B7** CSV export via `csv.ts` with the S01 guard; `nullable` exported as `true | false | unknown` (change recorded in section 14 when it lands); export reachable at 390 px.

### Later

- **B10** Keys row -> Living ERD with the relationship selected (drill-through registry "Later").
- **B11** (done 2026-11-22) Index entries carry the filter of a partial index in `predicate` (contract 1.1), and coverage says why a partial index does or does not count; see section 3. Expression text is not yet carried.

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005, D02). Registry entries P1-P10 in `packages/explorer/src/navigation.ts` after C03. The key index is a P1 target (Inspector -> Keys (t)), which today is the `Keys` inspector button (`explorer.html:78`).

### Inbound

- `selected.tableId`: highlight all rows of the table, scroll once.
- `selected.columnId`: highlight the row, scroll once.
- `selected.relationshipRef`: highlight rows whose match has that `constraintId` (or `source.column>target.targetColumn`).

### Outbound

- `onSelectTable(id)` (today via `wireRefs`, `:94`).
- `onSelectColumn`, `onSelectRelationship`, `onNavigate` (B4).
- Rule: a drill-through may prefill a live query but never runs it without a click. This view has no live query.

### URL state

- Shared keys read: `q d k`, `t`, `c`, `r`.
- View-local: `v.kind` (one of the five roles or absent for all).
- Not in the URL: scroll position (`viewState` slice).

## 6. Data contract dependencies

| Field | Required | Behaviour when absent |
|---|---|---|
| `allColumns[].pk`, `fk`, `index`, `unique`, `nullable`, `type`, `name`, `ondelete` | yes (coerced or defaulted at `build_explorer.py:46-50`) | `nullable ''` shows `Implicit / unknown`; `ondelete ''` shows nothing |
| `tables[].primaryKey`, `uniques[]`, `indexes[]` with `unique`, `partial`, `expression`, `columns` | yes (defaults and validation at `:53-67`) | empty groups show `None recorded` |
| `indexes[].predicate` | optional (contract 1.1; capped display text, and a group that carries one is made `partial` by `normalize()`) | a partial index shows `filter not recorded` and is not counted as coverage |
| `links[]` with `kind`, `column`, `target`, `targetColumn`, `constraintId` | yes | no match shows `No target recorded` |
| `allColumns[].line` | optional | `source_line` `0` |

No `LiveConnection` method is used.

## 7. Caveats

> C06: "Membership in a composite unique key or composite primary key does not make any member column unique on its own. Uniqueness is stated per key group, and index coverage depends on column order, predicates, and expressions."
> Shown: `Unique key groups` column lists whole groups (`:93`), `Index coverage` tests the leading column only, excludes expression indexes, and names each partial index with its filter, counting it only when the filter just excludes NULL keys (`:43-44`); toolbar note (today the paraphrase `Composite key membership retained`, MVP canonical text, B6).

> C07: "Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query."
> Shown: `Role` badge values `Declared FK | Inferred reference | Unresolved ID` (`:81`), the `kind` text in the reference cell (`:93`), the key-type filter options (`:93`), and the CSV `role` column (`:95`).

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the medium fixture, When `key-logic.keyRows` runs, Then the row count and each row's role equal the host's `keyRows` output (parity test before the inline code is deleted).
- **AC2** (B1, CTQ-10) Given a composite unique key `(a, b)`, When the rows for `a` and `b` render, Then neither is labelled unique on its own and both list `(a, b)` under `Unique key groups`.
- **AC3** (B1, CTQ-10) Given a declared FK on a non-leading column of a composite index and no other index, When rendered, Then `Index coverage` reads `Not recorded as leading column`.
- **AC4** (B1, CTQ-07) Given an inferred link whose target table is absent, When rendered, Then the role is `Inferred reference` (or `Unresolved ID` when no link matches), never `Declared FK`.
- **AC5** (B2, CTQ-10) Given the view mounted, When 20 characters are typed into the search box, Then `__backend-buddyMounts` is unchanged.
- **AC6** (B3, CTQ-10) Given `?t=<id>&c=<column>`, When the route loads, Then that row has `data-selected="true"` and is visible.
- **AC7** (B1, CTQ-02) Given 1920, 1366, and 390 px in both themes with the inspector open and closed, When rendered, Then the page does not scroll horizontally and the table scrolls in its container.
- **AC8** (B1, CTQ-11) Given both themes at 1366 and 390 px, When axe runs, Then zero serious or critical findings.

## 9. Test expectations

- Unit (node:test): `key-logic.test.ts` (`uniqueGroups` with partial and expression exclusions, `indexed` leading-column rule, `keyRows` roles for each of the five cases, `_id` heuristic). Prefix `F03`.
- Component (Vitest): `KeyIndex` with `fixtures/schemas/edge-cases.json` (composite keys, table without PK, unresolved inferred link).
- e2e (`tests/e2e/views/keys.spec.ts`, from `check_explorer.cjs`: key rows == count of `pk || fk || _id` columns).
- a11y: axe on the route; keyboard journey "filter to Declared FK, Tab to a row, open context menu".
- Fixtures: `small`, `medium`, `edge-cases`, `hostile`.

## 10. Security and privacy

- Inputs: SchemaGraph only; all interpolations escaped by `E()` today (`:93`); React port renders text.
- Storage: none. URL keys allowlisted and capped.
- Exports: identifiers, roles, types, nullability, targets; no statistics or sample values. Cells guarded (B7).
- CTQ-07: hostile-fixture render, CSP violations = 0 on the route.

## 11. Performance budget

- View TTI on the medium fixture <= 1.5 s (Q01). Shell chunk.
- Own caps: none today; the row count is bounded by the number of key-like columns. Virtualisation threshold shared with F02 (B2 there) if the large fixture requires it.

## 12. Accessibility

- Semantic table with column headers (`tableHTML`, `:70`); key-type select has `aria-label="Key type"` (`:93`); table links are buttons.
- Role is conveyed by text (badge label), not colour alone; the `good` class only changes emphasis.
- MVP adds `aria-selected` on highlighted rows and a live region for filter result counts.
- axe coverage: SPA route x 2 themes x 1366/390 and the artifact host view (CTQ-11).

## 13. Open questions

1. Should `nullable` in the CSV change from `True | False | implicit` to `true | false | unknown` (B7), given that existing consumers of the host CSV may exist? Owner: Product owner. By W03 brief.
2. Should columns that are the source of an inferred link but do not end in `_id` be included in the index (today excluded by the `_id` filter at `:81`)? Owner: Frontend lead. By W03 brief.
3. Is column-level selection (`onSelectColumn`) from this view an MVP requirement or Later? Owner: Frontend lead. By C03 freeze.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Current host view | `skill/assets/explorer.html:81` (`keyRows`), `:43-44` (`uniqueGroups`, `indexed`, `nullGuard`, `coverage`, `coverageHTML`), `:90-96` (`renderKeys`), `:78` (inspector `Keys` button) |
| Planned view | `packages/explorer/src/KeyIndex.tsx` (W03) |
| Planned logic | `packages/explorer/src/key-logic.ts`, `csv.ts` (W03) |
| Renderer rules relied on | `skill/scripts/build_explorer.py:46-67` (column flags, groups), `:88` (`fk` stamping), `:94-95` (inferred dropped when declared exists) |
| Partial-index coverage | `packages/explorer/src/index-coverage.ts` (also used by the Column Table's `tableColumnFacts`), `scripts/introspect_pg.py` (`pg_get_expr(indpred, indrelid)` into `predicate`), `skill/scripts/build_explorer.py` (`predicate` capped, implies `partial`) |
| Tests | `skill/scripts/check_explorer.cjs` (today); `index-coverage.test.ts` (parser, lookup coverage, host parity), `column-logic.test.ts`, `test_renderer.py` and `tools/local_admin/test_local_admin.py` (`F03` tests); `key-logic.test.ts`, `tests/e2e/views/keys.spec.ts` (W03/S02); `packages/explorer/src/export-browser.test.mjs` (F19 download and formula guard) |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-11-22 | - | F03 | B11 partial-index coverage. The export marked every FK column led only by a partial index as `index_leading=false`, which on a real catalog was about a quarter of the columns it reported as unindexed. PostgreSQL introspection now records each partial index's filter as `predicate` (contract 1.1); the PK / FK index and the Column Table count a partial index whose filter only excludes NULL keys as covering lookups by those columns, and name every other partial index with its filter. The CSV `index_leading` column gains the value `partial`, and a new `index_partial` column follows it. |
| 2026-11-22 | - | F19 | In-view CSV export button; provenance preamble and scope line on every host CSV export. |
| 2026-09-07 | - | D05 | Initial document from the pre-repo code. |
| 2026-09-07 | - | D05 | Review fixes: AC2 and AC3 tagged CTQ-10 (logic parity with the host `keyRows` and `indexed`, as AC1). |
