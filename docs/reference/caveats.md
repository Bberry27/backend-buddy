Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Caveats C01-C16 (canonical wording)

This file is the only place a caveat is authored (decision D8). The blockquote under each id is the canonical text. Every document quotes it verbatim by id; every UI string comes from `packages/explorer/src/caveat-strings.ts` (C03), which mirrors this file and is checked by `caveats.test.ts` and the docs lint. Nobody paraphrases a caveat.

Why this file exists: before the repository, the sixteen caveats lived only as scattered paraphrases in `skill/references/*.md`, `skill/SKILL.md`, the handoff document, and UI copy. Each entry below lists the legacy passages it consolidates (all verified at the commit in the status header; `skill/assets/extensions/` is a generated copy and is never cited) and the surfaces that must show it. The wording is frozen at gate G0; changing it afterwards is a reviewed change that updates `caveat-strings.ts`, the tests, and every quoting document in the same PR.

Conventions: "view" ids are the `mount()` ids in `packages/explorer/src/index.tsx:22` and the host ids in `skill/assets/explorer.html:22`; F-ids resolve in `docs/features/README.md`.

---

## C01 Unknown stays unknown

> Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero.

**Consolidates**

- `skill/SKILL.md:38` "Missing statistics are unknown, never zero or synthetic measurements. Node heights and flow widths must label unavailable data."
- `skill/references/advanced-views.md:12` "Unknown rows retain their domain color and use an explicit unprofiled label and baseline height, never a fabricated count."
- `skill/references/advanced-views.md:37` "A capped sample cannot establish the exact table row count: retain unknown or an independently measured total, plus a lower bound. Do not run unbounded COUNT scans to fill a chart."
- `docs/architecture/legacy-handoff.md:33-34` "Missing values must remain unknown; never substitute column counts or synthetic values to make building heights or fan-out widths look populated."
- UI: `packages/explorer/src/City.tsx:345` "Unprofiled · row count unknown"; `City.tsx:350` "Known row counts use log(1 + row count). Unknown counts keep the minimum height."; `City.tsx:351` "Unprofiled: baseline height"; `packages/explorer/src/city-layout.ts:88` "Unprofiled (row count unknown)"; `packages/explorer/src/fanout-logic.ts:56` "Row count unknown"; `packages/explorer/src/Fanout.tsx:126` "Unavailable or zero: structural guide"; `packages/explorer/src/NormalizationLens.tsx:49` "Functional-dependency coverage is unknown; absent statistics do not earn a clean score."; `packages/explorer/src/ColumnTable.tsx:31` "Sample size / coverage unknown"; `packages/explorer/src/JoinMatrix.tsx:214` "Unknown cardinality".

**Where surfaced**: F05 Living ERD (row label), F06 Row fan-out (legend, node label), F07 Column table (statistics cells), F08 Schema City (legend, tooltip, unknown-rows banner), F09 Normalization lens (score footer), F11 Join matrix (legend), F13 Domains (row label), F17 Connections and profiling (partial-result status), F18 Insights (unprofiled items). Docs: `docs/product-management/ctq.md` CTQ-01, `docs/architecture/schema-graph-contract.md` (`rowCount: null`, `rowCountLowerBound`, `profiling.status`).

---

## C02 Fan-out ratios are independent local factors

> A fan-out ratio is child rows divided by parent rows for one relationship. Ratios are independent local factors, not conserved flow: counts along a path are not additive, a ratio is not a proven per-parent multiplicity, and when either count is unknown the ratio is unknown.

**Consolidates**

- `skill/references/advanced-views.md:10` "Show local `child.rowCount / parent.rowCount` ratios, not conserved flow or proven per-parent multiplicity. Empty/unknown parents do not have a finite measured ratio. Live PK mode uses bounded actual subtree counts, not table totals."
- UI: `packages/explorer/src/Fanout.tsx:127` "Independent factors, not conserved flow. Counts are not additive."; `Fanout.tsx:128` "Declared non-unique FKs only. Table-wide ratios are estimates, not per-row matches."; code comment `Fanout.tsx:24` "Sankey determines ordering only. Its conserved node values are never presented as data."
- UI: `packages/explorer/src/City.tsx:355` "Road width uses the child/parent row-count ratio when both counts are known. It is a volume proxy, not measured relationship cardinality."

**Where surfaced**: F06 Row fan-out (legend), F08 Schema City (road legend and road tooltip), F18 Insights (fan-out width items). Docs: F06 and F08 feature documents section 7.

---

## C03 Discovered communities are analytical suggestions

