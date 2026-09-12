Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# WP-A01 Metadata model and migrations

| Field | Value |
|---|---|
| Work package | A01 (track A, phase 2) |
| Features | F16, F20 (data model only); F17 and F04 tables are created here and used by A03/A04 |
| CTQs | CTQ-07 (tenant scoping), CTQ-15 (upgrade/downgrade/upgrade), CTQ-16 (audit insert-only) |
| Caveats | none surfaced (no UI); C13 informs `review_decisions` and `erd_layouts` as the server-side records |
| Depends on | C01 |
| Blocks | A02, A03 |
| Branch | `a01/metadata-model` |
| Gate | G2 |

### 1. Goal

Create `services/api` as a Python 3.13 package with SQLAlchemy models for the fifteen metadata tables in `docs/architecture/data-model.md`, Alembic revision `0001` with a working `downgrade()`, `ops/sql/roles.sql` granting the API role least privilege (insert and select only on `audit_events`), the insert-only trigger on `audit_events`, and tests that prove upgrade -> downgrade -> upgrade on PostgreSQL 16 and that every tenant-scoped table carries `workspace_id`. No routes, no auth, no worker: those are A02-A04. A verifier can check the migration round trip, the trigger rejecting UPDATE/DELETE with errcode `42501`, and the static tenant-scoping check.

### 2. Reading list (ordered)

1. `docs/features/F16-projects-and-snapshots.md` and `F20-auth-and-workspaces.md` (D05): the entities and provenance fields the tables must hold; section 6 data-contract dependencies.
2. `docs/architecture/data-model.md` in full: sections 1 (conventions), 3.1-3.15 (columns, checks, indexes, the partial unique index on `jobs`, the `audit_events` trigger SQL verbatim), 4 (tenant-scoping summary), 5 (retention), 6 (open questions A01/A04 must answer or leave explicitly open).
3. `docs/architecture/schema-graph-contract.md` part B (`contractVersion`, `profiling.status`) and `packages/contract/schema-graph.v1.json` (C01): `snapshots.graph` is validated against it before insert (A04) and `snapshots.contract_version` is copied from it.
4. `docs/architecture/security-architecture.md` sections 4 (envelope encryption fields `encrypted_secret`, `key_id`, `encryption_keys.master_key_fingerprint`), 7 (session and CSRF columns).
5. `docs/architecture/deployment-architecture.md` sections 1 (the `migrate` one-shot service and `depends_on` ordering), 4 (`BB_DB_*` variables), 8 (every migration ships a tested downgrade).
6. `docs/architecture/adr/ADR-0003-backend-fastapi-and-contract-oracle.md`, `ADR-0005-auth-and-credential-encryption.md`, `ADR-0006-deployment-topology-and-artifact-csp.md`.
7. `docs/reference/limits-and-caps.md` section B (per-table and job caps become `jobs.per_table_seconds` and `jobs.cap_seconds` defaults; values to be decided are left as open questions, not invented).
8. `fixtures/sql/pg/seed.sql` (R01): the fixture database the dev overlay seeds; it is a customer-side database, not the metadata store, and must not be mixed into `0001`.
9. `docs/engineering/standards.md`, `security-policy.md`, `testing-policy.md` (D03); `docs/developer/setup.md` for the Python toolchain.

### 3. In scope

