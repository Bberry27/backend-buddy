Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Business case: Backend Buddy

This document is the G0 input for the decision to invest in turning the existing offline schema explorer into a licensable, self-hosted database-analysis product. It states the problem, the alternatives considered, what already differentiates the code, who decides what, who the product is for, how it could be licensed, how success is measured, and what could go wrong. Companion: `docs/business/product-vision-and-scope.md`. Registries referenced: features `docs/features/README.md`, CTQs `docs/product-management/ctq.md` (D04), caveats `docs/reference/caveats.md`.

Every market or pricing figure in this document is either absent or marked "to be validated". No number here is invented.

## 1. Problem statement

Teams that own relational databases with more than a few dozen tables cannot answer basic questions about them without hand work: which tables carry the data volume, which relationships are declared versus merely implied by naming, where normalization is questionable, what changed between two schema versions, and what a proposed cleanup would touch. The tooling they have splits the job across an IDE ER diagram, an ad-hoc SQL session against production, a wiki page that is out of date, and a slide with boxes and arrows.

Three failure modes recur:

1. **Inference presented as fact.** Diagrams and catalogs draw an arrow because a column is named `customer_id`, and the reader cannot tell it from a declared foreign key. Decisions are then made on evidence nobody checked.
2. **Fabricated or silently missing numbers.** Row counts default to zero, heights and widths get scaled from column counts to look populated, or a visual quietly drops what it could not measure.
3. **Unsafe evidence gathering.** To get real numbers someone opens a session against production with no read-only guard, no timeout, and no cap, and copies findings into a document that then decays.

The existing code already solves the analytical half of this problem for one project: thirteen linked views of one schema graph, a seven-rule review engine, and a bounded read-only profiler, all shipped as one offline HTML file (`skill/assets/explorer.html`, 13 tabs at `skill/assets/explorer.html:22`; nine React views mounted from `packages/explorer/src/index.tsx:22`; profiler `packages/explorer/server/schema_profiler.py`). What it lacks is everything that makes it a product: a repository, authentication, persistent projects and snapshots, live catalog extraction, server-side review decisions, deployment, tests that run in CI, and documentation (see "What is missing or broken" in the approved plan and `docs/architecture/legacy-handoff.md`).

The business question is whether to invest in that product layer. The recommendation below is yes, scoped to a single-tenant self-hosted MVP, gated by G0-G2.

## 2. Market and alternatives considered

Market sizing, growth, and buyer budgets for every category below are **to be validated** with design partners before any pricing decision. The categories are named so that positioning is explicit; the comparison rests on capability, not on figures.

| Category | What it does well | Where it leaves the problem unsolved | Relationship to this product |
|---|---|---|---|
| Schema documentation generators (generate static HTML or Markdown from a live catalog or DDL) | Complete, repeatable inventory of tables and columns; cheap to run in CI | Static pages, no analysis, no distinction between declared and inferred evidence, no profiling, no review workflow, no navigation between analytical perspectives | Adjacent; the product can consume their output as a snapshot and adds analysis on top |
| IDE ER views (diagram panels inside database IDEs and ORMs) | Immediate, accurate for the connected database, good for a handful of tables | One diagram style; hard to use above roughly a hundred tables; tied to a developer seat and a live connection; nothing persists for a team; no normalization or fan-out analysis | Substitute for P3 on small schemas only |
| Data catalogs (metadata, lineage, ownership, glossary, search across many systems) | Governance, discovery, lineage across warehouses and pipelines | Table-level and column-level metadata without structural analysis of one relational schema; heavyweight to deploy and price; rarely show fan-out, cycles, normalization, or diff | Complementary; a catalog answers "what exists and who owns it", this product answers "how is this schema built and where is it weak" |
| Diagramming SaaS (general-purpose or ER-flavored drawing tools) | Presentation quality, collaboration, cheap seats | Drawings are not derived from evidence; they drift from the database on day one; no profiling, review, or diff; the vendor hosts your schema | Substitute for the presentation use only; this product's SVG/PNG exports cover that need |

