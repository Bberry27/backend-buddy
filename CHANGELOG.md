# Changelog

All notable changes to Backend Buddy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every entry is prefixed with the work-package id (R, S, C, W, A, O, Q, D tracks) or feature id (F01–F22) that delivered it, so a line can be traced to its brief, branch, tests, and feature doc.

## [Unreleased]

### Security

- **R00** The private-data guard gained a `path:coverage-data` rule and now rejects
  `.coverage` and `.coverage.*` by name. coverage.py writes a SQLite database keyed by
  absolute source paths, so it is binary: the guard's NUL sniff skipped its content and
  the `content:windows-user-path` rule never saw the machine paths inside. One such file
  was tracked and is now removed from the working tree and git-ignored. It carried 66
  absolute paths naming the machine's user account and the private working copy, and no
  credentials. The blob remains reachable in history until the history is rewritten.

## [0.1.0-alpha] - 2026-09-08

First tagged release. Alpha: several views ship unfinished and are listed in
[`docs/releases/v0.1.0-alpha.md`](docs/releases/v0.1.0-alpha.md) section 3, which is the document to
read before demonstrating this build.

### Session summary, 2026-09-08

Picked up as a pre-product baseline: an offline HTML explorer with thirteen views and a
bounded read-only profiler, no repository, no container, no way to reach a database.
Ended with a private repository, a working local deployment, and a real PostgreSQL
rendering in all thirteen views from credentials typed into a browser.

What landed, in order: the private repository with a private-data guard and continuous
integration; the versioned SchemaGraph contract; the S01 security fixes closing a
confirmed stored cross-site-scripting sink, two SQL identifier-quoting bugs, a missing
dialect gate and a prefix-only spreadsheet-formula guard, each with a named regression
test; catalog introspection for PostgreSQL; a local admin area where credentials are
entered in a browser and encrypted on disk; a single-port Docker deployment with
one-command deploys; and the rename to Backend Buddy across every level.

Six defects were found by running it against a real database rather than by reading the
code: full TLS verification failed because the container's account had no home directory
for libpq's default certificate path; snapshots were written to a read-only path; a
mounted snapshot silently overwrote a populated schema on restart; the explorer was
cacheable at a URL whose contents change; every table landed in one district because
domain was set to the schema name; and every label carried a redundant schema prefix.

Where it stopped and what is next is recorded in `docs/HANDOFF.md`.


### Added

