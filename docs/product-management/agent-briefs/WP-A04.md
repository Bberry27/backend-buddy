Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# WP-A04 Jobs, worker, snapshots, reviews

| Field | Value |
|---|---|
| Work package | A04 (track A, phase 2) |
| Features | F16, F17 (primary); F04 (`PUT/GET /reviews/{findingId}`), F19 (artifact export job), F05 (`erd_layouts`) |
| CTQs | CTQ-01, CTQ-06, CTQ-07, CTQ-08, CTQ-16 |
| Caveats | C01, C04, C05, C09, C13 (server-side wording quoted from `docs/reference/caveats.md`; the export footer carries C05) |
| Depends on | A02, A03 |
| Blocks | O01, Q02 |
| Branch | `a04/jobs-worker-snapshots-reviews` |
| Gate | G2 |

### 1. Goal

Deliver the asynchronous and stateful half of the API: a `FOR UPDATE SKIP LOCKED` job queue with `python -m app.worker` running `extract`, `profile`, and `export` jobs under per-table budgets and a job-level cap with cancel, partial results, and polling; snapshot upload (size cap, jsonschema + `normalize()`, sha256, ETag and gzip), list, and delete; workspaces/projects routers; `PUT/GET /reviews/{findingId}`, preferences, and ERD layouts; artifact export through `build_explorer.render()` with attachment headers and default stripping of `sampleValues` and string extremes; and a retention purge for `job_items`. A verifier can check the partial-result semantics defined in section 3 (`profiling.status: 'incomplete'`, unknown stays unknown), one running job per connection, cancel between items, and that no endpoint accepts arbitrary SQL.

### 2. Reading list (ordered)

1. `docs/features/F17-connections-and-profiling.md` and `F16-projects-and-snapshots.md` (D05): B-numbered behaviours for jobs, partial results, snapshot provenance (C09), immutability; `F04-schema-review.md` B3 and B5 (finding id, decisions API); `F19-exports.md` (artifact export, stripping defaults, C05 footer); `F05-living-erd.md` (server-side layouts).
2. `docs/architecture/overview.md` section 5 (data flows 5.1 snapshot ingest, 5.2 extraction, 5.3 profiling with partial results, 5.4 reviews, 5.5 export).
3. `docs/architecture/data-model.md` 3.6 `projects`, 3.7 `snapshots` (origin, `parent_snapshot_id`, `source`, counts, `size_bytes`), 3.10 `jobs` (status enum, budgets, `cancel_requested_at`, partial unique index), 3.11 `job_items` (status enum, `reason`, observability columns), 3.12 `review_decisions`, 3.13 `erd_layouts`, 3.14 `user_preferences`, 5 (retention), 6 (open questions 1-5; A04 decides or leaves explicitly open).
4. `docs/architecture/schema-graph-contract.md` part B (`profiling.status`, `rowCountLowerBound`, `sampleValues`, B4 validation pipeline: jsonschema then `normalize()`), `packages/contract/schema-graph.v1.json`, `bb_profiler/contract.py` (C01).
5. `docs/architecture/security-architecture.md` sections 4 step 4 (decrypt in the worker only, plaintext never in `jobs.error` or `job_items.reason`), 5 finding 8, 8 (no endpoint accepts SQL; worker runs only profiler SELECTs), 9 (export stripping).
6. `docs/architecture/deployment-architecture.md` 1 (worker service), 4 (`BB_JOB_*`, `BB_SNAPSHOT_MAX_BYTES`, `BB_WORKER_CONCURRENCY`).
7. `docs/architecture/adr/ADR-0003-backend-fastapi-and-contract-oracle.md` (`normalize()` imported, never reimplemented; `render()` for export).
8. `docs/reference/limits-and-caps.md` B (per-table 5/60 s, job cap 600/3,600 s, one running job per connection, samples 3 triple opt-in, snapshot size cap and `finding_id` length to be decided here) and `docs/reference/caveats.md` C01, C04, C05, C09, C13.
9. A03 deliverables: `bb_profiler.core` (`Budget`, `BoundedReader`, `profile_table` returning `status`/`reason`), `drivers.*.introspect`, `policy`, `targets`, `services/api/app/crypto/envelope.py`, connections repository.
10. A02 deliverables: `require_role`, audit service, settings, repositories pattern.
11. Legacy shapes to reuse: `packages/explorer/server/profile_snapshot.py` (batch job shape: `--tables`, `--limit`, `--include-sample-values`, output written only after success; `validate_output` at `snapshot_io.py:4`); `skill/scripts/build_explorer.py:21` `normalize`, `:99` `render(raw)`; `schema_profiler.py:382-385` (strip previously exported `sampleValues` before profiling; keep this in the merge).
12. `docs/engineering/security-policy.md`, `standards.md`, `testing-policy.md` (D03).

