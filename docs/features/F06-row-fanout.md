Status: draft | Owner: Frontend lead | Last verified against code: 2026-09-08

# F06 Row fan-out

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | view `fanout` (`packages/explorer/src/index.tsx:22`; `Fanout.tsx`); host tab `fanout` (`skill/assets/explorer.html:22`); live `POST /api/subtree` (`packages/explorer/server/serve_explorer.py:100-101`); planned SPA route `/w/:ws/p/:project/s/:snapshot/fanout` (W01) |
| CTQs | CTQ-01, CTQ-02, CTQ-08, CTQ-10, CTQ-11 |
| Caveats | C01, C02, C05, C14 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

Row fan-out shows how one root table fans out through declared, non-unique foreign keys to its children, grandchildren and so on, up to four hops, with a local ratio (child rows / parent rows) on each relationship. In "Table counts" mode the ratios come from snapshot row counts; in "Start from one row" mode a bounded, read-only live query counts the actual descendants of a single primary-key value. It answers "if I touch this row or this table, how much is downstream". It must never be read as conserved flow: ratios are independent local factors, counts along a path are never added, and an unknown count yields an unknown ratio.

## 2. Driver

- **Persona**: P2 DBA / performance engineer (primary), P3 backend developer (delete and archive impact), P4 data analyst.
- **Job to be done**: "Before I archive or cascade-delete from this table, tell me which tables fan out from it and roughly how much per parent row, without running anything I did not ask for."
- **Business metric**: to be validated (D01). Candidate: time from question to first evidence in profiling-backed reviews.

## 3. Current state

Verified against `packages/explorer/src/Fanout.tsx` (167 lines) and `packages/explorer/src/fanout-logic.ts` (149 lines).

**Props and mount**

- `Fanout({ graph, onSelectTable, live }: Props)` (`Fanout.tsx:54`) with a locally typed `Props = { graph; onSelectTable; live? }` (`:9`), structurally `ViewProps` minus `onSelectTables`.
- Registered as `fanout` (`index.tsx:22`).
- The root defaults to `defaultFanoutRoot(graph)` (`fanout-logic.ts`), the table with the most eligible children rather than the first alphabetically. Only declared non-unique foreign keys fan out, so most tables have no children at all -- 106 of the 160 in `fixtures/schemas/medium.json` -- and the alphabetical default landed on one of them, opening the view on a single node with nothing under it.
- Each option in the root select carries its child count, or `(no fan-out)`, from `fanoutChildCounts(graph)`, so the choice is informed rather than blind.
- In schema mode a root with no eligible children gets a `role="status"` notice naming the root and saying no declared non-unique foreign key points at it, alongside the existing "No visible child relationships at this depth." beneath the diagram.
- Row mode is available only when `typeof live?.subtree === 'function'` (`:69`); otherwise the mode button is disabled with title "A live subtree connection is required" (`:110`) and a `role="status"` notice says "Start from one row unavailable: no live subtree connection." (`:114`).

**Model (schema mode)**

- `relationships()` (`fanout-logic.ts:63-86`) keeps only `declared FK` links between known tables (`:67`), groups by `[source, target, constraintId || column->targetColumn]` (`:68`), and drops a relationship when a unique key of the child covers the FK columns or any pair is `one-to-one` (`:81-82`), so only non-unique declared FKs fan out.
- `buildFanout(graph, root, depth, collapsed)` (`:88-123`): depth clamped to 1..4 (`:91`); node identity is `[depth, tableId]` (`:99`); caps at 400 nodes (`:100`) and 5,000 visited paths (`:104`); a child already on the ancestor path is pruned and counted as a cyclic relationship (`:108`); each edge carries `localRatio(parentRows, childRows)` (`:112-113`).
- `localRatio` (`:54-59`) returns `ratio: null` with reasons "Row count unknown" (`:56`), "Parent has zero rows" (`:57`), or "Ratio exceeds numeric range" (`:59`); `knownCount` accepts only finite non-negative numbers (`:19-21`).
- Notices (`:118-122`): "<N> cyclic relationship(s) pruned on affected paths.", "View safety limit reached (400 nodes or 5,000 paths). Collapse a branch or reduce depth to inspect other paths.", "Some tables recur at different depths. Their row counts are repeated, never added."

