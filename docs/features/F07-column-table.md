Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F07 Column table

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | view `columns` (`packages/explorer/src/index.tsx:22`; `ColumnTable.tsx`); host tab `columns` (`skill/assets/explorer.html:22`); live `POST /api/profile` (`packages/explorer/server/serve_explorer.py:94-95`); planned SPA route `/w/:ws/p/:project/s/:snapshot/columns` (W01) |
| CTQs | CTQ-01, CTQ-02, CTQ-07, CTQ-08, CTQ-10, CTQ-11 (CTQ-07 and CTQ-08 added here; registry row and traceability update pending, section 13 Q6) |
| Caveats | C01, C05, C06 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

The Column table is the schema-wide column browser: every column of every table as a tile coloured by type family, with key, index, nullability and profiling facts, searchable and filterable across the whole snapshot. It answers "which columns look like this, which declared FKs lack a covering index, which `_id` columns have no constraint, and what does the sampled data say about this column". It must never be mistaken for a data catalogue of measured truths: profiling statistics are sample-scoped unless the profile says otherwise, and index coverage is stated per key group with column order.

## 2. Driver

- **Persona**: P3 backend developer (primary), P2 DBA / performance engineer (unindexed FKs, nullability), P4 data analyst (type and null rates).
- **Job to be done**: "Find every column that matches this shape, tell me what constrains it and how it is indexed, and show what the sample says before I write the query."
- **Business metric**: to be validated (D01). Candidate: unindexed-FK findings confirmed or dismissed per review.

## 3. Current state

Verified against `packages/explorer/src/ColumnTable.tsx` (215 lines) and `packages/explorer/src/column-logic.ts` (157 lines).

**Props and mount**

- `ColumnTable({ graph, onSelectTable, live }: ColumnTableProps)` (`ColumnTable.tsx:98`) with exported `ColumnTableProps { graph; onSelectTable; live? }` (`:8-12`); `onSelectTables` is not accepted. Registered as `columns` (`index.tsx:22`).

**Facts and classification (`column-logic.ts`)**

- `COLUMN_FAMILIES` = integer, decimal, text, datetime, boolean, json, binary, uuid, enum, other (`:5`); `columnFamily(type)` classifies by regex on the lower-cased type (`:8-20`), arrays always `other` (`:10`).
- Family colours: `ColumnTable.css:37-46` maps each `.ct-family-<name>` class onto `--ct-family-<name>` from `packages/explorer/src/tokens.css`, which C02 mirrors from `COLUMN_FAMILY_COLORS` in `palettes.ts`. Both themes have their own ten values, chosen so that no two families are closer than 11 CIEDE2000 under normal vision, deuteranopia, protanopia or tritanopia and each clears 3:1 against `--bg` and `--panel` (`tokens.test.ts`). `.ct-root` sets `color-scheme: inherit` (C02, was `light dark`, which contradicted the host).
- `tableColumnFacts(table, links)` (`:49-101`): builds the index set from `indexes`, `uniques`, the primary key, and single unique columns (`:51-56`); groups declared FKs by `[target, constraintId]` or ordinal (`:60-65`); a group is covered only when a non-partial, non-expression index has the FK columns as its ordered leading prefix (`:68-71`, comment "Keep the recorded FK order: MySQL requires the same ordered index prefix."). Per column it returns `primary`, `foreign`, `inferred`, `unique`, `indexed`, `unindexedDeclared` (`:85-98`), and three descriptions: `indexDescription` (leading column versus "member N, not leading", partial or expression "FK coverage unverified", or "Indexed according to column metadata; index order is unknown." / "No index recorded.", `:81-84`), `uniqueDescription` ("Composite unique membership; this column alone is not necessarily unique", "Conditional or expression uniqueness; whole-column uniqueness unverified", or "Individually unique", `:92`), and `foreignDescription` ("Declared FK: ...", "FK metadata: ...", "Inferred by naming, not a declared constraint: ...", `:93-97`).
- `columnProfile(column, rowCount, tableProfiling)` (`:115-133`) resolves `scope` to `sample`, `table`, or `unknown` (`:121`), validates `nullFraction` to 0..1 (`:124`), and derives `sampleRatio` (distinct / sample), `rowRatio` (distinct / total rows), and `coverage` (sample / total rows) only when denominators are known and positive (`:127-129`). `formatProfileValue` prints `undefined` as "Not available" and `null` as "NULL" (`:152-156`).
- `matchesColumn` (`:143-150`): family, nullable, unindexed declared FK, `_id` without FK (`/_id$/i`, `:147`), and a substring search over table id, name, schema, className, and column name (`:149`).