> Discovered communities are analytical suggestions computed from the declared-FK graph. They are structural candidates, not the project's business ownership model and not confirmed business domains.

**Consolidates**

- `skill/references/advanced-views.md:17` "Discovered clusters are analytical suggestions, not automatically the project's business ownership model."
- `skill/references/extraction.md:20` "Business domains and entity types should use actual module ownership or existing documentation. Prefix heuristics are acceptable when marked inferred."
- UI: `packages/explorer/src/Domains.tsx:124` "Communities are structural candidates, not confirmed business domains."; `skill/assets/explorer.html:84` "Entity classifications are inferred".

**Where surfaced**: F13 Domains (method panel), F08 Schema City (district legend when `Districts = Discovered communities`), F02 Entity index (classification note), F18 Insights (community items). Docs: F08 and F13 feature documents section 7.

---

## C04 Migration SQL is a draft and is never executed by the product

> Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf.

**Consolidates**

- `skill/references/advanced-views.md:14` "Migration SQL is a draft, never executed by the artifact. Cover dependency order and dialect quoting; mark unsupported types/expressions, missing definitions, and destructive changes explicitly."
- `skill/references/review-and-updates.md:17` "Avoid automatic schema mutations. The explorer may generate read-only, dialect-correct validation SQL but does not execute it."
- `docs/architecture/legacy-handoff.md:56` "do not execute draft migration SQL from the explorer."; `docs/architecture/legacy-handoff.md:68` "Keep migrations labeled draft and flag incomplete/unsupported metadata rather than guessing SQL."
- UI: `packages/explorer/src/SchemaDiff.tsx:123` "Export draft migration SQL; no execution"; `packages/explorer/src/schema-diff-logic.ts:279` SQL header "DRAFT ONLY - <dialect>; A -> B. No execution is performed."; `skill/assets/explorer.html:99` "-- Verify candidate semantics before running." and "-- Read-only SELECT diagnostic; run against the intended database."

**Where surfaced**: F10 Schema diff (export button, SQL header), F04 Schema review (validation SQL panel), F19 Exports (draft SQL download), F22 Offline artifact. Docs: CTQ-06, `docs/engineering/security-policy.md`.

---

## C05 Sampled evidence is not proof

> Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized.

**Consolidates**

- `skill/references/advanced-views.md:13` "`distinct(A) == distinct(A,B)` is sample evidence, not proof across the full relation. A unique or constant determinant can be vacuous; label or exclude such cases. Do not claim unprofiled tables are normalized."
- `skill/references/advanced-views.md:37` "A capped sample cannot establish the exact table row count".
- `docs/architecture/legacy-handoff.md:42` "A capped sample cannot establish an exact total row count."
- `packages/explorer/server/schema_profiler.py:38-39` (module docstring) "These observations are sample-only, not established database constraints, even after exhaustion."
- UI: `packages/explorer/src/NormalizationLens.tsx:23` "Sample evidence only"; `NormalizationLens.tsx:26` "Sample-only functional dependency arrows"; `NormalizationLens.tsx:49` "No sampled violation is not proof of a normal form."; `packages/explorer/src/fanout-logic.ts:142` "Live results are truncated (limit N). Counts and ratios may be partial."

**Where surfaced**: F09 Normalization lens (flags, arrows, footer), F07 Column table (statistics with sample denominator), F06 Row fan-out (truncation notice), F17 Connections and profiling (result status), F18 Insights, F19 Exports (profiled export footer). Docs: CTQ-08.

---

## C06 Composite unique membership does not imply single-column uniqueness

> Membership in a composite unique key or composite primary key does not make any member column unique on its own. Uniqueness is stated per key group, and index coverage depends on column order, predicates, and expressions.

**Consolidates**

- `skill/references/advanced-views.md:11` "Composite unique membership does not mean each individual column is unique."
- `skill/references/extraction.md:22` "A single column's apparent uniqueness does not establish uniqueness of each member of a composite key; index coverage depends on order, predicates, and expressions."
- UI: `packages/explorer/src/column-logic.ts:92` "Composite unique membership; this column alone is not necessarily unique"; `skill/assets/explorer.html:93` "Composite key membership retained".

**Where surfaced**: F07 Column table (uniqueness description), F03 PK/FK index (key membership legend), F15 Inspector (key section). Docs: `docs/architecture/schema-graph-contract.md` (`uniques`, `indexes`).

---

## C07 Declared and inferred evidence stay distinguishable

> Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query.

**Consolidates**

