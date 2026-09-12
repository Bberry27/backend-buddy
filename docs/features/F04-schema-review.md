Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# F04 Schema review

| Field | Value |
|---|---|
| Status | existing |
| Owner | Frontend lead |
| Surfaces | host view `review` (`skill/assets/explorer.html`, tab `#tab-review` at `:22`, findings engine `buildFindings` at `:102-125`, renderer `renderReview` at `:128-133`, finding detail `findingDetail` at `:127`, validation SQL generators `:97-101`); planned React `ReviewView` with `review-logic.ts` registered under `review` (W03); planned SPA route `/w/:ws/p/:project/s/:snapshot/review` (W01); planned API `PUT/GET /reviews/{findingId}` (A04) |
| CTQs | CTQ-02, CTQ-06, CTQ-10, CTQ-11, CTQ-16 |
| Caveats | C04, C07, C08, C13 |
| Last verified | pre-repo (2026-09-07) |

## 1. Purpose

Schema review runs a fixed set of structural rules over the snapshot and lists the resulting review candidates in three categories (Normalization, Integrity, Index coverage), each with the affected columns, observable evidence, what to check next, an optional read-only validation SQL draft, and a reviewer's decision. A user answers "what in this schema deserves a second look, and what have we already decided about it". Findings are candidates, not verdicts; the SQL is a draft the product never executes; and decisions stored in the browser are convenience state, not the team's review record.

## 2. Driver

- **Persona**: P1 architect and P2 DBA/performance engineer (primary), P5 engineering manager (decision tracking), P3 backend developer (definitions in `docs/business/business-case.md`, D01).
- **Job to be done**: "Give me an evidence-backed list of things to check in this schema, let me record what we decided, and hand me a query I can review before running it myself."
- **Business metric**: to be validated (business case D01 in progress). Candidate: share of findings with a recorded decision after a review session.

## 3. Current state

Verified against `skill/assets/explorer.html` and `skill/scripts/build_explorer.py`.

**Findings engine**

- `buildFindings()` at `explorer.html:102-125` runs once at module load (`const findings=buildFindings()` at `:126`) over `data.tables`. Each call to `add()` (`:104`) records `{id, table, rule, category, columns, evidence, next, sql, confidence}`. `confidence` defaults to `Review candidate` and is never overridden anywhere in the file.
- Finding id (`:104`): `[t.id, rule, names.join(','), signature].join('|')` where `signature = JSON.stringify({columns: <the named columns>, links: outgoing(t), indexes: t.indexes, uniques: t.uniques})`. Because the signature embeds all outgoing links of the table, any relationship change on the table changes the ids of all its findings and detaches their decisions.
- Rules as implemented (eight `add()` call sites; the approved plan and `skill/references/review-and-updates.md:7-15` describe seven, see open question 1):

| # | Rule (`rule` string) | Category | Trigger | Line | SQL draft |
|---|---|---|---|---|---|
| 1 | `Primary key not recorded` | Integrity | no `pk` column (`pk(t)` at `:42`) | `:106` | none |
| 2 | `Repeating numbered fields` | Normalization | two or more columns share the stem after removing a trailing number, regex `/^(.*?)(?:_)?([1-9][0-9]*)(.*)$/` | `:107-108` | `SELECT <cols> FROM <table> LIMIT 100` |
| 3 | `Structured payloads` | Normalization | column type matches `/JSON|ARRAY/i` or name ends `_json` | `:109-110` | `SELECT jsonb_typeof(<col>::jsonb) ... GROUP BY 1` when the first column type contains `JSON` |
| 4 | `Relationship pair uniqueness` | Normalization | `type === 'Association / detail'`, two or more declared-FK columns, no unique group contained in them | `:111-113` | `duplicates()` (`:100`) |
| 5 | `Unconstrained reference candidate` | Integrity | link `kind !== 'declared FK'` | `:116` | `orphanSQL(l)` (`:101`) only when the target column exists and types match |
| 6 | `FK index coverage` | Index coverage | declared FK column not `indexed()` (`:44`) | `:117` | none |
| 7 | `Relationship type mismatch` | Integrity | declared FK, column type differs from target column type | `:118` | none |
| 8 | `Possible copied attributes` | Normalization | for an `<stem>_id` FK column, sibling columns `<stem>_{name,email,code,description}` whose base name (`name`, `email`, ...) or full name (`<stem>_name`, ...) exists on the target table (`tc.name===s` or `tc.name===x.name` at `:120`) | `:119-121` | none |