- R00: clean-tree export of the explorer view library, Python profiler, portable skill, build orchestration, and the legacy handoff document into a new repository; private example data, reference artifacts, QA outputs, and build outputs were never copied. The export script (`export_clean_tree.ps1`) stays in the owner's private copy because it names the private source paths and the files it renamed; the exported file list is the first commit, and the private-data guard governs the tree from there.
- R00: root repository configuration: `.gitignore` (ignores `reference/`, `examples/`, `dist/`, `skill/assets/extensions/dist/`, QA outputs, environment files), `.gitattributes` (LF line endings, binary markers), `.editorconfig`, `.nvmrc` pinning Node 22, and a VS Code workspace file (`backend-buddy.code-workspace`) that hides the generated skill mirror from search and holds no machine-local paths.
- R00: root governance documents: `README.md`, `LICENSE` (proprietary commercial license, draft pending legal review), `SECURITY.md`, `CONTRIBUTING.md`, `AGENTS.md`, and this changelog.
- R00: `scripts/private_data_guard.mjs` (`npm run guard`): forbidden private and QA-output paths, image and QA-report rules, 2 MB size cap, machine-local path detection, run in CI and before every commit; a name denylist runs only locally from a file outside the repository.
- R00: `scripts/generate_notices.mjs` (`npm run notices`) generating `THIRD_PARTY_NOTICES.md` from the lockfile, with a `--check` mode that fails on drift.
- R00: `scripts/text_hygiene.test.mjs` (part of `npm run test:scripts` and the CI `scripts` job): every file the private-data guard lists must use LF line endings and end with a newline, as `.editorconfig` and `.gitattributes` require.
- R00: GitHub configuration: `ci.yml` (explorer typecheck and unit tests, Python unit tests, offline artifact build with CSP assertion, private-data guard, script tests), `security.yml` (gitleaks, `npm audit --omit=dev`, pip-audit, notices drift, weekly schedule), pull-request template with the definition-of-done checklist, Dependabot for npm and GitHub Actions, and `CODEOWNERS`.
- C01: `packages/contract/schema-graph.v1.json`, the SchemaGraph contract as a JSON Schema (draft 2020-12) for contract version 1: every field of the canonical contract with its type, enumeration, required set, length cap and numeric bound, the legacy boolean and nullable wire forms still accepted, and unknown fields still ignored so a minor version stays backward compatible.
- C01: `scripts/gen_contract.mjs` (`npm run contract`, `npm run contract:check`), a dependency-free generator from that schema to `packages/explorer/src/contract.generated.ts`, to the field tables in `skill/references/schema-contract.md` and to Part A of `docs/architecture/schema-graph-contract.md`, which reproduces that reference verbatim; `--check` compares all three, fails on drift and runs inside `npm test`.
- C01: `packages/profiler` with the Python package `bb_profiler` and `bb_profiler.contract.validate_document()`, which validates a document with `jsonschema` and then runs `build_explorer.normalize()` as the semantic oracle, imported by path and never reimplemented; `ContractError` subclasses `ValueError`. `BB_CONTRACT_PATH` overrides the schema location.
- C01: contract corpus cases for the fields contract v1 promoted, generated into `fixtures/contract/v1/{valid,invalid}`: `contractVersion` at a higher minor with an unknown field, `profiling.status: incomplete` beside an unknown row count and a lower bound, three sample values; and, invalid, a mismatched major version, a string `line`, four sample values, and a negative `rowCountLowerBound`.
- C01: contract tests on both sides -- `packages/profiler/tests/test_contract.py` (17 cases), `packages/explorer/src/contract.test.ts` (5 cases) and `scripts/gen_contract.test.mjs` (11 cases) -- asserting that the structural and semantic stages partition the invalid corpus, that the schema's caps equal `NAME_CAP`, `TEXT_CAP` and `MAX_SCALAR_LENGTH`, and that a lower bound never sits beside a known row count.
- R01: seeded synthetic fixture generator `scripts/generate-fixtures.mjs` (`npm run fixtures`) producing `fixtures/schemas/{small,medium,medium-measured,large,edge-cases,many-domains,hostile,empty}.json`, `fixtures/sql/{sqlite,pg}/seed.sql`, and `fixtures/contract/{valid,invalid}` corpora, with tests that validate every fixture against the contract and `normalize()`.
- A01: `services/api`, the Python 3.13 package `app` holding the metadata store: SQLAlchemy 2 declarative models for the fifteen tables of `docs/architecture/data-model.md` section 3 with every check constraint, unique constraint, and index that document specifies; `app/db.py`, which resolves the store's URL from `BB_DB_*` with the password read only from the file named by `BB_DB_PASSWORD_FILE` and never rendered into a message; and a `WorkspaceScoped` mixin so a tenant-scoped table cannot be added without `workspace_id`.
- A01: Alembic revision `0001` (`services/api/alembic/versions/0001_initial.py`) with a working `downgrade()`, the `citext` extension `users.email` needs, and the trigger `audit_events_no_update_delete`, which makes the audit trail insert-only by raising SQLSTATE `42501` on UPDATE and DELETE (CTQ-16). `alembic.ini` and `alembic/env.py` take the URL from `app.db`, so no database URL is ever written into a configuration file.
- A01: `ops/sql/roles.sql`, creating `backend-buddy_migrate` (owns the schema) and `backend-buddy_app` (the api and worker role) with least privilege: insert and select only on `audit_events`, select only on `alembic_version`, no CREATE on the schema, and no password anywhere in the file. The script is idempotent, sets no default privileges deliberately, and fails rather than leave `backend-buddy_app` over-privileged on the audit trail.
- A01: 24 tests in `services/api/tests` against a real PostgreSQL 16 taken from `BB_TEST_DATABASE_URL`, each in its own throwaway database: upgrade -> downgrade -> upgrade on an empty database (CTQ-15), a drift check that Alembic's own comparison finds no difference between revision `0001` and the models, UPDATE and DELETE on `audit_events` both rejected with `42501`, one queued-or-running job per connection through the partial unique index, the frozen status enumerations rejected and accepted, the 5/60 s and 600/3,600 s budgets as defaults and as caps, and a static check that every tenant-scoped table carries `workspace_id` with an index leading on it and that no column stores a secret in the clear (CTQ-07).
- C02: `packages/explorer/src/tokens.css`, the design-token layer: the sixteen host variables byte-identical to `skill/assets/explorer.html:9-10` per theme, ten semantic tokens (`--danger`, `--success`, `--warning`, `--focus-ring`, `--selection`, `--selection-soft`, `--dim`, `--elevation-1..3`), and six data palettes with a value per theme (twelve domain hues, ten column families, three diff statuses, the Join Matrix cells with their soft variants and count ink, three Arc Diagram states, three Schema City road kinds, and the City hemisphere light). Custom properties only, no fetched resource of any kind, so the artifact CSP is untouched and bundle order against the nine view stylesheets cannot matter.
- C02: `packages/explorer/src/palettes.ts`, the single source those variables mirror, for the callers that cannot read a custom property: three.js materials, the Join Matrix canvas, and SVG attributes. `domainColor(domainId, allDomainIds, theme)` is deterministic by the domain's sorted position and returns the thirteenth domain onwards as a stripe over a reused hue instead of silently repeating a colour.
- C02: `packages/explorer/src/color-math.ts`: WCAG 2.1 relative luminance and contrast ratio, CIE L*a*b*, CIEDE2000 in the Sharma, Wu and Dalal formulation, CIE76, and dichromat simulation in the Brettel, Vienot and Mollon LMS space -- the Vienot 1999 single-plane reduction for protanopia and deuteranopia, whose composed linear-sRGB matrices the tests reproduce to five decimals, and the 1997 two-half-plane construction for tritanopia, which the 1999 simplification does not cover.
- C02: `packages/explorer/src/theme.tsx`: `ThemeProvider`, `useTheme()` and a module-level `useThemeDetector()` that watches `data-theme` on the root element and one `prefers-color-scheme` query for the whole bundle, however many views subscribe. It writes no storage; the theme choice stays with the shell.
- C02: `scripts/check-hardcoded-colors.mjs` (`npm run lint:colors`) with `check-hardcoded-colors.allow` and 15 tests: it fails on any hex, colour function, or CSS named colour in `packages/explorer/src` outside the token layer and the test files, and on an allowlist entry nothing matches any more, so an allowance cannot outlive the value it covers. The only entry is the Schema City district palette at `city-layout.ts:77` and `:194`, which W05 replaces.
- C02: 40 tests across `tokens.test.ts`, `palettes.test.ts` and `color-math.test.ts` (CTQ-11): the host variables parsed out of `explorer.html` and compared per theme, `tokens.css` and `palettes.ts` compared in both directions, `--ink` and `--muted` on all three surfaces at or above 4.5:1, every data and semantic colour at or above 3:1 on `--bg` and `--panel`, and no two members of a categorical palette closer than 11 CIEDE2000 under normal vision, deuteranopia, protanopia or tritanopia. Shortfalls that come from a frozen host value are recorded with an owner rather than hidden: `--edge` measures 2.29:1 on `--bg` in light mode, and `--warning` 4.21:1.

