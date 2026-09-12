Status: draft | Owner: Platform lead | Last verified against code: pre-repo (2026-09-07)

# ADR-0001: Monorepo layout

- **ADR status**: proposed
- **Date**: 2026-09-07
- **Deciders**: Product owner, Platform lead, Frontend lead, Backend lead
- **Work packages**: R00, R01, C01, A01, O01
- **Related**: ADR-0002 (frontend), ADR-0003 (backend and contract), ADR-0007 (private data), `docs/engineering/code-layout.md` (D03)

## Context

The baseline is a two-level tree: a root `package.json` whose scripts delegate to `scripts/project.mjs`, one npm package `packages/explorer` (React views, esbuild IIFE build, Python server files under `packages/explorer/server`), and a portable `skill/` directory that receives a byte copy of the explorer package through `syncSkill()` (`scripts/project.mjs:52-60`; folders `src`, `server`, `dist` and five named files). The Python renderer and its tests live in `skill/scripts/` (`build_explorer.py`, `test_renderer.py`) and the profiler and loopback server in `packages/explorer/server/` (`schema_profiler.py`, `serve_explorer.py`, `profile_snapshot.py`, `snapshot_io.py`, two test files). The root `package.json` already declares `engines` `node >= 22`, `npm >= 10.5.1` and scripts `restore`, `build`, `typecheck`, `test`, `guard`, `notices`, `fixtures`, `verify:host`, `hooks`.

Forces:

- The skill must keep working from its own directory without Node at render time (`skill/SKILL.md:21`, `:40`), so whatever is copied into `skill/assets/extensions` must be self-contained.
- The plan adds a SPA, a contract package, a Python API and worker, a profiler package, fixtures, root-level Playwright tests, Docker files, and a documentation tree, each owned by a different work package and often built by a different agent in parallel; work packages carry `may-modify` and `must-not-touch` globs, so package boundaries must be directory boundaries.
- Python and Node coexist: `scripts/project.mjs:10` locates the interpreter through `PYTHON`; CI sets `python3` (`.github/workflows/ci.yml`).
- The private example must never be copied into the tree (ADR-0007); `scripts/private_data_guard.mjs` enforces an allowlist of paths.

## Decision

Adopt the following layout in the new repository; each top-level directory is owned by the work packages named in the plan and nothing else writes there.

```
package.json                 npm workspaces: packages/explorer, packages/web
packages/explorer/           view library + shell-neutral modules (node:test only; copied by syncSkill)
packages/web/                Vite + React 19 + React Router 7 SPA (Vitest + Testing Library)
packages/profiler/           Python bb_profiler: core, drivers/{postgresql,sqlite}, policy, targets, compat
packages/contract/           schema-graph.v1.json, codegen script, fixtures/contract/{valid,invalid}
services/api/                FastAPI app, alembic/, worker entrypoint, tests/
skill/                       preserved; syncSkill copies explorer dist/src and bb_profiler
fixtures/schemas/            generated synthetic SchemaGraph fixtures; fixtures/sql/{sqlite,pg}/seed.sql
tests/{e2e,a11y,perf,security}/   Playwright at repo root, bundled Chromium + swiftshader
deploy/                      Dockerfile, compose.yml, compose.dev.yml, compose.qa.yml, .dockerignore, .env.example
scripts/                     project.mjs, generate-fixtures.mjs, verify_host.mjs, private_data_guard.mjs, docs_lint.mjs, generate_notices.mjs, size-budget.mjs
docs/                        documentation tree (docs/README.md)
```

1. Root `package.json` becomes an npm workspaces root for `packages/explorer` and `packages/web`; `packages/explorer` keeps its own lockfile until workspaces are enabled in R00 (the current lockfile is preserved byte for byte, `skill/SKILL.md:40`).
2. `packages/explorer/src` stays the canonical view source; `skill/assets/extensions` stays a generated copy (root `AGENTS.md`), never cited in docs and never edited directly.
3. Python code lives in two places only: `packages/profiler/bb_profiler` (library, tests beside it) and `services/api` (app, alembic, worker, tests). `packages/explorer/server` is removed once `compat.py` makes `connect_readonly`/`profile`/`subtree` importable from the new package and the 51 tests pass unchanged (A03); `skill/scripts/build_explorer.py` stays where the skill needs it and is imported by the API.
4. Browser tests live at the repository root under `tests/` and never inside packages; unit tests stay beside their modules.
5. Generated fixtures live under `fixtures/`; the default build input is `fixtures/schemas/medium.json` (`scripts/project.mjs:89`), never a private file.
6. `scripts/` holds repository-level automation only; package-level build scripts stay in the package (`packages/explorer/build.mjs`).

## Consequences

- Positive: work-package globs map to directories; `syncSkill` keeps a single source of truth for the skill; `packages/explorer` can forbid router/fetch/Vitest imports by lint (`no-restricted-imports`, S02) because it is its own package; Python packaging is explicit (`requirements.txt` per package, `pyproject` later).
- Negative: two npm lockfiles during the transition to workspaces; Python import paths change for the profiler (mitigated by `compat.py` and the unchanged test suite); the skill copy grows by the profiler package.
- Neutral: `skill/scripts/build_explorer.py` remains outside `packages/`, which is deliberate: the skill must render without the platform.

## Alternatives considered

- Separate repositories per component: rejected; the contract, view library, skill copy, and API validation change together, and the plan's agents need one CI gate.
- Keep `packages/explorer/server` as the profiler home: rejected; the worker and the skill both import it, and the plan's `Driver` protocol and `policy.py` do not belong under a UI package.
- Put Playwright tests inside `packages/web`: rejected; the suites exercise the artifact and the compose stack, not one package.
- Do nothing (single package plus skill): rejected; no place for the API, worker, contract, or fixtures.

## CTQs affected

- CTQ-13 docs-code sync: fixed paths let the docs lint check citations.
- CTQ-14 private-data hygiene: the allowlist in `scripts/private_data_guard.mjs` is expressed over this layout.
- CTQ-12 test health: coverage gates are computed per package.
- CTQ-15 deployability: one image from `deploy/` builds every runtime component.

## Verification

- R00: `git ls-files` matches the allowlist; `npm run guard` green; `npm run restore && npm run build && npm test` green on ubuntu from a clean clone (Gate G1).
- A03: `packages/profiler` tests import through `compat.py` and pass unchanged; `syncSkill()` copies the package and `skill/scripts/test_renderer.py` still passes.
- Q05: `scripts/docs_lint.mjs` resolves every `path:line` citation in `docs/` against the tree.

## Change log

| Date | Change | By (role) |
|---|---|---|
| 2026-09-07 | Created (proposed) | Platform lead |