- Result order: category, table, rule (`:124`).

**Validation SQL**

- `quote(s)` at `:97` doubles embedded double quotes; `tableSQL(id)` at `:98` emits `"schema"."name"` from the table's `schema` and `name` fields (falling back to `quote(id)` for unknown ids); `readonly(sql)` at `:99` wraps SQL for `postgresql` (`BEGIN READ ONLY; SET LOCAL statement_timeout = '10s'; ... ROLLBACK;` with the comment `-- Verify candidate semantics before running.`) or `sqlite` (`BEGIN; ... ROLLBACK;` with `-- Read-only SELECT diagnostic; run against the intended database.`) and returns an empty string for any other dialect, so unknown dialects get no SQL.
- `duplicates()` (`:100`) and `orphanSQL()` (`:101`) use `tableSQL`; `orphanSQL` combines all pairs sharing a `constraintId` into one `NOT EXISTS` predicate and returns nothing when a composite group has any member whose `nullable !== 'False'` (`skill/references/schema-contract.md:53`). It is only generated when the target column exists and its type matches the source column (`:116`), so an unresolved inferred target never yields a query (C07).
- The detail panel (`findingDetail` at `:127`) shows the SQL in a `<pre>` with the text `Generated for <dialect>. Nothing is executed here.` and a `Copy SQL` button (`copySQL` at `:183`: clipboard write, or select the text when the clipboard is unavailable). There is no control anywhere that runs SQL and the artifact CSP has `connect-src 'none'` (`:6`).

**Rendering and filters**

- `renderReview(tables)` at `:128-133`. Rows = findings whose table is in the filtered set and match the search (table id, class name, domain, columns, evidence at `:129`), the category select (`Normalization | Integrity | Index coverage`, default `Normalization` at `:37`), the rule select (all distinct rule strings), and the decision select (`open | investigate | intentional | resolved`, default `open`).
- Notice text at `:130`: `Schema evidence only. Confirm functional dependencies and business rules before restructuring. Integrity and index checks are separate from normalization.`
- Table columns (`:130`): `Entity / columns`, `Candidate / category`, `Evidence`, `Decision`, `Review` (an `Inspect` button per row). `Inspect` (`:131`) sets `state.selected` to the table and `state.finding` to the finding, opens the inspector, and renders `findingDetail` inside the entity inspector under the title `Review evidence` (`:76`).
- `findingDetail` (`:127`) shows: the notice `<confidence>. Structural heuristics do not prove a normal-form violation or a functional dependency.`, rule and category, evidence, `Review next` text, the `Review decision` select, and the SQL section when present.

**Decisions**

- `reviews` is read at load from `localStorage` key `backend-buddy:<project.key>:reviews` (`:39-40`, `readStored` `:35`) as a map of finding id to decision. The decision select change handler (`:79`) writes it back with `save()` (`:36`) and shows the toast `Browser storage unavailable; review state is temporary` when storage fails, then re-renders.
- Decisions are never garbage-collected; ids orphaned by signature changes remain in storage.

**Export**

- `exportRows` (`:132`): `table columns category rule evidence review_next decision validation_sql`; downloaded as CSV by the header export button (`:180`).

**Defects and gaps (current state)**