- Local admin area (`npm run admin`): add a PostgreSQL connection in a browser, test it, and populate its structure, with no environment variable and no file editing. Credentials are encrypted with AES-256-GCM under a key held only on the local machine, bound to the connection id so a ciphertext moved between records fails rather than authenticating as another connection. Secrets are write-only: no page renders a password, a certificate body, or ciphertext, asserted against the response body. Forms carry a server-issued token, because relying on the Origin header or a SameSite cookie fails in an embedded browser and reads to a user as the product being broken. Interim until work package A03 delivers the same flow inside the API; 13 tests cover it, including the full form-to-populated-schema flow against a real PostgreSQL.
- `scripts/introspect_pg.py`: read a PostgreSQL catalog into a contract-valid snapshot. Catalog metadata only, so no row, value, minimum or maximum is read; row counts are absent rather than estimated because the catalog figure is a planner guess.
- C03: `packages/explorer/src/selection.ts`, the drill-through selection model (feature F14, ADR-0004): the `ViewId` union of all fourteen views, `Selection` and `NavigationTarget`, and the id forms of `docs/architecture/schema-graph-contract.md` B3 -- `columnId`/`parseColumnId` for `table.id#column`, `relationshipRef`/`resolveRelationshipRef` for a `constraintId` else `source.column>target.targetColumn`, and `validateSelection`, which drops every id the loaded graph does not resolve and enforces "exactly one of `tableId`/`tableIds`". Identifiers that contain a separator are escaped inside each component, so the table id with an angle bracket in the hostile fixture round-trips; the relationship fallback keeps its dots and is resolved against the graph rather than parsed positionally.
- C03: `packages/explorer/src/route-state.ts`, one route grammar for both shells: the global keys `t c r ts f q d k`, the frozen per-view `v.*` allowlist, `MAX_VALUE_LENGTH` 200, canonical serialization (fixed key order, `v.*` sorted, `encodeURIComponent`, no empty values, byte-identical for equal states) and `fromHash`/`toHash` for the offline artifact. Deep links are treated as hostile input: an undeclared `v.*` name, an over-length value, a key outside the grammar, a repeated key and an undecodable escape are each dropped with a warning that names the key and never the value.
- C03: `packages/explorer/src/view-state.ts`, the persisted per-view slice under `backend-buddy:view-state:v1:<project scope>:<fingerprint>:<view>` (caveat C13), with `graphFingerprint` and `projectScope` extracted from `snapshotKey()` so the Living ERD layout key and the new family share both halves. Reads go through a caller-supplied validator and degrade to no state on absent storage, a throwing accessor, invalid JSON, a wrong version or a rejected value -- never to a fabricated one. The MVP slices for City, the relational map, Schema Diff and Row fan-out ship with their bounds validators.
- C03: `packages/explorer/src/navigation.ts`, the P1-P10 registry the inspector menu (W02), the context menus (W04) and the generated end-to-end matrix all read: `entries` with `from`, `to`/`toAll`, `requires`, `carries`, `label`, `viewStateKeys` and a `viewState` producer per entry, plus `targetsFor`, `resolve` (which throws on an unknown entry or a target the entry does not offer) and `caveatFor`. P2 and P10 are marked `prefillOnly`, and no module of the contract performs I/O or reaches for a live connection.
- C03: `packages/explorer/src/mount-policy.ts` and root reuse in `index.tsx`: `decideMount` returns `update` for the same container and view, and `recreate` only for a view change or a replaced container, so a filter keystroke re-renders in place instead of destroying the React tree (CTQ-10). `mountCount()` reports the number of roots created. The file carries the RK-05 note on what root reuse changes for the City selection effect and for Schema Diff's loaded snapshots.
- C03: `packages/explorer/src/caveat-strings.ts`, the checked mirror of `docs/reference/caveats.md`: all sixteen ids with their heading and their canonical blockquote, so every user-facing caveat string comes from one place (decision D8, rule DL-05). `caveats.test.ts` re-reads the source document and asserts the sixteen titles and texts match after whitespace normalisation, and that neither side carries an id the other does not.
- C03: 36 tests across `selection.test.ts`, `route-state.test.ts`, `view-state.test.ts`, `navigation.test.ts`, `mount-policy.test.ts` and `caveats.test.ts`, using the synthetic `small`, `medium` and `hostile` fixtures only: round trips over dotted table ids, a composite constraint id and an inferred link's fallback ref; the 200-character cap on values and on `ts` members; the allowlist per view; storage isolation across two projects and two snapshot fingerprints; twenty keystrokes producing one root; and the sixteen caveat equalities.
- A02: the FastAPI application in `services/api/app`: local accounts with argon2id hashes, a minimum length of 12 and a common-password deny list; server-side sessions carrying only a sha256 of a 256-bit token, in a `__Host-backend-buddy_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`) with a non-prefixed development fallback and a startup warning; rotation on login and on a role change; `POST /auth/sessions/revoke-all`; CSRF double submit bound to `sessions.csrf_token_hash` plus an origin check in middleware that also covers `POST /auth/login`; API keys scoped to one workspace at one role, shown once and stored as a prefix and a digest; and `python -m app.bootstrap`, which creates the first owner and the `encryption_keys` fingerprint row and refuses to run twice.
- A02: RBAC where the declaration is the enforcement (`app/auth/rbac.py`): a route depends on the object that checks it, `test_rbac_matrix` reads the declarations back out of the assembled application and fails on an undeclared route, and the same declarations are written into `services/api/openapi.json` as `x-backend-buddy-role`. Roles are `owner > admin > reviewer > viewer` read from `workspace_members` on every request, beside two declarations that are not roles: `public` and `authenticated`. Nobody may grant a role at or above their own, a workspace keeps at least one owner, and an identifier from another workspace answers 404 rather than 403.
- A02: the audit service (`app/audit.py`) with the closed vocabulary of `data-model.md` section 3.15, writing in its own transaction so a rejected login's `login.failure` row survives the rollback, and with `details` redacted before storage (CTQ-16).
- A02: `app/core`: the whole `BB_*` environment contract as pydantic-settings with an unknown `BB_*` variable failing startup and the master key read from a file and length-checked at boot; structlog JSON on stdout for every line including uvicorn's own, with a request id honoured from a proxy only when the peer is trusted and a redaction processor applied after the traceback is rendered; fixed client-facing error strings, including a replacement for FastAPI's validation handler, which by default echoes the rejected input -- the password, on a login body; the security headers and the strict SPA Content Security Policy from `security-architecture.md` section 6.2, emitted byte for byte and compared against that document by the test.
- A02: `GET /healthz` (touches nothing) and `GET /readyz` (store reachable, Alembic at head, master-key fingerprint matching, 503 with a redacted reason otherwise), slowapi rate limits on login and API-key creation, the SPA served from `packages/web/dist` with a traversal-safe path check and an HTML-only fallback, and `services/api/openapi.json` generated by `python -m app.export_openapi` with a `--check` mode that fails on drift.
- A02: 147 tests in `services/api/tests` against a real PostgreSQL 16, each class in its own throwaway database, including the CTQ-named `test_rbac_matrix`, `test_A02_idor_returns_404`, `test_A02_cookie_flags_and_csrf`, `test_A02_audit_rows_for_auth_events`, `test_A02_log_redaction`, `test_A02_settings_reject_unknown`, `test_A02_readyz_master_key_mismatch` and `test_A02_bootstrap_once`; `app/auth/**` coverage is 98 % against the 95 % floor (CTQ-12). Three of them assert against the documents rather than against the code: the SPA CSP against `security-architecture.md`, the audit vocabulary against `data-model.md`, and the environment contract against `deployment-architecture.md`.
- A02: `docs/security/authn-authz.md` (role matrix, cookie and CSRF model, API-key lifecycle, bootstrap procedure, what an operator must do outside the product, and the known gaps) and `docs/features/F20-auth-and-workspaces.md`, which D05 had not written.