- `skill/references/schema-contract.md:51` "Use exactly `declared FK` or `inferred by naming` for `kind`. ... An inferred target may be absent; label it unresolved and do not generate an executable validation query for it."
- `skill/SKILL.md:30` "declared versus inferred references ... A column named `id` is not automatically a PK. An `_id` suffix is not proof of an FK."
- `skill/references/review-and-updates.md:17` "An inferred reference is not a reason to query or constrain an unrelated table."
- `skill/references/extraction.md:20` "Prefix heuristics are acceptable when marked inferred."
- UI: `skill/assets/explorer.html:81` and `:93` legend entries "Declared FK", "Inferred reference", "Unresolved ID"; `explorer.html:158` "solid lines are declared foreign keys and dashed lines are inferred references"; `explorer.html:11` `.edge.inferred{stroke-dasharray:5 4...}`; `packages/explorer/src/Domains.tsx:118` "inferred pairs excluded"; `packages/explorer/src/ArcDiagram.tsx:141` "inferred or unresolved links excluded".

**Where surfaced**: F01 Relational map (edge style and legend), F02 Entity index, F03 PK/FK index, F04 Schema review (finding evidence), F05 Living ERD (edge style), F11 Join matrix, F12 Arc diagram (exclusion count), F15 Inspector (relationship details), F18 Insights (unresolved inferred links). Docs: `docs/architecture/schema-graph-contract.md` (`kind`).

---

## C08 Heuristic findings are review candidates, not verdicts

> Heuristic findings are review candidates, not verdicts. Each finding names its columns, its observable evidence, why it might matter, and what would confirm or dismiss it. A structural heuristic does not prove a normal-form violation, a functional dependency, or a design defect.

**Consolidates**

- `skill/references/review-and-updates.md:3` heading "Review Candidates, Not Verdicts"; `:5` "Each candidate must identify its columns, observable evidence, why it might matter, and what would confirm or dismiss it."
- `skill/SKILL.md:31` "Structured payloads and historical snapshots are not automatically design defects."
- `docs/architecture/legacy-handoff.md:23` "Normalization Lens with explained heuristic flags".
- UI: `skill/assets/explorer.html:127` "Structural heuristics do not prove a normal-form violation or a functional dependency."; `explorer.html:104` "Review candidate"; `explorer.html:116` "Unconstrained reference candidate"; `packages/explorer/src/NormalizationLens.tsx:130` "Higher means more review priority; lower means fewer observed candidates."

**Where surfaced**: F04 Schema review (finding detail), F09 Normalization lens (score explanation), F15 Inspector (findings section), F18 Insights (every item, per work package W06). Docs: `docs/product-management/ctq.md`, F18 feature document.

---

## C09 A source checkout or snapshot is not the live database

> A source checkout, ORM model, or stored snapshot documents a schema at one point in time. It is not proof of the live database schema. "Declared" means declared in the identified evidence source, not verified against a live catalog, unless the snapshot's provenance says so.

**Consolidates**

- `skill/SKILL.md:12` "A repository checkout is not proof of the live database schema or the latest development branch."
- `docs/architecture/legacy-handoff.md:32` "It is ORM/source documentation, not proof of the current deployed database schema."
- `skill/references/schema-contract.md:51` "`declared FK` means declared in the identified evidence source, not necessarily verified live."
- `skill/references/extraction.md:26` "Record source hashes or a migration/catalog snapshot identifier. A git commit alone is insufficient when schema files have uncommitted changes; hash the actual source too."
- UI: `skill/assets/explorer.html:178` status text "Snapshot only" versus "Live read-only connection".

**Where surfaced**: F16 Projects and snapshots (snapshot provenance: `origin`, `source.basis`, hash), F10 Schema diff (snapshot A/B provenance), F15 Inspector (source line), F22 Offline artifact (footer status), F17 Connections and profiling (extraction result labelled `source.basis='Live catalog extraction'`). Docs: `docs/architecture/data-model.md` (snapshots table).

---

## C10 N:M junction collapse requires key evidence

> A table is collapsed into an N:M junction edge only when its key evidence supports it: exactly two foreign-key groups whose columns are covered by a primary or unique key. A generic multi-FK fact table, a ternary relation, or a junction that is itself referenced is never collapsed into one binary edge.

**Consolidates**

- `skill/references/advanced-views.md:9` "Never collapse a generic multi-FK fact table as an N:M junction without checking its key constraints."
- `skill/references/schema-contract.md:55` "Many-to-many relationships need the junction entity and its two FK groups; don't fabricate a direct physical FK between endpoints."
- Code comment `packages/explorer/src/living-logic.ts:60` "A ternary relation, or a referenced junction, cannot be replaced by one binary edge."; UI `packages/explorer/src/LivingERD.tsx:204` "N junctions collapsed" with the "Show junctions" toggle at `LivingERD.tsx:182`.