- SQL bug 1 (`:108`, rule 2): `FROM ${quote(t.id)}` uses the display id instead of `tableSQL(t.id)`. For `id 'public.items'` this emits `"public.items"` (one identifier containing a dot) rather than `"public"."items"`, contradicting `skill/references/schema-contract.md:32` ("do not split identifiers on dots in SQL generation"; the qualified form is `tableSQL`).
- SQL bug 2 (`:110`, rule 3): same `quote(t.id)` defect, and `jsonb_typeof(...)::jsonb` is PostgreSQL-only but is emitted whenever the column type contains `JSON`, without a dialect gate; on a `sqlite` project `readonly()` wraps it in the SQLite transaction form, producing a statement SQLite cannot parse.
- Both drafts are marked read-only and never executed (C04), so the defects are wrong references a reviewer might copy, not injections: `quote()` doubles quotes, so no break-out is possible.
- Crash path: `structured[0].type.toUpperCase()` at `:110` throws when a column `type` is not a string (`normalize()` only `setdefault`s `type` at `build_explorer.py:46`); because `buildFindings()` runs at top level (`:126`) the whole page fails to initialise. S01 adds `_text` validators.
- Finding ids are long (they embed serialized JSON) and change when unrelated links change (see engine notes); A04 requires an opaque, length-capped id validated against the loaded graph.
- Findings are computed once at load (`:126`); after a live `profile()` replaces `data.tables` (`:189`) they are stale.
- Findings are computed from `data.tables` (all tables) and filtered by `ids` at `:129`, so filters never change the findings themselves, which is correct; but every filter keystroke still rebuilds the whole view (`:68`, `:178`).
- The C08 notice at `:127` and the C04 texts at `:99` and `:127` are paraphrases; MVP uses canonical strings.
- Export button hidden at widths <= 700 px (`:14`).

## 4. Intended behaviour

### MVP

- **B1** `review-logic.ts` (pure, `packages/explorer/src`) implements the rules with the same rule strings, categories, evidence text, next text, and ordering as `buildFindings`; a parity test asserts identical `{table, rule, columns, category}` sets against the inline engine on the medium fixture before the inline code is deleted (W03).
- **B2** SQL drafts use `schema-diff-logic.quoteIdentifier` / `qualifiedName` (`packages/explorer/src/schema-diff-logic.ts:167`, `:172`) for every table reference (fixes `:108` and `:110`), and rule 3 emits `jsonb_typeof` for `postgresql`, `json_type` for `sqlite`, and no SQL with an explicit message for any other dialect (S01 in the host, mirrored in `review-logic.ts`). Every draft keeps the read-only wrapper and the "nothing is executed" label (C04, CTQ-06).
- **B3** Finding id: stable, opaque, length-capped; derived from the rule and the evidence the rule actually depends on rather than all outgoing links; a change in relevant evidence reopens the finding (`skill/references/schema-contract.md:59`). L-06 later moves to sha256 signatures with TS/Python parity. The exact cap is set in A04 and recorded in `docs/reference/limits-and-caps.md`.
- **B4** `ReviewView` (React) replaces `renderReview`; filters (category, rule, decision, search) are URL state (`v.category`, `v.rule`, `v.status`, shared `q`; section 5); no remount on filter change (CTQ-10).
- **B5** Decisions: `decisions.ts` adapters (W02): localStorage adapter with today's key family for the offline artifact (C13), API adapter `PUT/GET /reviews/{findingId}` for the SPA (A04) with an audit row per change (CTQ-16). The UI states which store it is writing to.
- **B6** Inbound selection: `f=<findingId>` opens the finding in the inspector; `t` filters the list to that table's findings (P1 "Review (findings of t)").
- **B7** Outbound (P8): finding -> Column Table (finding columns), Living ERD (the relationship for FK findings), Fan-out (orphan candidates, prefilled root only); `onSelectTable` on table links. No drill-through runs a query.
- **B8** Canonical caveat strings from `caveat-strings.ts` for C04 (SQL section), C08 (finding notice and list notice), C13 (decision store note).
- **B9** Static lint proves no code path from `validationSql` or `migrationDraft` to any connection (CTQ-06); the `Copy SQL` button stays the only affordance.
- **B10** CSV export via `csv.ts` with the S01 guard; `validation_sql` cells are guarded like any other; export reachable at 390 px.
- **B11** Robustness: non-string field types cannot crash the engine (S01 validators in `normalize()`; defensive `String()` in `review-logic.ts`); `hostile` and `edge-cases` fixtures produce findings without error.

### Later

- **B20** Insights v0 (F18, W06) aggregates review findings with other signals; F04 remains the per-finding detail surface.
- **B21** sha256 finding signatures with Python parity (L-06).
- **B22** Rule confidence gradation (today constant `Review candidate`); requires a product decision (open question 4).

