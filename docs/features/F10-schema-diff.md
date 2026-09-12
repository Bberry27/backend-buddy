Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F10 Schema diff

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | view `diff` (`packages/explorer/src/index.tsx:22`; `SchemaDiff.tsx`); host tab `diff` (`skill/assets/explorer.html:22`); planned SPA route `/w/:ws/p/:project/s/:snapshot/diff` (W01); planned snapshot picker against `snapshots` (F16, A04) |
| CTQs | CTQ-02, CTQ-06, CTQ-07, CTQ-10, CTQ-11 |
| Caveats | C04, C09, C15 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

Schema diff compares two SchemaGraph snapshots, A and B, table by table: added, removed, changed, unchanged, with per-detail before / after values, side-by-side DDL for the selected table, and a dialect-aware draft migration from A to B. It answers "what changed between these two snapshots, and what would a migration have to do". It must never be mistaken for a deployment tool: the migration is a draft with explicit `INCOMPLETE` and `DESTRUCTIVE / DATA REVIEW` markers, it is never executed, and a snapshot is a point-in-time document, not the live database.

## 2. Driver

- **Persona**: P3 backend developer (primary), P1 architect, P2 DBA / performance engineer (reviewing destructive changes), P6 licensee security reviewer (verifying no execution path).
- **Job to be done**: "Show me exactly what differs between yesterday's snapshot and today's, flag anything that loses data, and give me a draft I can review, not run."
- **Business metric**: to be validated (D01). Candidate: destructive changes caught before deployment per project.

## 3. Current state

Verified against `packages/explorer/src/SchemaDiff.tsx` (148 lines) and `packages/explorer/src/schema-diff-logic.ts` (479 lines).

**Props and mount**

- `SchemaDiff({ graph, onSelectTable }: ViewProps)` (`SchemaDiff.tsx:55`); `live` and `onSelectTables` are not used. Registered as `diff` (`index.tsx:22`).

**Snapshot loading**

- Side A starts empty; side B defaults to `{ graph, label: 'Current graph' }` (`:56-58`).
- `loadFile(side, file)` (`:78-93`) rejects files over 20 MB before reading (`:84`), parses with `parseSchemaSnapshot(await file.text())` (`:85`), and uses a per-side read token to discard stale reads (`:80`, `:86`). Inputs accept `.json,application/json` (`:117`). "Use current graph as A/B" (`:95-101`, `:119`) and "Swap snapshots A and B" (`:121`) exist.
- `parseSchemaSnapshot(text)` (`schema-diff-logic.ts:39-79`) is the only untrusted-input parser in the view library: nesting depth limited to 32 (`:44`); `tables` and `links` arrays required (`:49`, also accepting a `{ graph: {...} }` wrapper at `:48`); at most 20,000 tables and 100,000 links (`:50`); unique non-empty table ids (`:55`); `allColumns`, `indexes`, `uniques` arrays required (`:57`); string `name` / `schema` and string-array `primaryKey` (`:58-59`); unique named columns with string types and `nullable` in `''|'True'|'False'` (`:63-65`); at most 200,000 columns (`:68`); index columns string arrays (`:71`); links with string endpoints and `kind` in the two allowed values (`:76`). Extra keys are kept as data ("Snapshot text is never evaluated.", `:78`).

**Comparison**

- `compareSchemas(before, after)` (`:137-165`) produces one `TableDiff` per union id with `details` of kinds `table`, `column`, `primary key`, `foreign key`, `index`, `unique` (`:6-14`). Column shapes compare type (via `typeDefinition` when present, `:128-130`), nullability, `default`, `serverDefault` (or `server_default`), `applicationDefault`, pk, indexed, unique, fk, generated flags, and collation as separate fields (`:124-127`), so an application default change is reported as its own field.
- Destructive flags: removed table (`:144`), removed column, type change, or a change to `NOT NULL` (`:153`), table-shape changes other than `definition` (`:147`).
- `unionEdges(before, after)` (`:468-479`) groups links by `[source, target, constraintId || column, kind]` for the union diagram.
- Dialect: `resolveDialect` accepts `postgres|postgresql` and `mysql` (`:82-87`); the view resolves `override || B.project.dialect || A.project.dialect || ''` (`SchemaDiff.tsx:70`) with a select offering Unknown / PostgreSQL / MySQL (`:122`).

