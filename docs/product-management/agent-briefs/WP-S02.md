Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# WP-S02 Test toolchain

| Field | Value |
|---|---|
| Work package | S02 (track S, phase 1) |
| Features | F01, F05, F06, F07, F08, F10, F11, F12, F22 (the six converted browser suites cover F05-F08 and F10-F12; `check_map_pan.cjs` covers F01; F08, F11, F12 have no feature document yet, see `docs/features/README.md:26`, `:29-30`) |
| CTQs | CTQ-02, CTQ-03, CTQ-04, CTQ-05, CTQ-07 (artifact part), CTQ-09 (size measurement only), CTQ-11 (artifact host views), CTQ-12, CTQ-14 |
| Caveats | none surfaced (a toolchain package; C16 is exercised by the flat-fallback checks but no caveat text is written) |
| Depends on | R01, S01 |
| Blocks | W01 (and every package whose acceptance runs Playwright: S03's spec-level checks are Python only, so S03 does not wait) |
| Branch | `s02/test-toolchain` |
| Gate | G1 |

### 1. Goal

Make browser behaviour a CI gate for the first time: pinned Playwright with bundled Chromium under swiftshader, axe, ESLint, coverage measurement, a size-budget script, the six legacy browser suites converted into `tests/e2e/views/` with `msedge` defaults and self-skips removed, `scripts/verify_host.mjs` parameterised so every expected count is derived from the loaded graph, and CI jobs that run all of it from a clean clone on ubuntu. The Gate G1 lines this package proves: "Six converted browser suites green on bundled Chromium", "Artifact CSP byte-identical and `verify_host` reports zero external requests", and the CTQ-12 baseline of silently skipped suites going from 2 to 0.

### 2. Reading list (ordered)

1. `docs/features/F22-offline-artifact-and-skill.md` sections 3 ("QA harnesses"), 4 (B1), 8-9, 14.
2. `docs/architecture/adr/ADR-0008-testing-strategy.md` (decision 4 is this package's specification; decisions 1, 7, 10 set the runners and environment) and `ADR-0007-private-data-and-fixture-policy.md` decision 4 (schema-derived assertions).
3. `docs/architecture/adr/ADR-0006-deployment-topology-and-artifact-csp.md` decision 5 (CSP asserted byte-identically; `test_explorer_http.py:34` is corrected by S03, not here).
4. `docs/product-management/ctq.md` rows CTQ-02, 03, 04, 05, 09, 11, 12 (the "Measurement method" column names the test files and test names this package creates or moves) and the CTQ-12 note (baseline of 2 silently skipped suites).
5. `docs/developer/test.md` sections 5-7 (the suite reference table with the env vars, channels, and flags of each legacy suite; the `verify_host.mjs` known limitations; the two skill-level checks). This package supersedes section 5 with `tests/README.md` and must update sections 5-7.
6. `docs/reference/limits-and-caps.md` section B (budgets: SPA shell 350 KB gz, City chunk 700 KB, Living ERD chunk 250 KB; the artifact has no budget yet) and section C (preserved constants).
7. Code, in this order:
    - `scripts/verify_host.mjs`: usage `:12`, `require('playwright')`/`pngjs` `:15-17`, default output directory `:19` (resolves outside the clone), browser launch with swiftshader flags `:40`, helpers `labelVisibility` `:63`, `boundsCheck` `:71`, `projectionMotion` `:116`, `cityDragCheck` `:158`, `viewSpecs` `:202`, the per-view inspector-parity block `:218-236`, the hardcoded private counts at `:249`, `:261`, `:269`, `:278`, `:292`, `:303`, `:327`, `:334` (`165`, `2363`, `2,363`), the stale component path `scripts/src/LivingERD.tsx` at `:32` and `:343` (`--local-living`, `--sample-fixture`), `externalRequests` recording `:320` and assertion `:361`, `report.json` writing `:363`, exit code `:368`. `report.schema` at `:323` already reads `window.schemaSnapshot()`: it is the source for every derived count.
    - `skill/scripts/check_explorer.cjs:17-18` (schema-derived counting to copy) and `skill/scripts/check_map_pan.cjs` (the pan-versus-click regression to fold into `tests/e2e/views/map.spec.ts`, then delete).
    - The six suites in `packages/explorer/src`: `city-browser.test.mjs` (swiftshader flags `:53`), `dependency-browser.test.mjs` (Join Matrix and Arc Diagram), `fanout-browser.test.mjs:22` (`channel: process.env.FANOUT_BROWSER_CHANNEL || 'msedge'`), `living-browser.test.mjs:26` (same idiom), `column-browser.test.ts:9` (skips unless `COLUMN_TABLE_PLAYWRIGHT_PATH`) and `:43` (`channel: 'msedge'`), `schema-diff-browser.test.ts:8` (skips unless `SCHEMA_DIFF_PLAYWRIGHT_PATH`) and `:26` (`channel: 'msedge'`). Each builds a React fixture with esbuild in memory; keep that mechanism, replace inline data with `fixtures/schemas/{small,medium,medium-measured,many-domains}.json`.
    - `packages/explorer/package.json:13` (`tsx --test src/*.test.ts` collects the two `.ts` browser suites), `packages/explorer/build.mjs`, `scripts/project.mjs:104-114`.
    - `.github/workflows/ci.yml` (jobs `explorer`, `python`, `artifact` with the substring CSP check at `:93`, `guard`, `scripts`) and `.github/workflows/security.yml`.
    - `packages/explorer/src/City.tsx` selectors and names the harness depends on: `.schema-city-*` classes (`schema-city-controls empty failure flat hovering legend name name-count name-priority names road-key scene summary target toolbar tooltip unprofiled-mark`), accessible names `3D city`, `Flat map`, `Zoom in`, `Zoom out`, `Fit city` (`:316-322`), `Interactive 3D schema city` (`:331`), `Schema City flat map` (`:224`); `LivingERD.tsx:179` `Search tables`, `:187` `Fit diagram`; `ColumnTable.tsx` `Inspect table <name>` (used at `verify_host.mjs:222`).
    - `tests/security/artifact.spec.ts` authored by S01 (this package makes it run).
8. `AGENTS.md` sections 5-7. `docs/engineering/testing-policy.md` and `accessibility-standards.md` (D03) do not exist yet; ADR-0008 is the policy until they land.

### 3. In scope

1. **Dependencies (root `package.json`, exact versions, devDependencies only)**: `@playwright/test`, `@axe-core/playwright`, `pngjs`, `eslint`, `typescript-eslint`, `eslint-plugin-jsx-a11y`, `eslint-plugin-react-hooks`, `c8`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. Playwright browsers installed in CI with `npx playwright install --with-deps chromium` (bundled Chromium only; no `msedge` anywhere in the tree afterwards). This is the dependency change the brief lists (README open question 2 is thereby answered for S02: the brief lists them, so no separate package).
2. **`playwright.config.ts`** at the root: projects `e2e`, `a11y`, `security` (`perf` is Q01); Chromium launch args `--use-angle=swiftshader --enable-unsafe-swiftshader`; `webServer` unused (artifact opens from `file://`; fixtures bundled in-test); reporter `list` plus `junit` to `test-results/` (git-ignored); retries 0.
3. **Six converted suites** under `tests/e2e/views/` (`city.spec.ts`, `matrix-arcs.spec.ts` from `dependency-browser`, `fanout.spec.ts`, `living.spec.ts`, `columns.spec.ts`, `diff.spec.ts`), each preserving the legacy assertions (pan/drag separation, WebGL loss and no-WebGL paths for City, pixel checks via `pngjs`, exports non-empty, responsive bounds) but: no `msedge`, no env-var self-skip, fixtures from `fixtures/schemas/`, expected counts computed from the loaded fixture, test names prefixed with the CTQ id (`CTQ-03 city 3d drag does not inspect`, `CTQ-04 canvas non-blank`, `CTQ-04 flat fallback under --use-gl=disabled`, ...). Delete the six legacy files from `packages/explorer/src` (the mirror follows via `npm run build`), so `tsx --test src/*.test.ts` collects 75 tests and 0 skips.
4. **`tests/e2e/views/map.spec.ts`** carrying the `skill/scripts/check_map_pan.cjs` assertions (pan above threshold does not open the inspector; ordinary click does) against the built artifact; then delete `skill/scripts/check_map_pan.cjs` and update `AGENTS.md`/`docs/developer/test.md` references to it. `skill/scripts/check_explorer.cjs` stays (it ships with the skill).
5. **`scripts/verify_host.mjs` parameterised**: replace the eight hardcoded assertions with values from `report.schema` (tables, columns, `knownRowCounts`, first id) and per-view DOM counts derived from the same JSON; `--schema <path>` flag that cross-checks `report.schema` against the given file's `tables`/`allColumns` totals; theme loop (`dark`, `light`) over all 13 tabs at each width with the bounds check; remount counter installed with `page.addInitScript` (define `window.BackendBuddyViews` through a setter that wraps `mount` and counts calls, then assert the count does not grow across 20 typed characters in `#search` on a React view; until C03 lands, record the count as a measurement and assert only that it is finite; flip to a hard assertion in C03's acceptance); `externalRequests` empty (keep `:320`/`:361`); axe (`@axe-core/playwright`) on the four host views and on flat City at 1366 and 390, both themes, failing on `serious`/`critical`; fix the stale `scripts/src/LivingERD.tsx` path (`:32`, `:343`) to `packages/explorer/src/LivingERD.tsx`; default output directory becomes `outputs/verify-host` under the repository (git-ignored). Usage string, `--widths`, `--views`, `--skip-diff`, and the `report.json` shape (`input`, `sha256`, `viewports`, `schema`, `checks[]`, `externalRequests`, `summary`) stay.
6. **`tests/security/artifact.spec.ts`** (from S01) wired and green: `CTQ-05 csp byte-identical`, `CTQ-05 zero external requests`, `CTQ-07 hostile fixture inert`.
7. **ESLint**: root `eslint.config.mjs` (flat config) with typescript-eslint, `jsx-a11y`, `react-hooks`; for `packages/explorer/src/**`: `no-restricted-imports` forbidding `react-router`, `react-router-dom`, `vitest`, `@testing-library/*`, and `no-restricted-globals` forbidding `fetch` (the artifact bridge lives in `explorer.html`, not in the package); `npm run lint` at the root.
8. **Coverage**: `npm run test:coverage` running `c8` over `tsx --test src/*.test.ts` in `packages/explorer` with the CTQ-12 thresholds configured (`logic 90`, `overall 80`) but enforcement (`--check-coverage`) switched on only if the measured baseline already meets them; otherwise record the baseline in the report and leave enforcement to O02 (CTQ-12 "Lands in: S02, O02"). Python coverage (`coverage run -m unittest`) is measured the same way. `scripts/no-skip-check.mjs` reads the JUnit output and fails on any skipped test (CTQ-12 "zero silently skipped suites").
9. **`scripts/size-budget.mjs`**: reads `scripts/size-budget.json`; measures gzip sizes of `packages/explorer/dist/extensions.js`, `packages/explorer/dist/extensions.css`, and `dist/backend-buddy.html`; the artifact entries are `warn` only (no budget exists, `limits-and-caps.md` B "to be decided"); the file carries the three SPA budgets from section B as `fail` entries that W01 activates when the paths exist. Prints one JSON line per entry.
10. **Vitest skeleton** for `packages/web`: `vitest.workspace.ts` at the root and `vitest.setup.ts` (jest-dom), with no `packages/web` sources yet (W01 creates them); `npm run test:web` exits 0 with "no test files" until W01.
11. **CI**: `ci.yml` gains jobs `lint` (`npm run lint`), `e2e` (build the artifact from `fixtures/schemas/medium.json`, `npx playwright test`, upload `test-results/` on failure), `verify-host` (`node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host --widths=1920,1366,390`, upload `report.json` as an artifact, never commit it), `coverage`; the `artifact` job's CSP check at `:93` becomes the full byte-identical string; `ci.yml:59` and `scripts/project.mjs` discovery patterns cover `skill/scripts/test_*.py` (S01 changed `project.mjs:108`; this package aligns `ci.yml`). The `python` job installs nothing extra.
12. **`tests/README.md`**: how to run each layer locally and in CI, the fixture each suite uses, the swiftshader flags, where outputs go, and the rule that no screenshot or `report.json` is committed. `docs/developer/test.md` sections 5-7 are shortened to point at it. `docs/features/F22-offline-artifact-and-skill.md` sections 3 and 14 record the harness changes; `docs/product-management/ctq.md` "Today" cells for CTQ-02, 03, 04, 05, 11, 12 are updated.

### 4. Out of scope

- Any change to `skill/assets/explorer.html` or `skill/scripts/build_explorer.py` (S01), or to `packages/explorer/server/**` (S03; including the `test_explorer_http.py:34` CSP constant, which S03 corrects).
- Any change to view components or CSS beyond deleting the six legacy suite files (C02, C03, W04, W05 own the views).
- `packages/web` sources, `ViewHost`, `window.__backend-buddyMounts`: W01. CTQ-10 measurement in the SPA: W01/W04.
- `tests/e2e/drill-through.spec.ts`, `tests/e2e/rowcount.spec.ts`, `tests/e2e/matrix.spec.ts`, `tests/e2e/pan-click.spec.ts` for the SPA: W04, W01.
- Performance harness (`tests/perf/**`, TTI, frame medians, `city-layout.perf.test.ts`), baselines, and the +20 % gate: Q01. This package only measures sizes.
- Security matrix beyond the artifact spec (RBAC, IDOR, CSRF, deep-link fuzz, storage isolation, bundle grep, SPA CSP violations): Q02.
- Trivy, SBOM, release workflow, nightly jobs: O02; compose-based e2e: O01/O02.
- Visual-regression baselines: L-01. Do not commit PNG baselines.
- Converting root to npm workspaces or moving `packages/explorer` dependencies: not decided (open question 1); keep `--prefix packages/explorer` unless the owner decides otherwise.

### 5. May modify

```
package.json                                     (devDependencies and scripts: lint, test:e2e, test:coverage, test:web, size, verify:host; no runtime dependency)
package-lock.json                                (root lockfile created by npm ci for the new devDependencies)
playwright.config.ts                             (new)
eslint.config.mjs                                (new)
vitest.workspace.ts, vitest.setup.ts             (new)
tests/**                                         (new: e2e/views/*.spec.ts, security/artifact.spec.ts wiring, README.md, fixtures loader helpers under tests/helpers/)
scripts/verify_host.mjs
scripts/size-budget.mjs, scripts/size-budget.json   (new)
scripts/no-skip-check.mjs                        (new)
scripts/*.test.mjs                               (tests for the two new scripts)
packages/explorer/src/*-browser.test.mjs, packages/explorer/src/*-browser.test.ts   (delete only)
skill/scripts/check_map_pan.cjs                  (delete)
.github/workflows/ci.yml, .github/workflows/security.yml
.gitignore                                       (add playwright-report/, test-results/, outputs/ if not already present; they are present today at .gitignore lines under "QA and test outputs")
docs/developer/test.md                           (sections 5-7)
docs/features/F22-offline-artifact-and-skill.md  (sections 3 and 14)
docs/product-management/ctq.md                   ("Today" cells only)
AGENTS.md                                        (the check_map_pan.cjs reference only)
CHANGELOG.md                                     ([Unreleased], lines prefixed S02:)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror; run npm run build instead
fixtures/**                             generated; change scripts/generate-fixtures.mjs only if in scope (it is not)
THIRD_PARTY_NOTICES.md                  generated by scripts/generate_notices.mjs (devDependencies at the root are not bundled; run npm run notices:check to confirm no drift)
packages/explorer/package.json, packages/explorer/package-lock.json   the explorer package gets no new dependency
packages/explorer/src/**                except deleting the six legacy suite files listed above
packages/explorer/build.mjs             no metafile/sourcemap change here (ADR-0002 decision 4 is delivered by W01 with the SPA budgets)
packages/explorer/server/**             S03
skill/assets/explorer.html              S01 / S03
skill/scripts/build_explorer.py         S01
skill/scripts/check_explorer.cjs        ships with the skill; stays
docs/reference/caveats.md               frozen at G0
docs/reference/limits-and-caps.md       no cap changes; the artifact budget stays "to be decided"
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Artifact CSP byte-identical (full string in `docs/reference/limits-and-caps.md` C) | `skill/assets/explorer.html:6` | `tests/security/artifact.spec.ts` `CTQ-05 csp byte-identical`; `ci.yml` job `artifact` full-string grep |
| Zero network requests from the artifact | D9 | `verify_host.mjs` `externalRequests` (`:320`, `:361`); `CTQ-05 zero external requests` |
| Selector contracts: `.schema-city-*` family, `data-selected="true"`, `is-selected`, `data-rowcount` values, accessible names `Search tables`, `3D city`, `Flat map`, `Fit city`, `Fit diagram`, `Inspect table <name>` | `agent-briefs/README.md` frozen list; `City.tsx:316-322`, `LivingERD.tsx:179`, `:187` | The converted suites and `verify_host.mjs` consume them; this package must not rename any and must not add new ones (W04/W05 add `data-selected`) |
| `report.json` shape and `verify_host.mjs` CLI (`--widths`, `--views`, `--skip-diff`, positional input and output) | `scripts/verify_host.mjs:12`, `:29` | `scripts/verify_host.test.mjs` (new, parses the usage string and a sample report) |
| Project-neutral fixtures: no test asserts a count that originated in the original private example; expected counts are derived from the loaded graph | ADR-0007 decisions 3-4 | `npm run guard`; local denylist; review of every `assert.equal(... , <literal>)` in `tests/**` |
| Browser: bundled Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`; no `msedge` | ADR-0008 decision 4 | `grep -rn msedge tests scripts packages/explorer/src` empty |
| `npm test` remains the default gate and keeps running `scripts/project.mjs test` (typecheck, 75 logic tests, Python, fixtures) | `scripts/project.mjs:104-114` | `npm test` green; Playwright runs under a separate script and CI job |
| `packages/explorer` builds with `node:test` only (no Vitest, router, or fetch inside the package) | ADR-0002 decision 2 | `eslint.config.mjs` `no-restricted-imports` / `no-restricted-globals`; `npm run lint` |
| Storage key families, host CSS variables, `normalize()` oracle, profiler caps | repository-wide list | Untouched by this package |

### 8. Deliverables checklist (definition of done)

- [ ] Code and tests, names prefixed with CTQ ids in `tests/**` and `S02` in `scripts/*.test.mjs`, green locally with the acceptance commands
- [ ] Feature document sections 3 and 14 updated: F22 (harnesses); F05-F08, F10-F12 rows in `docs/features/README.md` unchanged (test file paths there already name `tests/e2e/views/*.spec.ts`)
- [ ] Migration: none, because this package has no server-side state
- [ ] `CHANGELOG.md` lines under `[Unreleased]` prefixed `- S02: ` (Added: toolchain, converted suites, verify_host parameterisation, size budget script, no-skip check; Removed: six legacy suites, `check_map_pan.cjs`, `msedge` defaults)
- [ ] Release-note line in the PR body
- [ ] Security checklist (interim, until D03): every new devDependency pinned exactly; `npm audit --omit=dev --audit-level=high` unchanged (dev-only additions); `npm run notices:check` green; no test writes outside `outputs/`, `test-results/`, `playwright-report/`
- [ ] Accessibility result recorded: axe counts per host view and flat City at 1366/390 x dark/light from `verify_host.mjs` (serious/critical must be 0; moderate/minor listed for the Design and accessibility lead)
- [ ] Performance measurement: `node scripts/size-budget.mjs` output (gzip bytes for `extensions.js`, `extensions.css`, `dist/backend-buddy.html`) recorded in the PR body and in F22 section 3 as the first artifact-size measurement (F22 B11)
- [ ] Caveat text: none added (no UI change)
- [ ] `npm run guard` green; no PNG, `report.json`, or private schema added; `outputs/` and `test-results/` git-ignored
- [ ] `npm run build` run and the mirror committed (the six suite deletions propagate to `skill/assets/extensions/src`)
- [ ] All changed paths inside the `may-modify` globs
- [ ] CTQ-12 baseline recorded: skipped suites 0 (was 2), coverage percentages for `packages/explorer` logic modules and Python, with the enforcement decision stated

### 9. Acceptance commands

From the repository root on ubuntu (`PYTHON=python3`), in order.

```sh
npm ci                                                        # root devDependencies (new lockfile)
npm run restore
npx playwright install --with-deps chromium
npm run guard
npm run lint                                                  # exit 0
npm run typecheck
npm test                                                      # 75 node:test cases, 0 skipped; Python and fixture tests green
npm run test:coverage                                         # prints coverage; exit 0 (enforcement per section 3 item 8)
node scripts/no-skip-check.mjs test-results/junit.xml         # exit 0, "0 skipped"
npm run build
npx playwright test tests/e2e/views tests/security            # six view suites + artifact spec green on bundled Chromium
node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host --widths=1920,1366,390
node -e "const r=require('./outputs/verify-host/report.json');if(r.externalRequests.length||r.summary.failed)process.exit(1);console.log(r.schema)"
node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host-small --schema fixtures/schemas/small.json --views=map,city   # counts cross-checked against the given schema
node scripts/size-budget.mjs                                  # one JSON line per entry, exit 0
npm run notices:check
grep -rn msedge tests scripts packages/explorer/src | wc -l   # 0
ls packages/explorer/src/*-browser.test.* 2>/dev/null | wc -l # 0
test ! -f skill/scripts/check_map_pan.cjs
grep -c "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'" .github/workflows/ci.yml   # 1
git status --porcelain fixtures skill/assets/explorer.html skill/scripts/build_explorer.py packages/explorer/server   # empty
```

The verifier additionally builds from a second fixture and re-runs the harness to prove that no count is hardcoded:

```sh
node scripts/project.mjs build --schema fixtures/schemas/many-domains.json
node scripts/verify_host.mjs dist/backend-buddy.html outputs/verify-host-many --widths=1366
node -e "const r=require('./outputs/verify-host-many/report.json');if(r.summary.failed)process.exit(1)"
```

### 10. Reporting format

Per `agent-briefs/README.md` section 10. Measurements must include: number of Playwright tests and their durations, axe serious/critical counts per view/theme/width, gzip sizes from `size-budget.mjs`, c8 and Python coverage percentages, skipped-test count, and the remount count observed across 20 keystrokes (informational until C03). "Out of scope, found" must list any selector or accessible name a converted suite needed that is not in the frozen list.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-01 private-data leakage | Every literal count in the six suites and `verify_host.mjs` is replaced by a derived value; the verifier's second-fixture run (section 9) proves it; `report.json` and PNGs go to git-ignored `outputs/`, `test-results/` |
| RK-07 swiftshader flakiness | Pixel checks use the legacy thresholds and medians; no perf assertion here; retries 0 so flakiness is visible, and any flaky check is reported, not retried away |
| RK-09 Windows vs Linux | ubuntu CI is the reference; `PYTHON=python3`; no absolute paths; `pathToFileURL` for `file://` |
| RK-15 silently skipped tests | Self-skips removed; `scripts/no-skip-check.mjs` fails CI on any skip |
| RK-22 duplicated source trees | Deleting the legacy suites from `packages/explorer/src` and running `npm run build` prunes the mirror (`syncFolder` at `scripts/project.mjs:43-50`) |
| RK-23 CI has never run | The first green run of `ci.yml` from a clean clone is a deliverable of this package's PR; report the run URL |
| RK-10 scope creep | No SPA tests, no perf harness, no visual baselines |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Initial brief (D08). |

Open questions for the owner (needed before S02 starts):

1. Whether the root `package.json` becomes an npm workspace (ADR-0001 layout) in this package or stays on `--prefix packages/explorer` until W01 adds `packages/web`. This brief assumes `--prefix` stays and root devDependencies are installed with a root lockfile.
2. Whether coverage thresholds are enforced in this package if the measured baseline is below the CTQ-12 targets (default here: measure and record; enforce in O02).
3. Whether `skill/scripts/check_explorer.cjs` should also stop requiring `playwright` unconditionally (it ships with the skill and is outside this package's scope); owner of the skill docs to decide by G1.
