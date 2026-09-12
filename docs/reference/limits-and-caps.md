Status: draft | Owner: Backend lead | Last verified against code: pre-repo (2026-09-07)

# Limits and caps

Every numeric limit the product enforces, with the line that enforces it and the CTQ it serves. Section A is code that exists today (line numbers valid at the commit in the status header; `skill/assets/extensions/` is a generated copy and is never cited). Section B lists budgets from the approved plan that are targets for the MVP build and are not yet in code. The docs lint (Q05) checks that the values in section A match the constants in the source.

Rule: changing a cap is a reviewed change that updates this file, the feature document (sections 11 and 14), and the test that pins the value, in the same PR.

## A. Enforced in code today

### A1. Profiler (`packages/explorer/server/schema_profiler.py`)

| Cap | Value | Source | CTQ | Notes |
|---|---|---|---|---|
| `MAX_ROWS` | 10,000 rows per table sample | `schema_profiler.py:73`; clamp in `_cap()` `:96` | CTQ-08 | Requests above the cap are silently reduced (`min(value, MAX_ROWS)`), never rejected. |
| `MAX_DEPTH` | 4 hops for subtree traversal | `schema_profiler.py:74`; check `:461` | CTQ-08 | `depth` must be an int in `0..4`. |
| `MAX_PARAMETERS` | 400 bound parameters per statement | `schema_profiler.py:75`; used `:155`, `:411`, `:441` | CTQ-08 | Drives key batching. |
| `MAX_BATCH_KEYS` | 100 keys per batch | `schema_profiler.py:76`; `:441` | CTQ-08 | Effective batch = `min(100, (400 - 1) // pairs)`. |
| `MAX_QUERIES` | 512 queries per operation | `schema_profiler.py:77`; check `:248` | CTQ-08 | Exceeding raises `ProfileLimitError` (fail closed). Module-level so tests can patch it (`test_schema_profiler.py:202`). |
| `DEADLINE_SECONDS` | 5.0 s per operation | `schema_profiler.py:78`; deadline set `:235`, checked `:239-240` | CTQ-08 | Whole-operation deadline; on expiry `ProfileLimitError`. Patchable (`test_schema_profiler.py:204`, `:213`). The MVP replaces this with per-table budgets (section B). |
| `MAX_SCALAR_LENGTH` | 256 characters for retained scalars | `schema_profiler.py:79`; `:107`, `:110`, `:316` | CTQ-07, CTQ-08 | Strings truncated; bytes hex-encoded up to 128 bytes. |
| `MAX_FD_COLUMNS` | 32 candidate columns for functional dependencies | `schema_profiler.py:80`; `:334`, `:351` | CTQ-08 | Recorded as `maxCandidateColumns` in table profiling. |
| Sample values per column | 3 distinct, non-NULL, bounded scalars | `schema_profiler.py:363` (`_sample_values`) | CTQ-07 | Only when `include_sample_values=True`, an explicit boolean (`:370-371`); previously exported `sampleValues` are stripped (`:382-385`). |
| PostgreSQL `statement_timeout` at connect | 5000 ms | `schema_profiler.py:216` (`-c statement_timeout=5000`) | CTQ-08 | Set in the connection options for `connect_readonly`. |
| PostgreSQL `statement_timeout` per statement | remaining deadline in ms, minimum 1 | `schema_profiler.py:262-263` | CTQ-08 | `set_config('statement_timeout', ..., true)` inside the read-only transaction. |
| PostgreSQL `statement_timeout` at transaction start | `DEADLINE_SECONDS * 1000` = 5000 ms | `schema_profiler.py:289-290` | CTQ-08 | After `SET TRANSACTION READ ONLY` at `:288`. |
| SQLite connection timeout | `DEADLINE_SECONDS` | `schema_profiler.py:197` | CTQ-08 | `sqlite3.connect(..., timeout=DEADLINE_SECONDS)`. |
| SQLite progress handler | every 1,000 VM instructions | `schema_profiler.py:279` | CTQ-08 | Interrupts a running statement once the deadline has passed (`test_schema_profiler.py:208-214`). |
| SQLite write guard | `PRAGMA query_only = ON` | `schema_profiler.py:199`, `:278`; restored `:284` | CTQ-08 | |

### A2. Profiling CLI and loopback server (`packages/explorer/server`)

