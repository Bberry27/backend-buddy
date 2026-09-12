Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# WP-A03 Profiler package and connections

| Field | Value |
|---|---|
| Work package | A03 (track A, phase 2) |
| Features | F17 (primary); F22 (the skill keeps a working profiler through `syncSkill`) |
| CTQs | CTQ-07, CTQ-08, CTQ-16 |
| Caveats | C01, C05, C09, C14 (server-side wording, quoted from `docs/reference/caveats.md`; `source.basis='Live catalog extraction'` labels C09) |
| Depends on | C01, A01 |
| Blocks | A04, Q03 |
| Branch | `a03/profiler-package` |
| Gate | G2 |

### 1. Goal

Move the bounded read-only profiler into `packages/profiler/bb_profiler` behind a `Driver` protocol (PostgreSQL, SQLite) with `Budget`/`BoundedReader`, `profile_table`, live catalog `introspect()` for both dialects producing contract-valid output, `policy.py` column-class redaction, `targets.py` private-target deny and `tls_mode -> sslmode`, and a `compat.py` so that `packages/explorer/server/schema_profiler.py` keeps its public surface (`connect_readonly`, `profile`, `subtree`, `ProfileLimitError`) and **all 32 tests in `packages/explorer/server/test_schema_profiler.py` pass unchanged, including the `patch.object(service, 'MAX_QUERIES', 1)` and `patch.object(service, 'DEADLINE_SECONDS', ...)` cases at lines 201-213**. Add envelope encryption (`services/api/app/crypto/envelope.py`) and the admin-only, audited, write-only connections CRUD. A verifier can check the unchanged test file passing, the policy tests, the targets tests, the connections response schema, and that `syncSkill()` copies the new package into the skill.

### 2. Reading list (ordered)