**DDL and migration draft**

- `tableDDL(graph, table, dialect)` (`:284-311`) emits `CREATE TABLE` plus `ALTER TABLE ... ADD PRIMARY KEY | UNIQUE`, `CREATE INDEX`, and `ADD FOREIGN KEY` statements; unknown dialects, dialect mismatches, views, unsupported types, unrecorded nullability, generated or identity columns, unsupported defaults, partial or expression indexes, and missing MySQL index names all become `INCOMPLETE:` comments instead of guessed SQL (`SqlBuilder`, `:199-282`).
- `quoteIdentifier` rejects empty identifiers and C0 / DEL control characters and doubles the quote character (`:167-171`); `qualifiedName` refuses a dotted id without separate `name` and `schema` (`:172-175`).
- `migrationDraft(comparison, dialect)` (`:319-465`) orders statements in five phases ("Drop affected foreign keys", "Drop replaced keys and indexes", "Change tables and columns", "Recreate keys and indexes", "Recreate foreign keys", `:458`), withholds every statement for a table that hit a new incomplete issue or an unresolved constraint dependency via a blocked-set fixpoint (`:336-357`, `:445`, `:452-457`), and records destructive items for `DROP TABLE` (`:377`), `DROP COLUMN` (`:402`), new `NOT NULL` columns (`:404`), type changes (`:413`), and `SET NOT NULL` (`:414`). An `applicationDefault` change emits only the comment "applicationDefault changed; no database DDL applies." (`:407`) and by itself does not count as a touched table (`:332`). Type changes never guess a `USING` expression (`:425`).
- Every draft starts with the header `-- DRAFT ONLY - <dialect>; A -> B. No execution is performed.` followed by `-- DESTRUCTIVE / DATA REVIEW:` and `-- INCOMPLETE:` comment lines (`:279`); `statementCount` counts non-comment lines (`:280`).

**Rendering and interactions (`SchemaDiff.tsx`)**

- Legend with counts per status (`:129`), search (`:127`), "Changes only" (`:128`), zoom 40-160 % in 10 % steps (`:64`, `:130`).
- Status colours come from the token layer (C02): `tokens.css` declares `--sd-added`, `--sd-removed` and `--sd-changed` per theme, `SchemaDiff.css:30-33` remaps the one that applies onto `--sd-status` and `--sd-fill`, and the `color-mix` fills at `:1` blend it into `--panel`. `.sd-root` no longer declares the three base values itself, so the light theme gets light values instead of the dark ones.
- `UnionDiagram` (`:18-53`): grid of up to 4 columns (`:23-24`), removed tables hatched (`:31`, `:45`), edges coloured by status and dashed when inferred (`:38`) with a `<title>` showing before / after; nodes are `role="button"` `tabIndex={0}` with Enter / Space (`:43`), `aria-pressed` for the selection, and a `<title>` summarising up to 12 details and 5 before / after values truncated to 500 characters (`:15`, `:44`).
- Inspector (`:134-145`): table select listing every diff row (`:136`); "Inspect table in schema explorer" calling `onSelectTable(active.id)` (`:137`); a `role="tablist"` with arrow-key navigation over "DDL A / B", "Changes (n)", "Migration draft" (`:139`); DDL panes as labelled `<pre>` (`:141`); changes as `<details>` per detail with a "Data review" marker for destructive ones (`:142`); migration status `role="status"` "Incomplete / N unresolved items" or "Draft ready for review" plus destructive and statement counts, and the SQL (`:143`).
- Export: "Export draft" with title "Export draft migration SQL; no execution" (`:123`) downloads `schema-diff-A-to-B-<dialect|unknown>-DRAFT.sql` (`:102-110`).

**Known limitations**