- A03: **Measure row counts**, a separate consented action per connection, so a populated schema
  can carry measured row counts. Populating the structure reads catalog metadata and never queries
  a table, which is why every count was unknown, every Schema City building sat at the 0.6 baseline
  and every Row fan-out ratio read "Unavailable". `GET /connections/{id}/measure` states what will
  run before anything does -- one `SELECT count(*)` per table in a read-only session, no column
  value read, 15 s per table, 3 minutes for the run, views skipped because a view has no stored
  rows of its own -- and `POST` to the same path runs it, merges the counts and re-renders.
  Available only once a structure exists, and it says so until then.
- A03: counts are exact and unknowns stay unknown. `count(*)` is an exact count from the adapter,
  which is what `rowCount` is defined to hold, so a large table gets a real total rather than the
  `rowCountLowerBound` a capped 10,000-row sample would yield -- the profiler's cap would have left
  the biggest tables at baseline height, which is the opposite of the point. A table that times
  out, is refused, or is not reached before the run deadline keeps an unknown count and carries
  `profiling.status: 'incomplete'` with the reason in fixed wording; it is never back-filled with
  zero, never given a planner estimate, and never left holding a count from an earlier run. A
  measured zero is recorded as zero. A successful count clears any stale `rowCountLowerBound`,
  which the contract forbids beside a known count.
- A03: the contract-critical half is a pure function. `merge_row_counts(document, count_table)`
  takes a counting callable, so every rule about what may reach a snapshot is tested without a
  database, and only the driver half needs PostgreSQL. Counting statements are composed with
  `psycopg.sql.Identifier`, never interpolated (S01). 10 tests cover the rules; 2 more run the
  whole path against a real PostgreSQL 16 and assert every merged count equals `count(*)` from the
  database, that views are skipped, that the consent page precedes the read, and that the rendered
  artifact carries the measurement.

- A03: **Gather column statistics**, a second consented action, so a populated schema carries null
  fractions, distinct counts and -- where the type allows it -- extremes. One `SELECT` per table
  computed by the database: a row count, and per column a non-NULL count and a `count(DISTINCT)`.
  The aggregates come back and the rows do not, so no row is retained. `GET
  /connections/{id}/statistics` states all of that, and what will be withheld, before anything
  runs; `POST` to the same path runs it, merges and re-renders.
- A03: statistics cover the whole table, not a sample. That is why this path computes aggregates
  instead of calling the bounded row-sampling profiler, which caps at `MAX_ROWS` (10,000) and would
  have to report `rowCountLowerBound` and a sampled distinct count on anything larger. `sampled` is
  `false`, `scope` is `table`, and the Column Table view consequently reports 100% coverage rather
  than a fraction. The same pass yields an exact row count, so it refreshes `rowCount` and can never
  overwrite an exact count with a floor.
- A03: extremes are the one real value retained, and only where the type cannot carry free text, a
  secret or an identifier. `extremes_allowed()` keeps them for numeric, date, time and interval
  columns and withholds them for text, character, JSON, XML, array, binary, enum, UUID and boolean
  columns, which get counts alone -- the "string min/max off by default" rule of WP-A03. Retained
  extremes are truncated to the contract's 256-character scalar cap by the database, so an
  oversized value never crosses the wire. Sample values are not offered at all: they need the
  triple opt-in that `policy.py` will bring, and both actions strip any `sampleValues` an earlier
  run left behind rather than let them look current.
