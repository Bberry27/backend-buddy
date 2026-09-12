Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Glossary

Terms used across the documentation, in the order a reader meets them. Where a term has a code anchor today it is cited; terms marked "planned" are defined by the approved plan and land with the named work package. Caveat ids resolve in `docs/reference/caveats.md`.

**Declared vs inferred**
The two evidence classes for a relationship. A *declared* link (`kind: 'declared FK'`) was declared in the identified evidence source (ORM model, DDL, or live catalog); an *inferred* link (`kind: 'inferred by naming'`) was proposed by a naming or prefix heuristic and may have an unresolved target. The two values are the only ones allowed (`packages/explorer/src/types.ts:5`; `skill/references/schema-contract.md:51`). Declared does not mean verified live (C07, C09).

**SchemaGraph (contract)**
The canonical JSON shape every view consumes: `tables[]`, `links[]`, `project {name, key, dialect}`, optional `source`. Typed in `packages/explorer/src/types.ts`; normalized by `normalize()` in `skill/scripts/build_explorer.py`; documented in `skill/references/schema-contract.md`. Planned: JSON Schema `packages/contract/schema-graph.v1.json` with generated TypeScript (C01).

**Snapshot**
One immutable SchemaGraph captured at a point in time, with provenance (`source.file`, `source.sha256`, `source.commit`, `source.basis`). Today: the schema JSON inlined into the offline artifact, or a file loaded into Schema Diff. Planned: a row in the `snapshots` table with `graph`, `sha256`, `contract_version`, `origin` (`upload` or `extraction`), `parent_snapshot_id` (A04). A snapshot is not the live database (C09).

**Profile / profiling**
Bounded, read-only sampling of a selected table's rows that adds `profiling` to columns (`nullFraction`, `distinctCount`, `min`, `max`, `sampleSize`, `scope: 'sampled'`) and to tables (`sampleSize`, `sampled`, candidate functional dependencies), plus optional `sampleValues` (`packages/explorer/server/schema_profiler.py:18-39`). A profile is sampled evidence, not proof (C05), and never turns an unknown row count into a number (C01). Planned: `profile` job kind with per-table budgets and partial results (A04).

**Extraction**
Producing a snapshot from a source: today an adapter that emits the contract (`skill/references/extraction.md`); planned, live catalog introspection for PostgreSQL and SQLite yielding `origin='extraction'` and `source.basis='Live catalog extraction'` (A03).

**Subtree**
The bounded set of child rows reachable from one parent row through declared parent-to-child relationships, up to `MAX_DEPTH` hops and `MAX_ROWS` rows per hop (`schema_profiler.py:458-461`). Powers Row fan-out "live PK mode" via `LiveConnection.subtree` (`types.ts:9`). Ratios derived from it are local factors, not conserved flow (C02).