**Rendering and interactions (`ColumnTable.tsx`)**

- Toolbar: search input using `useDeferredValue` (`:101-102`, `:181`); "Profile" button enabled only with `live.profile`, title "Profile all tables, up to 10,000 rows per table" (`:183`); "Export current schema snapshot (JSON)" (`:184`).
- Type-family fieldset with per-family counts (`:187`); filters "Nullable only", "Unindexed declared FKs" (title explains ordered leading-prefix coverage, `:190`), "_id without FK" (title "naming-inferred links are not constraints", `:191`); "Clear filters" (`:192`).
- Results bar `role="status"` "N / M columns in K tables" (`:195`); "Expand all" / "Collapse all" (`:196`); the first two groups are open by default (`index < 2`, `:202`).
- `ColumnGroup` (`:52-96`): toggle with `aria-expanded` and `aria-controls` (`:67`), column count "n / total columns" when filtered (`:70`), row count "<n> rows" or "Rows unknown" (`:72`), an inspect button calling `onSelectTable(table.id)` (`:73`, wired at `:202`); tiles paged by `PAGE_SIZE = 120` with "Show N more" (`:14`, `:63-64`, `:92`). Each tile is a button with `aria-pressed` (`:83`), family swatch and label (`:84`), name, type or "Type unknown" (`:86`), badges PK / FK / INFERRED / UNIQUE / INDEXED / NULLABLE / NULLABILITY UNKNOWN (`:39-50`), and a `ProfileReadout`. The tile tooltip includes `Minimum:` and `Maximum:` profile values (`:81-82`).
- `ProfileReadout` (`:19-37`): "No statistics" when the profile is empty (`:23`); "Nulls x% in sample | (scope unknown)" with an `aria-hidden` bar (`:26-27`); "N distinct in sample | in table | (scope unknown)" (`:29`); "Sample|Profile N rows / x% coverage | coverage unknown" (`:30`); "Sample size / coverage unknown" (`:31`); ratios (`:32-33`); "Distinct / total rows: N/A (empty table) | unknown" (`:34`); "Range available" (`:35`).
- Column inspector aside (`:204-212`): opens on tile click (local `selected {table, column}`, `:108`), shows nullability, index coverage, uniqueness, references, total rows or "Unknown", minimum and maximum (`:209`), the readout, and "Inspect table" calling `onSelectTable` (`:211`).
- Live profile (`:141-161`): `live.profile({ tables: <every table id in the current graph>, maxRowsPerTable: 10000 })` (`:149`: `currentGraph.tables.map(table => table.id)`, so the view's own search and family filters are not applied, matching the button title "Profile all tables" at `:183`) guarded by a request token, an `inFlight` ref, and a graph-identity check with the comment "A host may install the returned graph before this promise resolves." (`:150-153`); the result replaces the whole graph for this view while `profiled.base === graph` (`:99-100`). Status line "Sampled profile; limit N rows per table. Sample distinct counts are not total distinct estimates." or "Profile completed." (`:198`); errors `role="alert"` (`:199`).
- Export (`:163-177`): serialises `currentGraph` (possibly profiled) to `<project.key | 'schema'>-column-snapshot.json` (`:166`, `:170`).

**Known limitations**

- No `AbortSignal` is passed to `live.profile` (`:149`) although the contract accepts one (`types.ts:9`); an in-flight full-schema profile cannot be cancelled, unlike Fan-out and the Normalization lens.
- Column selection is view-local (`:108`); nothing emits a column-level selection, so the inspector's column detail is lost at the boundary. No inbound `selected` either.
- Export includes `profiling.min`, `profiling.max`, and any `sampleValues` present, with no stripping or opt-in (`:166`).
- The profiled overlay is keyed on graph object identity (`:100`), so the host remount on every filter keystroke (`skill/assets/explorer.html:68`, `:178`) discards the profiled result, filters, expansion, and selection.
- Defaults are not shown: `default`, `serverDefault`, `applicationDefault` (`types.ts:2`) are not rendered anywhere in the view, although `caveats.md` C15 lists "F07 Column table (default column)" as a surface.
- `maxRowsPerTable: 10000` is a literal (`:149`).

## 4. Intended behaviour

### MVP

- **B1** Honour inbound `selected.tableId` and `selected.columnId` (P1 `t`, `c` in the contract's `table.id#column` form, one column): open the group, page to the column, mark the tile `data-selected="true"` and `is-selected`, open the column inspector, and scroll once per selection change.
- **B2** Honour an inbound finding (P4, P8): `c` carries exactly one column (the finding's first column, `table.id#column`; `c` is 0..1 per `docs/architecture/drill-through-contract.md` section 4), `f` carries the finding id, and `v.only=finding` switches the finding filter on. The view resolves the finding's full column set from `f` against the loaded graph (Normalization Lens ids name their columns: `dup:<name>:<type>` and `fd:<table>:<determinant>:<dependent>`, F09 B2; Review finding ids resolve through `navigation.resolve`, section 13 Q4), filters the group to those columns, shows a dismissible "Filtered by finding" chip, and keeps every other filter clear. Dismissing the chip clears `v.only` and `f`. When `f` cannot be resolved, the view falls back to B1 for `c` and shows no chip.
- **B3** Emit `onSelectColumn('<table.id>#<column>')` on tile click (the `columnId` form of `docs/architecture/drill-through-contract.md` section 3), in addition to the local inspector; keep `onSelectTable` on the inspect buttons.
- **B4** Outbound P10: an FK column offers "Open in Living ERD" with `r` = the constraint ref (`onNavigate`); a PK column with an opt-in sample value offers "Fan-out from this row" that prefills `v.pk` and never runs the query.
- **B5** Pass an `AbortSignal` to `live.profile` and abort on unmount, graph change, and a second click; show "Cancel" while profiling.
- **B6** Export strips `sampleValues` and string `min` / `max` by default with an explicit "Include sensitive statistics" opt-in; the file carries the snapshot provenance line (C09) and the sample caveat (C05) in a top-level `notes` field.
- **B7** Render the three default kinds separately when present (`default`, `serverDefault`, `applicationDefault`) in the tile tooltip and the inspector, labelled per C15, without emitting any DDL.
- **B8** Survive filter keystrokes without remount (C03): search, family filters, expansion, selection, and a profiled overlay persist; the overlay is keyed on graph fingerprint, not object identity.
- **B9** `data-rowcount="unknown"|"0"` on group headers, and profile statistics keep "in sample" / "in table" / "(scope unknown)" wording from `caveat-strings.ts` (C01, C05).

### Later

- **B10** CSV export of the visible tiles (F19) with C05 footer.
- **B11** Column-class badges from A03 `policy.py` (secret, pii-direct, ...) shown on tiles; statistics redacted per class.
- **B12** Unindexed-FK row -> Join Matrix cell (candidate registry entry, "Later").

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03.

### Inbound

| Entry | From | Arrives with |
|---|---|---|
| P1 | Inspector "Open in Column Table" | `t`, `c` (`table.id#column`) |
| P3 | City building context menu | `t` |
| P4 | Normalization Lens finding | `t`, `c` (first finding column), `f`, `v.only=finding` |
| P7 | Schema Diff changed table | `t` |
| P8 | Review finding | `t`, `c` (first finding column), `f`, `v.only=finding` |
| P9 | Fan-out node | `t` |

Honoured fields: `selected.tableId`, `selected.columnId` (exactly one, `table.id#column`), `selected.findingId` (B2). Highlight: `data-selected="true"` and `is-selected` on the tile; group opened; once per selection change the tile is scrolled into view.

### Outbound

- `onSelectTable(id)` from the group inspect button (`ColumnTable.tsx:73`, `:202`) and the inspector "Inspect table" (`:211`) - exists today.
- `onSelectColumn('<table.id>#<column>')` on tile click - B3.
- P10: FK column -> Living ERD with `r` (`onNavigate`); PK column with opt-in sample -> Fan-out row mode prefilled (`v.pk`), the user still clicks Run - B4.
- Rule: a drill-through may prefill a live query but never runs it without a click. This view's own "Profile" also runs only on click (`:183`).

### URL state

- Reads and writes shared keys `t`, `c`, `f`, `q` (search text).
- View-local keys, per the `columns` allowlist frozen in `docs/architecture/drill-through-contract.md` (section 4): `v.family` (comma-separated subset of `COLUMN_FAMILIES`, `column-logic.ts:5`), `v.only` (comma-separated tokens: `nullable`, `unindexed`, and `idnofk` map to the three checkboxes at `ColumnTable.tsx:189-191`; `finding` restricts the group named by `t` to the columns of `f`, B2), and `v.page` (0-based tile page of the group named by `t`, so a deep link to a tile beyond the first 120 reproduces; other groups' paging stays in `viewState`). Values capped at 200 characters. No other view-local key is registered; the earlier proposal (`v.fam`, `v.nullable`, `v.unindexed`, `v.idnofk`, `v.open`) is withdrawn.
- Deliberately not in the URL: expansion state ("Expand all" / "Collapse all"), paging of groups other than `t`, profiled overlay, inspector open state; these live in the `viewState` slice keyed by graph fingerprint.

## 6. Data contract dependencies

| Field | Required | When absent |
|---|---|---|
| `tables[].id`, `name`, `schema`, `className` | `id` required | label falls back to id (`ColumnTable.tsx:17`); search skips missing fields (`column-logic.ts:149`) |
| `tables[].rowCount` | optional | "Rows unknown" (`:72`), "Total rows: Unknown" (`:209`), ratios omitted (`column-logic.ts:128-129`) |
| `tables[].allColumns[].{name,type,pk,fk,nullable,index,unique}` | required | `type` empty shows "Type unknown" (`:86`); `nullable ''` shows NULLABILITY UNKNOWN (`:48`) |
| `tables[].allColumns[].profiling.{nullFraction,distinctCount,sampleSize,sampled,scope,min,max}` | optional | "No statistics" (`:23`); scope `unknown` wording |
| `tables[].profiling.{sampleSize,sampled}` | optional | column-level values used first (`column-logic.ts:119-120`) |
| `tables[].indexes[]`, `uniques[]`, `primaryKey`, `pk` | optional | "No index recorded." / column-metadata wording (`column-logic.ts:84`) |
| `links[].{source,column,target,targetColumn,kind,constraintId}` | required except `constraintId` | groups by ordinal when no `constraintId` (`:61`) |
| `allColumns[].{default,serverDefault,applicationDefault}` | optional | not rendered today; B7 |
| `project.key` | optional | export filename falls back to `schema` (`:170`) |

`LiveConnection` method used: `profile({ tables, maxRowsPerTable })` (`types.ts:9`), returning `ProfileResult { graph, sampled, limit }` (`types.ts:8`).

## 7. Caveats

> C01: "Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero."
> Shown: "Rows unknown" (`ColumnTable.tsx:72`), "Total rows: Unknown" (`:209`), "No statistics" (`:23`), "Sample size / coverage unknown" (`:31`), "(scope unknown)" (`:26`, `:29`), "Distinct / total rows: N/A (empty table) | unknown" (`:34`).

> C05: "Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized."
> Shown: "in sample" suffixes (`:26`, `:29`, `:32-33`), profile status "Sampled profile; limit N rows per table. Sample distinct counts are not total distinct estimates." (`:198`), coverage percentage (`:30`). MVP (B6): export `notes`.

> C06: "Membership in a composite unique key or composite primary key does not make any member column unique on its own. Uniqueness is stated per key group, and index coverage depends on column order, predicates, and expressions."
> Shown: `uniqueDescription` "Composite unique membership; this column alone is not necessarily unique" (`column-logic.ts:92`); `indexDescription` "member N, not leading", "partial, FK coverage unverified", "expression, FK coverage unverified" (`:81-84`); filter title at `ColumnTable.tsx:190`.

Also surfaced here according to `docs/reference/caveats.md` "Where surfaced" but not in the registry row for F07 (reconciliation in section 13):

> C15: "An application-level default (an ORM or code default) is not a SQL default. The two are shown separately, an application default is never emitted as DDL, and a code function is never emitted as executable migration SQL."
> Shown: nowhere today (defaults are not rendered); B7 adds the three-way display.

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the medium fixture, when the route is `?t=<a>&c=<a>%23<col>`, then group `<a>` is open, the tile `<col>` carries `data-selected="true"`, the column inspector shows `<col>`, and the tile is scrolled into view once.
- **AC2** (B2, CTQ-10) Given `?t=<a>&c=<a>%23x&f=fd:<a>:x:y&v.only=finding`, then only tiles `x` and `y` of `<a>` are visible, tile `x` carries `data-selected="true"`, the "Filtered by finding" chip is shown, and dismissing it removes `v.only` and `f` from the URL and restores all columns.
- **AC3** (B3, CTQ-10) Given a tile click, then `onSelectColumn` is called once with `'<table.id>#<column>'` and the inspector opens.
- **AC4** (B4, CTQ-10) Given a PK tile with an opt-in sample value, when "Fan-out from this row" is chosen, then the route becomes `.../fanout?t=<a>&v.pk=<value>` and no `/api/subtree` request occurs.
- **AC5** (B5, CTQ-08) Given profiling is in progress, when "Cancel" is clicked, then the `AbortSignal` is aborted, the status returns to idle, and no profiled overlay is applied.
- **AC6** (B6, CTQ-07) Given a profiled graph with `sampleValues` and string `min`/`max`, when Export is clicked without the opt-in, then the JSON contains no `sampleValues` key and no string `min`/`max`, and the `notes` field carries the C05 and C09 sentences.
- **AC7** (B9, CTQ-01) Given the medium-measured fixture, then a group with `rowCount: 0` has `data-rowcount="0"` and one with `rowCount: null` has `data-rowcount="unknown"`; their readouts say "N/A (empty table)" and "unknown" respectively.
- **AC8** (B8, CTQ-10) Given two families selected and a profiled overlay, when 20 host filter keystrokes are typed, then `window.__backend-buddyMounts` is unchanged and both persist.
- **AC9** (B7, CTQ-07) Given the hostile fixture column whose `applicationDefault` contains SQL text and markup, then the inspector shows it as text under "Application default", separate from "Server default", no dialog opens, and the view emits no DDL string derived from it (C15).
- **AC10** (CTQ-02; responsive matrix, no behaviour tag) Given 390 px width, then the inspector aside stacks below the tiles and the body does not scroll horizontally.

## 9. Test expectations

- Unit (node:test): `column-logic.test.ts` (13 tests today) covers `columnFamily`, `tableColumnFacts` coverage rules, `columnProfile` scope resolution, `matchesColumn`; add `F07` cases for finding-column resolution from `f` (lens `dup:` and `fd:` ids against the graph) and the export-stripping function (pure).
- Component (Vitest, `packages/web`): `F07` tests for inbound selection opening and paging, abort on unmount (mock `live.profile` receives a signal), and export stripping.
- E2E: `tests/e2e/views/columns.spec.ts` (from `column-browser.test.ts`, which today self-skips without `COLUMN_TABLE_PLAYWRIGHT_PATH`; S02 removes the skip and `msedge`); `tests/e2e/drill-through.spec.ts` rows for P1, P3, P4, P7, P8, P9, P10.
- A11y: axe on `columns` route x 2 themes x 1366/390; keyboard journey "search, Tab to tile, Enter, Tab to Inspect table, Enter" (CTQ-11).
- Perf: render of `large.json` with all groups collapsed within TTI budget; "Show 120 more" paging keeps interaction under 100 ms on the medium fixture (to be baselined in Q01).
- Security: hostile fixture (column names and types with markup) renders as text; export of the hostile fixture contains no executable content and stripped fields (CTQ-07).
- Fixtures: `small`, `medium`, `medium-measured`, `large`, `hostile`.

## 10. Security and privacy

- Inputs: search text (in-memory filter only) and the "Profile" click. No free-text reaches a query; the profiler receives table ids validated against the snapshot allowlist (F17).
- Renders from untrusted data: names, types, descriptions, and profile values (`formatProfileValue` stringifies via `JSON.stringify`, `column-logic.ts:152-156`); all as React text nodes or `title` attributes.
- Sensitive statistics: `min`, `max` (tile tooltip `:81-82`, inspector `:209`) and `sampleValues` (in exports) can expose customer data. MVP: A03 policy classes decide what the profiler returns; B6 strips on export by default; string extremes are off by default at the profiler (plan A03).
- Storage: none today; MVP `viewState` (C13).
- Export: a Blob download of JSON (`:166-171`), no network. Under the SPA the export moves to the `export` job with `Content-Disposition: attachment` (A04) or stays client-side with B6 stripping.
- Live: `profile` without an abort signal today (`:149`); B5 fixes. The request runs only on click (C14).
- CTQ-07 checks: hostile fixture render, export stripping test, no secrets in the bundle.

## 11. Performance budget

| Budget or cap | Value | Source |
|---|---|---|
| View TTI on medium fixture | <= 1.5 s | limits B (Q01) |
| Columns per group page | 120 | `ColumnTable.tsx:14`, `:63-64`, `:92` |
| Live rows per table | 10,000 requested (`:149`), clamped by `MAX_ROWS` | `serve_explorer.py:95`; `schema_profiler.py:73` |
| Groups open by default | 2 | `ColumnTable.tsx:202` |
| Search deferral | `useDeferredValue` | `:102` |

## 12. Accessibility

- Roles and names: search `aria-label` (`:181`); `fieldset`/`legend` for families (`:187`); results `role="status"` linked by `aria-describedby` (`:195`, `:201`); group toggles `aria-expanded` + `aria-controls` (`:67`); tiles are buttons with `aria-pressed` (`:83`); inspector `aside[aria-label="Column inspector"]` with a labelled close button (`:204-205`); errors `role="alert"` (`:199`); icons `aria-hidden`.
- Keyboard: all controls are native; paging via "Show N more" button (`:92`).
- Colour independence: family swatch is paired with the family name (`:84`); null bar is `aria-hidden` and paired with the percentage text (`:26-27`).
- Live regions: results count and profile status are `role="status"`; a completion announcement for profiling exists (`:198`).
- Motion: none.
- Text alternative: the view is text-first; no canvas.
- Axe coverage: `columns` route x 2 themes x 1366/390 (CTQ-11).

## 13. Open questions

1. Registry reconciliation: `caveats.md` lists F07 under C15 ("default column") but the view renders no defaults and the registry row omits C15. Add C15 to the row and build B7, or remove F07 from C15. Owner: Product owner. Gate: G0.
2. Should the client-side export remain at all once the server `export` job exists, given stripping and audit (CTQ-16) are server concerns? Owner: Backend lead. Gate: G1.
3. Is `min`/`max` display in tooltips acceptable for `pii-direct` columns before A03 policy classes are wired, or should the view hide extremes until then? Owner: Security lead. Gate: G1.
4. Resolved by the contract (`c` is one `table.id#column`, `docs/architecture/drill-through-contract.md` section 4): finding column sets come from `f`. Remaining: Normalization Lens ids name their columns (F09 B2), but Review (F04) finding ids are a signature scheme (W03 `review-logic.ts`); must `navigation.resolve(P8)` derive the column set from the review finding, or must the F04 id scheme name its columns? Owner: Frontend lead (C03, W03). Gate: G1.
5. Should the "Profile" action profile only visible (filtered) tables, matching the Normalization lens, or all tables as today? Owner: Product owner. Gate: G0.
6. This document lists CTQ-07 (export stripping and hostile-fixture rendering, section 10, AC6, AC9) and CTQ-08 (the capped `live.profile` request; `docs/reference/limits-and-caps.md` A2 row for `POST /api/profile`) in its header, as F06 and F09 already do for their live requests. The F07 rows in `docs/features/README.md` and `docs/product-management/traceability.md` section 3 still read CTQ-01, 02, 10, 11 and must be updated to match, or the two ids removed here. Owner: Product owner. Gate: G0.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| View | `packages/explorer/src/ColumnTable.tsx` |
| Logic | `packages/explorer/src/column-logic.ts` |
| Styles | `packages/explorer/src/ColumnTable.css` (the `--ct-family` mechanism, values from the token layer) |
| Tokens | `packages/explorer/src/tokens.css` `--ct-family-*` and `--danger`; `COLUMN_FAMILY_COLORS` in `palettes.ts` (C02) |
| Live route | `packages/explorer/server/serve_explorer.py:94-95` (`/api/profile`); `schema_profiler.py` (`profile`) |
| Contract | `packages/explorer/src/types.ts` (`ColumnProfiling`, `LiveConnection.profile`) |
| Navigation | `packages/explorer/src/navigation.ts` (P1, P3, P4, P7, P8, P9, P10) after C03 |
| Tests | `packages/explorer/src/column-logic.test.ts`; `packages/explorer/src/column-browser.test.ts` (legacy, converted by S02); `tests/e2e/drill-through.spec.ts` (W04) |
| Host mount | `packages/explorer/src/index.tsx:22`; `skill/assets/explorer.html:195` |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-08 | - | C02 | The ten family colours moved from `ColumnTable.css:37-46` to `tokens.css` `--ct-family-*` with a value per theme, mirrored by `COLUMN_FAMILY_COLORS` in `palettes.ts`; `.ct-error` uses `--danger`; `.ct-root` sets `color-scheme: inherit` instead of `light dark`; every `var(--x, #hex)` fallback removed, so a light-mode mount no longer falls back to dark values. |
| 2026-09-07 | - | D05 | Review fixes: `c` is one `table.id#column` and finding columns resolve from `f` (B1, B2, AC1, AC2, P4/P8 rows); `v.*` keys aligned to the `columns` allowlist (`family`, `only`, `page`); `onSelectColumn` takes a `columnId` string; `:149` profiles every table in the graph, not "visible"; CTQ-07/08 declared in the header (Q6); AC9 retagged to CTQ-07; AC10 to CTQ-02 only; stray Schema diff budget row and punctuation removed. |
| 2026-09-07 | - | D05 | Initial document from the pre-repo baseline. |
