Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0003: Python FastAPI backend with a worker, and JSON Schema plus `normalize()` as the contract oracle

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Backend lead, Platform lead, Frontend lead
- **Work packages**: C01, A01, A02, A03, A04
- **Related**: ADR-0001, ADR-0005 (auth and encryption), ADR-0006 (deployment), `docs/architecture/schema-graph-contract.md`, `docs/architecture/data-model.md`, F16, F17

## Context

All server-side logic today is Python: the profiler `packages/explorer/server/schema_profiler.py` (constants `:73-80`; `connect_readonly` `:189-224`; bounded `_Reader` `:227-270`; read-only session setup in `_reader` `:273-291`), the loopback HTTP wrapper `serve_explorer.py`, the batch CLI `profile_snapshot.py`, and the renderer `skill/scripts/build_explorer.py` with its 13-rule `normalize()` (`:21-96`). Sixty Python tests cover them (51 profiler and HTTP, 9 renderer); PostgreSQL is covered only through mocks. The TypeScript contract is `packages/explorer/src/types.ts:1-10`, documented in `skill/references/schema-contract.md`; there is no version field, no machine-readable schema, and several fields views read are reachable only through index signatures (`types.ts:4`, `:6`).

Forces:

- Long profiling jobs cannot run inside the API event loop: today one request profiles every table under a single 5 s deadline (`schema_profiler.py:235-240`; `ColumnTable.tsx:149` posts all tables) and fails whole (`:58-59` "no partial success is returned"); the loopback server serialises jobs with a lock (`serve_explorer.py:89-90`).
- `normalize()` is the only place the contract's semantic rules are enforced (unique ids `:34-36`, declared-FK resolution `:81-82`, duplicate pairs `:84-86`, composite groups `:89-93`, inferred dedupe `:94-95`) and 9 renderer tests pin it; re-implementing it in TypeScript or pydantic would create a second oracle that drifts.
- `packages/explorer/src` is byte-copied into the skill and must build without Python, so TypeScript types cannot be generated at build time from a Python model.
- `MAX_QUERIES` and `DEADLINE_SECONDS` are module-level so tests patch them (`test_schema_profiler.py:201-206`); the move to a package must keep that.
- Live catalog introspection does not exist (`source.basis` defaults at `build_explorer.py:30`), yet "connect to databases" requires it (D6).
- Quoted from `docs/reference/caveats.md` (C09): "A source checkout, ORM model, or stored snapshot documents a schema at one point in time. It is not proof of the live database schema. "Declared" means declared in the identified evidence source, not verified against a live catalog, unless the snapshot's provenance says so."

## Decision

1. **Backend**: Python 3.13 FastAPI in `services/api` with SQLAlchemy and Alembic on PostgreSQL 16 (`data-model.md`); a `worker` process (`python -m app.worker`) built from the same image claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` and runs `extract`, `profile`, and `export`; the API never opens a customer database connection.
2. **Profiler package**: move `schema_profiler.py` to `packages/profiler/bb_profiler` behind a `Driver` protocol (quote character, paramstyle, read-only session setup, statement timeout, `LIMIT` syntax, `introspect`, `approximate_row_count`) with `postgresql` and `sqlite` drivers, `BoundedReader(driver, session, Budget)`, `policy.py`, `targets.py`, and `compat.py` so `connect_readonly`/`profile`/`subtree` and all 51 tests pass unchanged. Per-table budgets replace the whole-run deadline; results are partial with `profiling.status='incomplete'` and a reason (C01, C05).
3. **Contract source of truth**: a committed JSON Schema `packages/contract/schema-graph.v1.json` adding `contractVersion` and promoting `kind`, `checks`, `file`, `definition`, `sampleValues`, `rowCountLowerBound`, and `profiling.status` (`schema-graph-contract.md` Part B). TypeScript types are generated into `packages/explorer/src/contract.generated.ts` (committed) and re-exported by `types.ts`; hand-written `ViewProps`, `Selection`, `NavigationTarget`, and `LiveConnection` stay in `types.ts`.
4. **Oracle**: the Python side validates a document with `jsonschema` against the same file and then runs `build_explorer.normalize()`; no pydantic codegen of the graph. The API stores the normalized graph. Both sides run the shared valid/invalid corpus.
5. **API surface (A04)**: workspaces, projects, snapshots (upload with size cap, ETag, gzip, list, delete), connections (write-only secrets), jobs (`POST`, `GET /jobs/{id}`, cancel), reviews (`PUT/GET reviews/{findingId}`), preferences, ERD layouts, export via `build_explorer.render()` with `Content-Disposition: attachment`. OpenAPI is the source of the SPA client types.
6. **Job semantics**: one running job per connection (partial unique index), `Budget(perTableSeconds default 5, max 60)`, job cap default 600 s hard max 3600 s, cancel honoured between items, `job_items` retention purge.

## Consequences

- Positive: the 60 existing tests keep passing; one semantic oracle; long jobs off the event loop; partial results end the class of failure where profiling a whole medium-sized schema in one request exceeds the deadline and returns nothing, without fabricating counts; OpenAPI-typed client.
- Negative: two type systems (JSON Schema + generated TS, Python validation) with a codegen check to keep them aligned; the worker adds a process and a queue table; `compat.py` carries the old API until callers move. Per-table budgets remove the whole-run guard, so the job cap is mandatory (plan risk).
- Neutral: pydantic models still exist for request bodies and settings; only the graph itself is not modelled in pydantic.

## Alternatives considered

- Node/TypeScript backend: rejected; the profiler, renderer, and 60 tests are Python, and psycopg 3 read-only semantics are proven.
- pydantic codegen for the graph with TS generated from pydantic: rejected; `packages/explorer/src` must build without Python, and `normalize()`'s 13 rules would be re-implemented or bypassed.
- Re-implement `normalize()` in TypeScript for client-side validation: rejected; the API is the only ingest point and duplicating rules invites drift.
- Run profiling inside API request handlers with a longer timeout: rejected; blocks the event loop and cannot cancel or report per-table progress.
- Celery/Redis queue: rejected at MVP; `SKIP LOCKED` on the existing PostgreSQL removes a service and matches single-tenant compose.
- Do nothing (keep the loopback server): rejected; no identity, no persistence, whole-run failures.

## CTQs affected

- CTQ-01 unknown stays unknown: incomplete items never write counts (merge test).
- CTQ-08 profiler bounds: per-table `Budget`, real PostgreSQL write rejection and `statement_timeout` tests (Q03).
- CTQ-07 security posture: RBAC matrix, IDOR negatives, secrets never in responses.
- CTQ-09 API p95 for profiling 20 tables <= 3 s.
- CTQ-12 Python coverage 85 %, auth/crypto/policy 95 %.
- CTQ-16 audit rows for jobs, exports, decisions.

## Verification

- C01: `scripts/gen_contract.mjs --check` green; corpus tests on both sides; `skill/references/schema-contract.md` field tables regenerated (Gate G1).
- A03: `packages/profiler` tests pass through `compat.py` unchanged; `Driver` conformance tests for both dialects; `introspect()` output validates against the schema and `normalize()`.
- A04: merge test proving incomplete items never write counts; one-running-job index test; upload size cap and ETag tests; `PUT /reviews/{findingId}` rejects ids not in the loaded graph.
- Q03: real PostgreSQL via compose qa: write rejected, `statement_timeout` aborts, per-table deadline yields `partial` with reason (Gate G2).

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed) | Backend lead |
| 2026-09-07 | Review fix: `connect_readonly` and `_Reader` citations corrected to `:189-224` and `:227-270` | Backend lead |