- A03: a column type the database refuses to aggregate no longer costs its table every statistic.
  `json` and `xml` have no equality operator, so one such column failed the whole statement; the
  pass now retries with counts alone and labels the table `profiling.status: 'incomplete'` with the
  reason, keeping the null fractions it did get. A distinct count nobody measured is absent, not
  zero. Verified on a real database: a table with `json`, `xml` and `integer[]` columns degrades on
  its own without touching the other 155.

### Changed

- A02: `SameSite=Strict` ships as the session cookie's default, tightening the `Lax` proposed in `docs/architecture/security-architecture.md` section 7 on the work-package owner's instruction; `BB_COOKIE_SAMESITE=lax` restores the documented value, and both halves are pinned by tests. The report proposes the same edit to that document.
- A02: `BB_DEPLOYMENT_MODE` (`self-hosted` by default, `hosted` for the multi-tenant edition) is declared in `app/core/settings.py` for the product owner's addendum to the A02 brief, so a private or loopback profiling target is allowed by default on a machine the operator owns and A03 has one switch to read rather than a policy to invent.
- A02: `services/api/pyproject.toml` and `requirements.txt` gained fastapi, uvicorn, pydantic-settings, argon2-cffi, structlog and slowapi. `cryptography` is deliberately not among them: A02's only cryptographic primitive is a sha256 fingerprint from `hashlib`, and a dependency the package cannot reach is a pip-audit row with no code path behind it. A03, which encrypts, declares it.
- C01: `packages/explorer/src/types.ts` re-exports the ten generated contract interfaces from `contract.generated.ts` and keeps only `SubtreeResult`, `ProfileResult`, `LiveConnection` and `ViewProps` by hand. The fields the views previously reached through an index signature (`kind`, `definition`, `checks`, `file`, `line`, `rowCount*`, `sampleSize`, `sampled`, `profiling` with `status` and `reason`, `sampleValues`, `typeDefinition`, the three default fields and `cardinality`) are now typed. No view changed and `npm run typecheck` passes untouched.
- C01: `npm test` runs the contract drift check first and discovers `packages/profiler/tests`, guarded like the `fixtures/` step so an empty tree skips with a message instead of failing.
- C01: `skill/references/schema-contract.md` gained a contract-version section and generated field tables between `<!-- generated:fields:start -->` and `<!-- generated:fields:end -->`; the prose above them stays hand written. `docs/architecture/schema-graph-contract.md` Part A is now written from that reference by the same generator and compared to it by `--check`, so the two prose copies of the contract cannot drift apart.
- R01: `npm run build` renders `dist/backend-buddy.html` from `fixtures/schemas/medium.json` by default; `--schema <path>` or `BB_SCHEMA` overrides it for local builds against snapshots that live outside the repository.
- R00: `scripts/verify_host.mjs` replaces the legacy host verifier under a project-neutral name. Its eight count assertions derive from the embedded snapshot (`report.schema`), the default output directory is the git-ignored `outputs/schema-map-qa` inside the repository, the `--local-living` and `--sample-fixture` bundles resolve `packages/explorer`, and a missing `playwright` or `pngjs` exits 2 with instructions instead of a stack trace; `scripts/verify_host.test.mjs` pins that contract. S02 pins those dependencies and adds the `--schema` cross-check, the theme loop, the remount counter, and axe.
- R00: the CI `scripts` job restores `packages/explorer` before `npm run test:scripts`, and `scripts/generate-fixtures.test.mjs` fails instead of skipping under `CI` when the TypeScript validators cannot load. `npm run test:scripts` (`node --test "scripts/**/*.test.mjs"`) is the single documented invocation; `scripts/repo_consistency.test.mjs` checks that every document names it, that the CI job restores first, and that the root governance documents link only to existing paths.
- R01: the fixture tests read the locally forbidden table and column counts from `BB_FORBIDDEN_COUNTS` instead of embedding them, so the repository stays count-neutral (AGENTS.md section 3); `fixtures/README.md` no longer states the values.
- R00: the Python HTTP test suite uses a neutral template filename.
- A01: `docs/architecture/data-model.md` section 6 now records a decision or an owner and a gate for each of its five open questions: the `finding_id` length cap is decided at 512 characters (the btree key limit for the unique index it sits in), and the snapshot size cap, the purge grace period, where `connection.test` runs, user erasure, and Schema City camera persistence stay open with an owner named.
- R00: the repository is initialised locally (`git init -b main`, `core.autocrlf=false`, `core.hooksPath=.githooks` via `npm run hooks`); the first commit passes the private-data guard in git mode through the pre-commit hook. The private GitHub repository, first push, and branch protection follow once the owner confirms the tracked file list.
- C02: every colour literal left the nine views. The 105 `var(--x, #hex)` fallbacks are gone, which fixes a real defect rather than a style point: each fallback held a dark-theme value, so a view mounted anywhere but the artifact host page rendered dark-on-light. `ColumnTable.css` maps `--ct-family` onto the palette variables and sets `color-scheme: inherit` instead of `light dark`; `SchemaDiff.css` keeps its `--sd-status` remap but takes the three base colours from the token layer; the Arc Diagram, Domains, Row fan-out, Normalization Lens and Schema City literals became `--arc-*`, `domainColor()`, `--danger`, `--road-*` and `--elevation-*`.
- C02: `JoinMatrix.tsx` reads the theme through `useTheme()` instead of attaching a `MutationObserver` to every ancestor of its viewport plus a `matchMedia` listener, once per mounted instance. The canvas repaints on a theme change exactly as before, the `getComputedStyle` reads keep working, and their fallbacks are now the palette rather than five dark-only hex values.
- C02: `LivingERD.tsx` passes `colorMode` to `<ReactFlow>`, and `LivingERD.css` maps the library's controls, minimap, handles, edge labels, selection box and node shadows onto tokens, so React Flow's own light defaults no longer show through.
- C02: the Domains view colours a community by its own id rather than by its rank in the table-count order, so a community keeps its colour when another one gains or loses tables, and the palette grew from eight hues to twelve plus a stripe variant.
- C03: `packages/explorer/src/types.ts` `ViewProps` gained the eight additive optional fields of the drill-through contract -- `selected`, `onSelectColumn`, `onSelectRelationship`, `onNavigate`, `viewState`, `onViewStateChange`, `fullGraph` and `theme` -- with `onSelectTable` unchanged, so the nine view components compile untouched and W04 wires them one at a time. `Selection`, `NavigationTarget` and `ViewId` are re-exported from `selection.ts` for the views that already import from `./types`.
- C03: `packages/explorer/src/living-logic.ts` `snapshotKey()` now composes its key from `view-state.ts`'s `projectScope` and `graphFingerprint` instead of holding its own FNV-1a hash. The returned string is unchanged for every input -- checked against the pre-C03 implementation over 49 fixture variants -- so saved Living ERD layouts are not orphaned, and `living-logic.test.ts` now pins the composed value.
- C03: `docs/architecture/drill-through-contract.md` section 10 records the implementation of sections 2 to 6, 8 and 9 with file and test paths; `docs/features/F05-living-erd.md` and `F15-inspector.md` sections 3 and 14, the `docs/features/README.md` F14 row, and the `docs/reference/limits-and-caps.md` row for the 200-character route cap now name the code that implements them.

