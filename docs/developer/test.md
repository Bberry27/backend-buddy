Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# Testing

Every test command that exists in the repository, what it covers, and what it does not. The policy behind these commands (layers, coverage targets, gates) is `docs/engineering/testing-policy.md` (D03); the CTQ each command measures is in `docs/product-management/ctq.md` (D04). This page is the operational reference.

Two facts to keep in mind at the commit in the status header:

- `npm test` runs no browser code. The six Playwright suites exist but are not wired in, Playwright is not a dependency, and four suites default to Microsoft Edge. Work package S02 fixes this (pinned `@playwright/test`, bundled Chromium, suites moved to `tests/e2e/views/`).
- `scripts/verify_host.mjs` still carries count assertions from the original private example and therefore fails on fixtures until S02 parameterises it (section 6).

## 1. The default gate: `npm test`

```sh
npm test
```

`node scripts/project.mjs test` runs, in order, and stops at the first failure (`scripts/project.mjs:104-115`; `run()` exits with the child status, `:14-18`):

| Step | Command executed | What it covers |
|---|---|---|
| 1 | `npm run typecheck` in `packages/explorer` (`tsc --noEmit`, `packages/explorer/package.json:12`) | Types of `packages/explorer/src` including the two `.ts` browser tests; the `.mjs` files are not typechecked |
| 2 | `npm test` in `packages/explorer` (`tsx --test src/*.test.ts`, `:13`) | 75 pure-logic tests in seven files (section 2); `column-browser.test.ts` and `schema-diff-browser.test.ts` match the glob but self-skip unless their env var is set |
| 3 | `python -m unittest discover -s packages/explorer/server -p test_*.py` | 32 profiler tests + 19 HTTP/CLI tests (section 3) |
| 4 | `python -m unittest discover -s skill/scripts -p test_*.py` | 9 renderer contract tests + 31 S01 renderer security regressions (`test_renderer_security.py`) |
| 5 | `python -m unittest discover -s fixtures -p test_*.py`, guarded by `hasUnittestFiles()` (`scripts/project.mjs:67-81`, `:109-113`), which prints a skip line when no `fixtures/test_*.py` exists | 10 fixture validation tests in `fixtures/test_fixtures_normalize.py` (R01): every committed fixture passes the contract and `normalize()` |

The interpreter is `PYTHON` or the platform default (`scripts/project.mjs:10`); step 5 exists because Python 3.12+ exits non-zero when discovery finds nothing (comment at `:62-66`).

Individual pieces:

```sh
npm run typecheck                                 # step 1 only
npm --prefix packages/explorer test               # step 2 only
python -m unittest discover -s packages/explorer/server -p 'test_*.py'
python -m unittest discover -s skill/scripts -p 'test_*.py'
python -m unittest discover -s packages/profiler/tests -p 'test_*.py'   # needs jsonschema
python -m unittest discover -s fixtures -p 'test_*.py'
npm run test:python                               # all four of the above, the list CI uses
python -m unittest packages.explorer.server.test_schema_profiler -v   # does not work: use -s discovery, the modules import each other by bare name
```

Quote `test_*.py` in bash and zsh so the shell does not expand it. On Windows PowerShell the quotes are optional.

## 2. TypeScript logic tests (`node:test` via tsx)

Seven files in `packages/explorer/src`, 75 tests, no DOM, no React rendering. They pin the invariants behind caveats C01, C07, C11, and C12 (wording in `docs/reference/caveats.md`), plus dialect quoting and deterministic layouts without input mutation.

| File | Tests | Module under test |
|---|---|---|
| `schema-diff-logic.test.ts` | 21 | `schema-diff-logic.ts` (diff, DDL, migration draft, snapshot parser hardening) |
| `column-logic.test.ts` | 13 | `column-logic.ts` |
| `fanout-logic.test.ts` | 11 | `fanout-logic.ts` |
| `dependency-logic.test.ts` | 9 | `dependency-logic.ts` (Join matrix, Arc diagram) |
| `living-logic.test.ts` | 9 | `living-logic.ts` |
| `lens-domain-logic.test.ts` | 7 | `lens-domain-logic.ts` |
| `city-layout.test.ts` | 5 | `city-layout.ts` (1, 2, 12, 120, 600 tables) |

Run one file:

```sh
npm --prefix packages/explorer exec -- tsx --test src/city-layout.test.ts
```

Test names must carry the feature or CTQ id once the id conventions apply (AGENTS.md, section 4): `test('F08 ...', ...)`.

## 3. Python tests (`unittest`)