Positioning that follows from the table: the product is an **evidence-bound analysis and review layer for one relational schema at a time**, deployed where the schema owner controls the data, with an offline artifact for sharing. It does not compete on catalog breadth, on drawing freedom, or on being inside the IDE.

Alternatives to building the product that were considered and rejected:

- **Keep the offline artifact as an internal tool only.** Zero cost, but no revenue, no security hardening, and the confirmed security findings in the plan stay open (for example the unescaped `${t.line}` at `skill/assets/explorer.html:77` and `quote()` instead of `tableSQL()` at `:108` and `:110`).
- **Open-source the views and sell services.** Possible later; rejected for the MVP because the licensable value is the integrated product (auth, connections, profiling jobs, review record, exports), not any single view.
- **Rebuild on a different stack.** Rejected: all server logic and 60 tests are Python, nine views and 75 tests are React and TypeScript, and the skill must keep working (decisions D1, D2, D9 in the plan).

## 3. Differentiators grounded in the code

Each differentiator names the code that already does it and the work package that completes it. Feature ids resolve in `docs/features/README.md`.

| # | Differentiator | Evidence today | Completed by |
|---|---|---|---|
| 1 | **Thirteen linked views of one schema graph.** Relational map, entity index, PK/FK index, normalization review (host views), plus Living ERD, Row fan-out, Column Table, Schema City, Normalization Lens, Schema Diff, Join Matrix, Arc Diagram, Domains (React). Every view reads the same `SchemaGraph` contract. | Tablist with 13 `data-view` ids at `skill/assets/explorer.html:22`; component map `fanout, columns, city, living, lens, domains, matrix, arcs, diff` at `packages/explorer/src/index.tsx:22`; shared `ViewProps` at `packages/explorer/src/types.ts:10` | F01-F13 exist; W03 ports the four host views to React |
| 2 | **Drill-through between perspectives.** Select a table in one view and continue the investigation in another, with URL state so a finding can be linked. | Today one-directional and lossy: views only emit `onSelectTable(id)` (`packages/explorer/src/types.ts:10`); the host tears the React tree down on every filter change (`skill/assets/explorer.html:178` calls `unmount()` unconditionally; `packages/explorer/src/index.tsx:22` always creates a new root) | F14, F15: C03 navigation contract, W02 inspector, W04 drill-through registry P1-P10, route `/w/:ws/p/:project/s/:snapshot/:view` |
| 3 | **Bounded read-only profiling where unknown stays unknown.** Live evidence comes from an explicitly selected connection, opened read-only, with caps on rows, depth, parameters, queries, time, and scalar length; anything not measured stays labelled unknown rather than becoming zero. | Caps `MAX_ROWS 10000, MAX_DEPTH 4, MAX_PARAMETERS 400, MAX_BATCH_KEYS 100, MAX_QUERIES 512, DEADLINE_SECONDS 5.0, MAX_SCALAR_LENGTH 256, MAX_FD_COLUMNS 32` at `packages/explorer/server/schema_profiler.py:73-80`; SQLite `PRAGMA query_only = ON` at `:199`; PostgreSQL `SET TRANSACTION READ ONLY` at `:288`; docstring `:56-57` "Queries use SELECT only, with no graph-supplied SQL"; City tooltip "Unprofiled · row count unknown" at `packages/explorer/src/City.tsx:345` | F17: A03 per-table budgets and partial results, `policy.py` redaction classes, `targets.py` private-target deny; CTQ-01, CTQ-08 |
| 4 | **Review decisions, not verdicts.** The seven-rule review engine emits candidates with evidence and a suggested next step; the user records a decision (`open`, `investigate`, `intentional`, `resolved`) that travels with the export. | Decision select at `skill/assets/explorer.html:127`; status filter at `:130`; export rows carry `decision` and `validation_sql` at `:132`; decisions stored under the `backend-buddy:<project.key>` prefix (`:39`) | F04, F16: `PUT/GET /reviews/{findingId}` server-side record (A04); F18 Insights v0 (W06) |
| 5 | **Offline artifact with a locked-down CSP.** One HTML file that renders every view with zero network access, safe to attach to a change request. | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'` at `skill/assets/explorer.html:6`; renderer `skill/scripts/build_explorer.py` | F22, F19: `export` job (A04) reuses `build_explorer.render()`; CTQ-05 keeps the CSP byte-identical (decision D9) |
| 6 | **Schema City: a 3D orientation view with an accessible flat twin.** Districts are domains, footprint is column count, height is log row count, roads are FKs. The flat SVG mode uses the same layout and takes over automatically when WebGL fails. | Pure layout kernel `packages/explorer/src/city-layout.ts`, tested at 1, 2, 12, 120, and 600 tables (`packages/explorer/src/city-layout.test.ts:20`); WebGL probe and fallback at `packages/explorer/src/City.tsx:301-308`; "WebGL unavailable · Flat map active" at `:349`; road legend at `:355` | F08 Schema City MVP (W05): search, selection highlight, fly-to, district labels, 12-hue palette, inspectable roads |
| 7 | **Every heuristic carries its caveat.** Sixteen contractual caveats (C01-C16) are authored once and quoted verbatim in UI and docs. | `docs/reference/caveats.md`; UI strings will come only from `packages/explorer/src/caveat-strings.ts` (C03) | CTQ-13 docs lint; `caveats.test.ts` |