## 5. Drill-through contract

Reference: `docs/architecture/drill-through-contract.md` (ADR-0005, D02). Registry entries P1 (Inspector -> Review (findings of t)) and P8 (Review finding -> Column Table, Living ERD, Fan-out) in `packages/explorer/src/navigation.ts` after C03.

### Inbound

- `f` (finding id): open the finding detail in the inspector, highlight the row (`data-selected="true"`, `is-selected`), scroll once.
- `t`: filter the list to that table's findings and highlight its rows.
- `c`: highlight findings that name that column.

### Outbound

- `onSelectTable(id)` on table links (today `wireRefs`, `:131`).
- `onNavigate` targets per P8: Column Table with `t` and `c` (finding columns), Living ERD with `r` for FK findings (rules 5, 6, 7), Fan-out with `t` as root for rule 5 (orphan candidates).
- Rule: a drill-through may prefill a live query but never runs it without a click. The Fan-out target is prefilled only; the user clicks Run there. The validation SQL draft is never executed by any target.

### URL state

- Shared keys: `t`, `c`, `f`, `q d k`.
- View-local: `v.category` (`normalization | integrity | index`), `v.rule` (rule slug, allowlisted from the rule table), `v.status` (the decision filter: `open | investigate | intentional | resolved | all`). These are the `review` allowlist names in `docs/architecture/drill-through-contract.md` section 4 (`rule`, `category`, `status`); adding or renaming one needs a registry change and an update to this section in the same PR.
- Not in the URL: decisions themselves (storage or API), scroll position (`viewState`).

## 6. Data contract dependencies

| Field | Required | Behaviour when absent |
|---|---|---|
| `tables[].allColumns[]` with `name`, `type`, `pk`, `nullable`, `fk` | yes | rules 1-3, 5-8 |
| `tables[].type` | yes (`Unclassified` default) | rule 4 applies only to `Association / detail` |
| `tables[].indexes[]`, `uniques[]`, `primaryKey` | yes | rules 4 and 6 (`uniqueGroups`, `indexed` at `:43-44`) |
| `tables[].schema`, `name` | optional (`''` and `id` defaults at `build_explorer.py:37`) | `tableSQL` falls back to the quoted id |
| `links[]` with `kind`, `constraintId`, `column`, `targetColumn` | yes | rules 5-8 and `orphanSQL` composite handling |
| `project.dialect` | yes (`unknown` default at `:26`) | no SQL emitted for unknown dialects |
| `project.key` | yes | decision storage key (C13) |

No `LiveConnection` method is used. Findings do not use `rowCount` or `profiling`.

## 7. Caveats

> C04: "Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf."
> Shown: SQL section header and label in the finding detail (today `Read-only validation SQL` and `Generated for <dialect>. Nothing is executed here.` at `:127`; MVP canonical text), the SQL comment lines from `readonly()` (`:99`), the CSV `validation_sql` column.

> C07: "Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query."
> Shown: rule 5 evidence text `... by naming only` and `target column is not in the parsed model` (`:116`); `orphanSQL` omitted when the target column is missing or types differ (`:116`).

> C08: "Heuristic findings are review candidates, not verdicts. Each finding names its columns, its observable evidence, why it might matter, and what would confirm or dismiss it. A structural heuristic does not prove a normal-form violation, a functional dependency, or a design defect."
> Shown: list notice (`:130`), finding notice (`:127`), `confidence` value `Review candidate` (`:104`), and the `evidence` / `Review next` fields of every finding; MVP canonical text.

> C13: "Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state."
> Shown: decision store note next to the `Review decision` select (MVP, B5); storage-failure toast (`:79`). Key family `backend-buddy:<project.key>:reviews` (`:39`).

## 8. Acceptance criteria