**Model (row mode)**

- `parsePrimaryKey(table, text)` (`:29-51`): single-column keys accept JSON scalars or raw text, refuse unsafe integers by returning the trimmed text (`:36`); composite keys require a JSON object with exactly the PK columns, non-null, non-object values (`:41-50`) and reject unsafe numbers with "Quote large numeric key values as JSON strings to preserve their exact value." (`:45-46`).
- `runSubtree` (`Fanout.tsx:84-99`) runs only on form submit (`:115`), aborts any in-flight request (`:90-91`), and calls `live.subtree({ rootTable, pkValue, depth, maxRowsPerHop: 10000 }, signal)` (`:94`); a request token discards stale responses (`:89`, `:95-98`).
- `buildLiveFanout(result, rootTable, collapsed, graph)` (`fanout-logic.ts:125-149`) keeps only forward links between known nodes (`:128`) that correspond to an eligible declared non-unique FK (`:129`), and emits notices for truncation "Live results are truncated (limit <N>). Counts and ratios may be partial." (`:142`), omitted non-forward links (`:143`), ineligible relationships (`:144`), revisited tables "Live paths revisit some tables. Their row sets may overlap; path counts are never added." (`:146`), and a missing depth-zero root (`:147`).
- The server route `POST /api/subtree` (`serve_explorer.py:100-101`) forwards `depth` (default 4) and `maxRowsPerHop` (default 10,000) to `schema_profiler.subtree`, which clamps rows to `MAX_ROWS` (`_cap`, `schema_profiler.py:460`) and rejects a `depth` outside 0..4 with `ValueError('depth must be an integer from 0 through 4')` (`schema_profiler.py:461-462`; `docs/reference/limits-and-caps.md` A1). The view's depth select (1-4) never sends an out-of-range value.

**Rendering and interactions**

- Layout (`Fanout.tsx:15-52`) uses `d3-sankey` for ordering only (comment at `:24`: "Sankey determines ordering only. Its conserved node values are never presented as data."); stroke width is `ratio / maximumRatio * 24`, or 1.5 for unknown or zero ratios (`:44`); ratio labels are de-overlapped per layer (`:46-50`).
- Toolbar: root table select (`:103-106`), depth select 1-4 (`:107`), mode group "Table counts" / "Start from one row" with `aria-pressed` (`:108-111`), expand-all reset (`:112`).
- Row mode form (`:115-122`): PK input with a composite placeholder listing the PK columns (`:116-117`), submit button "Load subtree" (`:119`), the cap "10,000 rows per hop" (`:120`), and "No known primary key for this table." (`:121`).
- Legend (`:124-129`): "Local ratio: child rows / parent rows", "Unavailable or zero: structural guide", "Independent factors, not conserved flow. Counts are not additive.", and in schema mode "Declared non-unique FKs only. Table-wide ratios are estimates, not per-row matches."
- Diagram (`:131-153`): the ribbon SVG is `aria-hidden` (`:135`); each node is a button labelled `Inspect <table>, <count label>` (`:145`) that calls `onSelectTable(node.tableId)`, with a collapse toggle carrying `aria-expanded` (`:150`). A "Local relationship ratios" table (`:155-163`) is the text alternative; its Parent and Child cells are buttons calling `onSelectTable` (`:159-160`).
- Error text is `role="alert"` (`:123`); notices are `role="status"` (`:130`); the scroll region is focusable with `aria-busy` while loading (`:131`).

**Known limitations**

- No inbound selection or root parameter: the root defaults to the first table by id (`:55-56`) and can only be changed via the select.
- Any change to `graph`, root, depth, mode, `live`, or the PK text clears the loaded live result and aborts the request (`:71-75`), so editing the PK field after a load discards the result.
- Relationship-level and re-root drill-through do not exist: node buttons emit a bare table id (`:145`), ratio rows expose parent and child as two separate buttons (`:159-160`), and `onSelectTables` is not accepted (`:9`).
- No export (the host toolbar substitutes a whole-schema JSON dump, `skill/assets/explorer.html:180`).
- The host remounts the view on every filter keystroke (`explorer.html:68`, `:178`), losing root, depth, mode, collapsed set, and any loaded subtree.
- `maxRowsPerHop: 10000` is a literal in the view (`:94`) rather than shared configuration.