What the code does **not** yet do, so that nobody sells it early: live catalog introspection (`introspect()` does not exist; A03), user accounts and RBAC (A02), persistent projects and snapshots (A01, A04), any dialect beyond PostgreSQL and SQLite (decision D6), and a hosted multi-tenant service (L-08).

## 4. Stakeholders and RACI

Roles, never names. At MVP several roles are held by the same person (the Product Owner is also the licensor, the repository owner, and the human reviewer of coding-agent output); the table records the role that is accountable so that the separation is explicit when the team grows. R = responsible, A = accountable (exactly one per row), C = consulted, I = informed.

| Decision | Product Owner | Sponsor (licensor) | Engineering (coding agents + human reviewer) | Security reviewer | Legal | GitHub org owner | Design partners |
|---|---|---|---|---|---|---|---|
| Business-case approval (G0) | R | A | C | C | I | I | C |
| Architecture decisions (ADR-0001..0008, D1-D9) | A | I | R | C | I | I | I |
| Security sign-off (CTQ-07, CTQ-08, threat model Q02) | C | I | R | A | I | I | I |
| Release go/no-go (G1, G2, tagged releases) | A | C | R | C | I | I | I |
| Pricing and licensing model | R | A | I | I | C | I | C |
| Pilot selection (design partners for UX round 1 and UAT) | A | C | I | C | I | I | R |
| IP and licensing terms (LICENSE, THIRD_PARTY_NOTICES, OEM terms) | R | C | C | I | A | I | I |

Notes:

- The repository owner controls the private repository `Bberry27/backend-buddy`, branch protection, and who can merge (decision D7). It is informed of every decision above and responsible for none; it enforces them through repository settings.
- Security sign-off is accountable to the Security reviewer, not the Product Owner, so that schedule pressure cannot waive CTQ-07 or CTQ-08.
- The Sponsor is accountable for the two decisions that commit money or revenue (business case, pricing); the Product Owner is accountable for everything that shapes the product.

## 5. Personas and jobs-to-be-done

Six personas. Each job is written as "when ..., I want ..., so that ..." and names the features and caveats that serve it.

### P1 Enterprise data / platform architect

Owns the target-state data architecture across several teams; reviews designs, sets standards, and inherits legacy schemas nobody documented.

