Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0008: Testing strategy

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Platform lead, Frontend lead, Backend lead, Design and accessibility lead
- **Work packages**: S02, Q01, Q02, Q03, Q04, Q05, O02
- **Related**: ADR-0002, ADR-0003, ADR-0007, `docs/engineering/testing-policy.md` (D03), `docs/qa/*` (Q01, Q04)

## Context

`npm test` today runs `tsc --noEmit`, `tsx --test src/*.test.ts` (75 node:test cases over seven pure logic modules), and two Python `unittest` discoveries (51 profiler and HTTP tests, 9 renderer tests) through `scripts/project.mjs:104-115`; CI mirrors this in `.github/workflows/ci.yml` (jobs `explorer`, `python`, `artifact`, `guard`, `scripts`). Zero browser code is tested in that path: the glob excludes `*.test.mjs`, and the two `.test.ts` browser suites self-skip without an environment variable. Six Playwright suites exist but are unwired, Playwright is not a dependency, and four suites default to `msedge` (plan). `scripts/verify_host.mjs` is a 13-view harness with reusable helpers (`viewSpecs`, `boundsCheck`, `labelVisibility`, `cityDragCheck`, `projectionMotion`, byte-freezing, `report.json`) launched with `--use-angle=swiftshader --enable-unsafe-swiftshader` (`:40`), but it hardcodes private-example counts (8 occurrences) and has no npm entry beyond `verify:host`. PostgreSQL is covered only by mocks. There is no component, accessibility, performance, visual, security, or CSP test. Renderer injection coverage is one test with two vectors (`skill/scripts/test_renderer.py:60-68`).

Forces:

- CTQ-12 sets coverage gates: logic 90 %, components 75 %, overall 80 %, Python 85 %, auth/crypto/policy 95 %.
- CTQ-02, 03, 04, 10, 11 need a browser matrix (1920/1366/390 x light/dark x inspector open/closed; pan/click separation; 3D and flat City; drill-through across 13 views; axe on every route in two themes).
- CTQ-08 needs a real PostgreSQL to prove write rejection and `statement_timeout`.
- CTQ-09 needs frame-time and TTI measurements that are stable on shared CI (swiftshader is slow and pixel assertions flaky, plan risk).
- Ubuntu CI is the reference; development is on Windows (plan risk "Windows-only development vs Linux CI").
- The eight security findings close only with named regression tests (Gate G1).
- Quoted from `docs/reference/caveats.md` (C01): "Missing row counts and statistics are unknown: never zero, never a substituted value, never a fabricated count. Every visual that encodes a count labels unavailable data as unknown and keeps it distinguishable from a measured zero."

## Decision

Layers, each with its runner, location, and gate:

