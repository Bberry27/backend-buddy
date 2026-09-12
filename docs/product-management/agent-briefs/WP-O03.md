Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# WP-O03 Observability MVP

| Field | Value |
|---|---|
| Work package | O03 (track O, phase 2) |
| Features | none (cross-cutting); F17 metrics (`jobs_total`, `job_items_incomplete_total`, `profiler_redactions_total`) |
| CTQs | CTQ-16 (primary), CTQ-15 (backup/restore scripts exercised in compose-smoke) |
| Caveats | none surfaced |
| Depends on | O01 |
| Blocks | none (Q05 collects the results) |
| Branch | `o03/observability` |
| Gate | G2 |

### 1. Goal

Add the observability floor the MVP definition requires: a structlog redaction test that proves DSNs, passwords, tokens, cookies, and sampled values never reach a log line; a metrics endpoint exposing `http_requests_total`, `jobs_total{kind,status}`, `job_items_incomplete_total{reason}`, and `profiler_redactions_total{class}`; `/healthz` and `/readyz` verified end to end; and `ops/backup.sh` and `ops/restore.sh` that wrap the O01 runbook and are exercised once in the `compose-smoke` job. A verifier can check `test_O03_metrics_exposed`, `test_A02_log_redaction` passing under the final processor chain, and a backup/restore cycle restoring a snapshot row.

### 2. Reading list (ordered)

1. `docs/product-management/ctq.md` CTQ-16 (metric names, test names `test_O03_metrics_exposed`, `test_A02_log_redaction`) and CTQ-15.
2. `docs/architecture/deployment-architecture.md` 6 (health, readiness, logs, metrics exposed for scraping; OpenTelemetry is L-04), 7 (backup and restore outline; `ops/backup.sh`, `ops/restore.sh` land here).
3. `docs/architecture/security-architecture.md` 9 (redaction processor scope), 4 step 4 (plaintext secrets never in logs).
4. `docs/architecture/data-model.md` 3.15 (`audit_events.request_id` correlates with logs) and 3.11 (`job_items.reason` values feed `job_items_incomplete_total{reason}`).
5. `docs/product-management/risk-register.md` RK-21 (no forensics in the loopback server; the API must not repeat it), RK-08 (master-key backup step).
6. A02 deliverables `services/api/app/core/logging.py` (request id, redaction processor) and `health` router; A03 `policy.py` redaction counter; A04 job transitions (metric increment hooks).
7. `docs/operations/backup-and-restore.md` (O01): the manual procedure the scripts automate.
8. `docs/engineering/security-policy.md`, `standards.md`, `testing-policy.md` (D03).

### 3. In scope

