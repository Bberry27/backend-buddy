Status: draft | Owner: Product owner | Last verified against code: pre-repo (2026-09-07)

# Product vision and scope

This document fixes what the product is, what the MVP contains, what is deliberately excluded until later phases, and the principles that every feature, document, and agent brief must obey. It is the scope reference for gate G0 and for the roadmap (`docs/product-management/roadmap.md`, D04). The business rationale is in `docs/business/business-case.md`. Feature ids resolve in `docs/features/README.md`; caveat ids in `docs/reference/caveats.md`; decisions D1-D9 and work-package ids (R, S, C, W, A, O, Q, L) are those of the approved plan.

## 1. Vision statement

Backend Buddy lets the people who own a relational database see how it is built, where it is weak, and what changed, from evidence they can trust, without ever putting that database at risk.

It does this with thirteen linked analytical views over one schema graph, a bounded read-only profiler that never fabricates a number, a review workflow that records decisions instead of verdicts, and an offline artifact that carries every caveat with it. It runs where the schema owner controls the data.

In one sentence for a licensee: an evidence-bound analysis and review layer for one relational schema at a time.

## 2. What the product is and is not

| It is | It is not |
|---|---|
| A self-hosted web application plus an offline HTML artifact and a portable skill (`skill/`) | A data catalog, a lineage tool, or a general diagramming tool |
| Read-only towards every target database, by construction | A migration runner, a schema editor, or a query console |
| Analytical: findings are candidates with evidence and caveats | An authority: it never declares a schema normalized, correct, or defective |
| Single-tenant self-hosted at MVP, structured so a hosted service does not need a rewrite (D4) | A multi-tenant SaaS at MVP (L-08) |

## 3. In scope: MVP definition

The MVP is met when the following end-to-end statement is true on a clean clone (plan, gate G2). Each clause names the feature and work package that delivers it.

A licensee admin:

1. runs `docker compose up` from a clean clone and the stack reports ready at `/readyz` in under 5 minutes (O01; CTQ-15);
2. bootstraps the first owner account with a one-time password (`python -m app.bootstrap`, A02; F20);
3. creates a workspace and a project (A04; F16, F20);
4. either uploads a `SchemaGraph` snapshot, validated against `packages/contract/schema-graph.v1.json` and `build_explorer.normalize()` (C01, A04; F16), or registers a read-only PostgreSQL or SQLite connection whose credentials are envelope-encrypted, write-only, and never returned to the browser (A03; F17, D5, D6);
5. tests the connection, extracts the catalog into an immutable snapshot with `source.basis='Live catalog extraction'` (A03 `introspect()`, A04; F17, C09);
6. profiles selected tables as a background job with per-table budgets, partial results, and `profiling.status:'incomplete'` where the budget ran out (A03, A04; F17, CTQ-08, C01, C05);
7. navigates all thirteen views plus Insights v0 (W03, W04, W06; F01-F13, F18) with bidirectional, deep-linkable drill-through under the route `/w/:ws/p/:project/s/:snapshot/:view` (C03, W04; F14, CTQ-10) and a persistent inspector (W02; F15);
8. uses the completed Schema City MVP: unknown-rows banner with profile action, search and fly-to, inbound selection highlight, district labels in scene, a 12-hue colour-vision-safe palette, inspectable roads, keyboard table-list drawer, persisted view state, no remount on filter change (W05; F08);
9. records review decisions server-side (`PUT/GET /reviews/{findingId}`, A04; F04, F16, C13);
10. exports CSV, SVG, PNG, and the offline artifact, with `sampleValues` and string extremes stripped unless the exporter opts in (A04; F19, F22, CTQ-05);
11. sees an insert-only audit trail covering login, key and connection changes, jobs, exports, and decisions (A02; CTQ-16);
12. can roll back by image tag plus Alembic downgrade (O01, A01; CTQ-15).

Supporting scope that the statement depends on:

- **Security baseline** (D5, S01-S03, A02, Q02): local accounts with argon2id, server-side sessions, CSRF, RBAC (owner/admin/reviewer/viewer), API keys, strict SPA CSP, hardened offline artifact and loopback server, threat model with control-to-test mapping.
- **Contract v1** (D3, C01): JSON Schema as the source of truth, generated TypeScript types, Python validation, backward compatible with today's `SchemaGraph`.
- **Design tokens and theming** (C02; F21): sixteen host variables preserved byte-identically, semantic tokens, six data palettes with light and dark values, contrast and colour-vision-deficiency tests.
- **Synthetic fixtures** (R01): generated schemas (`small`, `medium`, `medium-measured`, `large`, `edge-cases`, `many-domains`, `hostile`, `empty`) so that nothing in the repository depends on the original private example (CTQ-14).
- **Test toolchain and CI** (S02, O02, Q01-Q03): Playwright with bundled Chromium, axe, Vitest, coverage gates, size budgets, real-PostgreSQL profiler tests, performance baselines.
- **Documentation** (D00-D08): registries, architecture and ADRs, engineering standards, developer docs, feature documents F01-F22, agent briefs, operations runbooks for deployment and rollback.
- **Dialects**: PostgreSQL and SQLite only (D6).
- **Deployment**: single-tenant Docker Compose (`db`, `migrate`, `api`, `worker`), TLS terminated at the operator's reverse proxy (D4).

