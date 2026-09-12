Status: draft | Owner: Frontend lead | Last verified against code: pre-repo (2026-09-07)

# WP-Q01 Performance harness

| Field | Value |
|---|---|
| Work package | Q01 (track Q, phase 2) |
| Features | F08 (City frames, `layoutCity`), F05 (Living ERD chunk and TTI), F17 (API profile p95); every view for TTI |
| CTQs | CTQ-09 (primary); CTQ-12 (no silently skipped perf suite) |
| Caveats | none surfaced |
| Depends on | W01, W05, R01 |
| Blocks | none (O02 wires the nightly job; Q05 records baselines in docs) |
| Branch | `q01/perf-harness` |
| Gate | G2 |

### 1. Goal

Measure what CTQ-09 promises and record the first baselines: `performance.mark` time-to-interactive per view on the medium fixture, a 60-frame scripted City orbit under swiftshader (median frame), `layoutCity(large)` as a node:test, and an API p95 script for profiling 20 tables against the compose fixture database. Baselines are written to `docs/qa/perf-baselines.md`; the +20 % regression gate is enabled as a warning first (RK-07). A verifier can check the numbers exist for every view, that the harness runs on ubuntu CI with bundled Chromium, and that no suite is silently skipped.

### 2. Reading list (ordered)

1. `docs/product-management/ctq.md` CTQ-09 row (budgets, test names `CTQ-09 <view> tti`, `CTQ-09 city median frame`, `city-layout.perf.test.ts`, `tests/perf/api/profile_p95.py`; open question 1: the 20 tables come from `fixtures/sql/pg/seed.sql` under `compose.qa.yml`, proposal to confirm).
2. `docs/reference/limits-and-caps.md` B (budgets: shell <= 350 KB gz, City chunk <= 700 KB, Living ERD chunk <= 250 KB, TTI <= 1.5 s, City median frame <= 66 ms, `layoutCity(large)` <= 400 ms, API p95 <= 3 s, +20 % gate).
3. `docs/product-management/risk-register.md` RK-07 (calibrate first; medians over 60 frames; warm-up; warnings until two green weeks).
4. `docs/architecture/adr/ADR-0008-testing-strategy.md` and `tests/README.md` (S02): where perf suites live and how Chromium is launched.
5. `docs/features/F08-schema-city.md` section 11 and `F05-living-erd.md` section 11 (performance budgets per feature); `docs/features/_template.md` section 11 wording.
6. Existing code to reuse: `packages/explorer/src/city-browser.test.mjs:52-53` (Chromium launch with `--use-angle=swiftshader --enable-unsafe-swiftshader`; the S02-converted `tests/e2e/city.spec.ts` inherits it); `scripts/verify_host.mjs:40` (same flags); `packages/explorer/src/city-layout.test.ts:20` (layout tested to 600 tables; the `large` fixture extends it); `scripts/generate-fixtures.mjs --large` (`fixtures/schemas/large.json` is generated on demand and gitignored, `fixtures/README.md`).
7. `scripts/size-budget.mjs` (S02/W01) and `deploy/compose.qa.yml` (O01) for the API p95 environment.
8. `docs/engineering/testing-policy.md` (D03) and `docs/developer/test.md`.

### 3. In scope

- `tests/perf/tti.spec.ts`: for each of the 13 views plus Insights, navigate to the route on the medium fixture, wait for the view's `performance.mark('backend-buddy:view-interactive')` (added by W01's `ViewHost` as a tiny hook if absent; report if it requires a W01 follow-up), record `measure` from navigation start; 5 runs, median; name `CTQ-09 <view> tti`.
- `tests/perf/city-frames.spec.ts`: 60-frame scripted orbit (deterministic camera path) on the medium fixture under swiftshader, after a 30-frame warm-up; median and p95 frame times via `requestAnimationFrame` deltas; name `CTQ-09 city median frame`.
- `packages/explorer/src/city-layout.perf.test.ts` (node:test): `layoutCity(large)` wall time over 5 runs, median; run only when `fixtures/schemas/large.json` exists (generated in the CI step, never committed) and fail, not skip, when missing in CI.
- `tests/perf/api/profile_p95.py`: submits a `profile` job for 20 tables of the fixture database through the API, polls to completion, repeats 10 times, reports p95 of end-to-end job duration and of the per-table `elapsed_ms`; runs under `compose.qa.yml`.
- `scripts/perf-report.mjs`: collects the JSON outputs into one table and compares against `docs/qa/perf-baselines.md`; exits non-zero on > +20 % regression only when `PERF_GATE=fail` (default `warn`).
- `docs/qa/perf-baselines.md` (new): status header; environment description (runner, Chromium version, swiftshader); one row per metric with baseline, budget, date, commit; the flip date for the gate; the rule that a baseline changes only by a reviewed PR.
- Feature docs section 11 updated with the measured numbers for F05 and F08; F14 and F18 section 11 rows get their TTI numbers; O02's `nightly.yml` invokes the harness (O02 wires; Q01 provides the npm scripts `perf:tti`, `perf:city`, `perf:layout`, `perf:api`).

### 4. Out of scope

- Fixing regressions found (report to the owning WP); changing budgets (CTQ rule 1: reviewed PR updating `ctq.md`, `limits-and-caps.md`, and the pinning test).
- Lighthouse, real-user monitoring, OpenTelemetry (L-04, L-07).
- Nightly visual-regression matrix (L-01).
- Bundle size budgets themselves (`size-budget.mjs`, S02/W01); Q01 only reports them in the baseline file.
- Any change under `packages/explorer/src` other than the new perf test file; any change to `City.tsx` (W05).

