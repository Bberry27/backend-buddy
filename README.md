# Backend Buddy

Interactive schema exploration, bounded read-only profiling, and structured schema review. Delivered today as a single offline HTML file; being built into a self-hosted database-analysis platform.

Working name: Backend Buddy. Repository: `Bberry27/backend-buddy` (private, personal account).

## What it is

You give it a **SchemaGraph**: a JSON snapshot of tables, columns, keys, indexes, and relationships in the canonical contract documented in [`skill/references/schema-contract.md`](skill/references/schema-contract.md). It gives you:

- **Thirteen linked views of one schema.** Four host views (relational map, entity index, PK/FK index, schema review) and nine React views (Living ERD, Row Fan-out, Column Table, Schema City, Normalization Lens, Schema Diff, Join Matrix, Arc Diagram, Domains). They share one selection and one inspector, so the table you pick in the Join Matrix is the table you inspect in the Column Table.
- **Evidence you can trust.** Declared constraints and inferred relationships are stored, styled, and labelled differently. Unknown statistics stay unknown: the explorer never substitutes zero or a synthetic number to make a chart look populated.
- **Bounded, read-only profiling.** An optional Python service profiles explicitly selected SQLite or PostgreSQL connections inside read-only transactions with hard caps on rows (10,000 per table), traversal depth (4 hops), query count, bound parameters, scalar length, and wall time. Nothing connects on import and no credentials are discovered from the environment.
- **A review workflow.** Normalization, referential-integrity, and index findings are review candidates, not verdicts. Each carries its evidence, a next validation step (read-only SQL for a supported dialect, never executed by the explorer), and a decision you can record and export as CSV.
- **An offline single-file artifact.** `dist/backend-buddy.html` embeds the views, icons, and schema JSON behind a locked-down Content Security Policy (`connect-src 'none'`), so it opens from a file share, a ticket attachment, or a release archive without a server or network access.

## What it is becoming

The roadmap turns this baseline into a licensable platform: a React application shell with URL-addressable drill-through between all views, a FastAPI service and worker that store snapshots, run extraction and profiling jobs against registered read-only connections, and keep an audit trail, all shipped as a Docker Compose stack a team runs on its own hardware. A hosted, multi-tenant SaaS edition follows. The offline artifact and the portable skill remain first-class exports throughout. See [`docs/product-management/roadmap.md`](docs/product-management/roadmap.md).

## Current state

What exists on `main` today, stated plainly:

| Area | Status |
|---|---|
| Nine React views (`packages/explorer/src`) | Working; pure logic modules covered by unit tests |
| Four host views, tab list, filters, theme, inspector | Working; implemented in vanilla JavaScript inside `skill/assets/explorer.html` |
| Offline artifact build (`npm run build`) | Working; renders from a synthetic fixture |
| Read-only profiler and loopback server (`packages/explorer/server`) | Working for SQLite; PostgreSQL path implemented but exercised only with mocks in the test suite |
| Synthetic fixtures (`fixtures/`) | Generated from a seeded script and validated against the contract |
| Application shell, routing, bidirectional drill-through | Not built |
| API, worker, metadata store, authentication | Not built |
| Docker image and Compose stack | Not built |
| Browser, accessibility, and performance suites | Legacy Playwright scripts exist but are not a CI gate: four run only by hand, and the two `node:test` browser suites that `npm test` collects self-skip without a Playwright runtime (S02 converts all six) |

Known security findings in the artifact and renderer are listed in the Security section of [CHANGELOG.md](CHANGELOG.md) and scheduled for the S01 hardening work package. Until it merges, build artifacts only from snapshots you trust.

## Quickstart

Requirements: Node 22 (see `.nvmrc`), npm 10, Python 3.13. The renderer, the profiler, and the loopback server run on the standard library, but the contract validator `bb_profiler` imports `jsonschema`, so the contract tests inside `npm test` need it installed. Install `psycopg[binary]` (psycopg 3) only if you want to profile PostgreSQL.

```sh
npm run restore   # npm ci inside packages/explorer (locked dependencies)
python -m pip install -r packages/profiler/requirements.txt   # jsonschema, for the contract tests
npm run build     # bundle the React views, refresh the skill mirror, render dist/backend-buddy.html
npm test          # contract drift check, typecheck, TypeScript unit, profiler, renderer, contract, and fixture tests
```

Open `dist/backend-buddy.html` in a browser. The default build input is `fixtures/schemas/medium.json`. Build against another snapshot with `npm run build -- --schema path/to/schema.json` or by setting `BB_SCHEMA`; keep such snapshots outside the repository.

If your interpreter is named `python3`, set `PYTHON=python3` before running the scripts (CI does).

Other scripts:

| Command | Purpose |
|---|---|
| `npm run guard` | Private-data guard: rejects files under private or QA-output directories, images outside `docs/assets/`, `report.json`, coverage data (`.coverage`), files over 2 MB, and machine-local paths; a local name denylist runs from `BB_DENYLIST_FILE` |
| `npm run notices` | Regenerate `THIRD_PARTY_NOTICES.md` from the lockfile |
| `npm run fixtures` | Regenerate the seeded synthetic fixtures under `fixtures/` |
| `npm run typecheck` | TypeScript `--noEmit` for `packages/explorer` |
| `npm run test:scripts` | `node:test` suites for `scripts/` via `node --test "scripts/**/*.test.mjs"` (any depth, `.test.mjs` suffix); CI runs the same script after `npm run restore`; a bare `node --test scripts/` fails on Node 22 |
| `npm run verify:host -- dist/backend-buddy.html [out-dir]` | Headless-browser sweep of a built artifact (`scripts/verify_host.mjs`); every count is derived from the embedded snapshot; needs `playwright` and `pngjs`, which S02 pins, and exits 2 with instructions until they are installed; default output `outputs/schema-map-qa` (ignored) |
| `npm run hooks` | Point `core.hooksPath` at `.githooks/` so the private-data guard runs before every commit |

To profile a schema against a database you control, or to run the loopback live viewer, read the "Optional Read-only Profiling" section of [`skill/references/advanced-views.md`](skill/references/advanced-views.md).

## Repository layout

```
packages/explorer/        Canonical React view library, pure logic modules, esbuild bundle, Python profiler and loopback server
skill/                    Portable skill: SKILL.md, references, explorer.html host, build_explorer.py renderer, browser checks
skill/assets/extensions/  Generated mirror of packages/explorer written by `npm run build`; never edit by hand
scripts/                  project.mjs (build/test orchestration), fixture generator, private-data guard, notices generator, host verifier
fixtures/                 Synthetic SchemaGraph snapshots, SQL seeds, and contract corpora used by builds and tests
docs/                     Documentation map (docs/README.md), business case, architecture and ADRs, developer guides, product management, feature docs, reference registries; the engineering set (docs/engineering/) lands with D03
dist/                     Build output (ignored); dist/backend-buddy.html is the offline artifact
backend-buddy.code-workspace   VS Code workspace: hides the generated skill mirror from search; holds no machine-local paths
```

`packages/explorer` is the only place to edit view or profiler code. `skill/assets/extensions` is regenerated on every build so the installed skill stays in step; its `dist/` is ignored.

Provenance: the tree was created by an allowlisted export from the owner's private working copy. The export script (`export_clean_tree.ps1`) stays in that private copy on purpose: it names the private source paths and the files it renamed, which the local denylist forbids here, so it cannot be tracked without defeating its own purpose. The exported file list is the first commit; from there the private-data guard (`npm run guard`) decides what may be tracked.

## Documentation

**Picking this up after a break, or on another machine? Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first.** It states what works, what is half-built, what to do next, and the things that are easy to trip over.

Start at [`docs/README.md`](docs/README.md), the documentation map with a status legend. Key entry points:

- [`docs/business/business-case.md`](docs/business/business-case.md): problem, personas, value proposition, licensing options
- [`docs/architecture/overview.md`](docs/architecture/overview.md): target architecture, components, data flows, ADR index
- [`docs/product-management/ctq.md`](docs/product-management/ctq.md): critical-to-quality registry with measurable targets
- [`docs/product-management/roadmap.md`](docs/product-management/roadmap.md): Now / Next / Later and release gates
- [`docs/features/README.md`](docs/features/README.md): feature registry F01–F22 and per-feature reference docs
- [`docs/architecture/legacy-handoff.md`](docs/architecture/legacy-handoff.md): the pre-repository baseline this repository started from

Contributors and coding agents should also read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Private data

This repository contains **synthetic fixtures only**. Never commit a customer's, employer's, or example project's schema, snapshot, profiling output, screenshot, or QA report, and never copy files in from another local project. Build and test against `fixtures/`; keep real snapshots outside the repository and point at them with `--schema` when you need them locally. `npm run guard` enforces these rules and runs in CI; run it before every commit. The policy is in [SECURITY.md](SECURITY.md), [ADR-0007](docs/architecture/adr/ADR-0007-private-data-and-fixture-policy.md), and [`docs/architecture/security-architecture.md`](docs/architecture/security-architecture.md) section 9; the engineering security policy (`docs/engineering/security-policy.md`) lands with D03.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open public issues for security findings.

## License

Proprietary. Copyright 2026 Bberry27. All rights reserved. See [LICENSE](LICENSE) (draft, pending legal review) for the evaluation grant and restrictions, and `THIRD_PARTY_NOTICES.md` for the open-source components and their licenses.