## 4. Intended behaviour

### MVP

- **B1** Accept an inbound root: `t` (or `v.root`) sets the root table; `ts=row,col` (P2) sets root `row` (marked `data-selected="true"` and `is-primary`) and highlights `col` with `data-selected="true"`; the diagram scrolls the highlighted node into view once per selection change.
- **B2** Prefill, never run: an inbound `v.pk` (P10) switches to row mode and fills the PK field; the request is sent only when the user clicks "Load subtree". No `/api/subtree` request may occur before that click (asserted by the drill-through matrix).
- **B3** Emit `onNavigate` to re-root on a node (P9: "re-root"), `onSelectRelationship(ref)` on a ribbon or ratio row (P9: "link -> relationship"), and `onNavigate` to the Column Table for a node (P9: "node -> Column Table"); keep `onSelectTable` on the node's inspect button.
- **B4** Show every caveat sentence from `caveat-strings.ts` (C01, C02, C05, C14) instead of the current local wording, in the legend and notices.
- **B5** Survive filter keystrokes without remount (C03): root, depth, mode, collapsed set, and a loaded live result persist across 20 keystrokes; a graph change with a different fingerprint still resets.
- **B6** Keep unknown distinguishable from zero (CTQ-01): node count label "Rows unknown" versus "0 rows", ratio "Unavailable" versus a numeric ratio, and `data-rowcount="unknown"|"0"` on the node element.
- **B7** Editing the PK text after a load keeps the previous result visible and marked stale until the next Run (replaces the reset at `Fanout.tsx:71-75`).
- **B8** Live requests carry the per-table budget and partial-result status from A04 (`profiling.status: 'incomplete'` with a reason) and render the truncation notice from it.

### Later

- **B10** CSV export of the ratio table and SVG export of the diagram with a caveat footer (F19).
- **B11** Live subtree through the API job queue with cancel (`GET /jobs/{id}`), replacing the direct loopback route (A04 follow-up; L-05 for the artifact bridge).

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03.

### Inbound

| Entry | From | Arrives with |
|---|---|---|
| P1 | Inspector "Open in Fan-out" | `t` (root = t) |
| P2 | Join Matrix cell | `v.root=row`, `ts=row,col` (target highlighted) |
| P3 | City building context menu | `t` (root) |
| P8 | Review orphan finding | `t` (root), `f` (finding id; orphan candidates highlighted) |
| P10 | Column Table PK column with opt-in sample | `t`, `v.pk=<value>` (row mode prefilled; user still clicks Run) |

Honoured fields: `selected.tableId` (root or highlight), multi-select `ts`. Highlight: `data-selected="true"` and `is-selected` on the node; once per selection change the node is scrolled into view.

### Outbound

- `onSelectTable(id)` from node and ratio-row buttons (`Fanout.tsx:145`, `:159-160`) - exists today.
- P9: node -> re-root (`onNavigate({ view: 'fanout', selection: { tableId }, viewState: { root: tableId }, reason: 'P9' })`, depth kept), link -> `onSelectRelationship(ref)`, node -> Column Table (`onNavigate({ view: 'columns', selection: { tableId }, reason: 'P9' })`) - B3. Targets use the `NavigationTarget` shape of `docs/architecture/drill-through-contract.md` section 2.
- Rule: a drill-through may prefill a live query but never runs it without a click (B2, `runSubtree` is bound to form submit at `:115`).

### URL state

- Reads and writes shared keys `t`, `ts`, `f`, `r`.
- View-local keys, per the `fanout` allowlist frozen in `docs/architecture/drill-through-contract.md` (section 4): `v.root` (table id), `v.depth` (1-4), `v.pk` (prefill only; the value is capped at 200 characters and is never sent without a click). There is no `v.mode` key: the view is in row mode exactly when `v.pk` is present and in schema mode otherwise. Whether `v.pk` may appear in a shareable URL at all is open (section 13).
- Deliberately not in the URL: collapsed set, loaded live result, scroll offset; these live in the `viewState` slice keyed by graph fingerprint.