- `services/api/app/core/metrics.py`: Prometheus text exposition at `GET /metrics` (viewer role or internal network only; decide per `security-policy.md`, record the choice) with counters `http_requests_total{method,route,status}`, `jobs_total{kind,status}`, `job_items_incomplete_total{reason}`, `profiler_redactions_total{class}`; no high-cardinality labels (no ids, no table names).
- Increment sites: request middleware (A02's), job finish (A04's queue), item finish (A04's worker), policy redaction (A03's counter drained by the worker).
- `services/api/tests/test_O03_metrics.py` (`test_O03_metrics_exposed` asserts all four metric families and label sets after one profile job on the SQLite fixture), `test_O03_no_high_cardinality_labels`.
- Redaction: extend the A02 processor if the test finds a gap (sampled values in `details`, cookie headers, `Authorization`); `test_A02_log_redaction` remains the pinning test and gains the cases found; log line schema documented (`ts`, `level`, `event`, `request_id`, `workspace_id`, `actor`, `route`, `status`, `duration_ms`).
- `ops/backup.sh`: `pg_dump` from the `db` container to a timestamped, permission-restricted file; reminder output that the master key must be backed up separately and encrypted; exit codes documented. `ops/restore.sh`: restore into a fresh `db`, run `migrate`, check `/readyz`, print the fingerprint result. Both POSIX sh, shellcheck clean, no secrets in argv.
- `compose-smoke` (O01's job): one added step that runs backup, wipes the volume, restores, and asserts a previously uploaded snapshot row exists (synthetic fixture only).
- `docs/operations/backup-and-restore.md` updated to reference the scripts; `docs/operations/observability.md` (new): log schema, metrics catalogue, scrape guidance, what is L-04.
- CHANGELOG line.

### 4. Out of scope

- OpenTelemetry tracing, Prometheus server, dashboards, alert rules, retention scrubber, key rewrap CLI (L-04).
- Audit event emission itself (A02, A03, A04 own their rows); O03 only verifies the correlation id.
- Changing log or metric names after this PR (needs a CTQ-16 row update).
- Docker or compose changes beyond the one `compose-smoke` step (O01).

### 5. May modify

```
services/api/app/core/metrics.py
services/api/app/core/logging.py            (redaction processor cases only; coordinate with A02 owner)
services/api/app/routers/metrics.py
services/api/app/main.py                     (mount the metrics router and middleware only)
services/api/tests/test_O03_*.py
services/api/tests/test_A02_logging.py       (add redaction cases found; keep existing assertions)
ops/backup.sh
ops/restore.sh
.github/workflows/ci.yml                     (one backup/restore step inside compose-smoke only)
docs/operations/backup-and-restore.md
docs/operations/observability.md
CHANGELOG.md                                 ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no Node dependency change
services/api/requirements*.txt          unless a metrics client is added; then list the exact pin in the PR and record it as a deviation
services/api/alembic/**, app/models/**  A01
services/api/app/{auth,audit.py}        A02
services/api/app/{crypto,routers/connections.py}   A03
services/api/app/{jobs,worker.py,routers/*}   A04 (metric increments are added through a hook A04 exposes; if none exists, report it)
deploy/**                               O01
packages/**, skill/**                   other tracks
docs/reference/caveats.md               frozen at G0
.github/workflows/{security,release,nightly}.yml   O02
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Metric names and label sets: `http_requests_total{method,route,status}`, `jobs_total{kind,status}`, `job_items_incomplete_total{reason}`, `profiler_redactions_total{class}` | CTQ-16; `deployment-architecture.md` 6 | `test_O03_metrics_exposed` |
| No high-cardinality labels (no ids, table names, DSNs) | `security-policy.md` | `test_O03_no_high_cardinality_labels` |
| JSON logs carry `request_id`; redaction covers DSNs, passwords, tokens, cookies, `Authorization`, sampled values | CTQ-16; `security-architecture.md` 9 | `test_A02_log_redaction` |
| `/healthz` and `/readyz` semantics unchanged (A02) | `deployment-architecture.md` 6 | `test_A02_readyz_master_key_mismatch` |
| Backups contain no plaintext secret; master key backed up separately | RK-08; `deployment-architecture.md` 7 | `ops/backup.sh` never reads the key file; shellcheck |
| Audit rows insert-only; O03 adds no path that mutates them | CTQ-16 | `test_A01_audit_update_delete_rejected` |
| Environment contract: any new variable (`BB_METRICS_*`) is added to `deployment-architecture.md` 4 and `.env.example` in the same PR, or not introduced | `deployment-architecture.md` 4 | `test_A02_settings_reject_unknown` |

### 8. Deliverables checklist (definition of done)

- [ ] Code, scripts, and tests, test names prefixed with `O03`/CTQ ids, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14: not applicable, because no feature surface changes; `docs/operations/*` updated instead
- [ ] Migration: none, because no schema changes
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (metrics exposure decision recorded; redaction cases; scripts free of secrets in argv)
- [ ] Accessibility result: not applicable
- [ ] Performance measurement recorded: `/metrics` response time and size after 1,000 requests (no budget; recorded)
- [ ] Caveat text: not applicable
- [ ] `npm run guard` green
- [ ] `npm run build`: not applicable
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: backup and restore exercised once in `compose-smoke` with the transcript linked

### 9. Acceptance commands

```sh
npm run guard
python -m unittest discover -s services/api/tests -p 'test_O03_*.py'
python -m unittest discover -s services/api/tests -p 'test_A02_logging.py'
shellcheck ops/backup.sh ops/restore.sh
docker compose -f deploy/compose.yml up -d --wait --wait-timeout 300
curl -fsS http://127.0.0.1:8000/metrics | grep -E '^(http_requests_total|jobs_total|job_items_incomplete_total|profiler_redactions_total)' | head
sh ops/backup.sh /tmp/backend-buddy-backup && docker compose -f deploy/compose.yml down -v && docker compose -f deploy/compose.yml up -d db --wait && sh ops/restore.sh /tmp/backend-buddy-backup/<file>.dump && curl -fsS http://127.0.0.1:8000/readyz
docker compose -f deploy/compose.yml logs api | python -c "import sys,json; [json.loads(l.split(' ',1)[-1]) for l in sys.stdin if l.strip().endswith('}')]"   # every line parses as JSON
docker compose -f deploy/compose.yml down -v
```

Package-specific assertions: after one profile job with a forced incomplete item, `job_items_incomplete_total{reason="per-table deadline"}` equals 1 and `jobs_total{kind="profile",status="partial"}` equals 1; no log line contains the fixture DSN password.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-21 no forensics | Request ids in every log line and in audit rows; metrics for job outcomes. |
| RK-08 master-key loss | `backup.sh` prints the separate-key-backup reminder and exits non-zero if `--acknowledge-key-backup` is absent (proposal; record as a decision). |
| RK-14 sensitive values | Redaction covers sampled values and `details`; metrics carry no values. |
| RK-06 runaway jobs | `jobs_total{status="running"}` per kind lets operators see saturation; per-connection limit is A04's. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