1. `docs/features/F17-connections-and-profiling.md` (D05): B-numbered behaviours for connections (create, test, extract, profile), redaction classes, partial results (A04), C14 and C05 wording obligations; section 6 (contract fields `profiling.status`, `rowCountLowerBound`, `sampleValues`, `source.basis`).
2. `docs/architecture/schema-graph-contract.md` part B (`contractVersion`, promoted fields `kind:'view'`, `checks`, `file`, `definition`, `sampleValues`, `rowCountLowerBound`, `profiling.status`) and `packages/contract/schema-graph.v1.json` (C01) with `bb_profiler/contract.py` (C01: jsonschema then `normalize()`).
3. `docs/architecture/security-architecture.md` sections 4 (envelope encryption steps 1-7; AAD = connection id; write-only; decrypt in the worker only), 5 finding 8 (data minimisation: min/max always shipped today; `sampleValues` single opt-in; 5 s whole-run deadline), 8 (worker executes only profiler-generated `SELECT ... LIMIT` over allowlisted identifiers), 10 open question 1 (whether the API may hold a decrypted secret for `connection.test`; implement the documented default and flag it).
4. `docs/architecture/data-model.md` 3.8 `connections`, 3.9 `encryption_keys`, 3.15 audit actions `connection.create|update|test|delete`.
5. `docs/architecture/deployment-architecture.md` 4 (`BB_ALLOW_PRIVATE_TARGETS`, `BB_DEFAULT_TLS_MODE`, `BB_JOB_TABLE_SECONDS_DEFAULT/_MAX`), 5 (TLS to customer databases).
6. `docs/architecture/adr/ADR-0003-backend-fastapi-and-contract-oracle.md`, `ADR-0005-auth-and-credential-encryption.md`, `ADR-0007-private-data-and-fixture-policy.md`.
7. `docs/reference/limits-and-caps.md` A1 (every cap with its line: `schema_profiler.py:73-80`; `_cap()` `:96`; `MAX_QUERIES` check `:248`; deadline `:235`, `:239-240`; PostgreSQL `statement_timeout` at connect `:216`, per statement `:262-263`, at transaction start `:289-290`; SQLite `PRAGMA query_only` `:199`, `:278`, restored `:284`; progress handler `:279`; sample values `:363`, `:370-371`, `:382-385`) and B (per-table 5/60 s; samples triple opt-in, max 3).
8. Existing code to move, function by function: `packages/explorer/server/schema_profiler.py:83` `ProfileLimitError`; `:87` `_quote`; `:93` `_cap`; `:99` `_scalar`; `:113` `_key`; `:119` `_Graph` (allowlist: `column` `:159`, `sql_table` `:164`, `pk` `:172`); `:184` `_Connection`; `:190` `connect_readonly` (SQLite `mode=ro` URI and `query_only`; PostgreSQL explicit `host dbname user password`, `service`/`passfile` rejected, `default_transaction_read_only=on`, `statement_timeout=5000`, `read_only = True`); `:227` `_Reader` (`check` `:238`, `identifier` `:242`, `select` `:246`); `:274` `_reader`; `:294` `_stats`; `:306` `_fd_codes`; `:327` `_dependencies`; `:356` `_sample_values`; `:368` `profile`; `:410` `_pk_values`; `:431` `_children`; `:458` `subtree`. Module docstring lines 38-39 and 56-57 carry C05 and C14 statements to keep.
9. `packages/explorer/server/test_schema_profiler.py` in full (32 tests): `:14` `import schema_profiler as service`; `:201-207` `test_budget_and_deadline_fail_closed` patches `service.MAX_QUERIES` and `service.DEADLINE_SECONDS` and asserts `PRAGMA query_only` is restored; `:208-214` `test_sqlite_progress_interrupts_expensive_select` patches `service.DEADLINE_SECONDS` to `.02`. The compat layer must make these patches effective at call time.
10. `packages/explorer/server/serve_explorer.py:12-13` (imports `connect_readonly, profile, subtree` and `validate_output`; S03 owns this file) and `profile_snapshot.py` (CLI; keeps working through compat); `snapshot_io.py:4` `validate_output`.
11. `scripts/project.mjs:52-60` `syncSkill()` (copies `src`, `server`, `dist` and five files); this package extends it to copy `packages/profiler/bb_profiler`.
12. `fixtures/sql/{sqlite,pg}/seed.sql` (R01): introspection targets for tests.
13. `docs/engineering/security-policy.md`, `standards.md`, `testing-policy.md` (D03).

### 3. In scope