## 6. Data contract dependencies

| Field | Required | When absent |
|---|---|---|
| `tables[].id`, `name`, `schema`, `domain` | `id` required | name falls back to id; meta shows `schema || domain || 'Table'` (`Fanout.tsx:147`) |
| `tables[].rowCount` | optional | "Rows unknown" (`:13`); ratio "Unavailable" with reason "Row count unknown" (`fanout-logic.ts:56`) |
| `tables[].primaryKey`, `allColumns[].pk`, `pk` | optional | row mode disabled per table: "No known primary key for this table." (`Fanout.tsx:121`); resolution order at `fanout-logic.ts:23-27` |
| `tables[].uniques`, `indexes[].unique`, `allColumns[].unique` | optional | relationship treated as non-unique (fans out) |
| `links[].kind === 'declared FK'` | required | inferred links never fan out (`fanout-logic.ts:67`) |
| `links[].constraintId`, `cardinality` | optional | grouping by column pair; `one-to-one` excluded (`:82`) |

`LiveConnection` method used: `subtree(request, signal)` (`types.ts:9`) returning `SubtreeResult` (`types.ts:7`); `profile` is not used.

## 7. Caveats

> C01: "Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero."
> Shown: node label "Rows unknown" (`Fanout.tsx:13`, `:148`); legend "Unavailable or zero: structural guide" (`:126`); ratio "Unavailable" with reason (`:12`, `fanout-logic.ts:56-57`); unknown or zero ratios draw a 1.5 px structural ribbon (`Fanout.tsx:44`).

> C02: "A fan-out ratio is child rows divided by parent rows for one relationship. Ratios are independent local factors, not conserved flow: counts along a path are not additive, a ratio is not a proven per-parent multiplicity, and when either count is unknown the ratio is unknown."
> Shown: legend (`Fanout.tsx:125`, `:127`, `:128`); notice "Their row counts are repeated, never added." (`fanout-logic.ts:121`); code comment on sankey use (`Fanout.tsx:24`).

> C05: "Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized."
> Shown: live truncation notice (`fanout-logic.ts:142`); `*` suffix on truncated ratio labels (`Fanout.tsx:139`) and "(partial)" on truncated nodes and rows (`:148`, `:161`).

> C14: "The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows."
> Shown: row mode disabled without `live.subtree` (`Fanout.tsx:69`, `:110`, `:114`); the query runs only on form submit (`:84`, `:115`); cap text "10,000 rows per hop" (`:120`).

Also surfaced here according to `docs/reference/caveats.md` "Where surfaced" but not in the registry row for F06 (reconciliation in section 13):

> C12: "A cycle is a strongly connected component of the declared dependency graph with more than one member, or a self-reference. A repeated visit during traversal is not by itself a cycle."
> Shown: the recurrence notice at `fanout-logic.ts:121` deliberately says "recur", not "cycle"; pruned back-edges are reported separately at `:119`.

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the medium fixture, when the route is `?v.root=<a>&ts=<a>,<b>`, then the root select shows `<a>`, the node for `<b>` carries `data-selected="true"`, and it is scrolled into view once.
- **AC2** (B2, CTQ-10, CTQ-08) Given `?t=<a>&v.pk=42` and a live connection, when the view renders, then the mode is "Start from one row", the PK field reads `42`, and no request to `/api/subtree` has been made; when "Load subtree" is clicked, exactly one request is made with `maxRowsPerHop <= 10000` and `depth <= 4`.
- **AC3** (B6, CTQ-01) Given the medium-measured fixture with one table at `rowCount: 0` and one at `rowCount: null`, when both appear as nodes, then their `data-rowcount` values are `"0"` and `"unknown"` and their labels are "0 rows" and "Rows unknown".
- **AC4** (B3, CTQ-10) Given a ribbon is clicked, then `onSelectRelationship` is called once with the constraint ref and `onSelectTable` is not called.
- **AC5** (B5, CTQ-10) Given depth 3 and one collapsed branch, when 20 filter keystrokes are typed in the host search, then `window.__backend-buddyMounts` is unchanged and the collapsed branch remains collapsed.
- **AC6** (B4, CTQ-01) Given any render, then the legend text equals the C01 and C02 strings in `caveat-strings.ts` byte for byte.
- **AC7** (B8, CTQ-08) Given a live response with `truncated: true` and `limit: 10000`, then the notice "Live results are truncated (limit 10,000). Counts and ratios may be partial." is shown with `role="status"`.
- **AC8** (CTQ-02; responsive matrix, no behaviour tag) Given 1920, 1366, and 390 px widths in both themes, then the ratio table and diagram scroll inside `.fanout-scroll` and the page body does not scroll horizontally.
- **AC9** (B7, CTQ-10) Given a loaded live result, when the PK text is edited, then the previous result stays visible with a "stale" marker until Run is clicked.

