Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F02 Entity index

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | host view `entities` (`skill/assets/explorer.html`, tab `#tab-entities` at `:22`, renderer `renderEntities` at `:82-89`); planned React `EntityIndex` registered under `entities` (W03); planned SPA route `/w/:ws/p/:project/s/:snapshot/entities` (W01) |
| CTQs | CTQ-02, CTQ-10, CTQ-11 |
| Caveats | C03, C07 (registry row lists C07 only; see open question 1) |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

The entity index is the sortable, filterable table of every table in the snapshot: model or class name, domain, entity type, column count, primary key, declared FK counts, and total links. A user answers "which tables are the largest, most connected, or belong to this domain" and compares two tables' column names side by side. It is an inventory, not a semantic comparison: matching column names do not establish matching meaning, and the entity classifications are inferred labels.

## 2. Driver

- **Persona**: P3 backend developer (primary), P4 data analyst, P1 architect (definitions in `docs/business/business-case.md`, D01).
- **Job to be done**: "List every table with its size and connections so I can sort, filter, and pick the two I need to compare."
- **Business metric**: to be validated (business case D01 in progress).

## 3. Current state

Verified against `skill/assets/explorer.html`.

**Rendering**

- `renderEntities(tables)` at `explorer.html:82-89` receives the tables already filtered by the three global filters (`scoped()` at `:60`: search across id, class name, domain, type, and column names; domain select; entity-type select).
- Sort (`:83`): `name` (id, `localeCompare`), `columns` (descending `allColumns.length`), `links` (descending `incoming+outgoing`). Sort state is `state.sort` (`:37`), default `name`.
- Toolbar (`:84`): `N entities`, sort select (`aria-label="Sort entities"`), `Compare (n/2)` button enabled only when exactly two tables are ticked, `Clear selection`, and the note text `Entity classifications are inferred`.
- Table columns (`:84`): `Select` (checkbox `aria-label="Compare <id>"`), `Entity / model` (table-link button + class name), `Domain / type`, `Columns`, `Primary key` (`pk` or `None recorded`), `FKs out / in` (declared-FK link counts), `All links` (outgoing + incoming links of any kind). Rows carry `data-row="<id>"`; the selected table's row gets class `selected` via `highlight()` (`:65`, CSS `tr.selected td` at `:11`).
- Every table link is a `<button class="table-link" data-table="<id>">` (`ref()` at `:49`) wired by `wireRefs()` (`:71`) to `selectTable` (`:63`), which opens the inspector.
- All HTML is built with template literals and `innerHTML` (`:84`, `:87`); every schema value passes through `E()` (`:34`). No unescaped schema value reaches this view.

**Comparison**

- Checkbox handler (`:86`): a third tick is refused with the toast `Select two entities to compare` (`notify()` at `:52`); state is `state.compare` (a `Set`, `:37`).
- `Compare` (`:87`) fills `#comparison` with the shared column names, the names only in A, the names only in B, and the sentence `N shared column names; matching names do not establish matching meaning.` Only column names are compared, not types, nullability, keys, or indexes; the comparison is not exportable.

**Export**

- `exportRows` (`:88`): `table model domain entity_type columns primary_key source_line` for the sorted, filtered rows; downloaded by the header export button through `exportCSV()` (`:180`).

**State**

- `state.sort` and `state.compare` are in-memory (`:37`); `Reset filters` (`:69`) clears the comparison set; nothing about this view is persisted or in the URL.

**Defects and gaps (current state)**

- Every filter keystroke rebuilds the table (`:68` -> `render()` `:178` -> `renderEntities`); the unconditional `BackendBuddyViews?.unmount()` at `:178` runs even though this is a host view.
- `FKs out / in` counts declared-FK links, that is column pairs: a composite FK with two column pairs counts as 2 (C11; not in the registry row for F02, noted in open question 1).
- The `Entity classifications are inferred` note (`:84`) is a paraphrase; MVP replaces it with the C03 canonical string from `caveat-strings.ts`.
- Comparison is capped at two tables and compares names only; it has no export.
- Export button hidden at widths <= 700 px (`:14`).
- No inbound selection API beyond the host's `state.selected` row highlight; no `data-selected` attribute (the row uses class `selected`).
- `source_line` in the CSV is the raw `line` field; `normalize()` defaults it to `0` (`build_explorer.py:37`) but does not type-check it (S01 adds an int validator).

## 4. Intended behaviour

### MVP