- F08: Schema City states what a building's height encodes and lets you choose it. A **Height** selector offers `Rows (measured)`, `Columns (declared)` and `Indexes (declared)`; the legend names the basis in use and the "Unprofiled: baseline height" key appears only for the measured basis, because the declared ones are always known. This does not weaken the guardrail: `rows` still renders an unmeasured count as the baseline height with its label, `cityHeightValue()` returns null only for an unmeasured row count, and `building.rowCount` keeps the measured value whatever the bars encode, so the tooltip, the unprofiled marker and the road ratio still describe the data rather than the chart. Until row counts are populated (A03) the measured basis is a flat plane on every snapshot, which is what the city looked like with no way to say otherwise.
- F08: Schema City's camera is reachable without knowing the mouse bindings. Left-drag pan and right-drag orbit already worked but nothing said so: the toolbar now carries turn-left, turn-right, tilt-up and tilt-down buttons, the scene is focusable and driven by the arrow keys (shift to turn and tilt, plus and minus to zoom, 0 to fit), and the legend states the drag gestures. Button and drag share the same target as `OrbitControls`, so the two cannot disagree, and a press is clamped to the control's own `maxPolarAngle` rather than being able to put the camera under the ground plane. The turn and tilt controls are disabled on the flat map, which has no camera to orbit.
- F05: the Living ERD zooms through four tiers instead of two. `erdTier()` replaces `detail = zoom > 1.2, clusters = zoom < 0.4` with `overview`, `domains`, `tables` and `detail`, adding the intermediate step that lists a domain's member names before its cards appear, and a 1.06 hysteresis margin so a diagram parked on a boundary no longer flickers between two levels. The toolbar names the current tier.
- F05: the Living ERD overview shows the schema's shape rather than isolated blobs. Below zoom 0.4 the diagram previously drew no edges at all; `planErdEdges()` now resolves each relationship endpoint to whatever stands in for it, so cross-domain relationships appear as ribbons between the bubbles, thickness by `log1p(count)` and dashed when the evidence is only naming, and a relationship from an expanded table into a collapsed domain still reaches that domain's bubble instead of being dropped.
- F05: a domain expands in place. `domainBounds()` positions each bubble around the tables it contains, in the same coordinate space as those tables, replacing the separate canvas-sized `domainOverviewLayout` grid (now removed) whose coordinates had nothing to do with where the tables were. Clicking a bubble reveals that domain's tables inside the outline it occupied and leaves every other domain collapsed and the viewport still, which is what makes zooming out and back in additive rather than a replacement. Selecting a table opens the domains its one-hop neighbourhood spans and frames it with the neighbours beside it, instead of dropping onto the one table at a fixed zoom 1.35.

### Fixed

- A02: the request's database transaction is committed by `UnitOfWorkMiddleware` before the response is forwarded, rather than in a dependency teardown, which FastAPI runs after the response has been sent. Two operations depended on the difference: a live `uvicorn` run showed a revoked API key succeeding once more after its own `200`, and the same window applied to `POST /auth/logout`. A test client cannot see it, because it completes teardown before it hands back the response, so `services/api/tests/test_A02_transactions.py` drives the raw ASGI application and reads the database from another connection inside the `http.response.start` hook.
- A02: `POST /workspaces/{workspace_id}/api-keys` answered 500 on its **success** path whenever the rate limiter was enabled: slowapi with `headers_enabled` writes the rate-limit headers into the endpoint's own `Response` parameter and raises when there is none. The handler now takes one, and `test_A02_a_rate_limited_route_succeeds_with_headers` exercises every rate-limited route with the limiter on, which is the configuration a deployment runs and no other suite used.

- R00: `skill/SKILL.md` and `skill/agents/openai.yaml` were exported with CRLF line endings and `skill/assets/icons.json` without a final newline; all three now match `.editorconfig` and `.gitattributes`, so the working tree equals what git stores.