## 9. Test expectations

- Unit (node:test): `fanout-logic.test.ts` (11 tests today) covers `buildFanout`, `buildLiveFanout`, `parsePrimaryKey`, `localRatio`; add `F06` cases for `data-rowcount` derivation inputs and the eligible-relationship filter with `cardinality: 'one-to-one'`.
- Component (Vitest, `packages/web`): `F06` tests for prefill-without-run (assert the `live.subtree` mock is not called until submit) and prop-change persistence.
- E2E: `tests/e2e/views/fanout.spec.ts` (from `fanout-browser.test.mjs`, `msedge` removed; fixtures instead of the original private example); `tests/e2e/drill-through.spec.ts` rows for P1, P2, P3, P8, P9, P10, including the assertion "no `/api/subtree` before Run".
- A11y: axe on `fanout` route x 2 themes x 1366/390; keyboard journey "select root, Tab to node, Enter".
- Perf: `buildFanout` on `large.json` at depth 4 stays under the 400/5,000 caps and completes within the view TTI budget.
- Security: hostile fixture ids in node labels render as text; `parsePrimaryKey` rejects objects and arrays for single-column keys (existing unit coverage).
- Python: `test_schema_profiler.py` and `test_explorer_http.py` cover the server side of `subtree` (F17).
- Fixtures: `small`, `medium`, `medium-measured` (zero versus unknown counts), `large`, `edge-cases` (SCC cycle, composite PK).

## 10. Security and privacy

- Inputs: the PK text field. It is parsed client-side by `parsePrimaryKey` (`fanout-logic.ts:29-51`) and sent as a JSON value to `live.subtree`; the profiler binds it as a parameter and validates identifiers against the snapshot (`packages/explorer/server/schema_profiler.py`, F17). No SQL is composed in the browser.
- Renders from untrusted data: table ids and names as React text nodes; live counts as numbers.
- Storage: none today; MVP `viewState` slice (in-memory, optionally persisted per C13).
- Live access: only through an explicitly supplied `LiveConnection` (C14); the request carries an `AbortSignal` (`Fanout.tsx:91`, `:94`). The loopback server enforces a 64 KB body cap, a single-flight lock, and a token (`serve_explorer.py:78-90`), with S03 moving the token to a cookie.
- CTQ-07: the drill-through matrix asserts no request before click; the hostile fixture asserts inert rendering.
- Privacy of `v.pk` in URLs is an open question (section 13): a primary-key value can identify a customer record.

## 11. Performance budget

| Budget or cap | Value | Source |
|---|---|---|
| View TTI on medium fixture | <= 1.5 s | limits B (Q01) |
| Depth | 1..4 | `fanout-logic.ts:91`; select at `Fanout.tsx:107`; mirrors `MAX_DEPTH` |
| Nodes per view | 400 | `fanout-logic.ts:100` |
| Paths visited | 5,000 | `fanout-logic.ts:104` |
| Live rows per hop | 10,000 requested (`Fanout.tsx:94`), clamped by `MAX_ROWS` | `serve_explorer.py:101`; `schema_profiler.py:73` |
| Live deadline | 5.0 s per operation today; per-table budgets at MVP | limits A1, B |
| Ribbon width | 1.5..24 px | `Fanout.tsx:44` |
| Live subtree latency (`POST /api/subtree`) | no budget at MVP; the CTQ-09 API p95 target in limits B measures `/api/profile`, not this route; a baseline is recorded in `docs/qa/perf-baselines.md` | Q01 |