| Cap | Value | Source | CTQ | Notes |
|---|---|---|---|---|
| `profile_snapshot.py --limit` default | 10,000 | `profile_snapshot.py:18` | CTQ-08 | Passed as `max_rows`, then clamped by `MAX_ROWS`. |
| Request body size | 1..65,536 bytes | `serve_explorer.py:83-84` | CTQ-07 | Larger or empty bodies are rejected. |
| `maxRowsPerTable` default (`POST /api/profile`) | 10,000 | `serve_explorer.py:95` | CTQ-08 | |
| `depth` default and `maxRowsPerHop` default (`POST /api/subtree`) | 4 and 10,000 | `serve_explorer.py:101` | CTQ-08 | |
| Concurrent read-only jobs | 1 (single-flight lock, `409` otherwise) | `serve_explorer.py:88-90` | CTQ-08 | |
| Bind address | `127.0.0.1:<port>`, exact `Host` match | `serve_explorer.py:42`, `:58-59`, `:113` | CTQ-07 | S03 adds `--bind` and `--allowed-hosts`. |
| Host-side validation SQL timeout (PostgreSQL draft) | `SET LOCAL statement_timeout = '10s'` | `skill/assets/explorer.html:99` | CTQ-06 | Text inside the draft SQL the user may copy; the product never executes it (C04). |

### A3. Row fan-out (`packages/explorer/src/fanout-logic.ts`, F06)

| Cap | Value | Source | CTQ | Notes |
|---|---|---|---|---|
| Depth | clamped to 1..4 | `fanout-logic.ts:91` | CTQ-09 | Mirrors `MAX_DEPTH`. |
| Nodes per view | 400 | `fanout-logic.ts:100` | CTQ-09 | Notice text at `:120`: "View safety limit reached (400 nodes or 5,000 paths)...". |
| Paths visited | 5,000 | `fanout-logic.ts:104` | CTQ-09 | Same notice. |
| Live subtree rows per hop | request default 10,000 (server-clamped) | `serve_explorer.py:101` | CTQ-08 | Truncation notice at `fanout-logic.ts:142`. |

### A4. Other views (`packages/explorer/src`)

| Cap | Value | Source | CTQ | Notes |
|---|---|---|---|---|
| Join matrix canvas threshold | canvas when `tables.length > 100`, SVG otherwise | `JoinMatrix.tsx:25` | CTQ-09, CTQ-11 | Cell geometry `CELL = 26`, `LEFT = 164`, `TOP = 132` at `JoinMatrix.tsx:9`. |
| Schema City district palette | 7 colours, cycling by index | `city-layout.ts:77` (`COLORS`), `:194` (`COLORS[index % COLORS.length]`) | CTQ-11 | An 8th domain repeats the 1st colour. The replacement values now exist in `packages/explorer/src/tokens.css` (`--palette-domain-01..12`) and `palettes.ts` (`domainColor()`, 12 hues plus a stripe variant from the 13th domain); W05 swaps the call site. Until then both lines are allowlisted in `scripts/check-hardcoded-colors.allow` with W05 as the expiry. |
| Schema City layout test coverage | 1, 2, 12, 120, 600 tables | `city-layout.test.ts:20` | CTQ-09 | Layout kernel tested to 600 tables; 1,000+ is post-MVP (L-02). |
| Normalization lens dependency arrows per table | first 8 | `NormalizationLens.tsx:19`; notice `:45` | CTQ-09 | "First 8 sample dependencies drawn; all N listed." |
| Normalization lens link arrows per page | 48 | `NormalizationLens.tsx:91` | CTQ-09 | Cross-table duplicate/dependency arrows. |
| Normalization lens page size | default 8 tables | `NormalizationLens.tsx:57` | CTQ-09 | User-selectable. |
| Normalization lens live profile rows | `maxRowsPerTable: 1000` per visible table | `NormalizationLens.tsx:115` | CTQ-08 | Below the server cap by design. |
| Column table page size | 120 columns per "Show more" | `ColumnTable.tsx:14` (`PAGE_SIZE`), `:63-64`, `:92` | CTQ-09 | |
| Domains page size | default 60 tables | `Domains.tsx:52` | CTQ-09 | |
| Domains zoom | 0.01..2 | `Domains.tsx:109` | CTQ-03 | |
| Living ERD search results | 25 | `LivingERD.tsx:152` | CTQ-09 | |
| Living ERD sample values shown | 3 | `LivingERD.tsx:35` | CTQ-07 | Display cap; storage cap is the profiler's 3. |
| Living ERD zoom | 0.001..2.6 | `LivingERD.tsx:195` | CTQ-03 | Semantic zoom: detail above 1.2, clusters below 0.4 (`:102`). |
| Schema diff snapshot file size | 20 MB | `SchemaDiff.tsx:84` | CTQ-07 | Checked before parsing. |
| Schema diff nesting depth | 32 levels | `schema-diff-logic.ts:44` (`parseSchemaSnapshot`) | CTQ-07 | |
| Schema diff tables / links | 20,000 / 100,000 | `schema-diff-logic.ts:50` | CTQ-07 | |
| Schema diff columns | 200,000 | `schema-diff-logic.ts:68` | CTQ-07 | |
| Schema diff zoom | 0.4..1.6 | `SchemaDiff.tsx:130` | CTQ-03 | |
| Label truncation | Arc diagram 20 chars (`ArcDiagram.tsx:10`); Domains 34 (`Domains.tsx:137`); Schema diff 31 (`SchemaDiff.tsx:11`); Living ERD sample text 65 (`LivingERD.tsx:16`) | as listed | CTQ-02 | Display only; full text in tooltips or titles. |