- Side B is host-filtered: the host passes `graph: {...data, tables}` where `tables = scoped()` applies the global search, domain, and entity-type filters (`skill/assets/explorer.html:195`, `:60`, called from `render()` at `:178`). "Current graph" (`SchemaDiff.tsx:58`) therefore silently reflects host filters while an imported A does not, so filtered-out tables appear as "A only" (removed).
- "Inspect table in schema explorer" is disabled unless the id exists in the host graph (`:137`), so removed tables and tables present only in an imported snapshot, the most interesting rows, cannot be inspected.
- Loaded snapshots, dialect, tab, zoom, and selection are lost whenever the host remounts the view: every filter keystroke (`explorer.html:68`) and every tab switch (`:178`).
- No inbound selection; `selected` is local (`:61`) and defaults to the first changed table (`:71`).
- Union edges are not clickable or focusable (`:38`); relationship changes are reachable only through the Changes tab.
- Only PostgreSQL and MySQL drafts exist; SQLite (an MVP dialect, D6) yields "unsupported dialect" (`schema-diff-logic.ts:82-87`, `:286`, `:321`).
- The union diagram is bespoke SVG and shares no renderer with the Living ERD (noted in `docs/architecture/legacy-handoff.md`).

## 4. Intended behaviour

### MVP

- **B1** Side B is the unfiltered snapshot: the host or `ViewHost` passes `fullGraph` (C03 additive prop) and the diff uses it for "Current graph", with host filters applied only to the diagram's search, never to what is compared.
- **B2** Snapshot picker: A and B can be chosen from the project's stored snapshots (F16) as well as from files; each side shows provenance (`origin`, `source.basis`, sha256, label) per C09.
- **B3** Honour inbound `selected.tableId`: select the diff row, mark the union node `data-selected="true"` and `is-selected`, and scroll it into view once per selection change.
- **B4** Outbound P7: a changed table offers "Open in Column Table" (`t`) and "Inspect" (`onSelectTable`); a removed table offers "Inspect in before-snapshot", which writes `t` and `v.side=a` (`docs/architecture/drill-through-contract.md` section 6, row P7) and opens the Inspector on snapshot A with a read-only banner "Viewing snapshot A (removed in B)". The inspect button is never disabled because a table is absent from B.
- **B5** Relationship changes emit `onSelectRelationship(ref)` from the Changes tab (`foreign key` details) and from clickable union edges.
- **B6** No execution path (CTQ-06, C04): the draft is text only; a static lint proves no import path exists from `migrationDraft` or `tableDDL` to any connection module, and no API endpoint accepts SQL. The header, destructive, and incomplete lines keep their exact wording from `caveat-strings.ts`.
- **B7** SQLite dialect support in `tableDDL` and `migrationDraft` limited to what SQLite can express, with `INCOMPLETE:` comments for the rest (matches D6 MVP dialects).
- **B8** Survive filter keystrokes without remount (C03): loaded snapshots, dialect override, tab, zoom, and selection persist across 20 keystrokes.
- **B9** Every comparison and export shows the C09 provenance line for both snapshots and the C15 note when an `applicationDefault` differs.

### Later

- **B10** Server-side diff between two stored snapshots as an `export` job variant producing the draft as an attachment with audit (A04 follow-up).
- **B11** Union diagram rendered by the Living ERD engine (removes the bespoke SVG; L-05 era).
- **B12** MySQL / MariaDB driver conformance for the draft (L-03).

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005). Registry entries P1-P10 live in `packages/explorer/src/navigation.ts` after C03.

### Inbound

No registry entry P1-P10 targets the diff at MVP. The view honours `selected.tableId` (B3) and `v.side` when routed directly. The F16 snapshot page deep-linking two stored snapshots (`.../diff?v.a=<snapshotId>&v.b=<snapshotId>`, B2) depends on the proposed `v.a` / `v.b` additions under "URL state" below and is blocked until the contract allowlist changes (section 13 Q6).

### Outbound