**Where surfaced**: F05 Living ERD (collapse notice and toggle, edge label "N:M via <junction>"), F15 Inspector (relationship detail). Docs: F05 feature document section 7; `docs/architecture/schema-graph-contract.md` (`cardinality`).

---

## C11 A composite FK counts once; association counts are column pairs

> A composite foreign key is one constraint and counts once wherever constraints are counted (matrix cells, community edges, cardinality). The relational map's association count is column pairs, not physical FK constraints. Every surface states which of the two it counts.

**Consolidates**

- `skill/references/schema-contract.md:53` "For a composite FK emit one link per ordered column pair, all sharing a nonempty `constraintId` ... The map's association count is column pairs, not the number of physical FK constraints."
- `skill/references/advanced-views.md:15` "count one composite constraint rather than each pair as separate FKs."
- UI: `packages/explorer/src/Domains.tsx:124` "A composite FK counts once; separate constraints retain their weight."; code comment `packages/explorer/src/lens-domain-logic.ts:26` "Composite column pairs contribute one edge; independent constraints retain their weight."; `packages/explorer/src/LivingERD.tsx:59` pair-count suffix "(N)" on multi-pair edges.

**Where surfaced**: F01 Relational map (association count label), F11 Join matrix (cell count), F13 Domains (method panel), F05 Living ERD (edge label), F12 Arc diagram (arc grouping). Docs: `docs/architecture/schema-graph-contract.md` (`constraintId`).

---

## C12 Cycles require strongly-connected-component analysis

> A cycle is a strongly connected component of the declared dependency graph with more than one member, or a self-reference. A repeated visit during traversal is not by itself a cycle.

**Consolidates**

- `skill/references/advanced-views.md:16` "Cycles require SCC analysis, not simply treating every traversal repeat as a cycle."
- Code: `packages/explorer/src/dependency-logic.ts:108` "Iterative Kosaraju avoids recursion limits for large schema dependency chains."; `dependency-logic.ts:142` `cyclic: members.length > 1 || selfLoop`.
- UI: `packages/explorer/src/fanout-logic.ts:121` "Some tables recur at different depths." (a recurrence notice that is deliberately not called a cycle).

**Where surfaced**: F12 Arc diagram (cycle list, backward arcs), F06 Row fan-out (recurrence notice), F18 Insights (SCC cycle items). Docs: F12 feature document section 7.

Note: this caveat has the thinnest legacy record (one reference sentence and code comments). Wording to be confirmed at G0.

---

## C13 Browser storage is convenience state; project isolation is mandatory

> Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state.

**Consolidates**

- `skill/references/schema-contract.md:59` "`project.key` must remain stable for one project's environment, and differ between environments/projects with identical table names. Theme and review decisions are scoped to this key. ... browser local storage is convenience state, not a team review database."
- `skill/references/review-and-updates.md:24` "Browser decisions are local; exports can be used as review records."
- `docs/architecture/legacy-handoff.md:52` "Keep per-project and per-snapshot persistence isolated."
- `skill/SKILL.md:21` "Use a stable, project-and-environment-specific `project.key`".
- Code: `skill/assets/explorer.html:39` key family `backend-buddy:<project.key>:...`; `packages/explorer/src/living-logic.ts:72` key `backend-buddy-erd:v1:<project.key>:<fingerprint>`.

**Where surfaced**: F04 Schema review (decision persistence note), F05 Living ERD (layout persistence), F08 Schema City (camera and mode persistence), F14 Drill-through navigation (view-state slice), F15 Inspector (decisions adapter), F16 Projects and snapshots (server-side decisions as the review record), F19 Exports, F20 Auth and workspaces, F22 Offline artifact. Docs: `docs/architecture/drill-through-contract.md`, `docs/engineering/security-policy.md`.

---

## C14 Never connect to production implicitly; read-only and explicitly selected only

> The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows.

**Consolidates**