## B. MVP budgets from the approved plan (targets, not yet in code)

Source: approved plan, CTQ registry and work packages. These become code in the WP named; until then they are targets recorded here so that `docs/product-management/ctq.md` and the feature documents cite one place.

| Budget | Target | CTQ | Lands in |
|---|---|---|---|
| SPA shell bundle | <= 350 KB gzipped | CTQ-09 | W01, `scripts/size-budget.mjs` |
| Schema City chunk | <= 700 KB | CTQ-09 | W01/W05 |
| Living ERD chunk | <= 250 KB | CTQ-09 | W01 |
| View time-to-interactive on the medium fixture | <= 1.5 s | CTQ-09 | Q01 |
| Schema City median frame time under swiftshader (60-frame scripted orbit, medium fixture) | <= 66 ms | CTQ-09 | Q01 |
| `layoutCity(large)` | <= 400 ms (node:test) | CTQ-09 | Q01 |
| API p95 for profiling 20 tables | <= 3 s | CTQ-09 | Q01, `tests/perf/api` |
| Regression gate after baselines | +20 % | CTQ-09 | Q01 |
| Per-table profiling budget | default 5 s, maximum 60 s | CTQ-08 | A03 (`Budget`, `BoundedReader`) |
| Job-level profiling cap | default 600 s, hard maximum 3,600 s | CTQ-08 | A04 |
| Running jobs per connection | 1 (partial unique index) | CTQ-08 | A04 |
| Sample values per column | 3, triple opt-in (policy, connection, request) | CTQ-07 | A03 (`policy.py`) |
| Route `v.*` value length | 200 characters | CTQ-07, CTQ-10 | C03: `packages/explorer/src/route-state.ts` `MAX_VALUE_LENGTH`, applied to every route value and to each `ts` member; an over-length value is dropped with a warning, never truncated |
| Inspector breadcrumb | 6 entries | CTQ-10 | W02 |
| Password minimum length | 12 characters, top-10k deny list | CTQ-07 | A02 |
| `docker compose up` to `/readyz` | < 5 min on a clean machine | CTQ-15 | O01 |
| Coverage gates | logic 90 %, components 75 %, overall 80 %, Python 85 %, auth/crypto/policy 95 % | CTQ-12 | S02, O02 |
| Snapshot upload size | to be decided in A04 (no value in the plan) | CTQ-07 | A04 |
| Finding id length | "length-capped", value to be decided in A04 | CTQ-07 | A04 |
| Offline artifact size | current build about 2.38 MB (plan); no budget set | CTQ-05 | to be decided |

## C. Preserved constants (do not change without an ADR)

| Constant | Value | Source | Why |
|---|---|---|---|
| Artifact CSP | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'` | `skill/assets/explorer.html` (byte-identical requirement, D9) | CTQ-05 |
| Host CSS variables | 16 variables | `skill/assets/explorer.html:9-10` | C02 copied the values byte-identically into `packages/explorer/src/tokens.css` and `palettes.ts` `HOST_COLORS`; `packages/explorer/src/tokens.test.ts` parses all three and fails on any difference. |
| Relationship `kind` values | `declared FK`, `inferred by naming` | `packages/explorer/src/types.ts:5`; `skill/references/schema-contract.md:51` | C07 |
| Storage key families | `backend-buddy:<project.key>:...` (`explorer.html:39`), `backend-buddy-erd:v1:<project.key>:<fingerprint>` (`living-logic.ts:72`) | as listed | C13 |