- `onSelectTable(id)` from "Inspect table in schema explorer" (`SchemaDiff.tsx:137`) - exists today, but disabled for removed and imported-only tables.
- P7: changed table -> Column Table (`onNavigate({ view: 'columns', selection: { tableId }, reason: 'P7' })`) and Inspector; removed table -> Inspector on the before-snapshot (`t`, `v.side=a`) with a read-only banner - B4.
- `onSelectRelationship(ref)` from foreign-key details and union edges - B5.
- Rule: a drill-through may prefill a live query but never runs it without a click. This view runs no live query at all; it never opens a connection (C04, CTQ-06).

### URL state

- Reads and writes shared keys `t`, `q` (diagram search).
- View-local keys, per the `diff` allowlist frozen in `docs/architecture/drill-through-contract.md` (section 4): `v.dialect` (`postgresql|mysql`, the dialect override select at `SchemaDiff.tsx:122`) and `v.side` (`a|b`: which snapshot an Inspector opened from this view shows; P7 writes `v.side=a` for a removed table). Values capped at 200 characters.
- Proposed additions, not yet allowlisted. Each needs a change to the contract table (`docs/architecture/drill-through-contract.md`, section 4, "Allowlisted `v.*` names") and to the `navigation.ts` registry in the same PR as the view change: `sqlite` as a third `v.dialect` value (B7; an MVP dialect per D6 that the contract row does not list yet), and `v.a` / `v.b` (stored snapshot ids for the F16 picker, B2). Until those PRs land, B2 deep links and a SQLite override in the URL are blocked (section 13 Q6).
- Deliberately not in the URL: the active inspector tab, the "Changes only" toggle, zoom, hover, and diff snapshots loaded from files; these live in the `viewState` slice keyed by graph fingerprint (the earlier `v.tab` and `v.changed` proposals are withdrawn).

## 6. Data contract dependencies

| Field | Required | When absent |
|---|---|---|
| `tables[].id`, `name`, `schema` | `id` required | label falls back to id (`schema-diff-logic.ts:88`); dotted id without `name`/`schema` cannot be quoted (`:173`) |
| `tables[].allColumns[].{name,type,nullable,pk,fk,index,unique}` | required | unrecorded nullability omits column DDL (`:218`) |
| `tables[].allColumns[].{typeDefinition,default,serverDefault,server_default,applicationDefault,generated,computed,identity,autoIncrement,collation}` | optional | compared when present (`:124-127`); generated/identity/collation force manual DDL (`:220`) |
| `tables[].primaryKey`, `primaryKeyName` / `primaryKeyConstraintName` / `pkConstraintName` | optional | composite PK without ordered `primaryKey` is incomplete (`:231`); PostgreSQL PK drop needs a name (`:347-349`) |
| `tables[].indexes[]`, `uniques[]` (+ `where`, `predicate`, `include`, `method`, `orders`, `lengths`) | required arrays | options make the index incomplete (`:239`) |
| `tables[].kind` / `tableKind` / `type`, `definition` / `viewDefinition` / `view_definition`, `checks` / `checkConstraints` | optional | views shown as source text only (`:293-297`); checks never reconstructed (`:269`) |
| `links[].{source,target,column,targetColumn,kind,constraintId,name,onDelete/ondelete,onUpdate,deferrable,initiallyDeferred}` | endpoints and `kind` required | FK without a name cannot be dropped, dependent edits withheld (`:338-341`) |
| `project.dialect` | optional | "Unknown" dialect: no SQL generated (`:286`, `:321`) |
| `source.*`, `origin`, sha256 | optional | provenance line "not recorded" (B2, B9) |

`LiveConnection` methods used: none. The view must never receive or use a connection (CTQ-06).

## 7. Caveats

> C04: "Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf."
> Shown: export button title "Export draft migration SQL; no execution" (`SchemaDiff.tsx:123`); SQL header "DRAFT ONLY - <dialect>; A -> B. No execution is performed." (`schema-diff-logic.ts:279`); filename suffix `-DRAFT.sql` (`SchemaDiff.tsx:107`); status "Draft ready for review" (`:143`); tab label "Migration draft" (`:139`).