## 4. Explicitly out of scope until later phases

Listed so that a pilot, a brief, or a PR cannot pull them in by accident. "Phase" refers to the plan's Later items (L-01..L-09) and to the post-MVP City list.

| Excluded from MVP | Why now | Earliest phase |
|---|---|---|
| Multi-tenant hosted service, billing, OIDC/SAML, customer-side connector agent | Requires tenant enforcement and identity work that the MVP structure supports but does not need (`workspace_id` everywhere, `connections.mode` reserved) | L-08 |
| MySQL/MariaDB, SQL Server, Snowflake, BigQuery, Oracle drivers; ORM-source adapters (SQLAlchemy, Prisma) | Two dialects exist and cover the CI path; each new driver needs a conformance harness | L-03 (MySQL/MariaDB) then L-08 |
| Schema City scale and polish: in-view filter chips, minimap and compass, grid picker, label budget and LOD for 1,000+ tables, keyboard camera, PNG/SVG export with caveat footer, hatched `rowCountLowerBound` heights, glass material for `kind:'view'`, discovered-community naming | The MVP City list (section 3, item 8) is what the orientation view needs to be usable; scale work follows measured baselines (Q01) | L-02 |
| Nightly visual-regression matrix | Baselines must stabilise on shared CI first | L-01 |
| OpenTelemetry, Prometheus server, retention scrubber for string extremes, key rewrap CLI | Observability MVP (O03) ships JSON logs, metrics endpoints, and health checks; the rest waits for an operator asking | L-04 |
| Artifact host bridge: hash deep links inside the artifact, "Open in" inside the artifact, reviews embedded in the export, localStorage state import | The artifact must stay byte-compatible with today's CSP (D9); bridge work follows the SPA contract | L-05 |
| sha256 finding signatures with TypeScript/Python parity | MVP uses the existing finding-id signature scheme; a hash scheme is a contract change | L-06 |
| Trivy gate, ZAP, SBOM, cosign, Caddy TLS profile, Lighthouse | Security CI at MVP is audits, gitleaks, guard, and the Q02 test suite | L-07 |
| GitHub labels, issue forms, CODEOWNERS sync | Governance tooling, not product | L-09 |
| Schema editing, migration execution, any write path to a target database | Contradicts principle 3 permanently, not just at MVP | never |
| Naming the product | Working name until the Product Owner decides (D7) | before first external pilot |

## 5. Principles

Five principles bind every feature document (section 4 "Intended behaviour" and section 7 "Caveats"), every agent brief, and every PR review. Where a principle is backed by a caveat, the caveat is quoted verbatim from `docs/reference/caveats.md`; the wording is frozen at G0 and is never paraphrased.

### 5.1 Evidence over inference

Every claim a view makes traces to evidence the user can inspect: a declared constraint, a catalog row, a sampled statistic with its sample size, or a named heuristic. Inference is allowed, but it is always labelled as such and never dressed as fact.

C07:

> Declared evidence (from the identified source or catalog) and inferred evidence (from naming or heuristics) are visibly distinguishable in every view, export, and finding. An inferred reference never receives a declared label, and an unresolved inferred target never produces an executable validation query.

C08:

> Heuristic findings are review candidates, not verdicts. Each finding names its columns, its observable evidence, why it might matter, and what would confirm or dismiss it. A structural heuristic does not prove a normal-form violation, a functional dependency, or a design defect.

C05:

> Sampled evidence is not proof. A capped sample cannot establish an exact row count, a functional dependency, uniqueness, or a normal form. The absence of a sampled violation does not earn a clean result, and an unprofiled table is never described as normalized.

Consequence for the MVP: Insights v0 (F18) presents items with C08 wording and a link to the evidence; the review record stores a decision, not a verdict.

### 5.2 Unknown stays unknown

A number the product did not measure is shown as unknown, never as zero and never as a stand-in derived from something else. This is CTQ-01 and the reason profiling returns partial results with a reason instead of failing or filling gaps.

C01:

> Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero.

Consequence for the MVP: `rowCount: null` and `rowCountLowerBound` are distinct contract fields (C01 work package), `data-rowcount="unknown"` and `"0"` are distinguishable in the DOM (CTQ-01), and Schema City shows an unknown-rows banner instead of flat buildings with no explanation (W05).

### 5.3 Read-only by construction