- **B1** `EntityIndex` (React, `packages/explorer/src/EntityIndex.tsx`) replaces `renderEntities` and registers under `entities` (W03). Columns, sort options, and the two-table comparison keep today's semantics; row data is computed by a pure function (in `key-logic.ts` or a sibling `entity-logic.ts`) and unit-tested.
- **B2** Filter changes update props without remounting (CTQ-10); the table body is virtualised or paged when the visible row count exceeds a threshold to be set in W03 (the medium fixture has about 160 tables; the large fixture defines the budget).
- **B3** Inbound selection: `selected.tableId` sets `data-selected="true"` and class `is-selected` on the row and scrolls it into view once per selection change.
- **B4** Outbound: table-link click -> `onSelectTable(id)`; row context menu -> `onNavigate` targets (Column Table, Fan-out, Living ERD, City, Keys, Review) from the registry (W04); a checked pair -> `onSelectTables([a,b])` so the inspector shows the relationship inspector as today (`:64`).
- **B5** Sort key and compare selection are URL state (`v.sort`, `v.compare`; the `entities` allowlist in `docs/architecture/drill-through-contract.md` section 4); the comparison panel is derived from `v.compare` when it holds exactly two ids. The shared multi-selection key `ts` is not used for comparison: the contract defines it as the multi-selection from Join Matrix cells, Arc cycle groups, and Domains communities.
- **B6** The inferred-classification note uses the canonical C03 text from `caveat-strings.ts`; the `FKs out / in` header states that it counts column pairs (C11).
- **B7** CSV export through `csv.ts` with the S01 cell guard; the comparison result is exportable as CSV (shared, only A, only B).
- **B8** Export is reachable at 390 px (toolbar action inside the view).

### Later

- **B10** Comparison extended to types, nullability, keys, and indexes (a "structural diff of two tables"), reusing `schema-diff-logic` primitives (F10). Roadmap: post-MVP.
- **B11** Optional `rowCount` column with `unknown` for missing counts (C01, CTQ-01).

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005, D02). Registry entries P1-P10 in `packages/explorer/src/navigation.ts` after C03. The entity index is not a named registry entry today; it is a general table surface with outbound targets (B4).

### Inbound

- Honours `selected.tableId` (B3): `data-selected="true"`, `is-selected`, scroll-into-view once. Multi-select `ts` (`selected.tableIds`) marks each listed row with `data-selected="true"` and the first with `is-primary` (contract section 7); it does not tick the compare checkboxes. The compare pair comes from `v.compare` only (B5).
- Column and relationship selections are not shown by this view (it has no column or relationship rows).

### Outbound

- `onSelectTable(id)` on table-link click (today `:71`, `:63`).
- `onSelectTables([a,b])` when two rows are ticked (today the `Compare` button only fills `#comparison`; MVP also informs the inspector).
- `onNavigate(target)` from the row context menu (B4).
- Rule: a drill-through may prefill a live query but never runs it without a click. This view has no live query.

### URL state

- Shared keys read: `q d k` (the three global filters), `t`, `ts` (highlight only).
- View-local keys registered: `v.sort` (`name` | `columns` | `links`), `v.compare` (two `table.id` values separated by a comma; exactly two ids are accepted, anything else is dropped with a console warning; the 200-character value cap of `route-state.ts` applies to the pair). These are the `entities` allowlist names in `docs/architecture/drill-through-contract.md` section 4; adding or renaming one needs a registry change and an update to this section in the same PR.
- Not in the URL: table scroll position (in the `viewState` slice keyed by graph fingerprint).

## 6. Data contract dependencies

| Field | Required | Behaviour when absent |
|---|---|---|
| `tables[].id`, `className`, `domain`, `type`, `allColumns[]`, `pk` | yes (defaults at `build_explorer.py:37`) | `className` defaults to `id`; `domain`/`type` `Unclassified`; `pk` shows `None recorded` |
| `tables[].line` | optional (`0` default, `:37`) | `source_line` column in CSV shows `0` |
| `links[].kind`, `source`, `target` | yes | counts of `FKs out / in` and `All links` |
| `tables[].rowCount` | optional | not shown today (B11) |

No `LiveConnection` method is used.

## 7. Caveats

> C07: "Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query."
> Shown: the `FKs out / in` column counts declared FKs only, while `All links` includes inferred references (`:84`); the MVP header text names both counts explicitly (B6).

> C03: "Discovered communities are analytical suggestions computed from the declared-FK graph. They are structural candidates, not the project's business ownership model and not confirmed business domains."
> Shown: toolbar note (today the paraphrase `Entity classifications are inferred` at `:84`; MVP uses the canonical string, B6). Note: the entity index shows the adapter's declared `domain` and `type` labels, not discovered communities; `caveats.md` "Where surfaced" lists F02 for the classification note. See open question 1.

## 8. Acceptance criteria