> C09: "A source checkout, ORM model, or stored snapshot documents a schema at one point in time. It is not proof of the live database schema. "Declared" means declared in the identified evidence source, not verified against a live catalog, unless the snapshot's provenance says so."
> Shown: today only the side labels (file name or "Current graph", `:116`). MVP (B2, B9): provenance line per side and in the export header.

> C15: "An application-level default (an ORM or code default) is not a SQL default. The two are shown separately, an application default is never emitted as DDL, and a code function is never emitted as executable migration SQL."
> Shown: `default`, `serverDefault`, `applicationDefault` compared as separate fields (`schema-diff-logic.ts:124-127`) and listed in the Changes tab; migration comment "applicationDefault changed; no database DDL applies." (`:407`); `defaultSql` refuses arbitrary expressions and ORM callables (`:185-196`).

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the host search filters the graph to 3 tables, when the diff compares an imported A against "Current graph", then B contains every table of the snapshot and no table is reported "A only" because of the filter.
- **AC2** (B4, CTQ-10) Given a table present in A and absent in B, when "Inspect in before-snapshot" is chosen, then the URL carries `t=<id>&v.side=a`, the Inspector opens on snapshot A with the read-only banner, and `onSelectTable` is called with the id.
- **AC3** (B4, CTQ-10) Given a changed table, when "Open in Column Table" is chosen, then the route becomes `.../columns?t=<id>`.
- **AC4** (B6, CTQ-06) Given the repository, when the static lint runs, then no module reachable from `schema-diff-logic.ts` imports a driver, fetch, or connection module, and the API test proves no endpoint accepts arbitrary SQL.
- **AC5** (B6, CTQ-07) Given the hostile fixture (view definition containing `DROP TABLE`, an `instructions` field, markup in names) is loaded as A, then it renders as text, no dialog opens, the definition appears only inside a `--` comment, and no DOM node is injected.
- **AC6** (B6, CTQ-07) Given a 21 MB file, when chosen, then the error "Snapshot exceeds the 20 MB limit." is shown and no parse is attempted; given 33 levels of nesting, then "Snapshot nesting exceeds 32 levels.".
- **AC7** (B9, CTQ-06) Given a column whose `applicationDefault` changed and nothing else, then the migration contains the comment at `schema-diff-logic.ts:407`, zero statements for that table, and the table is not in the touched set.
- **AC8** (B8, CTQ-10) Given A and B loaded from files and the "Changes" tab open, when 20 host filter keystrokes are typed, then `window.__backend-buddyMounts` is unchanged and both snapshots remain loaded.
- **AC9** (B3, CTQ-11) Given keyboard-only use, when Tab reaches a union node and Enter is pressed, then the inspector selects that table and the tablist is operable with arrow keys.
- **AC10** (B7, CTQ-06) Given `project.dialect: 'sqlite'`, then `tableDDL` produces a SQLite `CREATE TABLE` where expressible and `INCOMPLETE:` comments otherwise, never PostgreSQL syntax.
- **AC11** (CTQ-02; responsive matrix, no behaviour tag) Given 390 px width, then the union diagram scrolls inside `.sd-graph-scroll` and the body does not scroll horizontally.

## 9. Test expectations

- Unit (node:test): `schema-diff-logic.test.ts` (21 tests today, the de-facto specification of `parseSchemaSnapshot`, `compareSchemas`, `tableDDL`, `migrationDraft`); add `F10` cases for SQLite (B7), the provenance header (B9), and blocked-set behaviour with unnamed FKs.
- Component (Vitest, `packages/web`): `F10` tests that `fullGraph` is used for B, that removed tables keep an enabled inspect action, and that loaded snapshots survive a prop change with the same fingerprint.
- E2E: `tests/e2e/views/diff.spec.ts` (from `schema-diff-browser.test.ts`, which self-skips today without `SCHEMA_DIFF_PLAYWRIGHT_PATH`; S02 removes the skip and `msedge` and keeps its hostile fixture assertions); `tests/e2e/drill-through.spec.ts` rows for P7.
- A11y: axe on `diff` route x 2 themes x 1366/390; keyboard journey "choose A, Tab to node, Enter, arrow to Migration draft".
- Security (`tests/security`): hostile fixture through the diff (no dialog, no injected nodes, definition inert); upload abuse (size, nesting, counts); static lint for CTQ-06; bundle grep.
- Perf: `compareSchemas(large, large')` and `migrationDraft` within the view TTI budget; parse of a 20 MB fixture bounded (baseline in Q01).
- Fixtures: `medium` versus a generated `medium-changed` variant (R01 should add one: renamed column, type change, dropped table, added FK, `applicationDefault` change), `hostile`, `edge-cases` (composite PK without name, partial index, view).