- `packages/profiler/bb_profiler/`:
  - `core.py`: `Budget(max_rows, max_depth, max_parameters, max_batch_keys, max_queries, deadline_seconds, max_scalar_length, max_fd_columns)` with defaults equal to the eight compat constants; `BoundedReader(driver, session, budget)` replacing `_Reader` (same `check`, `identifier`, `select` semantics, per-statement `statement_timeout` from the remaining budget); `profile_table(graph, reader, table_id, *, include_sample_values, policy) -> TableResult` with `status: 'complete' | 'incomplete'` and `reason` (`per-table deadline`, `query budget`, `statement_timeout`, `driver error`); `_Graph` allowlist, `_stats`, `_fd_codes`, `_dependencies`, `_sample_values` moved with unchanged behaviour.
  - `drivers/base.py`: `Driver` protocol: `quote(identifier)`, `paramstyle`/marker, `open_readonly_session(dsn_or_config)`, `set_statement_timeout(ms)`, `limit_clause`, `introspect(session, options) -> SchemaGraph`, `approximate_row_count(session, table)` (catalog estimate; result goes to `rowCountLowerBound`/`rowCountEstimate` per the contract, never to `rowCount`), `restore(session)`.
  - `drivers/sqlite.py`, `drivers/postgresql.py`: the existing session setup moved verbatim (`query_only`, progress handler every 1,000 instructions; `SET TRANSACTION READ ONLY`, `set_config('statement_timeout', ...)`), plus `introspect()`: declared FKs only (`kind: 'declared FK'`, one link per column pair sharing `constraintId`), indexes (`unique`, `partial`, `expression`, `definition`), uniques, checks, views (`kind: 'view'`), `source.basis = 'Live catalog extraction'`, `project.dialect`; output validated by `contract.py` (jsonschema + `normalize()`).
  - `policy.py`: column classes `secret`, `pii-direct`, `binary`, `free-text`, `identifier`, `numeric`, `temporal`, `other` from name and type heuristics (rules documented in the module; overridable per connection); effects: `secret` -> `nullFraction` only; string `min`/`max` off by default; `sampleValues` only when policy allows, the connection opts in, and the request opts in (triple opt-in), max 3; a `redactions` counter per class for O03's metric.
  - `targets.py`: parse the DSN or config; deny loopback, link-local, RFC 1918, and cloud-metadata hosts unless `BB_ALLOW_PRIVATE_TARGETS`; `tls_mode` default `verify-full` mapped to `sslmode` (`verify-full`, `verify-ca`, `require`, `disable` only with an explicit admin choice, audited); `service`/`passfile` rejected as today.
  - `compat.py`: `MAX_ROWS ... MAX_FD_COLUMNS` module-level constants; `connect_readonly(dialect, dsn)`, `profile(graph, connection, tables, max_rows=MAX_ROWS, *, include_sample_values=False)`, `subtree(graph, connection, root_table, pk_value, depth, max_rows=MAX_ROWS)`, `ProfileLimitError`; each call builds `Budget(...)` **from the shim module's globals at call time** (never bound at import) so that `patch.object(schema_profiler, 'MAX_QUERIES', 1)` and `patch.object(schema_profiler, 'DEADLINE_SECONDS', -1)` take effect; whole-operation deadline semantics preserved for these three functions (a `ProfileLimitError` on expiry, `query_only` restored), because that is what the tests assert.
  - `contract.py` (C01) consumed for validation; `__init__.py` exports.
