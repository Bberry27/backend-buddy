# AGENTS.md

Entry point for coding agents, and for people working like them, in this repository. Read this file first, then the brief for your work package, then start.

## 0. Current state

Read [`docs/HANDOFF.md`](docs/HANDOFF.md) before anything else. It records what is finished, what is stopped mid-package, the decisions already made so they are not relitigated, and the known gaps. Starting work without it risks rebuilding something that exists or reversing a decision on purpose taken.

## 1. Start here

1. Read `docs/product-management/agent-briefs/README.md` and the brief for your work package, `docs/product-management/agent-briefs/WP-<id>.md`, **before any work**. The brief carries the feature and CTQ ids, an ordered reading list, in-scope and out-of-scope items, `may-modify` and `must-not-touch` globs, frozen contracts, the definition of done, and the exact acceptance commands. Stay inside your globs; other agents own the rest, often concurrently.
2. Follow the brief's reading list in order: feature doc, then contract, then ADRs, then the existing code.
3. Read the root governance documents once: [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).

## 2. Canonical sources and generated mirrors

| Path | Role |
|---|---|
| `packages/explorer/src` | Canonical React views, pure logic modules, and `types.ts` (the SchemaGraph contract) |
| `packages/explorer/server` | Canonical Python profiler, snapshot IO, loopback server, and their tests |
| `skill/assets/explorer.html` | Host page of the offline artifact: theme, tab list, filters, inspector, four host views |
| `skill/scripts/build_explorer.py` | `normalize()` and `render()`: validates canonical schema JSON and emits the artifact |
| `skill/assets/extensions/**` | **Generated** mirror of `packages/explorer`, written by `npm run build` (`syncSkill()` in `scripts/project.mjs`). Never edit it by hand; the next build overwrites it. |
| `fixtures/**` | **Generated** by `scripts/generate-fixtures.mjs` (`npm run fixtures`). Change the generator, not the output. |
| `THIRD_PARTY_NOTICES.md` | **Generated** by `scripts/generate_notices.mjs` (`npm run notices`); CI fails on drift. |

Edit only canonical files. When you change `packages/explorer`, run `npm run build` so the mirror follows, and commit both.

## 3. Guardrails

Carried over from [`docs/architecture/legacy-handoff.md`](docs/architecture/legacy-handoff.md) and the security policy. Each has a CTQ and tests behind it. Do not weaken one to make a task easier; if a brief appears to require it, stop and raise it.

- **Keep SchemaGraph project-neutral.** No project-specific names, aliases, domain knowledge, or table and column counts anywhere in `packages/explorer`, `skill/`, `scripts/`, or `fixtures/`. Tests derive expected counts from the loaded graph, never from literals tied to one schema. The forbidden counts themselves stay out of the repository as well: set `BB_FORBIDDEN_COUNTS` locally (comma-separated integers, alongside the name denylist in `BB_DENYLIST_FILE`) and `npm run test:scripts` rejects any fixture that reproduces them.
- **Preserve declared versus inferred evidence.** Declared constraints and inferred or naming-based relationships stay distinguishable in data, styling, and labels. A column named `id` is not automatically a primary key; an `_id` suffix is not proof of a foreign key.
- **Unknown stays unknown, never zero.** Missing `rowCount` or profiling statistics render as unknown with baseline sizing and an explicit label. Never substitute column counts, zeros, or synthetic values. A capped sample yields a lower bound, not a total.
- **Profiling only through explicitly selected read-only connections, within the existing bounds.** SQLite through an explicit file path that is never created; PostgreSQL through the *name* of a DSN environment variable. Nothing connects on import and nothing discovers credentials. The caps in `packages/explorer/server/schema_profiler.py` (rows, depth, parameters, batch keys, queries, deadline, scalar length, functional-dependency columns) may be tightened but not raised without an ADR.
- **Draft SQL is never executed by the explorer.** Validation SQL and migration drafts are shown for a supported, identified dialect only. A drill-through may prefill a live query but never runs it without an explicit user click.
- **Keep click-drag pan and click-versus-drag separation covered in browser tests** on the relational map, Schema City (3D and flat), and Living ERD. Panning must not select text or open the inspector; an ordinary click must still inspect.
- **Never publish snapshots or profiling results implicitly.** No upload, hosting, telemetry, or export happens as a side effect of any action. Sample values are opt-in and capped; min/max can be sensitive.
- **Preserve the offline artifact CSP byte for byte:** `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`. Only the copy served in live mode may change `connect-src`.
- **Secrets never reach the browser or the repository.** Connection strings, tokens, and keys live in environment variables or secret files; `.env*` is ignored and `.env.example` carries placeholders only.

## 4. Traceability

Every change maps to a feature (F01–F22) or a work-package id (R, S, C, W, A, O, Q, D tracks). Use the id everywhere so a line in the changelog leads to the brief, the branch, the tests, and the feature doc:

| Where | Convention | Example |
|---|---|---|
| Branch | `f##/<slug>` for features; `<wp-id>/<slug>` (lower case) for other work packages | `f08/city-search`, `s01/renderer-escaping` |
| Commit | Conventional Commits with scope = id | `feat(F08): add table search to Schema City` |
| Tests | Name prefixed with the id | `test('F08 search selects and flies to the table', ...)`; `def test_S01_line_is_escaped(self)` |
| CHANGELOG.md | One line under `[Unreleased]`, prefixed with the id | `- F08: table search with fly-to in Schema City` |
| Feature doc | Append to section 14 (implementation map and change log) of `docs/features/F##-<slug>.md` on merge | |
| PR title | Carries the id as the Conventional Commit scope; a title lint lands with Q05 | `feat(F08): Schema City search` |

## 5. Definition of done

A work package is done when all of the following hold (the checklist with package-specific additions is in `docs/developer/contribute.md` section 7 and in every brief; the rationale document `docs/engineering/definition-of-done.md` lands with D03):

- Code and tests named with the F/CTQ id, green locally with the brief's acceptance commands.
- Feature doc sections 3 (current state) and 14 (implementation map) updated.
- Migration with a tested downgrade, or an explicit "none, because ...".
- CHANGELOG line and release-note line.
- Security checklist completed; accessibility result recorded; performance number recorded where a budget exists.
- Caveat text is quoted verbatim from [`docs/reference/caveats.md`](docs/reference/caveats.md); once C03 lands, UI strings come only from its mirror `packages/explorer/src/caveat-strings.ts`.

## 6. Before you commit

```sh
npm run guard     # private-data guard: must be green on every commit
npm test          # typecheck, TypeScript unit, Python profiler, renderer tests
npm run build     # when you touched packages/explorer, so skill/assets/extensions follows
npm run test:scripts  # when you touched scripts/ (node --test "scripts/**/*.test.mjs" after npm run restore; a bare directory argument fails on Node 22)
```

Run `npm run guard` before every commit. Never `git init` or commit inside any directory other than this repository, and never copy files in from another local project; regenerate fixtures with `npm run fixtures` instead.

## 7. Do not

- Edit generated paths: `skill/assets/extensions/**`, the outputs under `fixtures/**`, `THIRD_PARTY_NOTICES.md`.
- Add dependencies or change `package.json` or `package-lock.json` unless the brief says so. CI uses `npm ci`; never rely on `npm install`.
- Leave to-do or fix-me markers in code or documentation. Record follow-ups in the brief's out-of-scope list or the changelog instead.
- Reimplement `normalize()`. It is the semantic oracle for the contract on both the Python and TypeScript sides.
- Raise profiler caps, loosen the CSP, or add network calls to the artifact.