- D06: the documented setup steps install the `jsonschema` that the contract validator needs. `README.md`, `CONTRIBUTING.md`, `docs/HANDOFF.md`, `docs/developer/setup.md` and `docs/developer/troubleshooting.md` all stated that the Python code needs nothing beyond the standard library, and `setup.md` called `npm run restore` "the only install step". `bb_profiler.contract` has imported `jsonschema` at module scope since C01, so `npm test` on a fresh checkout failed with `ModuleNotFoundError: No module named 'jsonschema'` at the `packages/profiler/tests` step. The dependency was already declared in `packages/profiler/pyproject.toml` and pinned in `packages/profiler/requirements.txt`; only the instructions omitted it. The three command lists that summarise what `npm test` covers now name the contract and fixture steps they had been missing.

- F05: `layoutTables()` grouped tables by domain only nominally. Each domain was anchored at a fixed 1100x1000 grid cell however many tables it held, with an anchor strength of 0.012 against an unbounded charge force, and residual overlap was resolved by pushing a table straight down -- out of its own domain and into the one below. The result was tables of one domain sprawling across another, acres of empty canvas between cards, and, once the bubbles were drawn where the tables actually were, bubbles that overlapped. Cells are now sized from the area each domain's tables need (`domainCells()`, packed with proportional clearance because the spill scales with the domain), the anchor holds at 0.09, the charge force is capped at 1000 units, and overlap is resolved by searching outward from where the simulation left the table. `living-logic.test.ts` asserts the cells are disjoint and that the resulting bubbles are too.
- F05: domain labels were scaled by `min(1, zoom * 5)`, which shrank them on screen below zoom 0.2 -- illegible at exactly the tier that exists to be read at a glance. They now hold a constant on-screen size, capped by the bubble so a small domain shrinks its own label instead of overflowing. Ribbon strokes use `vector-effect: non-scaling-stroke` and their count labels are counter-scaled, for the same reason: both are drawn inside the viewport transform, which had reduced a 5px thread to a third of a pixel at the overview tier.

- F06: Row fan-out opened on a root with nothing under it. Only declared non-unique foreign keys
  are eligible to fan out, so most tables have no children at all -- 106 of the 160 in
  `fixtures/schemas/medium.json` -- and the root defaulted to the first table alphabetically, which
  in that fixture is `analytics.cohorts` with none. The view drew one lone node, offered no
  explanation, and read as broken. `defaultFanoutRoot()` now opens on the widest-fanning table,
  every option in the root select carries its child count or `(no fan-out)` from
  `fanoutChildCounts()`, and a root with no children gets a notice naming it and saying that no
  declared non-unique foreign key points at it. The model, the caps and the ratio semantics are
  unchanged: with row counts unpopulated every ratio is still reported as unavailable and the edges
  stay structural guides, which is A03's gap and not this one.
- S02: the CI `python` job runs every Python suite, through `npm run test:python`. It restated the
  suite list and had drifted from `scripts/project.mjs` twice: `packages/profiler/tests` was absent
  altogether, so the 17 contract tests (C01, CTQ-01 / CTQ-07 / CTQ-13) that check
  `packages/contract/schema-graph.v1.json` against `normalize()` never ran in continuous
  integration and the contract-drift gate was not in fact a gate; and `skill/scripts` was pinned to
  `-p test_renderer.py`, which excluded `test_renderer_security.py`, so the 31 S01 hardening
  regressions did not run either. Neither omission could fail a build, which is why both survived.
  `scripts/project.mjs` now exports `PYTHON_TEST_SUITES` as the single list behind both `npm test`
  and the new `npm run test:python`; the job installs `packages/profiler/requirements.txt` first,
  because `bb_profiler.contract` imports `jsonschema` at module scope and the suite cannot import
  without it. `scripts/repo_consistency.test.mjs` now fails if the job restates a suite, if it runs
  `unittest discover` itself, or if a listed start directory holds no tests.
- S02: `security.yml` pip-audits every requirements file. It named
  `packages/explorer/server/requirements.txt` alone and reported "the Python code currently depends
  on the standard library only" when that file was missing, so `packages/profiler/requirements.txt`
  and the `jsonschema` it pins were never audited, despite that file's own comment naming
  `pip-audit`. Each file is now audited in its own log group and a missing one is skipped by name.
- R00: `THIRD_PARTY_NOTICES.md` lists `jsonschema` (MIT). `scripts/generate_notices.mjs` held one
  hardcoded `PYTHON_REQUIREMENTS_FILE`, so a required dependency of `packages/profiler` was absent
  from the notices and the section asserted that the Python code runs on the standard library.
  `PYTHON_REQUIREMENTS_FILES` now lists both files, an unknown requirement names the file it came
  from, and one package pinned two different ways across files is refused rather than resolved
  silently to whichever was read first. The section heading is no longer "(optional)", since
  jsonschema is required rather than an operator's choice, and each entry says which it is.

- R00: `THIRD_PARTY_NOTICES.md` lists `cryptography`, which the container image installs and which
  appeared in no notices at all. That is a licensing defect in a product that is itself licensed:
  a recipient could not see every third-party component they were receiving. The entry records the
  dual Apache-2.0 OR BSD-3-Clause choice the package offers, that it is required rather than
  optional, and that the binary wheels statically link OpenSSL (Apache-2.0 for the 3.x series) and
  compiled Rust dependencies which the wheel's publisher redistributes, not this project. The
  section's blanket "nothing here is bundled" claim is now scoped to *by Backend Buddy*, because a
  binary wheel plainly does carry bundled components.
- R00: `tools/local_admin/requirements.txt` declares `psycopg[binary]` and `cryptography`, and
  `deploy/Dockerfile` installs from it instead of repeating the versions. Both were named only in
  the Dockerfile, so a developer met them by watching an import fail and the notices generator
  could not see them. The `psycopg` entry no longer calls itself optional without qualification:
  the whole test suite runs without it, but the admin area the container serves does not.