## 10. Security and privacy

- Inputs: two JSON files (the only file upload in the view library) validated by `parseSchemaSnapshot` (`schema-diff-logic.ts:39-79`) after a 20 MB size check (`SchemaDiff.tsx:84`); the dialect select; search text. Nothing is evaluated; extra keys are data (`:78`).
- Renders from untrusted data: table and column names, types, definitions, and JSON values, all as React text nodes or `<title>` text; DDL identifiers pass `quoteIdentifier` (`:167-171`), and values in `defaultSql` are restricted to literals and a fixed keyword set (`:185-196`).
- Draft SQL is the highest-risk artefact: it emits `DROP TABLE`, `DROP COLUMN`, `ALTER TYPE`, `SET NOT NULL`. Controls: `DRAFT ONLY` header, destructive and incomplete markers, download only (`SchemaDiff.tsx:102-110`), no connection in scope, CTQ-06 static lint and API test (B6).
- Storage: none today; MVP `viewState` for loaded snapshots (C13), stored snapshots server-side (F16).
- Export: text download of the draft; the MVP artifact and snapshot exports strip `sampleValues` and string min/max by default (A04) - the draft contains no data values other than defaults.
- CTQ-07 checks: hostile-render e2e, upload-abuse tests, CSP-violation e2e (no inline handlers or data URLs beyond the Blob download).

## 11. Performance budget

| Budget or cap | Value | Source |
|---|---|---|
| View TTI on medium fixture | <= 1.5 s | limits B (Q01) |
| Snapshot file size | 20 MB | `SchemaDiff.tsx:84` |
| Nesting depth | 32 | `schema-diff-logic.ts:44` |
| Tables / links | 20,000 / 100,000 | `schema-diff-logic.ts:50` |
| Columns | 200,000 | `schema-diff-logic.ts:68` |
| Zoom | 0.4..1.6 | `SchemaDiff.tsx:130` |
| Tooltip detail | 12 details, 5 before/after pairs, 500 chars each | `SchemaDiff.tsx:15`, `:44` |
| Label truncation | 31 chars | `SchemaDiff.tsx:11` |
| Diagram grid | up to 4 columns, 260 x 112 cells | `SchemaDiff.tsx:23-24` |

## 12. Accessibility

- Roles and names: file inputs and buttons carry `aria-label` (`:117-121`, `:130`); legend `aria-label` (`:129`); union SVG `role="group"` with a count in its name (`:30`); nodes `role="button"`, `tabIndex={0}`, `aria-pressed`, Enter / Space (`:43`); inspector `section[aria-label]` (`:134`); table select `aria-label` (`:136`); `role="tablist"` with `aria-selected`, roving `tabIndex`, and ArrowLeft / ArrowRight (`:139`); `role="tabpanel"` with `aria-labelledby` (`:140`); `<pre>` blocks labelled (`:141`, `:143`); errors `role="alert"` (`:125`); migration status `role="status"` (`:143`).
- Colour independence: removed tables are hatched as well as coloured (`:31`, `:45`); status text appears on every node (`:48`) and in the legend; inferred edges are dashed (`:38`). That redundancy is why C02 holds the three status colours to 10 CIEDE2000 rather than the 11 it asks of a free categorical palette: added, removed and changed have to stay green, red and amber, and a red-green dichromat separates them by lightness plus the hatch.
- Keyboard gaps: union edges are not focusable (`:38`) - the Changes tab is the keyboard route to relationship details; B5 adds focusable edges.
- Motion: none.
- Text alternative: the inspector select lists every diff row with its status (`:136`); the Changes tab is a full textual diff.
- Axe coverage: `diff` route x 2 themes x 1366/390 (CTQ-11).