### 3. In scope

**Queue and worker**
- `app/jobs/queue.py`: claim with `SELECT ... FOR UPDATE SKIP LOCKED` ordered by `(status, created_at)`; `claimed_by` = worker instance id; heartbeat on `jobs.claimed_at`; requeue of stale claims (interval to be decided, proposal in the PR).
- `python -m app.worker`: loop with `BB_WORKER_CONCURRENCY` (default 1); decrypts the connection secret immediately before `open_readonly_session` and discards it after; fixed error strings only in `jobs.error` and `job_items.reason`.
- Job kinds: `extract` (`introspect()` -> new snapshot `origin='extraction'`, `source.basis='Live catalog extraction'`), `profile` (below), `export` (below).
- Cancel: `POST /jobs/{id}/cancel` sets `cancel_requested_at`; the worker checks between items; remaining items become `skipped` with `reason='cancelled'`; job status `cancelled`.
- One running job per connection enforced by the A01 partial unique index; the API returns 409 with the running job id.
- `GET /jobs/{id}`: status, per-item status and reason, `queries_used`, `elapsed_ms`, `rows_sampled`, remaining job budget (seconds), `result_snapshot_id`; list endpoint per project; audit `job.submit`, `job.cancel`, `job.finish`.

**Partial-result semantics for `profile` jobs (normative for A04, W-track consumers, and Q03)**
1. One `job_item` per selected table. Each item runs `profile_table` under `Budget(deadline_seconds=jobs.per_table_seconds)` (default 5, max 60) plus the query and row caps; the whole job runs under `jobs.cap_seconds` (default 600, hard max 3,600).
2. Item outcomes and what is written into the result graph for that table:
   - `done`: the sample completed and dependency analysis completed. Write `sampleSize`, `sampled: true`, `rowCountLowerBound`, column `profiling` per policy, table `profiling` with `status: 'complete'`. `rowCount` is written only when the sample was exhaustive (no overflow) or a measured total already existed, exactly as `schema_profiler.py:395-398` does today.
   - `partial`: the sample completed but a later step (dependency analysis or a column) hit the per-table deadline, the query budget, or a `statement_timeout`. Write what completed plus table `profiling: {status: 'incomplete', reason: <item reason>}`; columns not reached have no `profiling` key. `rowCount` follows the same rule as `done`.
   - `partial` with the sample itself cut off (deadline or `statement_timeout` during the `SELECT`): write nothing to the table except `profiling: {status: 'incomplete', reason}`; `rowCount`, `rowCountLowerBound`, `sampleSize`, and every column stay exactly as in the parent snapshot. **Unknown stays unknown: an incomplete item never writes `rowCount`, never writes `0`, and never writes a lower bound it did not observe.**
   - `skipped` (job cap reached, cancel, or one-running-job conflict at claim time): nothing is written; the table is unchanged; `reason` is `job cap`, `cancelled`, or `conflict`.
   - `failed` (driver error, policy error): nothing is written except `profiling: {status: 'incomplete', reason: 'driver error'}`; the redacted message goes to `job_items.reason`, never a DSN or value.
3. Job status: `succeeded` when every item is `done`; `partial` when at least one item is `done` and any item is `partial`, `skipped`, or `failed`; `failed` when no item is `done`; `cancelled` when cancel was requested and honoured.
4. Merge: the result snapshot is a deep copy of the parent graph (`parent_snapshot_id`, `origin='profile'`) with per-table updates only for `done`/`partial` items; previously exported `sampleValues` are stripped from the parent first (as `schema_profiler.py:382-385`); the merged graph passes jsonschema and `normalize()` before insert; `sha256` recorded. `test_A04_merge_incomplete_items_never_write_counts` proves rule 2 on a synthetic result with every outcome.
5. Metrics hooks for O03: `jobs_total{kind,status}`, `job_items_incomplete_total{reason}` incremented here (exporter lands in O03).