- `services/api/pyproject.toml` (or `requirements.txt` with pins, per `standards.md`), package `services/api/app` with `models/` (SQLAlchemy 2.x declarative), `db.py` (engine from `BB_DB_*` and `BB_DB_PASSWORD_FILE`), `alembic.ini`, `alembic/env.py`, `alembic/versions/0001_initial.py`.
- Tables exactly as `data-model.md` section 3: `workspaces`, `users`, `workspace_members`, `sessions`, `api_keys`, `projects`, `snapshots`, `connections`, `encryption_keys`, `jobs`, `job_items`, `review_decisions`, `erd_layouts`, `user_preferences`, `audit_events`; every check constraint, unique, index, and the partial unique index `(connection_id) where status in ('queued','running')`.
- `audit_events` trigger `audit_events_no_update_delete` with the function text from `data-model.md` 3.15 (errcode `42501`), created in `0001` and dropped in its `downgrade()`.
- `ops/sql/roles.sql`: `backend-buddy_app` role with `insert, select` on `audit_events` and table-level grants elsewhere; `backend-buddy_migrate` role that owns the schema; documented in the file header and referenced by `docs/operations/deployment.md` (D06/O01 owns that document; this package only adds a section 14-style note in the PR body for O01 to pick up).
- Tenant scoping: a `WorkspaceScoped` mixin; a static check (`services/api/tests/test_A01_tenant_scoping.py`) that every model in section 4's "yes" list has `workspace_id` not null and that every query helper in `app/repositories/**` takes a `workspace_id` argument (the helpers themselves are added by A02/A04; the check runs over whatever exists).
- Tests (`services/api/tests`, `unittest`): `test_A01_upgrade_downgrade_upgrade` against a real PostgreSQL 16 (`deploy/compose.qa.yml` when O01 lands; until then a `BB_TEST_DATABASE_URL` environment variable pointing at a local PostgreSQL, skipped-as-failure when unset in CI per CTQ-12), `test_A01_audit_update_delete_rejected`, `test_A01_one_running_job_per_connection` (partial unique index), `test_A01_check_constraints` (status enums), `test_A01_tenant_scoping`.
- `docs/architecture/data-model.md` section 14-equivalent: this document has no section 14; record decisions taken for open questions 1-5 in its section 6 by turning each into "decided in A01: ..." or "still open, owner ..." (the only allowed edit).
- Feature docs F16 and F20 section 14 rows; CHANGELOG line.

### 4. Out of scope

- FastAPI application, routes, settings, sessions, CSRF, RBAC, audit service (A02).
- Envelope encryption code and connections CRUD (A03); the columns exist here, the code does not.
- Worker, jobs logic, snapshot upload, reviews routes, retention purge job (A04); this package creates the tables and the `retain_until` columns only.
- Docker image, compose files, the `migrate` service definition (O01); this package provides the Alembic commands O01 wraps.
- Seeding fixture customer databases (R01 owns `fixtures/sql/pg/seed.sql`).
- Choosing values the plan left open (snapshot size cap, `finding_id` length, retention periods): record them as open questions with a proposal; do not hardcode a number without owner approval.

### 5. May modify