## 13. Open questions

1. Should the diff compare against the host-filtered graph ever be allowed (as an explicit "compare visible subset" toggle), or is B1's unfiltered B the only mode? Owner: Product owner. Gate: G0.
2. SQLite draft scope (B7): SQLite lacks `ALTER COLUMN`; is a table-rebuild recipe emitted as `INCOMPLETE:` guidance or omitted? Owner: Backend lead. Gate: G1.
3. Where does the "Inspector on the before-snapshot" (P7) get its graph in the SPA: a second snapshot fetch by id, or the loaded A object? Owner: Frontend lead (W02). Gate: G1.
4. Does the migration draft belong in the `export` job with audit (CTQ-16) at MVP, or stay client-side until B10? Owner: Backend lead. Gate: G0.
5. R01 fixture: the plan's fixture list has no "changed" counterpart for `medium.json`; F10 tests need one. Owner: Platform lead. Gate: G1.
6. Contract change request: the `diff` allowlist in `docs/architecture/drill-through-contract.md` section 4 lists `dialect` as `postgresql`/`mysql` and has no snapshot-id keys. B7 needs `sqlite` (D6 MVP dialect) and B2 needs `v.a` / `v.b`. Raise the change against the contract table and `navigation.ts` before W04; until it lands, B2 deep links are blocked and the SQLite override stays out of the URL. Owner: Frontend lead (C03). Gate: G1.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| View | `packages/explorer/src/SchemaDiff.tsx` |
| Logic | `packages/explorer/src/schema-diff-logic.ts` (`parseSchemaSnapshot`, `compareSchemas`, `tableDDL`, `migrationDraft`, `unionEdges`, `quoteIdentifier`, `qualifiedName`) |
| Styles | `packages/explorer/src/SchemaDiff.css` (the `--sd-status` / `--sd-fill` remap at `:30-33`) |
| Tokens | `packages/explorer/src/tokens.css` `--sd-added`, `--sd-removed`, `--sd-changed`; `DIFF_STATUS_COLORS` in `palettes.ts` (C02) |
| Contract | `packages/explorer/src/types.ts`; `schema-graph.v1.json` (C01 promotes `kind:'view'`, `checks`, `definition`) |
| Fixtures | `fixtures/sql/{sqlite,pg}/seed.sql` generated via `schema-diff-logic.tableDDL` (R01) |
| Navigation | `packages/explorer/src/navigation.ts` (P7 outbound) after C03 |
| Tests | `packages/explorer/src/schema-diff-logic.test.ts`; `packages/explorer/src/schema-diff-browser.test.ts` (legacy, converted by S02, hostile fixture retained); `tests/security` (CTQ-06 lint, upload abuse); `tests/e2e/drill-through.spec.ts` (W04) |
| Host mount | `packages/explorer/src/index.tsx:22`; `skill/assets/explorer.html:195` (passes the filtered `tables`) |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-08 | - | C02 | The three status colours moved from `SchemaDiff.css:1` to `tokens.css` with a value per theme; the `--sd-status` / `--sd-fill` remap at `:30-33` and the `color-mix` fills are unchanged. In light mode the trio is now lightness-separated as well as hue-separated, so `.sd-risk` text clears 4.5:1 and the three statuses stay 10 CIEDE2000 apart under deuteranopia and protanopia. |
| 2026-09-07 | - | D05 | Review fixes: `v.side` added (B4, AC2, P7 path); `v.a`/`v.b` and `sqlite` filed as contract-change proposals (Q6); `v.tab`/`v.changed` withdrawn; `onNavigate` target in contract shape; AC11 tagged to CTQ-02 only. |
| 2026-09-07 | - | D05 | Initial document from the pre-repo baseline. |