- When I inherit a schema with hundreds of tables, I want to see where the mass and the coupling are, so that I can decide what to decompose first. (F08 Schema City, F13 Domains, F12 Arc Diagram)
- When a team proposes a schema change, I want a diff with a draft migration I can read but that nothing executes, so that review is about semantics, not about whether someone will run it by accident. (F10 Schema Diff, C04)
- When I present a finding upward, I want an artifact that works with no network and carries its caveats, so that the reader trusts it and cannot mistake inference for fact. (F22 Offline artifact, F19 Exports, C07)

### P2 DBA / performance engineer

Keeps production databases healthy; is the person who gets paged.

- When someone asks "how big is this and what depends on it", I want row counts and fan-out ratios from a read-only bounded sample, so that I can answer without a production incident. (F06 Row fan-out, F17 Connections and profiling, C02, C14)
- When I see FK columns without an index or wide fan-out, I want them listed with evidence and a place to record my decision, so that the list becomes a work queue rather than a slide. (F18 Insights, F04 Schema review)
- When a profile hits its budget, I want partial results with a stated reason, not a failed job, so that a large schema still yields something. (F17, CTQ-08)

### P3 Backend developer

Works inside one bounded context day to day; touches the schema through an ORM.

- When I start a ticket on a table I have not touched, I want to jump from that table to its columns, keys, neighbours, and review findings in two clicks, so that I stop grepping migrations. (F14 Drill-through, F15 Inspector, F07 Column Table, F03 PK/FK index)
- When my ORM model differs from the database, I want the difference shown as declared versus inferred, and application defaults kept separate from SQL defaults, so that I fix the right layer. (F10, C07, C15)

### P4 Data analyst

Writes queries against the operational schema; needs join paths and cardinality expectations.

- When I need to join two tables, I want to see whether a declared path exists, through which junction, and how wide it is, so that I do not write a fan-out join by accident. (F11 Join Matrix, F05 Living ERD, C10, C11)
- When a column looks like an identifier, I want to know if it is actually unique or only part of a composite key, so that my group-by is correct. (F07, C06)

### P5 Engineering manager

Accountable for delivery and technical debt across several services.

- When planning a quarter, I want a ranked list of schema review candidates with evidence and status, so that debt work is visible and negotiable. (F18 Insights, F04, review decisions recorded server-side in F16)
- When two teams argue about domain boundaries, I want discovered communities next to declared domains, labelled as suggestions, so that the conversation has a shared picture. (F13, F08 with `Districts = Discovered communities`, C03)

### P6 Licensee security reviewer

Must approve the product before it may touch a licensee's database.

- When evaluating the product, I want proof that it opens read-only sessions, caps every query, never executes generated SQL, and never returns a stored credential, so that I can sign off without reading every line. (F17, F20 Auth and workspaces, CTQ-06, CTQ-07, CTQ-08, `docs/architecture/security-architecture.md` (D02), threat model (Q02))
- When it runs in our environment, I want it self-hosted with TLS at our reverse proxy, RBAC, an insert-only audit trail, and a documented rollback, so that it fits our controls. (decisions D4, D5; CTQ-15, CTQ-16)

## 6. Value proposition per persona

| Persona | Replaces | Value the product delivers | How we will know (metric; baseline to be validated) |
|---|---|---|---|
| P1 Architect | Hand-drawn diagrams, wiki pages, one-off SQL | An evidence-bound picture of a large schema with orientation (City), structure (ERD, Arc, Domains), and change (Diff), exportable offline | Time from "new schema" to "first written assessment"; number of assessment artifacts produced from the product |
| P2 DBA / perf | Ad-hoc production sessions, spreadsheets of counts | Bounded read-only profiling with partial results, fan-out and index insights with recorded decisions | Zero write or unbounded statements against target databases (CTQ-08); insight items moved from `open` to a decision per month |
| P3 Developer | Grepping migrations, IDE ER view, asking a colleague | Two-click drill-through from any table to its columns, keys, neighbours, and findings, deep-linkable | Path efficiency <= 1.5 and unassisted success >= 80 % on the UX protocol tasks (Q04) |
| P4 Analyst | Trial-and-error joins | Join Matrix and Living ERD with junction collapse and composite-key truth | Self-reported join errors avoided (survey, UX round 1) |
| P5 Manager | Debt discussions without evidence | A ranked, evidence-linked, statused list of review candidates per project | Percentage of review candidates with a recorded decision; recurring use of the Insights view |
| P6 Security reviewer | Reading source, requesting a pen test | Documented threat model, RBAC matrix, audit trail, encrypted write-only credentials, reproducible security tests in CI | Time to security sign-off at a pilot; number of findings raised during review |