1. **Pure logic (node:test)**: `packages/explorer/src/*.test.ts` stay on `tsx --test`; new C03 modules (`route-state`, `selection`, `navigation`, `view-state`, `mount-policy`, `caveat-strings`) and C02 (`tokens`, `color-math`) follow. Coverage via c8, gate 90 %. `caveats.test.ts` asserts UI strings match `docs/reference/caveats.md`.
2. **Components (Vitest + Testing Library + jsdom)**: `packages/web` only; prop-change behaviour per view before root reuse is enabled in the artifact; gate 75 %.
3. **Python (unittest, later pytest-compatible)**: `packages/profiler/tests`, `services/api/tests`, `skill/scripts/test_renderer.py`; gate 85 %, 95 % for auth, crypto, and policy modules; real PostgreSQL tests in `packages/profiler/tests/test_postgres_live.py` run under `compose.qa.yml` (Q03).
4. **Browser (Playwright at repo root, `tests/{e2e,a11y,perf,security}`)**: pinned `@playwright/test` with bundled Chromium and swiftshader flags; `@axe-core/playwright`; the six legacy suites converted into `tests/e2e/views/` with `msedge` defaults and self-skips removed and fixtures instead of private data; `scripts/verify_host.mjs` parameterised (schema-derived counts, `--schema`, theme loop over 13 tabs, remount counter, `externalRequests` empty, axe on host views and flat City); `tests/e2e/drill-through.spec.ts` generated from the navigation registry.
5. **Security (Q02)**: `tests/security/` with the hostile fixture through all 13 views and the artifact, RBAC matrix, IDOR negatives, upload abuse, cookie/CSRF e2e, deep-link fuzz, storage isolation, bundle grep, SPA CSP-violation e2e; `docs/security/threat-model.md` maps each control to a test. Static lint for CTQ-06 (no path from draft SQL to a connection).
6. **Performance (Q01)**: `performance.mark` TTI per view on the medium fixture; City 60-frame scripted orbit under swiftshader (median <= 66 ms); `layoutCity(large)` <= 400 ms in node:test; API p95 for 20 tables <= 3 s against the compose fixture; baselines in `docs/qa/perf-baselines.md`, then a +20 % regression gate; budgets are warnings until two green weeks.
7. **Accessibility (CTQ-11)**: axe 0 serious/critical on all routes x 2 themes x 1366/390 and on artifact host views; two keyboard-only drill-through journeys; palette contrast and colour-vision-deficiency unit tests (`tokens.test.ts`).
8. **Docs and hygiene**: `scripts/docs_lint.mjs` (registry completeness, 14 headings, caveat ids and text, ADR index, limits match constants), PR-title regex carrying an F/CTQ id, `scripts/private_data_guard.mjs`, gitleaks, audits, notices drift (CI).
9. **Naming and traceability**: every test name carries its feature or CTQ id; test files for a WP are listed in its brief; a finding closes only with a named regression test.
10. **Environment**: ubuntu CI is the reference; no OS-specific baselines at MVP; browser suites run in `compose.qa.yml` locally and in CI; ESLint (typescript-eslint, jsx-a11y, react-hooks, `no-restricted-imports`) runs on every PR.

## Consequences

- Positive: browser behaviour becomes a CI gate for the first time; fixtures replace private data; coverage gates make the DoD measurable; the drill-through matrix is generated, so a registry entry cannot ship untested.
- Negative: two JavaScript test runners (node:test in `packages/explorer`, Vitest in `packages/web`) and a Playwright image in CI; swiftshader runs are slow and need calibration; real-PostgreSQL tests need the compose stack.
- Neutral: the existing 60 Python tests and 75 node:test cases are kept as they are and only move directories where ADR-0001 requires.

## Alternatives considered

- Vitest everywhere including `packages/explorer`: rejected; the skill copy must build and test without Vitest, and `node:test` already covers the logic modules.
- Cypress instead of Playwright: rejected; the existing suites, the harness, and the swiftshader WebGL flags are Playwright-based.
- Visual-regression snapshots at MVP: deferred to L-01 nightly; pixel assertions are flaky on shared CI.
- Mock-only PostgreSQL: rejected; CTQ-08 requires real write rejection and `statement_timeout` behaviour.
- Do nothing: rejected; zero browser coverage cannot support CTQ-02/03/04/10/11.

## CTQs affected

- CTQ-12 directly; CTQ-02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 13, 14, 15, 16 through the layers above.

## Verification

- S02: `npm test` includes lint, c8 gates, and Vitest; `npx playwright test` runs the six converted suites on bundled Chromium; `scripts/verify_host.mjs` reports zero external requests and no literal counts (Gate G1).
- Q01: baselines recorded in `docs/qa/perf-baselines.md`; regression gate active after two green weeks.
- Q02: `tests/security/**` green; `docs/security/threat-model.md` control-to-test table complete (Gate G2).
- Q03: `test_postgres_live.py` green under `compose.qa.yml` in CI.
- Q05: `node scripts/docs_lint.mjs` green; PR-title regex enforced (every PR).

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed) | Platform lead |
| 2026-09-07 | Review fix: `npm test` orchestration citation corrected to `scripts/project.mjs:104-115` | Platform lead |
