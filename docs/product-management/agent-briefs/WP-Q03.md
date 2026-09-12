Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# WP-Q03 Real PostgreSQL profiler tests

| Field | Value |
|---|---|
| Work package | Q03 (track Q, phase 2) |
| Features | F17 (verification only) |
| CTQs | CTQ-08 (primary), CTQ-12 (no silently skipped suite in the nightly job) |
| Caveats | none authored (tests assert C01, C05, C14 behaviour) |
| Depends on | A03, R01 |
| Blocks | none (O02 wires the nightly job) |
| Branch | `q03/postgres-live-tests` |
| Gate | G2 |

### 1. Goal

Prove against a real PostgreSQL 16 (the `fixture-db` of `deploy/compose.qa.yml`, seeded from `fixtures/sql/pg/seed.sql`) what the mocked tests cannot: `introspect()` returns a contract-valid graph; `profile_table` respects the caps; a write is rejected; `statement_timeout` aborts a slow statement; a per-table deadline yields `status: 'incomplete'` with a reason and leaves `rowCount` unknown; redaction classes behave as `policy.py` specifies. A verifier can check `packages/profiler/tests/test_postgres_live.py` green under the qa overlay and failing (not skipping) when the database is absent in CI.

### 2. Reading list (ordered)

1. `docs/product-management/ctq.md` CTQ-08 row (test names `test_Q03_write_rejected`, `test_Q03_statement_timeout_aborts`, `test_Q03_per_table_deadline_partial_with_reason`; nightly on real PostgreSQL) and `roadmap.md` G2 CTQ-08 line.
2. `docs/features/F17-connections-and-profiling.md` sections 8-9 (acceptance criteria and test expectations tagged CTQ-08).
3. `docs/reference/limits-and-caps.md` A1 (every PostgreSQL-relevant cap with its line: `statement_timeout=5000` at connect `schema_profiler.py:216`, per statement `:262-263`, at transaction start `:289-290`; `SET TRANSACTION READ ONLY` `:288`; `default_transaction_read_only=on` `:215`; after A03 the citations point into `packages/profiler/bb_profiler`).
4. `docs/architecture/security-architecture.md` 5 finding 8 and 8; `docs/product-management/risk-register.md` RK-18 (read-only enforced at session level; Q03 is the proof).
5. A03 deliverables: `bb_profiler.drivers.postgresql`, `core.Budget`, `profile_table`, `policy.py`, `targets.py`, `compat.py`; A04's partial-result semantics (WP-A04 section 3) that the per-table deadline test must match.
6. Existing test builders to reuse: `packages/explorer/server/test_schema_profiler.py:17-27` (`table()`, `edge()` fixture builders), `:208-214` (slow recursive view pattern for forcing a timeout; port it to PostgreSQL `generate_series`), `:201-207` (fail-closed assertions).
7. `fixtures/sql/pg/seed.sql` (R01) and `fixtures/README.md` (synthetic only; tests derive expectations from the seed, never literals from the original private example).
8. `deploy/compose.qa.yml` (O01) and `docs/developer/test.md`.
9. `docs/engineering/testing-policy.md` (D03).

### 3. In scope

- `packages/profiler/tests/test_postgres_live.py` (unittest), connection from `BB_TEST_PG_DSN` (qa overlay sets it); when unset: `unittest.SkipTest` locally with a printed reason, but the nightly job passes `BB_REQUIRE_LIVE_PG=1` which turns the skip into a failure (CTQ-12):
  - `test_Q03_introspect_contract_valid`: `introspect()` output passes `bb_profiler.contract` (jsonschema + `normalize()`); every link `kind == 'declared FK'`; composite FKs share a `constraintId`; indexes carry `unique`/`partial`/`expression`/`definition`; views have `kind: 'view'`; `source.basis == 'Live catalog extraction'`.
  - `test_Q03_write_rejected`: an attempted `INSERT`/`UPDATE`/`CREATE` through the read-only session raises (`25006 read_only_sql_transaction` or equivalent) and the table row count is unchanged; also `SET default_transaction_read_only` cannot be overridden by a graph-supplied identifier (none exists; assert the reader has no such path).
  - `test_Q03_statement_timeout_aborts`: a deliberately slow statement (`pg_sleep` or a large `generate_series` view) under a small `Budget` raises within the deadline and the session is usable afterwards.
  - `test_Q03_per_table_deadline_partial_with_reason`: `profile_table` on a table whose sample is forced to exceed the per-table budget returns `status: 'incomplete'` with `reason` in the documented set, writes no `rowCount`, `rowCountLowerBound`, or column `profiling` for the cut-off sample (WP-A04 section 3 rule 2), and a subsequent table in the same session completes.
  - `test_Q03_caps_enforced`: `MAX_ROWS` clamp, `MAX_QUERIES` budget, `MAX_PARAMETERS` batching on `subtree` through the compat layer, all against real data.
  - `test_Q03_redaction_classes`: columns seeded as `secret`-like (`password_hash`), `pii-direct`-like (`email`), `binary`, `free-text`, and `identifier` produce the `policy.py` outputs (secret -> `nullFraction` only; string extremes absent by default; samples absent without triple opt-in; present, max 3, with it).
  - `test_Q03_targets_tls`: `tls_mode` maps to `sslmode`; connection to the fixture (a private address) succeeds only with `BB_ALLOW_PRIVATE_TARGETS`.
  - `test_Q03_unknown_stays_unknown`: after profiling with a sample cap below the table size, `rowCount` is `None` and `rowCountLowerBound` equals the cap plus one, matching `schema_profiler.py:395-398` semantics (C01).