The product cannot write to a target database, and nothing it generates is ever executed by it. This is enforced in code (read-only sessions, allowlisted identifiers, SELECT-only statements, caps on rows, depth, parameters, queries, and time) and tested against a real PostgreSQL (CTQ-06, CTQ-08), not promised in a settings page.

C14:

> The product never discovers or connects to a database implicitly, and never to production to make a view look populated. Live access uses only a connection the user explicitly selected, opened read-only with bounded queries, and a metadata request never authorizes scanning customer rows.

C04:

> Migration SQL and validation SQL are drafts for human review. The product never executes them, never offers a control that executes them, and never opens a database connection on their behalf.

Consequence for the MVP: a drill-through may prefill a live query (for example Column Table PK column to Fan-out row mode, registry entry P10) but never runs it without a click; the static lint in CTQ-06 proves that no path leads from `migrationDraft` or validation SQL to a connection.

### 5.4 Drill-through everywhere

Every one of the thirteen views accepts a selection from outside and emits selections and navigation targets to the rest of the product, so that an investigation can move between perspectives without losing context, and every state is a URL that can be shared. Filtering never rebuilds a view (zero remounts over twenty keystrokes, CTQ-10).

Convenience state that makes navigation pleasant (theme, layouts, camera, local decisions) is local and isolated per project; the review record of a team lives on the server.

C13:

> Browser storage holds convenience state only: theme, layouts, camera, and local decisions. It is not a team review database. Every stored key is scoped by the project's stable key (and, where the data depends on the schema, by the snapshot fingerprint) so that different projects and environments never read or overwrite each other's state.

Consequence for the MVP: the navigation contract (C03) is additive so the nine existing views compile untouched; the registry entries P1-P10 (W04) are the acceptance matrix; the inspector (W02) is the hub.

### 5.5 Offline artifact preserved

The single-file offline artifact and the portable skill keep working in every release: same CSP byte for byte, zero network requests, same `SchemaGraph` contract with backward compatibility, and a hardened loopback server for optional live mode (D9, CTQ-05). The web application is the primary experience, but a licensee can always hand someone an HTML file that carries every caveat with it.

C16 applies to the artifact and the web application alike:

> The flat, accessible rendering (flat SVG City, keyboard-reachable tables, text alternatives for canvas and WebGL surfaces) remains available in every release. It uses the same layout data as the 3D scene, can be chosen at any time, and is entered automatically when WebGL is unavailable or lost.

Consequence for the MVP: shell-neutral modules (tokens, theme, route state, selection, navigation registry, inspector, ported host views) live in `packages/explorer` so both shells reuse them (D1); the artifact export is a server job that calls the same renderer (`build_explorer.render()`, A04).

## 6. Constraints inherited from the approved decisions

| Decision | Constraint on scope |
|---|---|
| D1 | Frontend is Vite + React 19 + TypeScript + React Router 7 in `packages/web`; the esbuild IIFE remains only as the artifact export path |
| D2 | Backend is Python 3.13 FastAPI with a worker from the same image; app metadata in PostgreSQL 16 with Alembic |
| D3 | `packages/contract/schema-graph.v1.json` is the contract source of truth; `normalize()` stays the semantic oracle |
| D4 | Single-tenant Docker Compose at MVP; every tenant-scoped table carries `workspace_id` |
| D5 | Local accounts, sessions, CSRF, RBAC, API keys; envelope-encrypted connection secrets; OIDC/SAML later |
| D6 | PostgreSQL and SQLite at MVP |
| D7 | Private repository `Bberry27/backend-buddy`; proprietary LICENSE with DRAFT header; working product name |
| D8 | Caveats authored once in `docs/reference/caveats.md`, mirrored in `caveat-strings.ts`, linted |
| D9 | Skill, artifact CSP, and `SchemaGraph` backward compatibility preserved |

## 7. Gates

| Gate | Meaning | Scope decision it unlocks |
|---|---|---|
| G0 | Owner approves business case, CTQ registry, roadmap, feature registry, F08 and F14 documents; caveat wording frozen | Web track (W01) may start |
| G1 | Clean clone builds and tests green on fixtures only; private-data guard green; eight security findings closed with regression tests; artifact CSP byte-identical | MVP build proceeds on a hardened base |
| G2 | MVP definition (section 3) met with every CTQ measured and UX round 1 complete | First external pilot; pricing conversation may start |

## 8. Open questions for the product owner

1. Is Insights v0 (F18) a must-have for G2, or may it slip to the first post-MVP release if the web track is late? The MVP statement above includes it, per the plan.
2. Should SQLite be positioned to licensees at all, or kept as the CI and demo path only? This affects the connections page copy and the pilot pitch.
3. Do pilots need the offline artifact export at G2, or is the web application enough for the first pilot? The plan includes it; confirming lets the export job be sequenced last within A04 if needed.
4. Product name and the date by which it must be chosen (also raised in the business case).