## 7. Licensing and pricing model options

No prices are proposed here; price points are to be validated with design partners after G2. Each option is evaluated on fit with the architecture decisions already made.

| Option | Description | Fits the architecture because | Tradeoffs | When |
|---|---|---|---|---|
| **A. Self-hosted, per seat** | Licensee runs the Compose stack (D4); license counts named users in `users` / `workspace_members` | Single-tenant self-hosted is the MVP deployment; no metering infrastructure needed beyond a seat count | Seat counting needs a license mechanism (key file or honour system); revenue scales with users, not with schema value; P3 developers are many and price-sensitive, P1/P2 are few | MVP and first pilots |
| **B. Hosted, per workspace** | The licensor operates the service; price per workspace (tenant) with limits on projects, snapshots, or profiled tables | `workspace_id` is on every tenant-scoped table from day one (D4), so the schema does not change | Requires L-08 (multi-tenant enforcement, billing, OIDC/SAML) and a customer-side connector agent for databases that cannot be reached from the cloud (`connections.mode` reserved); hosting a licensee's schema metadata raises the security bar and lengthens the sales cycle | Post-MVP, after L-08 |
| **C. OEM / embedded** | A vendor embeds the view library or the offline artifact renderer in its own product | The view library (`packages/explorer`) and the renderer (`skill/`) are already separable and shell-neutral (D1, D9) | Needs a clean library API, a redistribution license, and THIRD_PARTY_NOTICES hygiene; support burden follows the OEM's release cadence; caveat wording must survive embedding (D8) | Opportunistic; only if a partner asks |

Recommendation: start with **A** for pilots because it needs no new infrastructure and matches P6's expectations; keep **B** structurally possible (already true) and decide on it after two pilots; treat **C** as demand-driven. The LICENSE ships with a DRAFT header until Legal reviews it (decision D7).

## 8. Success metrics tied to CTQs

Two kinds of metrics: **product quality** (enforced by the CTQ registry, measured in CI at gates G1 and G2) and **business** (baselines to be validated with pilots; no target is asserted before a baseline exists).

### 8.1 Product quality (from `docs/product-management/ctq.md`, D04)

| Outcome we promise | CTQ | Gate |
|---|---|---|
| No fabricated numbers; unknown is visibly unknown | CTQ-01 | G2 |
| Works on desktop and phone widths in both themes without overflow | CTQ-02 | G2 |
| Panning never counts as a click on map, City, and Living ERD | CTQ-03 | G2 |
| 3D renders, and the flat fallback appears when WebGL is off | CTQ-04 | G2 |
| The offline artifact makes zero network requests and keeps its CSP | CTQ-05 | G1, G2 |
| Draft SQL is never executed by the product | CTQ-06 | G2 |
| Security posture: no high or critical audit findings, RBAC matrix complete, secrets never in responses, strict SPA CSP | CTQ-07 | G1 (audits), G2 |
| Profiler bounds enforced against a real PostgreSQL, with per-table partial results | CTQ-08 | G2 |
| Bundle and interaction budgets met | CTQ-09 | G2 |
| Every view reachable inbound and outbound; zero remounts on filter keystrokes | CTQ-10 | G2 |
| Accessibility: axe 0 serious or critical, keyboard-only journeys | CTQ-11 | G2 |
| Coverage gates | CTQ-12 | G1, G2 |
| Docs and code stay in sync | CTQ-13 | every PR |
| No private data in the repository | CTQ-14 | every commit |
| `docker compose up` to ready in under 5 minutes; rollback rehearsed | CTQ-15 | G2 |
| Audit trail for every security-relevant action | CTQ-16 | G2 |