| File | Tests | Notes |
|---|---|---|
| `packages/explorer/server/test_schema_profiler.py` | 32 | In-memory SQLite plus a mocked `psycopg`; no live database. Module-level `MAX_QUERIES` and `DEADLINE_SECONDS` are patched by tests, which is why they stay module constants. |
| `packages/explorer/server/test_explorer_http.py` | 19 | Starts `serve_explorer.py` on a free loopback port and runs `profile_snapshot.py` as a subprocess against synthetic SQLite. Pins the `Host`/`Origin` security behaviour, including `localhost` rejected at `:206` (changes in S03). One test needs `node` on `PATH` and is skipped otherwise (`:373`). |
| `skill/scripts/test_renderer.py` | 9 | `normalize()` and `render()` contract: composite keys, unresolved references, duplicate columns, script-break containment, empty schema, `project.key` isolation. |
| `skill/scripts/test_renderer_security.py` | 31 | The S01 hardening regressions. Discovered by the default `test_*.py` pattern; `ci.yml` pinned `-p test_renderer.py` until S02 aligned it, so these did not run in CI. |

Run verbose: append `-v`. Run a single class or method with discovery pattern plus `-k`:

```sh
python -m unittest discover -s packages/explorer/server -p test_explorer_http.py -k Origin -v
```

PostgreSQL is exercised only through the mock until Q03 adds `packages/profiler/tests/test_postgres_live.py` against the Compose QA fixture.

## 4. Script tests (`node:test`)

```sh
npm run test:scripts        # node --test "scripts/**/*.test.mjs"; run npm run restore first
```

Covers every `*.test.mjs` under `scripts/` (any depth; other suffixes are not discovered): `scripts/private_data_guard.test.mjs` (18: rule set, allow list, denylist masking and refusal, git mode), `scripts/generate_notices.test.mjs` (20: license resolution, allowlist policy, deterministic output, `--check` drift detection, exit codes; R00), `scripts/generate-fixtures.test.mjs` (21: seeded determinism, contract validity of every fixture, the 2 MB cap, the local-only `BB_FORBIDDEN_COUNTS` check; the TypeScript-validator subtests skip locally without `npm run restore` and fail under `CI`; R01), `scripts/install-hooks.test.mjs` (4), `scripts/text_hygiene.test.mjs` (5: every file the guard lists uses LF line endings and ends with a newline, as `.editorconfig` and `.gitattributes` require; R00), `scripts/repo_consistency.test.mjs` (the script-test invocation is defined once in `package.json` and echoed by every document that names it, the CI `scripts` job restores before testing, the glob recurses, root governance documents link only to existing paths; R00), and `scripts/verify_host.test.mjs` (usage and exit codes, no count literals, in-repository default output, missing-dependency message; R00). Two tests skip on Windows (NTFS cannot create a file name containing a colon; symlinks need elevated rights) and some skip when `git` is absent; the skip reason is printed. CI runs `npm run restore` and then the same `npm run test:scripts` (`.github/workflows/ci.yml`, job `scripts`); Node 22 refuses a bare directory argument, so the glob lives in `package.json` only.

## 5. Browser suites (Playwright, not wired into `npm test`)

Six suites under `packages/explorer/src` cover seven of the nine React views (NormalizationLens and Domains have none; `dependency-browser.test.mjs` covers both Join matrix and Arc diagram). Each builds a fixture bundle in memory with esbuild, then drives a real browser. Two are `node:test` cases that self-skip; four are standalone top-level-await scripts that must be run with `node <file>` and are not matched by the `src/*.test.ts` glob.

### 5.1 Bring your own Playwright

Until S02, the runtime comes from outside the repository. Options: `npm init playwright@latest` in a scratch directory outside the clone, then `npx playwright install chromium`; or a global install. `pngjs` is also needed by the City and dependency suites and by `verify_host.mjs`. Point the env vars at that installation. Never commit a `node_modules` or a runtime path.

### 5.2 Suite reference