**Snapshots, projects, workspaces**
- `POST /w/{ws}/p/{project}/snapshots` (upload): body size cap `BB_SNAPSHOT_MAX_BYTES` (value to be decided; proposal in the PR with rationale, recorded in `limits-and-caps.md` B), `Content-Type: application/json`, jsonschema -> `normalize()` -> counts computed -> sha256 -> insert `origin='upload'`; duplicates by sha256 return the existing id; `GET` with `ETag` (sha256) and gzip; list with the provenance columns (C09 wording in the response `source` echo is the graph's own); soft delete with audit `snapshot.upload`/`snapshot.delete`.
- Projects and workspaces CRUD routers with `require_role` (owner/admin for mutation, viewer for read), tenant-scoped repositories, IDOR negatives 404.

**Reviews, preferences, layouts**
- `PUT/GET /w/{ws}/p/{project}/reviews/{findingId}`: `finding_id` is opaque, length-capped (value to be decided, recorded in `limits-and-caps.md` B), validated so that its table component names a table in the referenced snapshot (full finding parity is L-06); `decision` in (`open`, `investigate`, `intentional`, `resolved`); `note` length-capped; unique `(project_id, finding_id)`; audit `review.decide`; reviewer role.
- `GET/PUT /users/me/preferences` (theme, inspector open/closed, per the W01/W02 needs) and `GET/PUT .../layouts/{snapshotFingerprint}` for Living ERD positions (mirrors `backend-buddy-erd:v1:<project.key>:<fingerprint>`; bounds-checked like `parsePositions`).

**Export**
- `export` job: `build_explorer.render(graph)` on the snapshot; `sampleValues` and string `min`/`max` stripped unless the request carries `include_samples`/`include_extremes` and the connection/policy allow (mirror of the A03 triple opt-in); output stored temporarily and served by `GET /jobs/{id}/download` with `Content-Disposition: attachment`, `Content-Type: text/html`, `X-Content-Type-Options: nosniff`; the artifact's CSP is untouched by construction (`render()` never rewrites it); audit `export.download`. CSV/SVG exports remain client-side (W03).

**Retention**
- `python -m app.purge` (or a worker tick): deletes `job_items` past `retain_until` and finished `jobs` past `retain_until` (values to be decided, recorded); never touches `audit_events`.

**Tests** (`services/api/tests`): `test_A04_jobs.py` (`test_A04_merge_incomplete_items_never_write_counts`, `test_A04_one_running_job_per_connection_409`, `test_A04_cancel_between_items`, `test_A04_job_cap_marks_remaining_skipped`, `test_A04_partial_status_rules`), `test_A04_snapshots.py` (size cap, invalid contract 422, `normalize()` applied, sha256 dedupe, ETag/gzip, IDOR 404), `test_A04_reviews.py` (id cap, decision enum, audit row), `test_A04_export.py` (attachment headers, stripping default, opt-in, CSP string present byte-identically in the output), `test_A04_no_endpoint_accepts_sql` (in `test_security.py`: no request model has a field that reaches a cursor), `test_A04_audit_rows_for_jobs_exports_decisions`, `test_A04_purge.py`.

**Docs**: F16, F17 sections 3 and 14; F04, F19, F05 section 14 rows; `limits-and-caps.md` B rows for snapshot size cap and `finding_id` length filled in with the decided values (or left "to be decided" with the PR's proposal); `data-model.md` section 6 items marked decided or open; `openapi.json` regenerated.

### 4. Out of scope

- Connections CRUD, envelope encryption, `introspect()`, `profile_table`, `policy.py`, `targets.py` (A03; called here).
- Real PostgreSQL behaviour tests (Q03).
- Docker image, compose worker service definition (O01); metrics exporter, backup scripts (O03).
- Finding id redesign with sha256 and TS/Python parity (L-06).
- Retention scrubber for stored string extremes (L-04); reviews embedded in the export (L-05).
- Any schema change: if a column is missing, raise it as an open question; a new Alembic revision needs owner approval (A01 owns `0001`).
- Client-side CSV/SVG/PNG exports (W03, F19) and the SPA pages (W01).

### 5. May modify

```
services/api/app/jobs/**
services/api/app/worker.py
services/api/app/__main__.py                     (python -m app.worker / app.purge entry points)
services/api/app/purge.py
services/api/app/routers/{jobs,snapshots,projects,reviews,preferences,layouts,exports}.py
services/api/app/routers/workspaces.py           (project sub-resources only; A02 owns membership routes)
services/api/app/repositories/{jobs,snapshots,projects,reviews,preferences,layouts}.py
services/api/app/schemas/**                      (new request/response models)
services/api/app/services/{snapshots,merge,export}.py
services/api/openapi.json                        (regenerated)
services/api/tests/test_A04_*.py
services/api/tests/test_security.py              (test_A04_no_endpoint_accepts_sql)
docs/reference/limits-and-caps.md                (section B rows: snapshot size cap, finding_id length, retention values)
docs/architecture/data-model.md                  (section 6 only: decisions or still-open statements)
docs/features/F16-projects-and-snapshots.md      (sections 3 and 14 only)
docs/features/F17-connections-and-profiling.md   (sections 3 and 14 only)
docs/features/F04-schema-review.md               (section 14 only)
docs/features/F19-exports.md                     (section 14 only)
docs/features/F05-living-erd.md                  (section 14 only)
CHANGELOG.md                                     ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no Node dependency change
packages/**                             W and C tracks; bb_profiler is A03 (call it; a needed primitive is an open question)
services/api/alembic/**, services/api/app/models/**   A01
services/api/app/{auth,core,audit.py}   A02 (call, do not edit)
services/api/app/{crypto,routers/connections.py}       A03
skill/scripts/build_explorer.py         S01 (imported for normalize()/render(), never copied or edited)
skill/**                                S01, S03
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
deploy/**                               O01
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Partial-result semantics (section 3 rules 1-4): `profiling.status: 'incomplete'` with `reason`; an incomplete item never writes `rowCount`, `0`, or an unobserved lower bound; `skipped` writes nothing | this brief; `schema-graph-contract.md` B2; C01; CTQ-01, CTQ-08 | `test_A04_merge_incomplete_items_never_write_counts`, `test_A04_partial_status_rules`; Q03 `test_Q03_per_table_deadline_partial_with_reason` |
| Budgets: per-table default 5 s, max 60 s; job cap default 600 s, hard max 3,600 s; requests above the max are rejected (422), not clamped silently | `limits-and-caps.md` B; RK-06 | `test_A04_jobs.py` |
| One running job per connection (partial unique index; API 409) | `data-model.md` 3.10 | `test_A04_one_running_job_per_connection_409` |
| `normalize()` is the oracle and is imported from `skill/scripts/build_explorer.py`; jsonschema first, then `normalize()`; never reimplemented | D3; ADR-0003 | `test_A04_snapshots.py` asserts a `normalize()`-rejected graph is 422 with the oracle's message |
| Snapshots are immutable (`origin`, `parent_snapshot_id`, `sha256`, `contract_version`); soft delete only | `data-model.md` 3.7; C09 | `test_A04_snapshots.py` |
| No endpoint accepts arbitrary SQL; the worker executes only profiler-generated statements; draft SQL never executed | C04; CTQ-06 | `test_A04_no_endpoint_accepts_sql`; `scripts/sql-path-lint.mjs` (W03) |
| Secrets decrypted only in the worker, never in `jobs.error`, `job_items.reason`, logs, or snapshots | `security-architecture.md` 4 | `test_A04_jobs.py` error-hygiene case; `test_A02_log_redaction` |
| Export: `render()` output with `Content-Disposition: attachment`; `sampleValues` and string extremes stripped by default; artifact CSP byte-identical inside the output | D9; CTQ-05; RK-14 | `test_A04_export.py` |
| `finding_id` opaque, length-capped, unique per project; decision enum `open investigate intentional resolved` | `data-model.md` 3.12; F04 B3 | `test_A04_reviews.py` |
| Audit rows for `job.submit`, `job.cancel`, `job.finish`, `snapshot.upload`, `snapshot.delete`, `export.download`, `review.decide` | CTQ-16 | `test_A04_audit_rows_for_jobs_exports_decisions` |
| RBAC declared on every new route; IDOR negatives 404; tenant scoping on every repository | CTQ-07; `data-model.md` 4 | `test_rbac_matrix` (A02) grows with the new routes; `test_A01_tenant_scoping` |
| Storage key parity: `erd_layouts` keyed by `(project_id, snapshot fingerprint)` mirroring `backend-buddy-erd:v1:<project.key>:<fingerprint>` | C13; `data-model.md` 3.13 | `test_A04_layouts` |
| SchemaGraph backward compatibility: merge adds only optional fields | C01 | contract corpus tests |
| Environment contract names (`BB_JOB_*`, `BB_SNAPSHOT_MAX_BYTES`, `BB_WORKER_CONCURRENCY`) | `deployment-architecture.md` 4 | `test_A02_settings_reject_unknown` |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with `A04`/CTQ ids, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F16, F17; F04, F19, F05 section 14 rows)
- [ ] Migration: none, because A01's `0001` contains every table used (state the check); if a column proves missing, stop and raise it
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (worker-only decryption; error hygiene; upload abuse cases: oversize, wrong content type, deeply nested JSON, prototype-pollution keys are rejected by jsonschema/`normalize()`; export stripping)
- [ ] Accessibility result: not applicable, because no UI ships
- [ ] Performance measurement recorded: profile job of 20 tables on the SQLite fixture wall time and p95 over 5 runs (pre-baseline for CTQ-09's API p95 <= 3 s; the compose fixture number is Q01's)
- [ ] Caveat text: server-side strings carrying C01, C05, C09, or C13 wording quoted verbatim from `docs/reference/caveats.md`
- [ ] `npm run guard` green
- [ ] `npm run build`: not applicable, because `packages/explorer` is unchanged
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `limits-and-caps.md` B and `data-model.md` section 6 updated with every value decided here or an explicit "still open, owner, gate"
- [ ] Package-specific: `openapi.json` regenerated; W01's generated client types rebuilt in a follow-up W01 PR (note it in "Out of scope, found")

### 9. Acceptance commands

```sh
npm run guard
python -m pip install -r services/api/requirements.txt -r services/api/requirements-dev.txt -r packages/profiler/requirements.txt
export BB_TEST_DATABASE_URL=postgresql://backend-buddy:backend-buddy@localhost:5432/backend-buddy_test
cd services/api && alembic upgrade head && alembic history | wc -l && cd ../..        # one revision
python -m unittest discover -s services/api/tests -p 'test_*.py'                       # A01-A04 green, 0 skipped
python -m unittest services.api.tests.test_jobs -k test_A04_merge_incomplete_items_never_write_counts   # CTQ-01 proof (adjust module path to the layout)
python -m unittest services.api.tests.test_security -k test_A04_no_endpoint_accepts_sql               # CTQ-06
python -m coverage run -m unittest discover -s services/api/tests && python -m coverage report --fail-under=85   # CTQ-12 Python
python -m app.export_openapi --check                                                   # from services/api
pip-audit -r services/api/requirements.txt
python -m app.worker --once                                                            # processes one queued job against the SQLite fixture and exits 0
```

Package-specific assertions: after a `profile` job whose second item is forced to time out (test hook sets `per_table_seconds` to the minimum and uses the slow-view pattern from `test_schema_profiler.py:208-214`), `GET /jobs/{id}` shows `status: partial`, the item `reason` is `per-table deadline`, and the result snapshot's table has `profiling.status == 'incomplete'` and `rowCount` identical to the parent (`null`); `GET /snapshots/{id}` returns `ETag` equal to the hex sha256 and `Content-Encoding: gzip` when requested; the export download contains the exact artifact CSP string and no `sampleValues` key.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Include the outcome-to-write table from section 3 rule 2 with the test asserting each row.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-06 per-table budgets remove the whole-run guard | Job cap enforced by the worker between items; requests above the max rejected; remaining budget exposed in `GET /jobs/{id}`; one running job per connection. |
| RK-13 finding ids reopen decisions | `finding_id` opaque and length-capped; orphaned decisions are visible in the list endpoint, not deleted; L-06 pull-in is `risk-register.md` open question 1. |
| RK-14 sensitive values | Export strips `sampleValues` and string extremes by default; merge strips prior `sampleValues`; policy from A03 applied on write. |
| RK-08 master-key loss | Worker fails a job with a fixed "decryption failed" reason; `/readyz` already reports the mismatch (A02). |
| RK-21 no forensics | Every job transition audited with request id; `job_items` observability columns filled. |
| RK-01 private data | Tests use `fixtures/sql/sqlite/seed.sql` and synthetic graphs only. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |


---

## ADDENDUM (product owner, 2026-09-08) — overrides anything above that conflicts

Sections most relevant to this work package: **C, D**. Read all of it; the
flow spans several packages and each must not contradict the others.

The connection experience is a first-class product flow, not an administrative detail.
A user running the product locally opens a Connections page, adds a connection, enters
credentials once, and the engine populates the schema and its statistics from there. The
reference deployment target is **Azure Database for PostgreSQL**, and the design must not
assume a database on the same host.

### A. Private and local targets are ALLOWED by default

The original instruction had `targets.py` deny loopback, link-local and cloud metadata
addresses unless `BB_ALLOW_PRIVATE_TARGETS` was set. That is correct for a hosted
multi-tenant service, where a user-supplied host is an untrusted server-side request. It
is **wrong for the self-hosted MVP**, where the user owns the machine and connecting to
`localhost` or a private VNet address is the normal case, and a default deny would make
the product appear broken.

Implement a deployment mode instead:

- `BB_DEPLOYMENT_MODE=self-hosted` (the default): any target the operator can reach is
  allowed. Cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`,
  `169.254.170.2`) stay denied in every mode, because nothing legitimate profiles those
  and allowing them buys the user nothing.
- `BB_DEPLOYMENT_MODE=hosted`: the full deny-list applies, and only the connector-agent
  path may reach a private address. This mode is not exercised at MVP but the branch and
  its tests exist so the hosted edition is a configuration change, not a rewrite.

Document the reasoning where the setting is defined, so nobody "hardens" the default
later and breaks every local connection.

### B. TLS must work against Azure on the first try, without silently weakening

Azure enforces encryption in transit, and its hostnames look like
`<server>.postgres.database.azure.com`. Requirements:

- Offer `tls_mode` per connection: `verify-full` (default), `require`, `disable`.
  `disable` needs an explicit acknowledgement flag on the connection record.
- `verify-full` uses the system trust store, which already contains the DigiCert Global
  Root G2 that Azure chains to, so it should succeed unmodified. Allow an optional
  `ca_cert_pem` per connection for a private or rotated authority, written to a
  mode-0600 temporary file for the life of the connection and never logged.
- **Never silently downgrade.** If `verify-full` fails with a certificate or hostname
  error, the connection test must fail with an actionable message that names the cause
  and states that `require` encrypts without verifying identity, leaving the choice to
  the user. A tool that quietly falls back to an unverified channel is worse than one
  that fails.
- Set `sslmode` explicitly on every PostgreSQL connection. The current code sets
  `connect_timeout`, `options` and `autocommit` but leaves `sslmode` to libpq, whose
  default `prefer` will accept an unencrypted or unverified session without saying so.

Also handle the two Azure username shapes: Flexible Server takes a plain `user`, while
the legacy Single Server takes `user@servername`. Do not rewrite what the user typed;
if authentication fails and the host ends in `.postgres.database.azure.com` while the
username contains no `@`, say so in the error as a likely cause. A failed connection
must also distinguish a firewall rejection (timeout reaching the host) from a rejected
credential, because on Azure the first means an unconfigured firewall rule for the
client address and the second does not.

### C. A saved connection is stored configuration, not a held socket

"Stays connected" means the user enters credentials once and never again, not that a
socket stays open. Implement it as:

- The connection record persists: host, port, database, username, `tls_mode`, optional
  CA, and the envelope-encrypted password. `last_verified_at` and `last_error` are
  stored so the UI can show state without reconnecting.
- Every job opens a short-lived connection and closes it in a `finally`. A long-lived
  pooled connection to a customer database is a liability: it holds a server slot,
  survives credential rotation invisibly, and gives an idle process live read access.
- The UI shows `Verified 4 minutes ago`, never `Connected`, because the latter is a
  claim the product cannot make between jobs.
- Re-testing a connection is always available and is the only thing that updates
  `last_verified_at`.

### D. One guided flow, not four disconnected buttons

From the user's point of view adding a connection and seeing their schema is a single
action. Sequence it as one flow with visible progress and a resumable state per step:

1. **Add connection.** Host, port, database, username, password, TLS mode. Password is
   write-only from the moment it is submitted.
2. **Test.** A bounded round trip that authenticates and confirms catalog read access.
   Report a specific failure, not "connection failed".
3. **Populate structure.** Run `introspect()` and create the first snapshot. This is the
   step that makes the thirteen views show the user's own schema, so it is the moment the
   product becomes theirs. It reads catalog metadata only and touches no table rows.
4. **Populate statistics (optional, separate consent).** Profile selected tables for row
   counts and column statistics. This step reads rows, so it is never implicit: it is a
   distinct action with the scope, the caps, and the redaction policy stated on screen
   before it runs. Default to structure-only.

Steps 3 and 4 must be separately choosable, because the first is metadata and the second
touches data, and conflating them would take a decision away from the user that they are
entitled to make.

### E. What the user must do outside the product, and the product must tell them

Surface these in the Connections page as help text, since each is a common first failure:

- A dedicated read-only role, not an application user and not a superuser. The profiler
  asks the session to be read-only but cannot verify the credential lacks write grants.
- On Azure, a firewall rule permitting the client address, or private access configured.
- That column minimum and maximum values are real values from their tables and are part
  of a profile, and that sample values are separately opt-in and capped.


---

## ADDENDUM 2 (product owner, 2026-09-08) — deployment shape and container networking

Sections most relevant to this work package: **H**. Read all of it.

The product owner restated the target: **a local deployment that anyone can run**, where
the user adds their own database connections and sees their own data. Not a hosted
service. Two consequences, and the second is the most common reason a containerised
database tool appears broken on first use.

### F. Single-tenant local deployment is the shipping shape

`BB_DEPLOYMENT_MODE=self-hosted` is the default and the only mode exercised. The
workspace and role machinery stays, because it costs little and stored database
credentials must not be readable by an unauthenticated caller, but first run must be
trivial: one owner account created by a documented bootstrap command, no external
identity provider, no invitations, nothing to configure before the product is usable.
Optimise every decision for one person on one machine reaching their own databases.

### G. Connections are made from inside a container, so `localhost` is a trap

The API and worker run in a container. Inside it, `localhost` and `127.0.0.1` mean *the
container*, not the user's machine. A user who types `localhost` for a database running
on their host gets a connection refused that says nothing useful, and this is the single
most likely first-run failure. Handle all three topologies explicitly.

**1. A database on the user's own machine.** The container must reach the host. Add to
every service that opens database connections:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Docker Desktop on Windows and macOS resolves that name already; the mapping is what makes
it work on Linux, so include it unconditionally. Then, in `targets.py`, when the API is
running in a container and the user supplies `localhost`, `127.0.0.1`, or `::1`:

- Do not silently rewrite what they typed. Storing a host different from the one entered
  makes later failures inexplicable.
- Resolve and attempt `host.docker.internal` as a **documented fallback** when the literal
  host fails to connect, and on success report clearly that the host was reached through
  the container's host gateway and offer to save that instead.
- If both fail, the error must name the cause: the database is on the host but the API is
  in a container, and `host.docker.internal` is the address to use.

Detect containerisation rather than guessing: `BB_IN_CONTAINER=1` set by compose, with
the presence of `/.dockerenv` as a secondary signal. A test must cover both the detected
and undetected paths.

**2. A managed database such as Azure Database for PostgreSQL.** Outbound access works on
the default bridge network, so nothing in compose changes. What fails is the provider
firewall, and the message must say so: the rule must permit the **host machine's public
address**, not the container's private address, which the provider never sees. Distinguish
a firewall rejection, which presents as a connection timeout, from a rejected credential,
which returns promptly. Confirm DNS resolves inside the container before reporting a
network failure, so a broken resolver is not reported as a firewall problem.

**3. A database in another container.** Reaching it requires a shared Docker network and
the service or container name as the host. Document both the compose-level
`networks: [backend-buddy]` approach for a database defined in the same file, and
`docker network connect` for one from an unrelated project. This must be documentation,
not automation: joining another project's network on a user's behalf is not the product's
decision to make.

### H. First run shows an empty state, not sample data dressed as real data

The current build renders a synthetic fixture, and a user cannot tell from the interface
that what they are looking at is not their database. That is misleading, and it is the
specific complaint that produced this addendum.

- With no snapshot, the application opens on the Connections page with an empty state
  explaining that no database is connected yet. It does not open on sample data.
- The bundled fixture becomes an explicit, labelled action, something like "Explore a
  sample schema", and while a sample snapshot is loaded every view carries a persistent
  marker naming it as sample data. The marker is not dismissible.
- A snapshot records its origin, and the interface shows it: sample, uploaded file, or
  extracted from a named connection. A user must always be able to answer "whose data am
  I looking at" without leaving the page.