### 5. May modify

```
tests/perf/**
packages/explorer/src/city-layout.perf.test.ts
scripts/perf-report.mjs
package.json                              (perf:* scripts only)
docs/qa/perf-baselines.md
docs/features/F05-living-erd.md           (section 11 numbers and section 14 row)
docs/features/F08-schema-city.md          (section 11 numbers and section 14 row)
docs/features/F14-drill-through-navigation.md, F18-insights-and-recommendations.md   (section 11 only)
CHANGELOG.md                              ([Unreleased] section, one line)
```

### 6. Must not touch

```
skill/assets/extensions/**              generated mirror
fixtures/**                             generated (large.json is generated in CI, never committed)
THIRD_PARTY_NOTICES.md                  generated
package-lock.json                       no dependency change
packages/explorer/src/**.tsx, *-logic.ts, city-layout.ts   W04/W05 (a needed performance.mark hook is reported, not added here)
packages/web/src/**                     W01 (same rule)
services/**, deploy/**                  A and O tracks
.github/workflows/**                    O02 wires the nightly job
docs/product-management/ctq.md, docs/reference/limits-and-caps.md   budgets change only by the CTQ rule-1 PR
docs/reference/caveats.md               frozen at G0
```

### 7. Frozen contracts

| Contract | Where defined | Pinned by |
|---|---|---|
| Budgets exactly as `limits-and-caps.md` B; baselines never alter a budget | CTQ-09 rule 1 | `scripts/perf-report.mjs` reads budgets from one constant that mirrors the file (docs lint DL-08 style check in Q05) |
| Medians over 60 frames after warm-up; 5-run medians for TTI; p95 for API | RK-07 | `tests/perf/**` |
| Chromium launch flags `--use-angle=swiftshader --enable-unsafe-swiftshader`; bundled Chromium; no `msedge` | S02; RK-09 | `playwright.config.ts` |
| Fixtures only; `large.json` generated, never committed; no counts from the original private example | ADR-0007; `fixtures/README.md` | guard; `fixtures/.gitignore` |
| Zero silently skipped suites: a missing prerequisite fails with a message | CTQ-12 | `scripts/no-skip-check.mjs` |
| Selector contract used to detect readiness (`#tab-<view>`, `[data-view]`, `.schema-city-scene`) | `drill-through-contract.md` 7 | `tests/perf/tti.spec.ts` |
| Regression gate +20 % as warning until two green weeks; the flip is a reviewed PR editing `perf-baselines.md` | RK-07 | `perf-report.mjs` `PERF_GATE` |

### 8. Deliverables checklist (definition of done)

- [ ] Harness and tests, names prefixed with `CTQ-09`, green on ubuntu CI with the acceptance commands
- [ ] Feature document sections 11 and 14 updated (F05, F08; section 11 for F14, F18)
- [ ] Migration: none, because no schema changes
- [ ] `CHANGELOG.md` line under `[Unreleased]`, prefixed with the id
- [ ] Release-note line in the PR body
- [ ] Security checklist completed (the API p95 script uses a fixture connection only; no DSN in argv or logs)
- [ ] Accessibility result: not applicable
- [ ] Performance measurement recorded: this package's deliverable is the baseline table itself
- [ ] Caveat text: not applicable
- [ ] `npm run guard` green
- [ ] `npm run build`: run so the artifact and chunks measured are current; mirror unchanged
- [ ] All changed paths inside the `may-modify` globs
- [ ] Package-specific: every CTQ-09 metric has a row in `perf-baselines.md` with a number, a date, and a commit

### 9. Acceptance commands

```sh
npm run restore
npm run guard
npm run build
node scripts/generate-fixtures.mjs --large
node --test packages/explorer/src/city-layout.perf.test.ts               # prints median ms; budget 400
npm run perf:tti                                                          # npx playwright test tests/perf/tti.spec.ts --reporter=json
npm run perf:city                                                         # npx playwright test tests/perf/city-frames.spec.ts
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml up -d --wait --wait-timeout 300
python tests/perf/api/profile_p95.py --base-url http://127.0.0.1:8000 --tables 20 --runs 10
node scripts/perf-report.mjs                                              # table vs baselines; PERF_GATE=warn
node scripts/size-budget.mjs
node scripts/no-skip-check.mjs <junit-output>
docker compose -f deploy/compose.yml -f deploy/compose.qa.yml down -v
```

Package-specific assertions: `perf-report.mjs` output has one row per view for TTI, one for City median frame, one for `layoutCity(large)`, one for API p95, and the size rows; `PERF_GATE=fail node scripts/perf-report.mjs` exits non-zero when a baseline is artificially lowered by 30 % in a scratch run (demonstrated once).

### 10. Reporting format

As `docs/product-management/agent-briefs/README.md` section 10 (files changed; acceptance commands run; definition of done; frozen contracts; measurements; out of scope, found; open questions; deviations). The measurements section is the baseline table.

### 11. Risks

| Risk | What this package does |
|---|---|
| RK-07 swiftshader flakiness | Warm-up, medians, warnings first; environment recorded with each baseline; variance across 3 CI runs recorded before the gate flips. |
| RK-09 Windows vs Linux | Baselines are ubuntu CI numbers only; local Windows numbers are not written to the file. |
| RK-01 private data | Fixtures only; the 20 tables are the fixture's. |
| RK-10 scope creep | Regressions are reported to W05/W01/A04, not fixed here. |

### 12. Change log

| Date | PR | Change |
|---|---|---|
| 2026-09-07 | - | Brief created (D08). |