- **AC1** (B1, CTQ-02) Given the medium fixture at 1920, 1366, and 390 px in both themes with the inspector open and closed, When the entity index renders, Then the page does not scroll horizontally and the table scrolls inside its own container.
- **AC2** (B2, CTQ-10) Given the view mounted, When 20 characters are typed into the search box, Then `__backend-buddyMounts` is unchanged and the row count equals the number of tables matching `scoped()` semantics.
- **AC3** (B1, CTQ-10) Given the `columns` sort, When applied, Then rows are in descending column count with ties in id order; Given the `links` sort, Then in descending `incoming+outgoing`.
- **AC4** (B1, CTQ-11) Given two ticked rows, When a third is ticked, Then the third stays unticked and a `role="status"` live region asks for two entities; When `Compare` is clicked, Then the panel lists shared, only-A, and only-B names and the sentence that matching names do not establish matching meaning.
- **AC5** (B3, CTQ-10) Given `?t=<id>`, When the route loads, Then that row has `data-selected="true"` and is visible in the scroll container.
- **AC6** (B7, CTQ-07) Given the `hostile` fixture, When rows and the comparison are exported, Then formula-leading cells are prefixed with `'` and no markup from identifiers is rendered as HTML.
- **AC7** (B1, CTQ-11) Given both themes at 1366 and 390 px, When axe runs, Then zero serious or critical findings; the sort select, checkboxes, and table links are keyboard-operable with visible names.

## 9. Test expectations

- Unit (node:test): `entity-logic.test.ts` (sort comparators, compare set difference, export row shape). Prefix `F02`.
- Component (Vitest): `EntityIndex` renders rows from `fixtures/schemas/small.json`; compare cap; selection prop.
- e2e (`tests/e2e/views/entities.spec.ts`, from the entity assertions in `skill/scripts/check_explorer.cjs`: rows == tables, nonsense search yields 0 rows, reset restores, two-entity compare reveals the panel).
- a11y (`tests/a11y`): axe on the route; keyboard journey "tick two rows, Compare, read result".
- Fixtures: `small`, `medium`, `large` (virtualisation threshold), `hostile`.

## 10. Security and privacy

- Inputs: SchemaGraph only. Today all interpolations are escaped by `E()` (`:84`, `:87`); the React port renders text as children.
- Storage: none. URL keys allowlisted and capped (C03).
- Exports: the CSV contains identifiers, counts, and `source_line`; no statistics or sample values. Cells guarded (B7).
- CTQ-07: hostile-fixture render, SPA CSP violations = 0 on the route.

## 11. Performance budget

- View TTI on the medium fixture <= 1.5 s (Q01). Ships in the shell chunk.
- Own caps: none today (all filtered rows are rendered). B2 sets a virtualisation or page threshold in W03 and records it in `docs/reference/limits-and-caps.md`.

## 12. Accessibility

- Semantic `<table>` with `<th scope="col">` (`tableHTML` at `:70`); checkboxes have per-row `aria-label` (`:84`); sort select has `aria-label="Sort entities"`; table links are buttons.
- Colour independence: the selected row uses background plus `aria-selected` (MVP adds it); nothing is conveyed by colour alone.
- The toast at `:52` is a `role="status"` element (`:26`); MVP keeps a live region for the compare-cap message.
- axe coverage: SPA route x 2 themes x 1366/390 and the artifact host view (CTQ-11).

## 13. Open questions

1. The registry row for F02 lists C07 only, while `caveats.md` lists F02 under C03 ("classification note") and this view's FK counts are column pairs (C11). Update the registry row to `C03, C07, C11`? Owner: Product owner. By G0.
2. Should the two-table comparison stay name-only at MVP (plan) or reuse `schema-diff-logic` for a structural compare (B10)? Owner: Frontend lead. By W03 brief.
3. Virtualisation threshold for B2: fixed number or measured from the large fixture in Q01? Owner: Frontend lead. By W03.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Current host view | `skill/assets/explorer.html:82-89` (`renderEntities`), `:60` (`scoped`), `:63-65` (`selectTable`, `selectTables`, `highlight`), `:70-71` (`tableHTML`, `wireRefs`) |
| Planned view | `packages/explorer/src/EntityIndex.tsx` (W03) |
| Planned logic | `packages/explorer/src/key-logic.ts` or `entity-logic.ts`, `csv.ts` (W03) |
| Tests | `skill/scripts/check_explorer.cjs` (today); `tests/e2e/views/entities.spec.ts` (S02) |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-07 | - | D05 | Initial document from the pre-repo code. |
| 2026-09-07 | - | D05 | Review fixes: compare selection moved from the shared `ts` key to `v.compare` per the drill-through contract `entities` allowlist (B5, section 5); AC4 tagged CTQ-11. |