**Finding**
One review candidate produced by a rule (the host's 7-rule engine in `skill/assets/explorer.html`, Normalization Lens candidates, planned `review-logic.ts` and `insights-logic.ts`). A finding carries a stable id derived from its evidence signature, its category (normalization, referential integrity, index performance), evidence, why it matters, and the next validation step. Findings are candidates, not verdicts (C08).

**Decision**
A reviewer's recorded disposition of a finding: `open | investigate | intentional | resolved`. Today stored in browser storage under `backend-buddy:<project.key>:reviews` (`explorer.html:39`), which is convenience state (C13). Planned: `review_decisions` rows keyed by `finding_id`, written through `PUT /reviews/{findingId}` and audited (A04). A finding whose evidence changes reopens rather than inheriting an old decision (`skill/references/schema-contract.md:59`).

**Domain**
The declared business grouping of a table (`SchemaTable.domain`, `types.ts:4`), supplied by the adapter from module ownership or documentation. Drives the Domains filter, Schema City districts in "Business domains" mode, and colour assignment.

**Community (discovered)**
A cluster of tables computed by deterministic local modularity optimization over the undirected declared-FK graph (`packages/explorer/src/lens-domain-logic.ts:25-29`, `computeCommunities`). Community ids are their lexically first table id. Communities are analytical suggestions, not business ownership (C03).

**District**
A Schema City region produced by the squarified treemap in `layoutCity` (`packages/explorer/src/city-layout.ts:190-197`): one per domain (or per discovered community when the `Districts` select is set to discovered, `index.tsx:19-22`). Area is proportional to total column count; each district has a colour (C03, C16).

**Building / road**
Schema City primitives: a *building* is a table whose footprint is its column count and whose height is `log(1 + rowCount)` (baseline height when unknown, C01); a *road* is a declared FK between two buildings whose width is a volume proxy from the row-count ratio (C02).

**Junction**
A table that links two others in an N:M relationship through two FK groups covered by a key. Living ERD can collapse a junction into one N:M edge; collapse requires key evidence and never applies to generic multi-FK fact tables, ternary relations, or referenced junctions (`packages/explorer/src/living-logic.ts:43-63`; C10).

**Composite key / composite FK**
A primary, unique, or foreign key spanning more than one column. In the contract a composite FK is one link per ordered column pair sharing a `constraintId` (`skill/references/schema-contract.md:53`). It counts once as a constraint; the map's association count is column pairs (C11). Membership does not imply single-column uniqueness (C06).

**Cycle / SCC**
A strongly connected component of the declared dependency graph with more than one member, or a self-loop, found by iterative Kosaraju in `packages/explorer/src/dependency-logic.ts:108-142`. A repeated visit in a traversal is not a cycle (C12).

**Functional dependency (FD, candidate)**
A sample-only observation that `distinct(A) == distinct(A, B)` over the profiled rows, recorded under table `profiling.functionalDependencies` (`schema_profiler.py:30-39`). Vacuous determinants (unique or constant) are excluded or labelled. A candidate FD is evidence for review, not a constraint (C05, C08).

**Contract version**
Planned field `contractVersion` on the SchemaGraph, declared by `packages/contract/schema-graph.v1.json` (C01). The Python side rejects a different major version; TypeScript types are generated from the same file. Today the contract has no version field (`types.ts` has none); the artifact CSP and the existing contract fields stay backward compatible (D9).

**Fingerprint (graph)**
A stable hash identifying one snapshot's content, used to scope persisted view state. Today `snapshotKey()` in `packages/explorer/src/living-logic.ts:68-73` uses `source.hash | sourceHash | sha256` when present and otherwise hashes sorted tables and links. Planned: extracted into `view-state.ts` with unchanged output (C03; C13).

**Workspace / project**
Planned tenancy hierarchy (A01, A04). A *workspace* is the tenant boundary: every tenant-scoped table carries `workspace_id`, members have roles (owner, admin, reviewer, viewer), and connections and API keys belong to it. A *project* groups the snapshots, connections, and review decisions for one database or codebase inside a workspace. Today the nearest equivalent is `project.key`, the stable per-project-and-environment key that scopes browser storage (`skill/references/schema-contract.md:59`; C13).

**Connection**
Planned record of a database the product may read (A03): dialect, host, `tls_mode` (default `verify-full`), `mode`, and an envelope-encrypted secret that is write-only and never returned to the browser. Connections are explicitly registered, read-only, and never discovered (C14). Today the equivalent is the `--database` or `--dsn-env` argument to `serve_explorer.py` and `profile_snapshot.py`.

**Job / job item**
Planned unit of background work (A04). A *job* has a kind (`extract | profile | export`), a connection or snapshot, a budget, a status, and is claimed by the worker with `FOR UPDATE SKIP LOCKED`; at most one job runs per connection. A *job item* is one table inside a `profile` job with its own per-table budget and status, so one slow table yields a partial result instead of failing the run.

**Partial result**
A profile whose job finished with some items incomplete. Each incomplete item records a reason, the snapshot marks `profiling.status: 'incomplete'`, and the counts for those tables remain unknown; incomplete items never write counts (C01, C05). Today the whole operation fails closed instead (`ProfileLimitError`, `schema_profiler.py:83`, `:240`, `:248`), which is the behaviour the job model replaces.

**Live mode / live connection**
The optional read-only bridge from a view to the profiler: `LiveConnection {profile?, subtree?}` (`types.ts:9`), provided today by `serve_explorer.py` on loopback and by the planned API. A drill-through may prefill a live query but never runs it without an explicit click (F14, C14).

**Offline artifact**
The single self-contained HTML file built by `skill/scripts/build_explorer.py` from `skill/assets/explorer.html`, the esbuild IIFE bundle, icons, and a snapshot; runs from `file://` with the frozen CSP and makes zero network requests (F22, CTQ-05).

**Skill**
The portable `skill/` directory (SKILL.md, references, renderer, hardened loopback server, synced explorer source) that lets an agent produce the offline artifact for any project without Node; preserved unchanged in behaviour by D9.

**Drill-through**
Navigation from one surface to another that carries a selection (`t`, `c`, `r`, `ts`, `f`) and view state through the URL grammar in `route-state.ts` (planned, C03) and the navigation registry entries P1-P10 (W04). Today only `onSelectTable`/`onSelectTables` flow up to the host inspector (F14).

**Inspector**
The persistent side panel that shows the selected table, column, relationship, or finding and offers "Open in ..." targets. Today `#side`/`#detail` in `skill/assets/explorer.html`; planned `Inspector.tsx` (W02; F15).

**Fixture**
A synthetic SchemaGraph or SQL seed under `fixtures/` used by tests and the default build (R01: `small`, `medium`, `medium-measured`, `large`, `edge-cases`, `many-domains`, `hostile`, `empty`). Fixtures never carry data or names from the original private example.

**Gate (G0, G1, G2)**
Approval points in the roadmap: G0 documents approved and caveat wording frozen; G1 bootstrap and hardening green on CI from a clean clone; G2 MVP definition met (approved plan, "Verification (gates)").

**Work package (WP)**
One unit of build work with an id by track (D docs, R repo, S security, C contract, W web, A api, O ops, Q quality), an agent brief, allowed and forbidden paths, and acceptance commands (`docs/product-management/agent-briefs/`).