- `skill/SKILL.md:38` "The optional local adapter requires an explicitly selected read-only connection. Do not discover or connect to production merely to make a diagram look populated."
- `skill/references/extraction.md:5` "prefer read-only database catalog metadata with an explicitly identified connection/environment."; `extraction.md:14` "A metadata-only request does not authorize scanning customer rows."
- `skill/references/advanced-views.md:21` "supports explicitly selected SQLite and PostgreSQL connections ... It opens read-only transactions, parameterizes row values, validates identifiers against the snapshot, and bounds rows, depth, query count, and time. It never connects on import."
- `docs/architecture/legacy-handoff.md:40` "explicitly selected SQLite and PostgreSQL read-only access."; `legacy-handoff.md:55-56` "Integrate the read-only adapter as a deliberate, separately configured mode. Keep credentials out of browser bundles".
- Code: `packages/explorer/server/schema_profiler.py:56-57` (docstring) "Queries use SELECT only, with no graph-supplied SQL. SQLite query_only guards and progress deadlines, PostgreSQL read-only transactions and statement timeouts"; `schema_profiler.py:199` `PRAGMA query_only = ON`; `schema_profiler.py:288` `SET TRANSACTION READ ONLY`.

**Where surfaced**: F17 Connections and profiling (connection form, test and profile actions, `targets.py` deny list), F06 Row fan-out and F09 Normalization lens (live actions require a click), F20 Auth and workspaces (who may register connections), F22 Offline artifact (`serve_explorer.py`). Docs: `docs/architecture/security-architecture.md`, `docs/engineering/security-policy.md`, CTQ-07, CTQ-08.

---

## C15 Application defaults are not SQL defaults

> An application-level default (an ORM or code default) is not a SQL default. The two are shown separately, an application default is never emitted as DDL, and a code function is never emitted as executable migration SQL.

**Consolidates**

- `skill/references/advanced-views.md:5` "Application-level defaults are separate from SQL defaults; never emit a Python or JavaScript function as executable migration SQL."
- Code: `packages/explorer/src/schema-diff-logic.ts:407` emitted comment "applicationDefault changed; no database DDL applies."; `packages/explorer/src/types.ts:2` keeps `default`, `serverDefault`, and `applicationDefault` as distinct fields.

**Where surfaced**: F10 Schema diff (migration draft comments, column detail), F07 Column table (default column), F15 Inspector (column detail). Docs: `docs/architecture/schema-graph-contract.md` (`default`, `serverDefault`, `applicationDefault`).

Note: thin legacy record (one reference sentence plus code). Wording to be confirmed at G0.

---

## C16 The flat accessible fallback must remain available

> The flat, accessible rendering (flat SVG City, keyboard-reachable tables, text alternatives for canvas and WebGL surfaces) remains available in every release. It uses the same layout data as the 3D scene, can be chosen at any time, and is entered automatically when WebGL is unavailable or lost.

**Consolidates**

- `skill/references/advanced-views.md:12` "Keep persistent readable labels in 3D and flat views ... The flat SVG mode uses the same layout and must remain available when WebGL fails."
- `skill/SKILL.md:36` "Schema City (react-three-fiber with a flat fallback)".
- `docs/architecture/legacy-handoff.md:22` "accessible flat SVG fallback"; `legacy-handoff.md:66` "Verify 3D canvas pixels, camera motion, touch navigation, flat fallback, and exports."
- UI: `packages/explorer/src/City.tsx:349` "WebGL unavailable · Flat map active"; `City.tsx:224` aria-label "Schema City flat map"; `City.tsx:318` "Flat map" toggle; code comment `City.tsx:301` "Probe once so unavailable WebGL never leaves the Canvas stuck blank."

**Where surfaced**: F08 Schema City (mode toggle, failure status, legend), F21 Theming and design tokens (contrast in both modes), F11 Join matrix (canvas mode keeps accessible labels; `advanced-views.md:15` "keep labels accessible"), F05 Living ERD (keyboard alternative). Docs: `docs/engineering/accessibility-standards.md`, CTQ-04, CTQ-11.

---

## Coverage summary

| id | legacy doc passages | legacy UI/code passages | record strength |
|---|---|---|---|
| C01 | 4 | 9 | strong |
| C02 | 1 | 4 | adequate |
| C03 | 2 | 2 | adequate |
| C04 | 4 | 4 | strong |
| C05 | 4 | 4 | strong |
| C06 | 2 | 2 | adequate |
| C07 | 4 | 6 | strong |
| C08 | 4 | 4 | strong |
| C09 | 4 | 1 | adequate |
| C10 | 2 | 2 | adequate |
| C11 | 2 | 3 | adequate |
| C12 | 1 | 3 | thin |
| C13 | 4 | 2 | strong |
| C14 | 6 | 3 | strong |
| C15 | 1 | 2 | thin |
| C16 | 4 | 4 | strong |

Every id cites at least one legacy passage (D00 acceptance). C12 and C15 rest mostly on a single reference sentence each; their canonical wording adds precision (SCC definition; three-way default distinction) that the legacy text implies but does not state, and needs explicit owner confirmation at G0.