```
services/api/pyproject.toml
services/api/requirements*.txt
services/api/alembic.ini
services/api/alembic/**
services/api/app/__init__.py
services/api/app/db.py
services/api/app/models/**
services/api/tests/__init__.py
services/api/tests/test_A01_*.py
services/api/tests/conftest_db.py                (database URL helper; unittest, not pytest, unless testing-policy.md says otherwise)
ops/sql/roles.sql
docs/architecture/data-model.md                  (section 6 only: decisions or still-open statements)
docs/features/F16-projects-and-snapshots.md      (section 14 only)
docs/features/F20-auth-and-workspaces.md         (section 14 only)
CHANGELOG.md                                     ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated (fixtures/sql/pg/seed.sql is R01's customer-side fixture, not the metadata schema)
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no Node dependency change
packages/**                             frontend and profiler packages are not touched by A01
skill/**                                S01, S03
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only (the Python job addition for services/api is O02's)
deploy/**                               O01
services/api/app/{routers,auth,crypto,worker,core}/**   A02-A04
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Table set and columns as `data-model.md` section 3; status enums for `jobs` (`queued running succeeded partial failed cancelled`) and `job_items` (`pending running done partial skipped failed`); `snapshots.origin` in (`upload extraction profile import`) | `data-model.md` 3.7, 3.10, 3.11 | `test_A01_check_constraints` |
| `audit_events` insert-only by trigger (errcode `42501`) and by role grants | `data-model.md` 3.15; CTQ-16 | `test_A01_audit_update_delete_rejected` |
| One running job per connection: partial unique index `(connection_id) where status in ('queued','running')` | `data-model.md` 3.10; RK-06 | `test_A01_one_running_job_per_connection` |
| Every tenant-scoped table carries `workspace_id` not null (section 4 list); `users`, `sessions`, `encryption_keys` do not; `audit_events.workspace_id` nullable | `data-model.md` 4 | `test_A01_tenant_scoping` |
| Every migration has a working `downgrade()`; upgrade -> downgrade -> upgrade succeeds on PostgreSQL 16 | CTQ-15; `deployment-architecture.md` 8 | `test_A01_upgrade_downgrade_upgrade` |
| `snapshots.graph` is the output of `normalize()` and contract-valid; `contract_version` copied from `graph.contractVersion`; `sha256` of the canonical JSON | D3; `data-model.md` 3.7 | A04 tests; A01 only shapes the columns |
| Secrets never in plain columns: `connections.encrypted_secret` (bytea), `users.password_hash`, `sessions.token_hash`, `api_keys.key_hash` | `security-architecture.md` 4 | `test_A01_tenant_scoping` also asserts no column named `password`, `dsn`, or `token` exists unhashed |
| `review_decisions.finding_id` is opaque text with a length cap (value to be decided; recorded as open) and unique `(project_id, finding_id)` | `data-model.md` 3.12 | `test_A01_check_constraints` |
| Profiler caps and budgets (defaults 5/60 s per table, 600/3,600 s per job) as column defaults only from `limits-and-caps.md` B | `limits-and-caps.md` B | `test_A01_check_constraints` asserts defaults equal the documented values |
| Project-neutral: no fixture or seed in `services/api` carries counts from the original private example | ADR-0007 | `scripts/private_data_guard.mjs` |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with `A01`/CTQ ids, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F16, F20 section 14 rows; section 3 unchanged because no user-facing behaviour ships)
- [ ] Migration `0001` with a tested downgrade (this package's core deliverable)
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (role grants least privilege; no secret column in plain text; trigger present)
- [ ] Accessibility result: not applicable, because no UI changes
- [ ] Performance measurement: not applicable, because no budget exists for migrations; record the `0001` upgrade wall time for O01's `/readyz` < 5 min budget
- [ ] Caveat text: not applicable, because no UI strings ship
- [ ] `npm run guard` green
- [ ] `npm run build`: not applicable, because `packages/explorer` is unchanged
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `data-model.md` section 6 open questions each marked decided or still open with an owner

### 9. Acceptance commands

```sh
npm run guard
python -m pip install -r services/api/requirements.txt -r services/api/requirements-dev.txt
export BB_TEST_DATABASE_URL=postgresql://backend-buddy:backend-buddy@localhost:5432/backend-buddy_test      # or the compose.qa fixture after O01
cd services/api && alembic upgrade head && alembic downgrade base && alembic upgrade head && cd ../..
python -m unittest discover -s services/api/tests -p 'test_A01_*.py'                # all green; 0 skipped
psql "$BB_TEST_DATABASE_URL" -c "update audit_events set action='x' where false;"   # expected: ERROR ... 42501 is raised only for affected rows; use the unit test for the positive case
psql "$BB_TEST_DATABASE_URL" -f ops/sql/roles.sql                                  # exit 0, idempotent on second run
```

Package-specific assertions: `alembic history` shows exactly one revision; `\d jobs` lists the partial unique index; `\d audit_events` lists the trigger; `python -c "from app.models import *"` imports without a database.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Open questions must include every `data-model.md` section 6 item left undecided.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-06 per-table budgets remove the whole-run guard | Column defaults and check constraints (`per_table_seconds <= 60`, `cap_seconds <= 3600`) enforce the caps at the storage layer. |
| RK-08 master-key loss | `encryption_keys.master_key_fingerprint` exists so A02's `/readyz` can detect a wrong key. |
| RK-13 finding ids reopen decisions | `finding_id` is opaque text; the schema does not encode the legacy signature format (L-06 can change the producer without a migration). |
| RK-21 no forensics | `audit_events.request_id` and `ip` columns exist for A02's logging correlation. |
| RK-09 Windows vs Linux | Tests take the database URL from the environment; no local socket assumptions. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