- **AC1** (B1, CTQ-10) Given the medium fixture, When `review-logic.buildFindings` and the inline `buildFindings` both run, Then the multisets of `{table, rule, columns, category}` are identical.
- **AC2** (B2, CTQ-06) Given a table with `schema 'public'` and `name 'items'`, When rule 2 or 3 emits SQL, Then the table reference is `"public"."items"`; Given `dialect 'sqlite'`, Then rule 3 uses `json_type`; Given `dialect 'unknown'`, Then no SQL is emitted and the detail shows an explicit message.
- **AC3** (B9, CTQ-06) Given the repository, When the static lint runs, Then no import path connects `review-logic.ts` output or `migrationDraft` to any fetch, `LiveConnection` method, or API client; Given the API, When any endpoint receives SQL text, Then it is rejected.
- **AC4** (B5, CTQ-16) Given a signed-in reviewer, When a decision changes, Then `PUT /reviews/{findingId}` succeeds, an audit row is written, and the same id is returned by `GET`; Given a finding id longer than the cap or not present in the loaded graph, Then the API responds 4xx.
- **AC5** (B3, CTQ-16) Given a finding with decision `intentional`, When an unrelated link on another column of the same table changes, Then the finding id is unchanged and the decision persists; When a column named by the finding changes type, Then the id changes and the finding is `open`.
- **AC6** (B4, CTQ-10) Given the view mounted, When 20 characters are typed into the search box, Then `__backend-buddyMounts` is unchanged.
- **AC7** (B6, B7, CTQ-10) Given `?f=<id>`, When the route loads, Then the finding is open in the inspector; When "Open in Fan-out" is chosen for a rule-5 finding, Then Fan-out shows the root table prefilled and no `/api/subtree` request occurs before Run.
- **AC8** (B11, CTQ-07) Given the `hostile` fixture (including a non-string column `type`), When findings are built and rendered, Then no exception, no dialog, and no injected element occurs; CSV `validation_sql` cells are guarded.
- **AC9** (B4, CTQ-02, CTQ-11) Given 1920, 1366, and 390 px in both themes, When rendered, Then no horizontal page scroll and zero serious or critical axe findings.

## 9. Test expectations

- Unit (node:test): `review-logic.test.ts` (each rule positive and negative; parity test on `fixtures/schemas/medium.json`; SQL for postgresql, sqlite, unknown; composite `orphanSQL` omitted when a member is nullable; id stability). Prefix `F04`.
- Renderer (Python unittest, `skill/scripts/test_renderer_security.py`, S01): `normalize()` rejects non-string `type`, validates `line` as int.
- Component (Vitest): `ReviewView` filters, `Inspect` opens the finding, decision select writes through the adapter.
- e2e (`tests/e2e/views/review.spec.ts`): filter by category/rule/decision, decision persistence across reload (artifact) and across sessions (API), `Copy SQL`.
- Security (`tests/security`): static lint for CTQ-06; API test that no endpoint accepts SQL; hostile fixture through the review view and the artifact (`tests/security/artifact.spec.ts`).
- API (Python): `reviews` router tests: id cap, id not in graph, RBAC (reviewer may write, viewer may not), audit row.
- Fixtures: `medium`, `edge-cases`, `hostile`, `empty`.

## 10. Security and privacy

- Inputs: SchemaGraph; decisions (four enumerated values; API validates the enum and the finding id against the loaded snapshot).
- Rendering: today all values escaped by `E()` (`:127`, `:130`); React port renders text; SQL shown in a `<pre>` as text.
- SQL: generated text only; never executed (CTQ-06); identifiers quoted by doubling (`:97`); the fix in B2 corrects references, not safety.
- Storage: `backend-buddy:<project.key>:reviews` in the artifact (C13); `review_decisions` table keyed by `workspace_id`, snapshot, `finding_id` in the SPA (A01/A04); audit rows for decision changes (CTQ-16).
- Exports: CSV with evidence text and SQL drafts; no statistics or sample values; guarded cells.
- CTQ-07: hostile render, IDOR negatives on `/reviews/{findingId}` return 404, RBAC matrix includes the reviews routes.

## 11. Performance budget

- View TTI on the medium fixture <= 1.5 s (Q01). Shell chunk.
- Own caps: `LIMIT 100` in duplicate and repeating-field drafts (`:100`, `:108`), `statement_timeout '10s'` in the PostgreSQL wrapper (`:99`) (both are text in drafts, `docs/reference/limits-and-caps.md` A2). Findings are computed once per graph (`:126`), which the port keeps by memoising on the graph fingerprint.
- API p95 for `PUT /reviews/{findingId}`: to be set in A04 (no plan value).