### 8.2 Business (baselines to be validated)

| Metric | Why it matters | First measurement |
|---|---|---|
| Pilots that complete UAT on a real read-only PostgreSQL (Q05) | Proves the product works outside the original private example | G2 |
| UX round 1: unassisted task success >= 80 %, path efficiency <= 1.5, SUS >= 72 (Q04) | Proves drill-through is usable, not just complete | G2 |
| Review candidates with a recorded decision per project per month | Proves the review workflow is used, not just viewed | first pilot quarter |
| Time from pilot start to licensee security sign-off | Proves P6's job is served | first pilot |
| Conversion from pilot to paid license under option A | The revenue signal | after two pilots; target to be validated |

## 9. Risks and assumptions

### 9.1 Assumptions (each is a hypothesis to test, not a fact)

1. Organisations with large relational schemas will pay for an analysis and review layer distinct from their catalog and their IDE. To be validated with design partners.
2. Self-hosted deployment is acceptable or preferred by the first buyers because it keeps schema metadata on their side (P6).
3. PostgreSQL and SQLite cover the first pilots; MySQL/MariaDB and SQL Server are the next asks (L-03 and later).
4. Coding agents building against MVP-scoped documentation, with a human reviewer and CI gates, can deliver G1 and G2 without a larger team.
5. The caveat discipline (C01-C16) is a selling point to P1 and P6, not friction.

### 9.2 Risks (business view; the engineering risk register is `docs/product-management/risk-register.md`, D04)

| Risk | Impact | Mitigation |
|---|---|---|
| Private data from the original private example leaks into the repository through a filename, a constant, or prose | Breach of confidentiality; loss of trust before the first sale | Allowlisted export into a new directory, repo-neutral guard in CI and pre-commit, local-only denylist (CTQ-14; R00) |
| Docs-first becomes docs-only and the MVP slips | No product to pilot; sponsor confidence lost | MVP-scoped documents, hardening and fixtures in parallel (Phase 1), G0 reviews the business case, CTQs, feature registry, and F08/F14 first |
| A security incident at a pilot (unbounded query, credential exposure) | Ends the pilot and the reference | CTQ-07 and CTQ-08 as gate conditions; Security reviewer accountable for sign-off; threat model Q02 |
| Buyers expect breadth (many dialects, catalog features) rather than depth | Long sales cycles; feature pressure | Position as the analysis layer complementary to catalogs; dialect roadmap explicit in D6 |
| LICENSE and pricing unreviewed by Legal | Unenforceable terms; OEM conversations stall | DRAFT header on LICENSE until Legal review; pricing decision held until after two pilots |
| The product name is a working title | Rebranding cost after documents and repository names exist | Product Owner picks a name before the first external pilot (open question) |
| Single-person concentration of roles at MVP | Bottleneck; no independent security accountability | RACI names roles so that Security reviewer and Legal are filled by different people before the first external pilot |

## 10. Recommendation

Approve the business case at G0 with the MVP scope in `docs/business/product-vision-and-scope.md`, licensing option A for pilots, and the CTQ registry as the acceptance standard. Re-evaluate options B and C after two completed pilots with validated baselines for the business metrics in section 8.2.

## 11. Open questions for the product owner

1. Product name: the working name stays until you pick one (D7). When?
2. Who fills the Security reviewer and Legal roles for the first external pilot, given that they must be distinct from the Product Owner?
3. Which two design partners are candidates for pilots, and do they run PostgreSQL?
4. Is option B (hosted) a goal for the next twelve months, or a possibility to keep open? This affects how early L-08 is scheduled.
5. Should the offline artifact be licensed separately (for example, unlimited redistribution of exported artifacts within the licensee), or is it part of every seat?