- R00: `PYTHON_TEST_SUITES` includes `tools/local_admin`, so its 42 tests run in `npm test` and in
  CI, which installs the declared requirements first. Ten of them are what keep row counts and
  column statistics honest, and none of them had ever run in continuous integration.
- R00: `security.yml` audits all three requirements files, and
  `scripts/repo_consistency.test.mjs` now fails when the three lists that must agree drift apart --
  what the notices generator declares, what pip-audit scans, and that the image installs from a
  declaration rather than a repeated version. Each of those has silently omitted a file once
  already.

- O01: an upgraded image re-renders the page it serves. The rendered explorer is written once, when
  a connection is populated, and then kept across restarts -- deliberately, because re-rendering a
  mounted snapshot over a populated one would silently replace the user's own database. But the
  same rule froze the *interface* at whatever the views looked like on the day the schema was
  populated: a container rebuilt with new views kept serving the old ones, a new toolbar control
  simply never appeared, and nothing on screen said why. Two rounds of "the buildings still are not
  taller" were this, not the heights.
  `tools/build_id.py` fingerprints everything that decides how a snapshot is drawn -- the renderer,
  the host template, the icon geometry and the compiled bundle -- and `deploy/entrypoint.sh`
  re-renders the populated snapshot when that fingerprint differs from the one recorded beside the
  page. Re-rendering the same snapshot with a newer renderer changes the picture and not the data,
  which is what makes it safe where replacing the snapshot is not; the mounted-snapshot guard is
  untouched. The admin area stamps `view.build` whenever it renders, so a fresh populate is not
  immediately considered stale. 5 tests.

- F08: a selected building is outlined in Schema City's 3D mode. The city is one InstancedMesh, so
  a selected instance cannot be styled on its own; `BuildingOutline` is a separate object sized to
  it, drawing the box edges plus a translucent face tint in the theme's selection colour. Its
  material has `depthTest` off, so the outline stays visible when the building is behind a taller
  neighbour, which is exactly the moment a user has lost track of what they picked. A hovered
  building gets the same treatment at lower opacity, so the pointer says what it is over before a
  click commits to it.
- F08: Schema City has a **Labels** control, defaulting to **Prominent**. Naming every table put
  forty overlapping pills over the buildings they described on a 171-table schema, which is more
  legible as noise than as names. Prominent names the twenty tallest by whatever basis the city is
  sizing by -- so it follows the Height selector rather than being a second, competing idea of what
  matters -- and All and Selected only remain a click away. Whatever is hovered or selected is
  always named whatever the density, which is what makes hiding the rest lossless: the answer is a
  hover away. A schema with fewer tables than the budget loses nothing, so the default is safe on a
  small database. Both the toolbar control and the legend state the rule in force.

- R00: `cryptography` is pinned at `>=50,<51`. The first run of the widened pip-audit reported six
  known advisories against 46.0.7 -- PYSEC-2026-3552, -3553, -3554 and GHSA-537c-gmf6-5ccf -- whose
  fixes land in 48.0.1, 49.0.0 and 50.0.0, and the previous `>=44,<47` ceiling could reach none of
  them. The vulnerable version had been shipping inside the container image, undeclared and
  unaudited, which is precisely what declaring and auditing it was meant to surface. Verified that
  the stored connection secrets still decrypt under 50.0.1: the AEAD API has been stable since 2.0.

### Security

Work package S01 closed the artifact and renderer findings below. Each is pinned by a named regression test in `skill/scripts/test_renderer_security.py`, which `npm test` now discovers.

- S01: the inspector no longer renders a table's source line reference unescaped. `table.line`
  is validated as a non-negative integer in `normalize()` and escaped at the sink, closing a
  stored cross-site-scripting path that fired on page load for the initially selected table.
- S01: read-only validation SQL now routes every table through the identifier quoter, so a
  dotted display id such as `warehouse.items` emits `"warehouse"."items"` instead of one
  identifier that does not exist. The structured-payload probe is dialect-gated:
  `jsonb_typeof` on PostgreSQL, `json_type` on SQLite, and no SQL at all otherwise.
- S01: the renderer neutralises `</script` and `</style` case-insensitively and `<!--` in both
  the inlined bundle and the inlined stylesheet, and `normalize()` validates the type,
  character set, and length of every display field, so a hostile snapshot can no longer break
  out of the template or blank the page with a non-string value.
- S01: the CSV export guard covers a formula operator preceded by whitespace, a tab, or a
  carriage return, not only one in the first position.
- S01: entity-type colour lookup uses `Object.hasOwn`, so a table typed `constructor` no
  longer resolves to an inherited function.
- S01: the host unmounts the React view only when the view changes, so filtering no longer
  destroys view state on every keystroke. The contract also gains `contractVersion` with a
  major-version compatibility check.
- S01: 31 regression tests in `skill/scripts/test_renderer_security.py` pin each of the above,
  executing the host's SQL helpers and CSV encoder under `node` rather than only matching
  source text, and rendering the hostile fixture to assert no live element or early close.

- C02: the token layer adds no fetched resource. `tokens.test.ts` asserts that `tokens.css` contains no URL reference, no import rule and no font declaration, and that it declares nothing but custom properties on `:root` and `:root[data-theme=dark]`, so the artifact CSP (`default-src 'none'`) stays byte-identical and the inlined stylesheet cannot reach the network. No dependency was added.

Loopback-server hardening (bind and allowed-host options, capability token moved out of the page into a cookie, same-origin fetch metadata on POST) is scheduled for S03.

Test-coverage note: two `node:test` browser suites in `packages/explorer/src` are collected by `npm test` and self-skip without a Playwright runtime, so `npm test` is green without exercising them. S02 converts the six legacy browser suites into CI-gated Playwright specs and removes the self-skips (risk RK-15 in `docs/product-management/risk-register.md`).