- Seed additions needed for the slow and typed columns are requested from R01's generator as a change (`scripts/generate-fixtures.mjs`), not hand-edited into `fixtures/sql/pg/seed.sql`; until merged, the test creates temporary objects in a scratch schema it drops afterwards.
- `docs/developer/test.md` section on running the live tests; F17 section 14 row; CHANGELOG line.

### 4. Out of scope

- Fixing profiler behaviour (A03) or worker semantics (A04): failing tests are reported.
- SQLite live tests (already covered by the standard-library suite in `test_schema_profiler.py`).
- MySQL/MariaDB conformance harness (L-03).
- Performance numbers (Q01 owns API p95).
- Changing caps or budgets.

### 5. May modify

```
packages/profiler/tests/test_postgres_live.py
packages/profiler/tests/helpers_pg.py
docs/developer/test.md                    (live PostgreSQL section)
docs/features/F17-connections-and-profiling.md   (section 14 only)
CHANGELOG.md                              ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated (seed changes go through scripts/generate-fixtures.mjs as a reported change request)
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no dependency change
packages/profiler/bb_profiler/**      A03
packages/explorer/server/**             A03 (compat), S03 (server); test_schema_profiler.py frozen
services/**, deploy/**                  A and O tracks
docs/reference/limits-and-caps.md, docs/product-management/ctq.md   values change only by the CTQ rule-1 PR
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    O02 wires the nightly job
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Read-only session: `default_transaction_read_only=on`, `SET TRANSACTION READ ONLY`, `read_only = True`; writes rejected | `schema_profiler.py:215-224`, `:288`; C14 | `test_Q03_write_rejected` |
| `statement_timeout` at connect (5000 ms), per statement (remaining budget), at transaction start | `limits-and-caps.md` A1 | `test_Q03_statement_timeout_aborts` |
| Partial-result semantics (WP-A04 section 3 rules 1-4) | WP-A04; CTQ-08 | `test_Q03_per_table_deadline_partial_with_reason` |
| Unknown stays unknown: capped sample never sets `rowCount` | C01; `schema_profiler.py:395-398` | `test_Q03_unknown_stays_unknown` |
| Caps `MAX_ROWS 10000, MAX_DEPTH 4, MAX_PARAMETERS 400, MAX_BATCH_KEYS 100, MAX_QUERIES 512, DEADLINE_SECONDS 5.0, MAX_SCALAR_LENGTH 256, MAX_FD_COLUMNS 32` | `limits-and-caps.md` A1 | `test_Q03_caps_enforced` |
| Policy classes and triple opt-in samples (max 3) | A03 `policy.py`; `limits-and-caps.md` B | `test_Q03_redaction_classes` |
| Introspection output contract-valid; declared FKs only; `source.basis='Live catalog extraction'` | D3; C07; C09 | `test_Q03_introspect_contract_valid` |
| `tls_mode` default `verify-full`; private targets denied unless allowed | `deployment-architecture.md` 4-5 | `test_Q03_targets_tls` |
| Project-neutral: expectations derived from the seed at test time | ADR-0007 | guard; no literal counts in the test file |
| No silently skipped suite in CI | CTQ-12 | `BB_REQUIRE_LIVE_PG=1` in the nightly job |

### 8. Deliverables checklist (definition of done)

- [ ] Tests, names prefixed with `Q03`/`CTQ-08`, green under the qa overlay with the acceptance commands
- [ ] Feature document section 14 row (F17); section 3 unchanged
- [ ] Migration: none, because no schema changes
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (DSN from the environment only; scratch schema dropped; no customer database)
- [ ] Accessibility result: not applicable
- [ ] Performance measurement: not applicable (record suite wall time)
- [ ] Caveat text: not applicable
- [ ] `npm run guard` green
- [ ] `npm run build`: not applicable
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: the test file contains no numeric literal that equals a table or column count of any fixture (assertions computed from the seed)

### 9. Acceptance commands

```sh
npm run guard
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml up -d fixture-db --wait --wait-timeout 300
export BB_TEST_PG_DSN="host=127.0.0.1 port=<fixture-db port> dbname=fixture user=fixture password=<from compose.qa.yml secret>" BB_ALLOW_PRIVATE_TARGETS=true BB_REQUIRE_LIVE_PG=1
python -m unittest packages/profiler/tests/test_postgres_live.py -v          # all Q03 tests green, 0 skipped
unset BB_TEST_PG_DSN; BB_REQUIRE_LIVE_PG=1 python -m unittest packages/profiler/tests/test_postgres_live.py; echo "exit=$?"   # expected: non-zero (fails, does not skip)
python -m unittest discover -s packages/explorer/server -p 'test_*.py'        # mocked suite still green
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml down -v
```

Package-specific assertions: the `test_Q03_write_rejected` output shows the PostgreSQL error code; the per-table deadline test prints the item `reason` and the unchanged `rowCount: None`.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations).

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-18 read-only at session level only | This package is the proof; it also documents that the DSN user should lack write grants (operator step in O01's `deployment.md`). |
| RK-06 per-table budgets | The deadline test proves the budget is honoured on real I/O, not only in mocks. |
| RK-14 sensitive values | Redaction class test on realistic column names. |
| RK-01 private data | Fixture database only; DSN from the environment. |
| RK-07 flakiness | Timeouts use generous margins (deadline 0.2 s vs a 5 s sleep); the nightly job retries once and records the flake. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