## 12. Accessibility

- Semantic table; filter selects have `aria-label`s (`:130`); `Inspect` is a button per row; the decision control is a labelled `<select>` (`:127`).
- The SQL is text in a `<pre>` and copyable; the copy fallback selects the text (`:183`) so keyboard users can copy with Ctrl+C.
- Toast messages use `role="status"` (`:26`, `:52`).
- MVP adds `aria-selected` on the highlighted row and announces filter result counts in a live region; the inspector focus handling is F15's responsibility.
- axe coverage: SPA route x 2 themes x 1366/390 and the artifact host view (CTQ-11); keyboard journey "filter, Inspect, change decision, copy SQL".

## 13. Open questions

1. The code implements eight rules (section 3 table); the plan and `skill/references/review-and-updates.md` say seven. Keep all eight in `review-logic.ts` and correct the documents, or drop `Relationship type mismatch`? Owner: Product owner. By G0.
2. Finding-id cap value and derivation (B3): which evidence enters the signature for each rule? Owner: Frontend lead with Backend lead. By A04 and W03 briefs.
3. Should the artifact's localStorage decisions be importable into the SPA (L-05 lists "localStorage-state import")? Owner: Product owner. By G2 roadmap review.
4. Confidence gradation (B22): constant `Review candidate` today; is a per-rule confidence wanted, and what would it be based on? Owner: Product owner. Post-MVP.
5. Should `Reset filters` reset the review category to `Normalization` (today, `:69`) or to all categories? Owner: Frontend lead. By W03 brief.

## 14. Implementation map and change log

### Implementation map

| Concern | Path |
|---|---|
| Current engine | `skill/assets/explorer.html:102-126` (`buildFindings`, `findings`), `:97-101` (`quote`, `tableSQL`, `readonly`, `duplicates`, `orphanSQL`), `:43-44` (`uniqueGroups`, `indexed`) |
| Current view | `skill/assets/explorer.html:128-133` (`renderReview`), `:127` (`findingDetail`), `:79` (decision persistence), `:183` (`copySQL`) |
| Planned logic | `packages/explorer/src/review-logic.ts`, `decisions.ts` (W03, W02); identifier helpers `packages/explorer/src/schema-diff-logic.ts` (`quoteIdentifier`, `qualifiedName`) |
| Planned view | `packages/explorer/src/ReviewView.tsx` (W03) |
| Planned API | `services/api/app/routers/reviews.py`, `review_decisions` table (A01, A04) |
| Host fixes | S01: `explorer.html:108`, `:110`; `build_explorer.py` validators |
| Tests | `review-logic.test.ts`, `tests/e2e/views/review.spec.ts`, `tests/security/artifact.spec.ts`, `skill/scripts/test_renderer_security.py` |

### Change log

| Date | PR | WP | Change |
|---|---|---|---|
| 2026-09-07 | - | D05 | Initial document from the pre-repo code; recorded the two SQL defects at `:108` and `:110` and the eight-rule count. |
| 2026-09-07 | - | D05 | Review fixes: URL keys renamed to `v.category`, `v.rule`, `v.status` to match the drill-through contract `review` allowlist (B4, section 5); rule 8 trigger corrected to base name or full name (`:120`); AC5 tagged CTQ-16. |

### S01 artifact and renderer hardening (2026-09-08)

Closed the findings this document's section 3 recorded, each with a named regression
test in `skill/scripts/test_renderer_security.py`:

- `assets/explorer.html`: escape the inspector's source-line reference; route review SQL
  through `tableSQL`; dialect-gate the structured-payload probe via a new `jsonProbe`
  helper; own-property entity-type colour lookup; widen the CSV formula guard; unmount
  the React view only when the view changes.
- `scripts/build_explorer.py`: case-insensitive `</script` and `</style` neutralisation,
  `<!--` neutralisation, `_text` field validation with length caps, `_line_number`
  validation, and `contractVersion` with a major-version compatibility check.
- `scripts/project.mjs`: discover every `test_*.py` under `skill/scripts`, not only
  `test_renderer.py`, so the security suite runs.