| Suite (`packages/explorer/src/`) | Kind | Views | Enable / module env var | Browser channel env var | Default channel | Screenshot env var | WebGL flags |
|---|---|---|---|---|---|---|---|
| `column-browser.test.ts` | `node:test`, skips unless set (`:9`) | Column table | `COLUMN_TABLE_PLAYWRIGHT_PATH` = path to the `playwright` package directory (`:11`) | none; hardcoded `channel: 'msedge'` (`:43`) | Edge | `COLUMN_TABLE_SCREENSHOTS` (`:99`, `:103`) | no |
| `schema-diff-browser.test.ts` | `node:test`, skips unless set (`:8`) | Schema diff | `SCHEMA_DIFF_PLAYWRIGHT_PATH` (`:9`) | none; hardcoded `channel: 'msedge'` (`:26`) | Edge | `SCHEMA_DIFF_SCREENSHOTS` (`:90`, `:94`) | no |
| `city-browser.test.mjs` | standalone script | Schema City (3D and flat, WebGL loss, no-WebGL page) | `CITY_BROWSER_MODULES` = directory containing `playwright` and `pngjs` (`:1`, `:11`); bare `require` otherwise | `CITY_BROWSER_CHANNEL` (`:52`) | bundled Chromium | `CITY_QA_SCREENSHOTS` (`:89`, `:106`) | `--use-angle=swiftshader --enable-unsafe-swiftshader` (`:53`) |
| `dependency-browser.test.mjs` | standalone script | Join matrix, Arc diagram | `DEPENDENCY_BROWSER_MODULES` (`:1`, `:11`) | `DEPENDENCY_BROWSER_CHANNEL` (`:48`) | bundled Chromium | `DEPENDENCY_QA_SCREENSHOTS` (`:65`, `:85`, `:101`, `:109`) | no |
| `fanout-browser.test.mjs` | standalone script | Row fan-out | `FANOUT_PLAYWRIGHT_MODULE` = module path or name (`:10`) | `FANOUT_BROWSER_CHANNEL` (`:22`) | `msedge` (`\|\| 'msedge'`; an empty string still selects Edge) | `FANOUT_SCREENSHOT` = output `.png` path (`:48`, `:51`) | no |
| `living-browser.test.mjs` | standalone script | Living ERD | `LIVING_PLAYWRIGHT_MODULE` (`:11`) | `LIVING_BROWSER_CHANNEL` (`:26`) | `msedge` (same idiom) | `LIVING_SCREENSHOT` = output `.png` path (`:73`, `:84`, `:88`) | no |

Screenshots go wherever the env var points, or next to the test file for `city`, `dependency`, `column`, and `schema-diff`. Images outside `docs/assets/` fail the guard, so write them outside the clone or delete them before committing.

### 5.3 Running them today

```sh
# node:test suites: set the env var, then run the normal explorer test script
COLUMN_TABLE_PLAYWRIGHT_PATH=/path/to/node_modules/playwright SCHEMA_DIFF_PLAYWRIGHT_PATH=/path/to/node_modules/playwright npm --prefix packages/explorer test

# standalone scripts: run each file directly with node
CITY_BROWSER_MODULES=/path/to/node_modules node packages/explorer/src/city-browser.test.mjs
DEPENDENCY_BROWSER_MODULES=/path/to/node_modules node packages/explorer/src/dependency-browser.test.mjs
FANOUT_PLAYWRIGHT_MODULE=/path/to/node_modules/playwright FANOUT_BROWSER_CHANNEL=chromium node packages/explorer/src/fanout-browser.test.mjs
LIVING_PLAYWRIGHT_MODULE=/path/to/node_modules/playwright LIVING_BROWSER_CHANNEL=chromium node packages/explorer/src/living-browser.test.mjs
```

`esbuild` resolves from `packages/explorer/node_modules`, so `npm run restore` must have run. Set a `*_BROWSER_CHANNEL` to an installed channel (`chromium`, `chrome`, `msedge`); the two `.ts` suites cannot be redirected away from Edge without editing the file (S02 removes the hardcoding).

What S02 changes: suites move to `tests/e2e/views/` under a root `playwright.config.ts`, the `msedge` defaults and self-skips go, fixtures come from `fixtures/schemas`, and CI runs them on bundled Chromium with the swiftshader flags. `tests/README.md` will supersede this section.

## 6. Whole-artifact harness: `scripts/verify_host.mjs`

Sweeps all thirteen tabs of a built artifact at three widths, checks containment, non-blank content, inspector parity, empty-filter behaviour, City drag-versus-select in 3D and flat mode, both WebGL failure paths, and that the artifact made zero external requests; writes `report.json`, `report.md`, and screenshots.

```sh
node scripts/verify_host.mjs dist/backend-buddy.html <output-directory> [--skip-diff] [--views=map,city,...] [--widths=1920,1366,390] [--sample-fixture] [--local-living]
```

Usage string at `scripts/verify_host.mjs:12`. Requirements and behaviour:

- `playwright` and `pngjs` are loaded with CommonJS `require` from the script's location (`:15-17`) through `loadDependency`, which exits 2 with installation instructions when one is missing; the header comment (`:2`) documents the resolution order (the `node_modules` above the script, then `NODE_PATH`). `--local-living` and `--sample-fixture` import `esbuild` from `packages/explorer`'s locked dependencies (`explorerEsbuild`, `:31`, `:342`) and bundle `packages/explorer/src/LivingERD.tsx` (`:32`, `:343`).
- Pass an output directory or accept the default `outputs/schema-map-qa` at the repository root (`:19`), which is git-ignored and excluded by the guard. The output contains `report.json` and PNGs, both rejected by the guard anywhere else, so never point it at a tracked directory.
- Browser: bundled Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`; `SCHEMA_QA_BROWSER_CHANNEL` selects an installed channel (`:40`).
- External requests are recorded at `:320` and asserted empty at `:361` (CTQ-05). Exit code 1 on any failed check (`:368`).
- Count assertions at `:249`, `:261`, `:269`, `:278`, `:292`, `:303`, `:327`, and `:334` derive from the embedded snapshot (`report.schema`, read through `window.schemaSnapshot()`), so the harness runs against any fixture; `scripts/verify_host.test.mjs` fails if a count literal returns. S02 adds the `--schema` cross-check, the theme loop over both themes, the remount counter, and axe.

## 7. Skill-level browser checks

Shipped with the portable skill for agents that render an artifact elsewhere:

```sh
node skill/scripts/check_explorer.cjs dist/backend-buddy.html <qa-directory>   # RELATIONAL_MAP_BROWSER_CHANNEL optional (skill/scripts/check_explorer.cjs:11)
node skill/scripts/check_map_pan.cjs dist/backend-buddy.html                   # SCHEMA_QA_BROWSER_CHANNEL optional (skill/scripts/check_map_pan.cjs:7)
```

Both `require('playwright')` unconditionally (`:1` in each) and take no WebGL flags, so they cannot exercise City in a GPU-less environment. `check_explorer.cjs` derives its expected counts from the embedded schema (`:17-18`) and is the model for the schema-derived assertions S02 adds elsewhere. `check_map_pan.cjs` is the click-drag pan regression that AGENTS.md requires to stay covered; S02 folds it into `tests/e2e` and deletes the duplicate.

## 8. Guard, notices, and other checks that run in CI

| Command | What it checks | CI job |
|---|---|---|
| `npm run guard` | Private-data rules on every tracked (or, without `.git`, every walked) file (`scripts/private_data_guard.mjs`) | `ci.yml` / `guard` |
| `npm run notices:check` | `THIRD_PARTY_NOTICES.md` matches the lockfile and the license allowlist (`scripts/generate_notices.mjs --check`, R00; regenerate with `npm run notices`) | `security.yml` / `notices-drift` (`.github/workflows/security.yml:83-101`) |
| `npm --prefix packages/explorer audit --omit=dev --audit-level=high` | Production dependency advisories | `security.yml` / `npm-audit` |
| `pip-audit -r packages/explorer/server/requirements.txt` | psycopg advisories | `security.yml` / `pip-audit` |
| gitleaks (default rules) | Secrets in history | `security.yml` / `gitleaks` |
| `npm run build` then `test -s dist/backend-buddy.html` and `grep -q "connect-src 'none'" dist/backend-buddy.html` | Artifact builds from fixtures and keeps the offline CSP | `ci.yml` / `artifact` |

## 9. Writing tests

- Name every new test with the feature or CTQ id (`F08 ...`, `test_S01_...`); the id is the link to the brief, branch, and feature doc (AGENTS.md, section 4).
- Derive expected counts from the loaded fixture, never from literals tied to one schema (AGENTS.md, section 3).
- Keep browser fixtures inline (the esbuild `stdin` pattern used by every existing suite) or under `fixtures/`; never a real snapshot.
- Prefer a `node:test` case with `{ skip: <reason> }` over a hard failure when a runtime is optional, and print the reason.
- Coverage gates (CTQ-12: logic 90, components 75, overall 80, Python 85, auth/crypto/policy 95) become enforceable with S02 (c8) and the API track; until then record the number in the PR.

## 10. What is not tested today

No component or renderer tests for React (no jsdom, Vitest, or Testing Library); no accessibility auditing (axe arrives with S02); no performance, size-budget, or frame-time measurement (Q01); no real PostgreSQL (Q03); no CTQ-06 check yet (the static lint and API test that enforce C04, `docs/reference/caveats.md`, arrive with S01 and the API track); no test that the built `dist/backend-buddy.html` CSP string is byte-identical beyond the `connect-src 'none'` grep in CI (S01/S02 add the exact comparison).