## 12. Accessibility

- Roles and names: `section[aria-label="Row fan-out"]` (`Fanout.tsx:101`); selects with `aria-label` (`:103`, `:107`); mode group `role="group"` with `aria-pressed` buttons (`:108-110`); node buttons named "Inspect <table>, <count>" (`:145`); collapse toggles with `aria-expanded` (`:150`); status notices `role="status"` (`:114`, `:121`, `:130`); errors `role="alert"` (`:123`); scroll region `tabIndex={0}` with `aria-label` and `aria-busy` (`:131`).
- Text alternative: the ribbon SVG is `aria-hidden` (`:135`); the "Local relationship ratios" table (`:155-163`) carries the same data as text with a `<caption>`.
- Keyboard: every control is a native button, select, or input; no custom key handling is required.
- Colour independence: ratio is encoded by width and by the label text; structural (unknown) ribbons differ by class and width (`:44`, `:136`).
- Motion: none.
- Axe coverage: `fanout` route x 2 themes x 1366/390 (CTQ-11).

## 13. Open questions

1. May `v.pk` appear in a shareable URL? A PK value can identify a person. Options: allow, allow only for non-PII-classified PK columns (A03 policy), or keep prefill in `viewState` only. Owner: Security lead. Gate: G0.
2. Registry reconciliation: `caveats.md` lists F06 under C12; the registry row does not. Owner: Product owner. Gate: G0.
3. Should the row-mode cap (`maxRowsPerHop`) become a workspace setting rather than the literal at `Fanout.tsx:94`? Owner: Backend lead. Gate: G1 (A03 `Budget`).
4. For P2, when several constraints link the same row and column table, which one is highlighted, and does the cell carry `r` as well as `ts`? Owner: Frontend lead (C03). Gate: G1.
5. Should schema-mode ratios use `rowCountLowerBound` when `rowCount` is null (shown as ">= ratio") or stay unknown? Owner: Product owner. Gate: G0.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| View | `packages/explorer/src/Fanout.tsx` |
| Logic | `packages/explorer/src/fanout-logic.ts` |
| Styles | `packages/explorer/src/Fanout.css` |
| Live route | `packages/explorer/server/serve_explorer.py:100-101` (`/api/subtree`); `packages/explorer/server/schema_profiler.py` (`subtree`) |
| Contract | `packages/explorer/src/types.ts` (`LiveConnection.subtree`, `SubtreeResult`) |
| Navigation | `packages/explorer/src/navigation.ts` (P1, P2, P3, P8, P9, P10) after C03 |
| Tests | `packages/explorer/src/fanout-logic.test.ts`; `packages/explorer/src/fanout-browser.test.mjs` (legacy, converted by S02); `tests/e2e/drill-through.spec.ts` (W04) |
| Host mount | `packages/explorer/src/index.tsx:22`; `skill/assets/explorer.html:195` |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-08 | - | F06 | The view opened on a root with nothing under it and said nothing, which read as the feature being broken. Only declared non-unique FKs are eligible, so two thirds of the tables in a typical schema fan out to nothing, and the root defaulted to the first table alphabetically. `defaultFanoutRoot()` now picks the widest-fanning table, `fanoutChildCounts()` annotates every option in the select with its child count, and a root with no children gets an explicit notice naming why. No change to the model, the caps, or the ratio semantics: with row counts unpopulated every ratio is still "Unavailable" and the edges stay structural guides, which A03 addresses. |
| 2026-09-07 | - | D05 | Review fixes: `subtree` depth is rejected, not clamped (`schema_profiler.py:461-462`); `v.mode` dropped (row mode implied by `v.pk`); `onNavigate` targets in contract shape; `is-primary` on the P2 root; API p95 row re-scoped; AC8 tagged to CTQ-02 only. |
| 2026-09-07 | - | D05 | Initial document from the pre-repo baseline. |