- `packages/explorer/server/schema_profiler.py` becomes a thin module: `from bb_profiler.compat import *` plus a path shim so `import schema_profiler as service` and `service.MAX_QUERIES` keep working; **the file `test_schema_profiler.py` is not edited**; `serve_explorer.py` and `profile_snapshot.py` keep importing from it.
- `packages/profiler/tests/`: `test_A03_budget.py` (per-table deadline yields `status: 'incomplete'` with reason; `rowCount` untouched), `test_A03_policy.py` (`test_A03_secret_class_nullfraction_only`, `test_A03_string_extremes_off_by_default`, `test_A03_samples_triple_opt_in`, `test_A03_redaction_counter`), `test_A03_targets.py` (private hosts denied by default; `tls_mode` mapping; `service`/`passfile` rejected), `test_A03_introspect_sqlite.py` (against `fixtures/sql/sqlite/seed.sql`: declared FKs, indexes, uniques, checks, views; contract-valid; `source.basis`), `test_A03_introspect_postgresql.py` (mocked psycopg like today; the real run is Q03), `test_A03_compat.py` (imports `schema_profiler` from `packages/explorer/server` and asserts the eight constants and three functions exist and that patching the shim's constants changes behaviour).
- `services/api/app/crypto/envelope.py`: AES-256-GCM (`cryptography`), 96-bit random nonce prepended, AAD = connection id, master key from `BB_MASTER_KEY_FILE`, `encryption_keys` row with the master-key sha256 fingerprint created on first use; `test_A03_envelope.py` (round trip, AAD mismatch fails, wrong key fails, fingerprint recorded).
- `services/api/app/routers/connections.py`: `POST/GET/PATCH/DELETE /w/{ws}/connections`, admin role via A02 `require_role`; secret write-only (request accepts `password` or `dsn` secret part, response schema has no `encrypted_secret`, `key_id`, `password`, `dsn`); `POST .../test` performs `targets` validation and a read-only session open with a 5 s connect timeout (in the API process or as a job per open question 1; implement the documented default and record it); every mutation and test audited (`connection.create|update|test|delete`); delete zeroes `encrypted_secret`.
- `scripts/project.mjs` `syncSkill()`: also copy `packages/profiler/bb_profiler` into `skill/assets/extensions/profiler` (or the location `skill/SKILL.md` documents; update `skill/references/advanced-views.md` only if the import path in the documented CLI changes).
- `packages/profiler/requirements.txt` (`psycopg[binary]`, `jsonschema`), `services/api/requirements.txt` additions (`cryptography`).
- F17 sections 3 and 14; F22 section 14 row; `docs/reference/limits-and-caps.md` A1 rows re-pointed to the new file:line locations in the same PR (rule in that file); `docs/security/authn-authz.md` gets a "connection secrets" section or a new `docs/security/connection-secrets.md`.

### 4. Out of scope

- Jobs, worker loop, partial-result merge into snapshots, `profiling.status` write into stored graphs, cancel, polling (A04); A03 provides `profile_table` and `introspect` as the primitives A04 calls.
- Real PostgreSQL tests (Q03); this package keeps PostgreSQL mocked as today.
- Loopback server changes (S03), including `ProfileLimitError -> 422`.
- MySQL/MariaDB and other drivers (L-03); ORM adapters (L-08).
- Key rewrap CLI and retention scrubber (L-04).
- Editing `test_schema_profiler.py` or `test_explorer_http.py` (frozen; a failing test means the compat layer is wrong).
- Changing any cap value (needs an ADR per the frozen-contracts table).

### 5. May modify

```
packages/profiler/**                              (new package, tests, requirements, README)
packages/explorer/server/schema_profiler.py       (becomes the compat shim; public names preserved)
packages/explorer/server/requirements.txt         (point at packages/profiler or keep psycopg pin)
services/api/app/crypto/**
services/api/app/routers/connections.py
services/api/app/repositories/connections.py
services/api/app/schemas/connections.py
services/api/requirements*.txt
services/api/tests/test_A03_*.py
scripts/project.mjs                               (syncSkill copy of bb_profiler; PYTHONPATH for the server tests if needed)
skill/SKILL.md, skill/references/advanced-views.md   (only the profiler import path or CLI invocation if it changes)
docs/reference/limits-and-caps.md                 (A1 rows: new file:line for each cap; values unchanged)
docs/security/connection-secrets.md               (new) or docs/security/authn-authz.md section
docs/features/F17-connections-and-profiling.md   (sections 3 and 14 only)
docs/features/F22-offline-artifact-and-skill.md  (section 14 only)
CHANGELOG.md                                      ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated (the SQL seeds are consumed, not edited)
THIRD_PARTY_NOTICES.md                  generated
package.json, package-lock.json         no Node dependency change
packages/explorer/server/test_schema_profiler.py    frozen: must pass unchanged (32 tests)
packages/explorer/server/test_explorer_http.py      S03 only
packages/explorer/server/serve_explorer.py          S03 only (keeps importing connect_readonly, profile, subtree from schema_profiler)
packages/explorer/server/profile_snapshot.py, snapshot_io.py   keep working unchanged
packages/explorer/src/**                W and C tracks
packages/contract/**                    C01 (a needed contract field is an open question, not an edit)
services/api/alembic/**, services/api/app/models/**   A01
services/api/app/{auth,core,audit.py,routers/{auth,workspaces,users,api_keys,health}.py}   A02 (call, do not edit)
services/api/app/{worker,routers/{jobs,snapshots,projects,reviews,preferences,layouts,exports}.py}   A04
skill/assets/explorer.html, skill/scripts/build_explorer.py   S01
docs/reference/caveats.md               frozen at G0
.github/workflows/**                    R00, S02, O01, O02, Q05 only
deploy/**                               O01
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Compat constants `MAX_ROWS 10000, MAX_DEPTH 4, MAX_PARAMETERS 400, MAX_BATCH_KEYS 100, MAX_QUERIES 512, DEADLINE_SECONDS 5.0, MAX_SCALAR_LENGTH 256, MAX_FD_COLUMNS 32` keep their values and stay **module-level and patchable** on `schema_profiler` (read at call time) so `test_schema_profiler.py:201-213` passes unchanged | `schema_profiler.py:73-80` today; `limits-and-caps.md` A1 | `python -m unittest packages/explorer/server/test_schema_profiler.py` (32 tests); `test_A03_compat.py` |
| Public surface `connect_readonly(dialect, dsn)`, `profile(graph, connection, tables, max_rows, *, include_sample_values)`, `subtree(graph, connection, root_table, pk_value, depth, max_rows)`, `ProfileLimitError` importable from `schema_profiler` | `serve_explorer.py:12`, `profile_snapshot.py:6` | `test_explorer_http.py` (19 tests, S03-owned) still green |
| Read-only session setup preserved: SQLite `mode=ro` URI, `PRAGMA query_only = ON` restored after use, progress handler; PostgreSQL `default_transaction_read_only=on`, `SET TRANSACTION READ ONLY`, `statement_timeout`, no `service`/`passfile`, explicit `host dbname user password` | `schema_profiler.py:190-226`, `:274-292`; C14 | `test_schema_profiler.py`; Q03 real run |
| No graph-supplied SQL; identifiers allowlisted through `_Graph`; `SELECT ... LIMIT` only | `schema_profiler.py:56-57`, `:119-183`, `:246-256`; C14, CTQ-06 | `test_schema_profiler.py`; `test_A03_budget.py` |
| Unknown stays unknown: `rowCount` set only when the sample proves it (no overflow) or a measured total exists; `rowCountLowerBound` otherwise; catalog estimates never become `rowCount` | C01; `schema_profiler.py:395-398` | `test_schema_profiler.py` (`sampled['rowCount']` is None at `:199`); `test_A03_budget.py` |
| Sampled evidence is not proof: `sampled: True`, `sampleSize`, FD codes as sample-only | C05; docstring `:38-39` | `test_schema_profiler.py` |
| `include_sample_values` is an explicit boolean; samples max 3; policy triple opt-in | `schema_profiler.py:370-371`, `:363`; `limits-and-caps.md` B | `test_A03_samples_triple_opt_in` |
| Envelope: AES-256-GCM, 96-bit nonce prepended, AAD = connection id, master key file, fingerprint in `encryption_keys`; secrets write-only; decrypt in the worker | `security-architecture.md` 4 | `test_A03_envelope.py`; `test_A03_connections_response_has_no_secret_fields` |
| `tls_mode` default `verify-full`; private targets denied unless `BB_ALLOW_PRIVATE_TARGETS` | `deployment-architecture.md` 4-5; RK-18 | `test_A03_targets.py` |
| Introspection output contract-valid (`jsonschema` + `normalize()`), declared FKs only, `source.basis='Live catalog extraction'` | D3, C07, C09 | `test_A03_introspect_sqlite.py` |
| SchemaGraph backward compatibility: additive fields only | C01 | contract corpus tests |
| Audit rows for `connection.create|update|test|delete` | CTQ-16 | `test_A03_audit_rows_for_connection_changes` |
| Generated mirror: the skill copy of `bb_profiler` is produced by `syncSkill()`, never hand-edited | D9; RK-22 | `git diff --exit-code skill/assets/extensions` after `npm run build` |
| Project-neutral fixtures | ADR-0007 | guard |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, test names prefixed with `A03`/CTQ ids, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated (F17; F22 section 14 row)
- [ ] Migration: none, because A01's `0001` already contains `connections` and `encryption_keys` (state the check)
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (secret never in responses or logs; AAD binding; private-target deny; TLS default; audit rows)
- [ ] Accessibility result: not applicable, because no UI ships
- [ ] Performance measurement recorded: `profile_table` on the SQLite fixture per table in ms; connection test round trip; both feed CTQ-09's API p95 (Q01)
- [ ] Caveat text: server-side messages that carry C01, C05, or C14 wording are quoted verbatim from `docs/reference/caveats.md`
- [ ] `npm run guard` green
- [ ] `npm run build` run and the mirror committed (`syncSkill` now copies `bb_profiler`)
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: `git diff --exit-code packages/explorer/server/test_schema_profiler.py` is empty and the 32 tests pass
- [ ] Package-specific: `limits-and-caps.md` A1 file:line citations updated to the new locations, values unchanged

### 9. Acceptance commands

```sh
npm run guard
python -m pip install -r packages/profiler/requirements.txt -r services/api/requirements.txt -r services/api/requirements-dev.txt
git diff --exit-code packages/explorer/server/test_schema_profiler.py packages/explorer/server/test_explorer_http.py   # frozen files untouched
python -m unittest discover -s packages/explorer/server -p 'test_*.py'      # 51 tests green (32 + 19), 0 skipped
python -m unittest discover -s packages/profiler/tests -p 'test_*.py'       # A03 tests green
python -m unittest discover -s services/api/tests -p 'test_A03_*.py'        # envelope, connections, audit
python -m coverage run -m unittest discover -s packages/profiler/tests && python -m coverage report --fail-under=95 --include='packages/profiler/bb_profiler/policy.py'   # CTQ-12
python -m coverage run -m unittest discover -s services/api/tests -p 'test_A03_*.py' && python -m coverage report --fail-under=95 --include='services/api/app/crypto/*'
pip-audit -r packages/profiler/requirements.txt -r services/api/requirements.txt
npm run build && git diff --exit-code skill/assets/extensions                # mirror includes bb_profiler and is committed
python -m unittest discover -s skill/scripts -p 'test_renderer*.py'          # unchanged and green
```

Package-specific assertions: `python -c "import sys; sys.path.insert(0,'packages/explorer/server'); import schema_profiler as s; from unittest.mock import patch; print(s.MAX_QUERIES)"` prints `512`; `test_A03_compat.py` shows that `patch.object(schema_profiler, 'MAX_QUERIES', 1)` makes `subtree` raise `ProfileLimitError`; `GET /w/{ws}/connections` JSON schema in `openapi.json` contains none of `encrypted_secret`, `key_id`, `password`, `dsn`; `introspect()` on the SQLite seed yields a graph where every link has `kind: 'declared FK'` and `source.basis == 'Live catalog extraction'`.

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). Include a function-by-function move table (old `schema_profiler.py:line` -> new module) so `limits-and-caps.md` A1 can be re-pointed by review.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-06 per-table budgets remove the whole-run guard | `Budget` defaults from `limits-and-caps.md` B (5 s, max 60 s per table); the job cap is A04's; the compat functions keep the whole-operation deadline. |
| RK-08 master-key loss | Fingerprint recorded; documentation names the operator backup step (O01). |
| RK-14 sensitive scalar values in outputs | `policy.py` defaults: string extremes off, `secret` -> `nullFraction` only, samples triple opt-in; redaction counter for O03. Open question: numeric extremes for `identifier` (risk register open question 2). |
| RK-18 read-only at session level only | `targets.py` `verify-full` default and private-target deny; Q03 proves write rejection on real PostgreSQL. |
| RK-22 duplicated source trees drift | `syncSkill()` copies the package; the mirror is never hand-edited. |
| RK-01 private data | Introspection tests run only against the R01 seeds; no customer DSN in tests. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |


---

## ADDENDUM (product owner, 2026-09-08) — overrides anything above that conflicts

Sections most relevant to this work package: **A, B, C, E**. Read all of it; the
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

Sections most relevant to this work package: **F, G**. Read all of it.

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


---

## ADDENDUM 3 (product owner, 2026-09-08) — the credentials form ships in THIS package

The product owner has now asked four separate times where to enter database credentials.
Every answer so far pointed at the web application, which is three work packages away,
and the interim path requires exporting a connection string into an environment variable.
Both are wrong for a locally installed application. Quoting the requirement:

> i need somewhere in the ui like an admin area or something to put those credentials.
> users dont want to load that into a .env. This is a local application. It should be able
> to connect to a server with the right credentials.

**This work package now delivers a working credentials form, not only the API behind one.**

### I. A server-rendered admin area, in this package

Add a small server-rendered admin surface to the API. Server-rendered, not a single-page
application: it has no build step, no bundler, and no dependency on `packages/web`, so it
works the moment the container starts. W01 later builds the richer experience in the SPA,
and the two share the same endpoints, but this page must keep working because it is the
zero-build path for a local install and the only one that exists at MVP.

Routes, all behind the session authentication A02 established:

- `GET /admin` — list connections with name, host, database, TLS mode, and when each was
  last verified. Empty state explains that no database is connected and links to the form.
- `GET /admin/connections/new` and `POST /admin/connections` — the form and its submit.
- `POST /admin/connections/{id}/test` — verify and record the outcome.
- `POST /admin/connections/{id}/introspect` — read the catalog and create a snapshot.
- `POST /admin/connections/{id}/delete` — remove it, audited.

Form fields, matching a managed PostgreSQL because that is the reference target: display
name, host, port defaulting to 5432, database, username, password, TLS mode defaulting to
full verification, and an optional certificate authority in PEM form. Nothing else is
required to get started.

Rules the form must obey:

- **No environment variable is ever required to add a connection.** The existing
  `--dsn-env` flag stays for scripted use, but a person using the product types
  credentials into the form and never edits a file.
- Password and certificate inputs are write-only. After submission the page shows that a
  secret is set, never the value, never a masked round trip that could be read back. The
  rendered HTML must contain none of `password`, `dsn`, `encrypted_secret`, or `key_id`
  as a value, and a test must assert that against the response body.
- Submit over the session cookie with the CSRF protection A02 built. `autocomplete="off"`
  and `spellcheck="false"` on the secret fields; the form never appears in a `GET` query
  string.
- Test and introspect report a specific, actionable outcome, using the diagnosis rules in
  ADDENDUM 2 section G: a certificate failure names verification and the explicit
  alternative, a timeout against a managed host names the provider firewall and the
  machine's public address, a rejected credential mentions the legacy Azure username
  form, and a timeout to `localhost` from inside a container explains that `localhost` is
  the container and names `host.docker.internal`.
- Rendered with the same 16 design tokens as the rest of the product, in one small
  stylesheet served by the API. It should look like the product, not like a debug page.
  It does not need to be beautiful; it needs to be unmistakably usable.

### J. Reuse the introspection that already exists

`scripts/introspect_pg.py` is committed, tested against a live PostgreSQL 16, and produces
a contract-valid snapshot: 155 tables, 2,285 columns and 103 foreign-key column pairs on
its verification run. **Move its catalog queries into the PostgreSQL driver's
`introspect()` rather than writing them again**, and reduce the script to a thin command
line wrapper over the driver so there is one implementation. Its behaviours are
requirements, not suggestions:

- Catalog metadata only. No query against a user table, so no row, value, minimum or
  maximum is read by introspection.
- Row counts absent rather than estimated. The catalog's `reltuples` is a planner estimate
  and the contract requires an unmeasured count to stay unknown.
- One link per ordered foreign-key column pair, sharing the constraint name, so a
  composite key keeps its pair-level evidence and counts once.
- Views carry `kind: "view"` and their definition. Indexes carry the partial and expression
  flags so coverage heuristics stay honest.
- Foreign keys whose target lies outside the selected schemas are dropped and counted, and
  the count is reported in `source.basis`, because a dangling declared target fails the
  contract.
- The output is validated through the renderer's `normalize()` before it is stored, so a
  snapshot that would fail at render time fails at introspection with a specific message.

### K. Definition of done for this package, in the owner's terms

A person runs the stack, opens the admin area in a browser, types the host, database,
username and password of a managed PostgreSQL, clicks test, sees it succeed, clicks
populate structure, and then sees their own schema in the thirteen views. No file editing,
no environment variable, no command line. Demonstrate exactly that against a real
PostgreSQL in your report, and say plainly if any step still requires a terminal.
